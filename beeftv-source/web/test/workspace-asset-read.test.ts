import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as runtimeMode from "@/lib/runtime-mode";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import { captureUserScope, UserScopeAbandonedError } from "@/lib/user-scope-guard";
import { apiClient } from "@/services/api/request";
import { resourceFileUrl } from "@/services/api/resources";
import { loadAssetLibraryPage } from "@/services/local-workspace-sync";
import {
    isUnsavedWorkspaceAsset,
    isWorkspaceGeneratedHistoryAsset,
    loadWorkspaceAssetLibraryPage,
    loadWorkspaceAssetsForUse,
    preserveLegacyCacheOnlyAssetDrafts,
    resetWorkspaceAssetReadStateForTests,
    usesWorkspaceAssetLibraryApi,
    WORKSPACE_ASSET_BATCH_LIMIT,
    WORKSPACE_ASSET_LINKED_PROJECT,
    WORKSPACE_ASSET_TOMBSTONE_SEAM,
    WORKSPACE_ASSET_UNLINKED_PROJECT,
    workspaceAssetAllProjectsCount,
    workspaceAssetCountSum,
    workspaceAssetProjectOptions,
    workspaceAssetTraversalTotal,
} from "@/services/workspace-asset-read";
import { hydrateAssetStoreDrafts, peekAssetStoreDraft, recordAssetStoreDraft, resetAssetStoreDraftsForTests, useAssetStore, type Asset } from "@/stores/use-asset-store";

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function switchScope(userId: string) {
    const previous = getActiveUserScope();
    setActiveUserScope(userId);
    return () => setActiveUserScope(previous);
}

function sampleAsset(id: string, title = "缓存素材"): Asset {
    return {
        id,
        kind: "image",
        title,
        coverUrl: "/api/resources/res-1/file",
        tags: ["生成"],
        category: "material",
        status: "confirmed",
        source: "Canvas",
        metadata: { canvasId: "canvas-1", nodeId: "node-1" },
        data: { dataUrl: "/api/resources/res-1/file", storageKey: "resource:res-1", width: 8, height: 8, bytes: 4, mimeType: "image/png" },
        createdAt: "2026-10-02T00:00:00.000Z",
        updatedAt: "2026-10-02T00:00:00.000Z",
    };
}

function sampleClientAsset(id: string, title = "SQLite 素材", extra: Record<string, unknown> = {}) {
    return {
        id,
        kind: "image",
        title,
        coverUrl: "/api/resources/res-1/file",
        tags: ["生成"],
        category: "material",
        status: "confirmed",
        source: "Canvas",
        data: { dataUrl: "/api/resources/res-1/file", storageKey: "resource:res-1", width: 8, height: 8, bytes: 4, mimeType: "image/png" },
        createdAt: "2026-10-02T00:00:00.000Z",
        updatedAt: "2026-10-02T00:00:00.000Z",
        ...extra,
    };
}

function pageResponse(assets: unknown[], extra: { total?: number; page?: number; pageSize?: number; hasMore?: boolean; favoriteTotal?: number; recentTotal?: number; projectCounts?: Record<string, number>; generatedTotal?: number; generatedKindCounts?: Record<string, number>; kindCounts?: Record<string, number>; categoryCounts?: Record<string, number>; folderCounts?: Record<string, number> } = {}) {
    return {
        assets,
        kindCounts: extra.kindCounts ?? { image: assets.length },
        categoryCounts: extra.categoryCounts ?? { material: assets.length },
        folderCounts: extra.folderCounts ?? {},
        favoriteTotal: extra.favoriteTotal ?? 0,
        recentTotal: extra.recentTotal ?? 0,
        projectCounts: extra.projectCounts ?? {},
        generatedTotal: extra.generatedTotal ?? 0,
        generatedKindCounts: extra.generatedKindCounts ?? {},
        page: extra.page ?? 1,
        pageSize: extra.pageSize ?? 40,
        total: extra.total ?? assets.length,
        hasMore: extra.hasMore ?? false,
    };
}

function favoriteCatalog(count = 125) {
    return Array.from({ length: count }, (_, index) => {
        const n = count - index;
        const id = `fav-${String(n).padStart(3, "0")}`;
        return sampleClientAsset(id, `收藏${n}`, { metadata: { favorite: true } });
    });
}

function pagedFavorites(page: number, pageSize: number, catalog = favoriteCatalog()) {
    const start = Math.max(0, page - 1) * pageSize;
    return pageResponse(catalog.slice(start, start + pageSize), {
        page,
        pageSize,
        total: catalog.length,
        hasMore: start + pageSize < catalog.length,
        favoriteTotal: catalog.length,
    });
}

function envelope(data: unknown, status = 200) {
    return { data: { code: 0, msg: "", data }, status, statusText: "OK", headers: {}, config: {} as never };
}

function requestKey(config: { method?: string; url?: string }) {
    return `${String(config.method || "get").toLowerCase()} ${String(config.url || "")}`;
}

function isAssetCollection(url: string) {
    return url === "/assets" || /\/assets$/u.test(url);
}

function isAssetBatch(url: string) {
    return url.includes("/assets/batch");
}

function requestParams(config: { params?: unknown }) {
    return (config.params || {}) as Record<string, unknown>;
}

function requestBody(config: { data?: unknown }) {
    const data = config.data;
    if (typeof data === "string") {
        try {
            return JSON.parse(data) as unknown;
        } catch {
            return data;
        }
    }
    return data;
}

async function withAdapter<T>(adapter: NonNullable<typeof apiClient.defaults.adapter>, run: () => Promise<T>) {
    const previous = apiClient.defaults.adapter;
    apiClient.defaults.adapter = adapter;
    try {
        return await run();
    } finally {
        apiClient.defaults.adapter = previous;
    }
}

function libraryAdapter(options: {
    onPage: (config: { method?: string; url?: string; params?: unknown; data?: unknown }) => unknown;
    canonical?: Record<string, unknown> | ((ids: string[]) => unknown[]);
}): NonNullable<typeof apiClient.defaults.adapter> {
    return async (config) => {
        const url = String(config.url || "");
        const method = String(config.method || "get").toLowerCase();
        if (method === "post" && isAssetBatch(url)) {
            const ids = ((requestBody(config) as { ids?: string[] }).ids || []);
            const assets = typeof options.canonical === "function"
                ? options.canonical(ids)
                : ids.flatMap((id) => {
                    const row = options.canonical?.[id];
                    return row == null ? [] : [row];
                });
            return envelope({ assets });
        }
        if (method === "get" && isAssetCollection(url) && requestParams(config).page != null) {
            return envelope(options.onPage(config));
        }
        if (method === "put") throw new Error("overlay must not PUT");
        throw new Error(`unexpected ${requestKey(config)}`);
    };
}

const spies: Array<{ mockRestore: () => void }> = [];

function desktopBackend() {
    spies.push(spyOn(runtimeMode, "isNativeDesktopRuntime").mockReturnValue(true));
    spies.push(spyOn(runtimeMode, "isLocalRuntimeMode").mockReturnValue(true));
}

function browserLocal() {
    spies.push(spyOn(runtimeMode, "isNativeDesktopRuntime").mockReturnValue(false));
    spies.push(spyOn(runtimeMode, "isLocalRuntimeMode").mockReturnValue(true));
}

function hostedSession() {
    spies.push(spyOn(runtimeMode, "isNativeDesktopRuntime").mockReturnValue(false));
    spies.push(spyOn(runtimeMode, "isLocalRuntimeMode").mockReturnValue(false));
}

afterEach(async () => {
    while (spies.length) spies.pop()?.mockRestore();
    useAssetStore.setState({ assets: [] });
    resetWorkspaceAssetReadStateForTests();
    await resetAssetStoreDraftsForTests();
});

describe("workspace asset canonical reads", () => {
    test("desktop empty cache still lists and selects a SQLite asset", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        expect(usesWorkspaceAssetLibraryApi()).toBe(true);
        expect(useAssetStore.getState().assets).toEqual([]);
        const urls: string[] = [];
        try {
            const page = await withAdapter(async (config) => {
                urls.push(requestKey(config));
                const url = String(config.url || "");
                const method = String(config.method || "get").toLowerCase();
                if (method === "get" && isAssetCollection(url) && requestParams(config).page != null) {
                    expect(requestParams(config)).toEqual({ page: 1, pageSize: 40, status: "active" });
                    return envelope(pageResponse([sampleClientAsset("sqlite-1")]));
                }
                if (method === "post" && isAssetBatch(url)) {
                    expect(requestBody(config)).toEqual({ ids: ["sqlite-1"] });
                    return envelope({ assets: [sampleClientAsset("sqlite-1")] });
                }
                throw new Error(`unexpected ${requestKey(config)}`);
            }, async () => {
                const result = await loadAssetLibraryPage({ page: 1, pageSize: 40, status: "active" });
                expect(result.assets.map((asset) => asset.id)).toEqual(["sqlite-1"]);
                expect(result.total).toBe(1);
                expect(result.assets[0]?.title).toBe("SQLite 素材");
                await loadWorkspaceAssetsForUse(["sqlite-1"]);
                return result;
            });
            expect(page.assets).toHaveLength(1);
            expect(useAssetStore.getState().assets.map((asset) => asset.id)).toEqual(["sqlite-1"]);
            expect(urls.filter((url) => url.startsWith("get ")).length).toBe(1);
            expect(urls.some((url) => url.includes("/assets/sqlite-1"))).toBe(false);
        } finally {
            restore();
        }
    });

    test("hosted reads use the same SQLite library API as desktop", async () => {
        const restore = switchScope("owner-a");
        hostedSession();
        expect(usesWorkspaceAssetLibraryApi()).toBe(true);
        try {
            const page = await withAdapter(async (config) => {
                if (String(config.method || "get").toLowerCase() === "get" && isAssetCollection(String(config.url || ""))) {
                    return envelope(pageResponse([sampleClientAsset("hosted-1", "Hosted 素材")]));
                }
                throw new Error(`unexpected ${requestKey(config)}`);
            }, async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40 }));
            expect(page.assets.map((asset) => asset.id)).toEqual(["hosted-1"]);
        } finally {
            restore();
        }
    });

    test("stale confirmed cache does not resurrect a server deletion as saved", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        useAssetStore.setState({ assets: [sampleAsset("stale-deleted"), sampleAsset("live", "仍在库里")] });
        try {
            const page = await withAdapter(async (config) => {
                const url = String(config.url || "");
                const method = String(config.method || "get").toLowerCase();
                if (method === "get" && isAssetCollection(url) && requestParams(config).page != null) {
                    return envelope(pageResponse([sampleClientAsset("live", "仍在库里")]));
                }
                if (method === "post" && isAssetBatch(url)) {
                    const ids = (requestBody(config) as { ids?: string[] }).ids || [];
                    return envelope({ assets: ids.filter((id) => id === "live").map((id) => sampleClientAsset(id, "仍在库里")) });
                }
                throw new Error(`unexpected ${requestKey(config)}`);
            }, async () => {
                const result = await loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, status: "active" });
                expect(result.assets.map((asset) => asset.id)).toEqual(["live"]);
                expect(result.assets.every((asset) => !isUnsavedWorkspaceAsset(asset))).toBe(true);
                await expect(loadWorkspaceAssetsForUse(["stale-deleted"])).rejects.toThrow("部分本地素材不存在，请重新选择素材");
                await loadWorkspaceAssetsForUse(["live"]);
                return result;
            });
            expect(page.assets.map((asset) => asset.id)).toEqual(["live"]);
            expect(useAssetStore.getState().assets.find((asset) => asset.id === "stale-deleted")?.status).toBe("confirmed");
        } finally {
            restore();
        }
    });

    test("query failure stays a failure and does not become an empty saved library", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        useAssetStore.setState({ assets: [sampleAsset("stale")] });
        try {
            await expect(withAdapter(async () => {
                throw new Error("素材服务不可用");
            }, async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40 }))).rejects.toThrow("素材服务不可用");
            expect(useAssetStore.getState().assets.map((asset) => asset.id)).toEqual(["stale"]);
            expect(useAssetStore.getState().assets[0]?.status).toBe("confirmed");
        } finally {
            restore();
        }
    });

    test("pending delete draft hides a backend row and is not projected back into the store", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        useAssetStore.setState({ assets: [] });
        recordAssetStoreDraft("live", "delete");
        try {
            const page = await withAdapter(libraryAdapter({
                onPage: () => pageResponse([sampleClientAsset("live", "仍在库里")]),
                canonical: { live: sampleClientAsset("live", "仍在库里") },
            }), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40 }));
            expect(page.assets).toEqual([]);
            expect(page.total).toBe(0);
            expect(useAssetStore.getState().assets.map((asset) => asset.id)).toEqual([]);
        } finally {
            restore();
        }
    });

    test("explicit newer draft is retained over the backend payload", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        useAssetStore.setState({ assets: [sampleAsset("live", "服务端旧标题")] });
        useAssetStore.getState().updateAsset("live", { title: "本地新标题" });
        try {
            const page = await withAdapter(libraryAdapter({
                onPage: () => pageResponse([sampleClientAsset("live", "服务端旧标题")]),
                canonical: { live: sampleClientAsset("live", "服务端旧标题") },
            }), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40 }));
            expect(page.assets).toHaveLength(1);
            expect(page.assets[0]?.title).toBe("本地新标题");
            expect(isUnsavedWorkspaceAsset(page.assets[0]!)).toBe(true);
            expect(useAssetStore.getState().assets.find((asset) => asset.id === "live")?.title).toBe("本地新标题");
        } finally {
            restore();
        }
    });

    test("A→B→A after a pending read abandons the original expectedScope", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const expected = captureUserScope();
        const entered = deferred();
        const gate = deferred();
        try {
            const pending = withAdapter(async () => {
                entered.resolve();
                await gate.promise;
                return envelope(pageResponse([sampleClientAsset("sqlite-1")]));
            }, async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, expectedScope: expected }));
            await entered.promise;
            setActiveUserScope("owner-b");
            setActiveUserScope("owner-a");
            gate.resolve();
            await expect(pending).rejects.toBeInstanceOf(UserScopeAbandonedError);
            expect(useAssetStore.getState().assets).toEqual([]);
        } finally {
            restore();
        }
    });

    test("cache-only rows become recoverable unsaved drafts and report the tombstone seam", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        useAssetStore.setState({ assets: [sampleAsset("cache-only"), sampleAsset("live", "仍在库里")] });
        const urls: string[] = [];
        try {
            const preserved = await withAdapter(async (config) => {
                urls.push(requestKey(config));
                const url = String(config.url || "");
                const method = String(config.method || "get").toLowerCase();
                if (method === "get" && isAssetCollection(url) && requestParams(config).page == null) {
                    return envelope({ assets: [{ id: "live", title: "仍在库里", createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" }] });
                }
                if (method === "put") throw new Error("preserve must not write cache over SQLite");
                throw new Error(`unexpected ${requestKey(config)}`);
            }, async () => preserveLegacyCacheOnlyAssetDrafts());
            expect(preserved.preservedIds).toEqual(["cache-only"]);
            expect(preserved.tombstoneSeam).toBe(WORKSPACE_ASSET_TOMBSTONE_SEAM);
            const cacheOnly = useAssetStore.getState().assets.find((asset) => asset.id === "cache-only");
            expect(cacheOnly?.status).toBe("draft");
            expect(cacheOnly?.metadata?.recoverableLocalDraft).toBe(true);
            expect(isUnsavedWorkspaceAsset(cacheOnly!)).toBe(true);
            expect(urls.some((url) => url.startsWith("put "))).toBe(false);

            const page = await withAdapter(libraryAdapter({
                onPage: () => pageResponse([sampleClientAsset("live", "仍在库里")], { total: 1 }),
                canonical: {},
            }), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40 }));
            expect(page.assets.map((asset) => asset.id).sort()).toEqual(["cache-only", "live"]);
            expect(page.assets.find((asset) => asset.id === "cache-only")?.metadata?.unsaved).toBe(true);
            expect(page.total).toBe(2);
        } finally {
            restore();
        }
    });

    test("browser-local pages filter the store and never call the library API", async () => {
        const restore = switchScope("owner-a");
        browserLocal();
        expect(usesWorkspaceAssetLibraryApi()).toBe(false);
        useAssetStore.setState({ assets: [sampleAsset("local-1"), sampleAsset("local-2", "其他")] });
        const urls: string[] = [];
        try {
            const page = await withAdapter(async (config) => {
                urls.push(requestKey(config));
                throw new Error(`unexpected ${requestKey(config)}`);
            }, async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, query: "缓存" }));
            expect(page.assets.map((asset) => asset.id)).toEqual(["local-1"]);
            expect(urls).toEqual([]);
            await preserveLegacyCacheOnlyAssetDrafts();
            expect(useAssetStore.getState().assets.every((asset) => asset.status === "confirmed")).toBe(true);
        } finally {
            restore();
        }
    });

    test("favorite filters page through backend counts instead of the first 120 rows", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const requests: Array<Record<string, unknown>> = [];
        try {
            const load = (page: number) => withAdapter(async (config) => {
                const params = requestParams(config);
                requests.push(params);
                expect(params.favorite).toBe(1);
                expect(params.pageSize).toBe(40);
                expect(params.page).toBe(page);
                return envelope(pagedFavorites(page, 40));
            }, async () => loadWorkspaceAssetLibraryPage({ page, pageSize: 40, favorite: true, status: "active" }));

            const page1 = await load(1);
            const page2 = await load(2);
            const page4 = await load(4);
            expect(page1.assets.map((asset) => asset.id)).toEqual(favoriteCatalog().slice(0, 40).map((asset) => asset.id));
            expect(page1.assets.map((asset) => asset.id)).toContain("fav-125");
            expect(page1.hasMore).toBe(true);
            expect(page1.total).toBe(125);
            expect(page1.favoriteTotal).toBe(125);
            expect(page2.assets.map((asset) => asset.id)).toEqual(favoriteCatalog().slice(40, 80).map((asset) => asset.id));
            expect(page2.assets.some((asset) => page1.assets.some((item) => item.id === asset.id))).toBe(false);
            expect(page4.assets.map((asset) => asset.id)).toContain("fav-005");
            expect(page4.assets).toHaveLength(5);
            expect(page4.hasMore).toBe(false);
            expect(page4.total).toBe(125);
            expect(requests.every((params) => params.pageSize === 40 && params.favorite === 1)).toBe(true);
            expect(requests.map((params) => params.page)).toEqual([1, 2, 4]);
        } finally {
            restore();
        }
    });

    test("changed draft category and title leave the old filter and match the new one", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        useAssetStore.setState({ assets: [sampleAsset("live", "海边")] });
        useAssetStore.getState().updateAsset("live", { title: "室内新标题", category: "other" });
        try {
            const canonical = sampleClientAsset("live", "海边");
            const oldFilter = await withAdapter(libraryAdapter({
                onPage: () => pageResponse([canonical], { total: 1 }),
                canonical: { live: canonical },
            }), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, category: "material", query: "海边" }));
            expect(oldFilter.assets.map((asset) => asset.id)).toEqual([]);
            expect(oldFilter.total).toBe(0);

            const newFilter = await withAdapter(libraryAdapter({
                onPage: () => pageResponse([], { total: 0 }),
                canonical: { live: canonical },
            }), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, category: "other", query: "室内" }));
            expect(newFilter.assets.map((asset) => asset.id)).toEqual(["live"]);
            expect(newFilter.assets[0]?.title).toBe("室内新标题");
            expect(isUnsavedWorkspaceAsset(newFilter.assets[0]!)).toBe(true);
        } finally {
            restore();
        }
    });

    test("committed later-page upsert stays on its canonical page and is not extra'd on page 1", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        useAssetStore.setState({ assets: [sampleAsset("later-1", "本地新标题")] });
        useAssetStore.getState().updateAsset("later-1", { title: "本地新标题" });
        const canonical = sampleClientAsset("later-1", "服务端旧标题");
        try {
            const page1 = await withAdapter(libraryAdapter({
                onPage: () => pageResponse([sampleClientAsset("sqlite-1")], { total: 2, hasMore: true }),
                canonical: { "later-1": canonical },
            }), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40 }));
            expect(page1.assets.map((asset) => asset.id)).toEqual(["sqlite-1"]);
            expect(page1.total).toBe(2);

            const page2 = await withAdapter(libraryAdapter({
                onPage: () => pageResponse([canonical], { page: 2, total: 2, hasMore: false }),
                canonical: { "later-1": canonical },
            }), async () => loadWorkspaceAssetLibraryPage({ page: 2, pageSize: 40 }));
            expect(page2.assets.map((asset) => asset.id)).toEqual(["later-1"]);
            expect(page2.assets[0]?.title).toBe("本地新标题");
            expect(page2.total).toBe(2);
            const ids = [...page1.assets, ...page2.assets].map((asset) => asset.id);
            expect(new Set(ids).size).toBe(ids.length);
        } finally {
            restore();
        }
    });

    test("draft asset snapshot is usable when the store has no projected copy", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        // Hydration itself projects drafts; stage this fixture afterward to
        // exercise a draft whose effective-store projection is truly absent.
        await hydrateAssetStoreDrafts("owner-a");
        useAssetStore.setState({ assets: [] });
        recordAssetStoreDraft("snap-1", "upsert");
        Object.assign(peekAssetStoreDraft(getActiveUserScope(), "snap-1") as object, { asset: sampleAsset("snap-1", "快照素材") });
        const urls: string[] = [];
        try {
            const page = await withAdapter(async (config) => {
                urls.push(requestKey(config));
                if (String(config.method || "get").toLowerCase() === "put") throw new Error("snapshot must not PUT");
                return libraryAdapter({
                    onPage: () => pageResponse([], { total: 0 }),
                    canonical: {},
                })(config);
            }, async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40 }));
            expect(page.assets.map((asset) => asset.id)).toEqual(["snap-1"]);
            expect(page.assets[0]?.title).toBe("快照素材");
            expect(page.total).toBe(1);
            expect(useAssetStore.getState().assets).toEqual([]);
            expect(urls.some((url) => url.includes("/assets/batch"))).toBe(true);
            const overlayBatchCalls = urls.filter((url) => url.includes("/assets/batch")).length;

            await withAdapter(async (config) => {
                urls.push(requestKey(config));
                if (String(config.method || "get").toLowerCase() === "put") throw new Error("snapshot must not PUT");
                throw new Error(`unexpected ${requestKey(config)}`);
            }, async () => loadWorkspaceAssetsForUse(["snap-1"]));
            expect(useAssetStore.getState().assets.find((asset) => asset.id === "snap-1")?.title).toBe("快照素材");
            expect(urls.some((url) => url.startsWith("put "))).toBe(false);
            expect(urls.filter((url) => url.includes("/assets/batch"))).toHaveLength(overlayBatchCalls);
        } finally {
            restore();
        }
    });

    test("batch lookup chunks at 100 and rejects missing ids", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const ids = Array.from({ length: WORKSPACE_ASSET_BATCH_LIMIT + 1 }, (_, index) => `asset-${index + 1}`);
        const calls: string[][] = [];
        try {
            await expect(withAdapter(async (config) => {
                if (!isAssetBatch(String(config.url || ""))) throw new Error(`unexpected ${requestKey(config)}`);
                const chunk = ((requestBody(config) as { ids?: string[] }).ids || []);
                calls.push(chunk);
                return envelope({ assets: chunk.slice(0, Math.min(chunk.length, 50)).map((id) => sampleClientAsset(id)) });
            }, async () => loadWorkspaceAssetsForUse(ids))).rejects.toThrow("部分本地素材不存在，请重新选择素材");
            expect(calls).toHaveLength(2);
            expect(calls[0]).toHaveLength(100);
            expect(calls[1]).toEqual(["asset-101"]);
        } finally {
            restore();
        }
    });

    test("assets page and session hydrate through the workspace library API", () => {
        const page = readFileSync(resolve(import.meta.dir, "../src/pages/assets/index.tsx"), "utf8");
        const session = readFileSync(resolve(import.meta.dir, "../src/lib/user-session.ts"), "utf8");
        expect(page).toContain("usesWorkspaceAssetLibraryApi()");
        expect(page).toContain("canonicalReads");
        expect(page).toContain("projectCounts");
        expect(page).toContain("workspaceAssetProjectOptions");
        expect(page).toContain("workspaceAssetTraversalTotal");
        expect(page).toContain("canonicalHasMore");
        expect(page).toContain("generatedTotal");
        expect(page).toContain("generated: true");
        expect(page).toContain('title="永久删除素材"');
        expect(page).not.toContain("回收站");
        expect(page).toContain("加载更多");
        expect(page).not.toContain("删除当前页");
        const picker = readFileSync(resolve(import.meta.dir, "../src/components/assets/asset-library-picker-modal.tsx"), "utf8");
        expect(picker).not.toContain("clearWorkspaceArchivedAssets");
        expect(picker).not.toContain("回收站");
        expect(picker).not.toContain("删除当前页");
        expect(page).not.toContain("paginationTotal");
        expect(page).toContain("isUnsavedWorkspaceAsset");
        expect(page).toContain("素材读取失败");
        expect(page).not.toContain("preferLocalUnsynced");
        expect(page).not.toContain("isLocalWorkspaceMode");
        expect(session).toContain("preserveLegacyCacheOnlyAssetDrafts");
        expect(session).not.toMatch(/auth\/session|remote user|cloud/i);
    });

    test("blob display URLs are replaced from the resource storage key", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        try {
            const page = await withAdapter(async () => envelope(pageResponse([sampleClientAsset("blob-1", "带资源", {
                coverUrl: "blob:http://localhost/old",
                data: { dataUrl: "blob:http://localhost/old", storageKey: "resource:res-1", width: 8, height: 8, bytes: 4, mimeType: "image/png" },
            })])), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40 }));
            const asset = page.assets[0];
            expect(asset && "data" in asset && "dataUrl" in asset.data ? asset.data.dataUrl : "").toBe(resourceFileUrl("res-1"));
            expect(asset?.coverUrl).toBe(resourceFileUrl("res-1"));
        } finally {
            restore();
        }
    });

    test("owned resource keys resolve the current resource route after the process URL changes", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const stale = "http://127.0.0.1:9999/api/resources/res-1/file";
        try {
            const page = await withAdapter(async () => envelope(pageResponse([
                sampleClientAsset("stale-image", "旧地址图片", {
                    coverUrl: stale,
                    data: { dataUrl: stale, storageKey: "resource:res-1", width: 8, height: 8, bytes: 4, mimeType: "image/png" },
                }),
                {
                    id: "stale-video",
                    kind: "video",
                    title: "旧地址视频",
                    coverUrl: stale,
                    tags: [],
                    category: "material",
                    status: "confirmed",
                    data: { url: stale, storageKey: "resource:res-1", width: 8, height: 8, bytes: 4, mimeType: "video/mp4" },
                    createdAt: "2026-10-02T00:00:00.000Z",
                    updatedAt: "2026-10-02T00:00:00.000Z",
                },
            ])), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40 }));
            const image = page.assets.find((asset) => asset.id === "stale-image");
            const video = page.assets.find((asset) => asset.id === "stale-video");
            expect(image && "data" in image && "dataUrl" in image.data ? image.data.dataUrl : "").toBe(resourceFileUrl("res-1"));
            expect(image?.coverUrl).toBe(resourceFileUrl("res-1"));
            expect(video && "data" in video && "url" in video.data ? video.data.url : "").toBe(resourceFileUrl("res-1"));
        } finally {
            restore();
        }
    });

    test("non-resource external media URLs are left unchanged", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const external = "https://cdn.example.com/scene.png";
        try {
            const page = await withAdapter(async () => envelope(pageResponse([sampleClientAsset("external-1", "外链", {
                coverUrl: external,
                data: { dataUrl: external, width: 8, height: 8, bytes: 4, mimeType: "image/png" },
            })])), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40 }));
            const asset = page.assets[0];
            expect(asset && "data" in asset && "dataUrl" in asset.data ? asset.data.dataUrl : "").toBe(external);
            expect(asset?.coverUrl).toBe(external);
        } finally {
            restore();
        }
    });

    test("empty cache still returns SQLite project labels and counts", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        expect(useAssetStore.getState().assets).toEqual([]);
        const counts = { [WORKSPACE_ASSET_LINKED_PROJECT]: 1, 海边剧: 2, [WORKSPACE_ASSET_UNLINKED_PROJECT]: 4 };
        try {
            const page = await withAdapter(libraryAdapter({
                onPage: () => pageResponse([], { total: 7, projectCounts: counts }),
            }), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, status: "active" }));
            expect(page.assets).toEqual([]);
            expect(page.projectCounts).toEqual(counts);
            expect(workspaceAssetProjectOptions(page.projectCounts)).toEqual(expect.arrayContaining(["海边剧", WORKSPACE_ASSET_LINKED_PROJECT]));
            expect(workspaceAssetProjectOptions(page.projectCounts)).not.toContain(WORKSPACE_ASSET_UNLINKED_PROJECT);
            expect(workspaceAssetProjectOptions(page.projectCounts)).toHaveLength(2);
            expect(workspaceAssetAllProjectsCount(page.projectCounts)).toBe(7);
        } finally {
            restore();
        }
    });

    test("page 1 and page 2 keep the same overlay totals when a later-page row is deleted", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const catalog = favoriteCatalog(80);
        const deleted = "fav-010";
        recordAssetStoreDraft(deleted, "delete");
        try {
            const load = (page: number) => withAdapter(libraryAdapter({
                onPage: () => pagedFavorites(page, 40, catalog),
                canonical: { [deleted]: catalog.find((asset) => asset.id === deleted)! },
            }), async () => loadWorkspaceAssetLibraryPage({ page, pageSize: 40, favorite: true, status: "active" }));
            const page1 = await load(1);
            const page2 = await load(2);
            expect(page1.total).toBe(79);
            expect(page2.total).toBe(79);
            expect(page1.favoriteTotal).toBe(79);
            expect(page2.favoriteTotal).toBe(79);
            expect(page1.assets.some((asset) => asset.id === deleted)).toBe(false);
            expect(page2.assets.some((asset) => asset.id === deleted)).toBe(false);
            expect(page1.assets).toHaveLength(40);
            expect(page2.assets).toHaveLength(39);
        } finally {
            restore();
        }
    });

    test("delete outside the current page still drops the canonical total", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        recordAssetStoreDraft("sqlite-2", "delete");
        const batchIds: string[][] = [];
        try {
            const page = await withAdapter(libraryAdapter({
                onPage: () => pageResponse([sampleClientAsset("sqlite-1")], { total: 2, hasMore: true }),
                canonical: (ids) => {
                    batchIds.push(ids);
                    return ids.filter((id) => id === "sqlite-2").map((id) => sampleClientAsset(id));
                },
            }), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, status: "active" }));
            expect(page.assets.map((asset) => asset.id)).toEqual(["sqlite-1"]);
            expect(page.total).toBe(1);
            expect(batchIds).toEqual([["sqlite-2"]]);
        } finally {
            restore();
        }
    });

    test("committed draft moving into a favorite filter extras on page 1 and raises totals", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        useAssetStore.setState({ assets: [sampleAsset("live")] });
        useAssetStore.getState().updateAsset("live", { metadata: { ...(sampleAsset("live").metadata || {}), favorite: true } });
        try {
            const page = await withAdapter(libraryAdapter({
                onPage: () => pageResponse([], { total: 0, favoriteTotal: 0 }),
                canonical: { live: sampleClientAsset("live") },
            }), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, favorite: true, status: "active" }));
            expect(page.assets.map((asset) => asset.id)).toEqual(["live"]);
            expect(page.total).toBe(1);
            expect(page.favoriteTotal).toBe(1);
        } finally {
            restore();
        }
    });

    test("committed draft moving out of a favorite filter hides the row and drops totals", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        useAssetStore.setState({ assets: [{ ...sampleAsset("live"), metadata: { favorite: true } }] });
        useAssetStore.getState().updateAsset("live", { metadata: { favorite: false } });
        const canonical = sampleClientAsset("live", "SQLite 素材", { metadata: { favorite: true } });
        try {
            const page = await withAdapter(libraryAdapter({
                onPage: () => pageResponse([canonical], { total: 1, favoriteTotal: 1 }),
                canonical: { live: canonical },
            }), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, favorite: true, status: "active" }));
            expect(page.assets).toEqual([]);
            expect(page.total).toBe(0);
            expect(page.favoriteTotal).toBe(0);
        } finally {
            restore();
        }
    });

    test("committed draft changing project label updates sidebar counts with before/after semantics", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        useAssetStore.setState({ assets: [sampleAsset("live")] });
        useAssetStore.getState().updateAsset("live", { metadata: { ...(sampleAsset("live").metadata || {}), projectName: "海边剧" } });
        try {
            const page = await withAdapter(libraryAdapter({
                onPage: () => pageResponse([sampleClientAsset("live")], {
                    total: 1,
                    projectCounts: { [WORKSPACE_ASSET_UNLINKED_PROJECT]: 1 },
                }),
                canonical: { live: sampleClientAsset("live") },
            }), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, status: "active" }));
            expect(page.total).toBe(1);
            expect(page.projectCounts[WORKSPACE_ASSET_UNLINKED_PROJECT] ?? 0).toBe(0);
            expect(page.projectCounts["海边剧"]).toBe(1);
            expect(page.assets[0]?.title).toBe("缓存素材");
        } finally {
            restore();
        }
    });

    test("local-only matching draft extras on page 1 and raises totals without a canonical row", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        useAssetStore.setState({
            assets: [{ ...sampleAsset("draft-1", "未提交"), status: "draft", metadata: { favorite: true, projectName: "海边剧" } }],
        });
        recordAssetStoreDraft("draft-1", "upsert");
        try {
            const page = await withAdapter(libraryAdapter({
                onPage: () => pageResponse([sampleClientAsset("sqlite-1")], {
                    total: 1,
                    favoriteTotal: 0,
                    projectCounts: { [WORKSPACE_ASSET_UNLINKED_PROJECT]: 1 },
                }),
                canonical: {},
            }), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, status: "active" }));
            expect(page.assets.map((asset) => asset.id)).toEqual(["draft-1", "sqlite-1"]);
            expect(page.total).toBe(2);
            expect(page.favoriteTotal).toBe(1);
            expect(page.projectCounts["海边剧"]).toBe(1);
            expect(page.hasMore).toBe(false);
        } finally {
            restore();
        }
    });

    test("generated filters page through backend counts instead of the first 120 rows", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const catalog = Array.from({ length: 125 }, (_, index) => {
            const n = 125 - index;
            const id = `gen-${String(n).padStart(3, "0")}`;
            return sampleClientAsset(id, `生成${n}`, { source: "生成任务" });
        });
        const requests: Array<Record<string, unknown>> = [];
        try {
            const load = (page: number) => withAdapter(libraryAdapter({
                onPage: (config) => {
                    const params = requestParams(config);
                    requests.push(params);
                    expect(params.generated).toBe(1);
                    const start = (page - 1) * 40;
                    return pageResponse(catalog.slice(start, start + 40), {
                        page,
                        pageSize: 40,
                        total: catalog.length,
                        hasMore: start + 40 < catalog.length,
                        generatedTotal: catalog.length,
                        generatedKindCounts: { image: catalog.length },
                    });
                },
            }), async () => loadWorkspaceAssetLibraryPage({ page, pageSize: 40, generated: true, status: "active" }));
            const page1 = await load(1);
            const page2 = await load(2);
            const page4 = await load(4);
            expect(page1.assets.map((asset) => asset.id)).toContain("gen-125");
            expect(page1.total).toBe(125);
            expect(page1.generatedTotal).toBe(125);
            expect(page1.canonicalTotal).toBe(125);
            expect(page1.hasMore).toBe(true);
            expect(page2.assets.some((asset) => page1.assets.some((item) => item.id === asset.id))).toBe(false);
            expect(page4.assets.map((asset) => asset.id)).toContain("gen-001");
            expect(page4.assets).toHaveLength(5);
            expect(requests.every((params) => params.generated === 1 && params.pageSize === 40)).toBe(true);
        } finally {
            restore();
        }
    });

    test("empty cache still returns SQLite kind category and folder facets", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        expect(useAssetStore.getState().assets).toEqual([]);
        const kindCounts = { image: 5, text: 2 };
        const categoryCounts = { material: 5, other: 2 };
        const folderCounts = { "": 3, "folder-1": 4 };
        try {
            const page = await withAdapter(libraryAdapter({
                onPage: () => pageResponse([], { total: 7, kindCounts, categoryCounts, folderCounts }),
            }), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, status: "active" }));
            expect(page.assets).toEqual([]);
            expect(page.kindCounts).toEqual(kindCounts);
            expect(page.categoryCounts).toEqual(categoryCounts);
            expect(page.folderCounts).toEqual(folderCounts);
            expect(workspaceAssetCountSum(page.folderCounts)).toBe(7);
        } finally {
            restore();
        }
    });

    test("draft move and delete on another page update kind category and folder facets", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        useAssetStore.setState({
            assets: [{ ...sampleAsset("moved"), folderId: "folder-1", category: "other" }],
        });
        useAssetStore.getState().updateAsset("moved", { folderId: "folder-1", category: "other" });
        recordAssetStoreDraft("gone", "delete");
        const canonicalMoved = sampleClientAsset("moved", "SQLite 素材", { folderId: undefined, category: "material" });
        const canonicalGone = sampleClientAsset("gone", "稍后删除");
        try {
            const page = await withAdapter(libraryAdapter({
                onPage: () => pageResponse([sampleClientAsset("sqlite-1")], {
                    total: 10,
                    hasMore: true,
                    kindCounts: { image: 10 },
                    categoryCounts: { material: 10 },
                    folderCounts: { "": 10 },
                }),
                canonical: { moved: canonicalMoved, gone: canonicalGone },
            }), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, status: "active" }));
            expect(page.assets.map((asset) => asset.id)).toEqual(["sqlite-1"]);
            expect(page.total).toBe(9);
            expect(page.canonicalTotal).toBe(10);
            expect(page.kindCounts.image).toBe(9);
            expect(page.categoryCounts.material).toBe(8);
            expect(page.categoryCounts.other).toBe(1);
            expect(page.folderCounts[""]).toBe(8);
            expect(page.folderCounts["folder-1"]).toBe(1);
            expect(workspaceAssetCountSum(page.folderCounts)).toBe(9);
            expect(Object.prototype.hasOwnProperty.call(page.folderCounts, "")).toBe(true);
        } finally {
            restore();
        }
    });

    test("page 1 extras do not create a phantom traversal page", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        useAssetStore.setState({ assets: [{ ...sampleAsset("draft-1", "未提交"), status: "draft" }] });
        recordAssetStoreDraft("draft-1", "upsert");
        try {
            const page = await withAdapter(libraryAdapter({
                onPage: () => pageResponse([sampleClientAsset("sqlite-1"), sampleClientAsset("sqlite-2"), sampleClientAsset("sqlite-3")], { total: 3, hasMore: false }),
                canonical: {},
            }), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, status: "active" }));
            expect(page.assets.map((asset) => asset.id)).toEqual(["draft-1", "sqlite-1", "sqlite-2", "sqlite-3"]);
            expect(page.total).toBe(4);
            expect(page.canonicalTotal).toBe(3);
            expect(page.canonicalHasMore).toBe(false);
            expect(workspaceAssetTraversalTotal(page)).toBe(3);
        } finally {
            restore();
        }
    });

    test("overlay deletes on first pages still leave later canonical pages reachable", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const catalog = favoriteCatalog(120);
        for (const asset of catalog.slice(0, 80)) recordAssetStoreDraft(asset.id, "delete");
        const canonical = Object.fromEntries(catalog.slice(0, 80).map((asset) => [asset.id, asset]));
        try {
            const load = (page: number) => withAdapter(libraryAdapter({
                onPage: () => pageResponse(catalog.slice((page - 1) * 40, page * 40), {
                    page,
                    pageSize: 40,
                    total: 120,
                    hasMore: page * 40 < 120,
                    kindCounts: { image: 120 },
                    folderCounts: { "": 120 },
                }),
                canonical,
            }), async () => loadWorkspaceAssetLibraryPage({ page, pageSize: 40, status: "active" }));
            const page1 = await load(1);
            const page3 = await load(3);
            expect(page1.total).toBe(40);
            expect(page1.canonicalTotal).toBe(120);
            expect(page1.canonicalHasMore).toBe(true);
            expect(workspaceAssetTraversalTotal(page1)).toBe(120);
            expect(page1.assets).toHaveLength(0);
            expect(page3.assets).toHaveLength(40);
            expect(page3.assets.map((asset) => asset.id)).toContain("fav-001");
            expect(page3.total).toBe(40);
            expect(page3.canonicalTotal).toBe(120);
            expect(workspaceAssetTraversalTotal(page3)).toBe(120);
            expect(page1.kindCounts.image).toBe(40);
            expect(page1.folderCounts[""]).toBe(40);
        } finally {
            restore();
        }
    });

    test("generated history overlay uses active generated before/after deltas", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        useAssetStore.setState({
            assets: [{ ...sampleAsset("live"), source: "生成任务" }],
        });
        useAssetStore.getState().updateAsset("live", { source: "生成任务" });
        try {
            const page = await withAdapter(libraryAdapter({
                onPage: () => pageResponse([sampleClientAsset("live")], {
                    total: 1,
                    generatedTotal: 0,
                    generatedKindCounts: {},
                }),
                canonical: { live: sampleClientAsset("live") },
            }), async () => loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 40, status: "active" }));
            expect(page.generatedTotal).toBe(1);
            expect(page.generatedKindCounts.image).toBe(1);
            expect(isWorkspaceGeneratedHistoryAsset(page.assets[0]!)).toBe(true);
        } finally {
            restore();
        }
    });
});
