import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import localforage from "localforage";

import * as runtimeMode from "@/lib/runtime-mode";
import { isDirectorCanonicalPersistSource, persistDirectorImageUpload, persistDirectorLibraryAsset } from "@/lib/canvas/director/director-library-persist";
import { getActiveUserScope, getActiveUserScopeEpoch, setActiveUserScope } from "@/lib/user-scope";
import { captureUserScope, UserScopeAbandonedError } from "@/lib/user-scope-guard";
import { apiClient } from "@/services/api/request";
import * as imageStorage from "@/services/image-storage";
import * as localWorkspaceSync from "@/services/local-workspace-sync";
import { persistWorkspaceAssetChanges, resetWorkspaceAssetCommitStateForTests } from "@/services/workspace-asset-repository";
import { hydrateAssetStoreDrafts, peekAssetStoreDraft, resetAssetStoreDraftsForTests, unloadAssetStoreDraftsForTests, useAssetStore, type ImageAsset, type NewAsset } from "@/stores/use-asset-store";

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

function panoramaAsset(title = "全景图", storageKey = "resource:res-1"): NewAsset {
    return {
        kind: "image",
        title,
        coverUrl: "/api/resources/res-1/file",
        tags: ["全景图"],
        source: "导演台",
        data: { dataUrl: "/api/resources/res-1/file", storageKey, width: 8, height: 8, bytes: 4, mimeType: "image/png" },
        metadata: { source: "director-panorama" },
    };
}

function cacheOnlyAsset(id = "cache-only"): ImageAsset {
    return {
        id,
        kind: "image",
        title: "参考图",
        coverUrl: "/api/resources/res-1/file",
        tags: ["全景图"],
        source: "导演台",
        createdAt: "2026-10-02T00:00:00.000Z",
        updatedAt: "2026-10-02T00:00:00.000Z",
        data: { dataUrl: "/api/resources/res-1/file", storageKey: "resource:res-1", width: 8, height: 8, bytes: 4, mimeType: "image/png" },
        metadata: { source: "director-panorama" },
    };
}

function envelope(data: unknown) {
    return { data: { code: 0, msg: "", data }, status: 200, statusText: "OK", headers: {}, config: {} as never };
}

function requestKey(config: { method?: string; url?: string }) {
    return `${String(config.method || "get").toLowerCase()} ${String(config.url || "")}`;
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

const spies: Array<{ mockRestore: () => void }> = [];

function desktopBackend() {
    spies.push(spyOn(runtimeMode, "isNativeDesktopRuntime").mockReturnValue(true));
    spies.push(spyOn(runtimeMode, "isLocalRuntimeMode").mockReturnValue(true));
}

function browserLocal() {
    spies.push(spyOn(runtimeMode, "isNativeDesktopRuntime").mockReturnValue(false));
    spies.push(spyOn(runtimeMode, "isLocalRuntimeMode").mockReturnValue(true));
}

afterEach(async () => {
    while (spies.length) spies.pop()?.mockRestore();
    useAssetStore.setState({ assets: [] });
    resetWorkspaceAssetCommitStateForTests();
    await resetAssetStoreDraftsForTests();
});

describe("director library persist canonical writes", () => {
    test("desktop persist puts the owned asset and does not snapshot the whole library", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const remote = spyOn(localWorkspaceSync, "saveRemoteUserDataNow");
        const urls: string[] = [];
        try {
            await withAdapter(async (config) => {
                urls.push(requestKey(config));
                const id = String(config.url || "").split("/").pop();
                return envelope({ asset: { id, title: "全景图", category: "other", status: "confirmed", createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" } });
            }, async () => {
                const result = await persistDirectorLibraryAsset({ asset: panoramaAsset(), expectedScope: captureUserScope() });
                expect(result.created).toBe(true);
                expect(result.confirmed).toBe(true);
                expect(urls).toEqual([`put /assets/${result.assetId}`]);
                expect(remote).not.toHaveBeenCalled();
                expect(peekAssetStoreDraft(getActiveUserScope(), result.assetId)).toBeUndefined();
            });
        } finally {
            remote.mockRestore();
            restore();
        }
    });

    test("persist failure keeps the explicit draft and does not claim a save", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        try {
            await withAdapter(async () => {
                throw new Error("disk full");
            }, async () => {
                await expect(persistDirectorLibraryAsset({ asset: panoramaAsset(), expectedScope: captureUserScope() })).rejects.toThrow("disk full");
                expect(useAssetStore.getState().assets).toHaveLength(1);
                const id = useAssetStore.getState().assets[0].id;
                expect(peekAssetStoreDraft(getActiveUserScope(), id)?.kind).toBe("upsert");
            });
        } finally {
            restore();
        }
    });

    test("A→B→A before persist dispatch does not create a draft", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const expected = captureUserScope();
        const urls: string[] = [];
        try {
            setActiveUserScope("owner-b");
            setActiveUserScope("owner-a");
            await withAdapter(async (config) => {
                urls.push(requestKey(config));
                return envelope({ asset: { id: "unexpected" } });
            }, async () => {
                await expect(persistDirectorLibraryAsset({ asset: panoramaAsset(), expectedScope: expected })).rejects.toBeInstanceOf(UserScopeAbandonedError);
                expect(urls).toEqual([]);
                expect(useAssetStore.getState().assets).toEqual([]);
            });
        } finally {
            restore();
        }
    });

    test("A→B→A during upload does not dispatch persist", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const expected = captureUserScope();
        const entered = deferred();
        const gate = deferred();
        const urls: string[] = [];
        const upload = spyOn(imageStorage, "uploadImage").mockImplementation(async (_source, _progress, scope) => {
            expect(scope).toEqual(expected);
            entered.resolve();
            await gate.promise;
            return { storageKey: "image:panorama", url: "blob:panorama", width: 8, height: 8, bytes: 1, mimeType: "image/png" };
        });
        try {
            await withAdapter(async (config) => {
                urls.push(requestKey(config));
                return envelope({ asset: { id: "unexpected" } });
            }, async () => {
                const pending = persistDirectorImageUpload({
                    source: new Blob(["img"], { type: "image/png" }),
                    expectedScope: expected,
                    toAsset: (uploaded) => ({ ...panoramaAsset(), data: { dataUrl: uploaded.url, storageKey: uploaded.storageKey, width: uploaded.width, height: uploaded.height, bytes: uploaded.bytes, mimeType: uploaded.mimeType } }),
                });
                await entered.promise;
                setActiveUserScope("owner-b");
                setActiveUserScope("owner-a");
                gate.resolve();
                await expect(pending).rejects.toBeInstanceOf(UserScopeAbandonedError);
                expect(urls).toEqual([]);
                expect(useAssetStore.getState().assets).toEqual([]);
            });
        } finally {
            upload.mockRestore();
            restore();
        }
    });

    test("cache-only existingAssetId still persists the same library row", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const urls: string[] = [];
        useAssetStore.setState({ assets: [cacheOnlyAsset()] });
        expect(peekAssetStoreDraft(getActiveUserScope(), "cache-only")).toBeUndefined();
        try {
            await withAdapter(async (config) => {
                urls.push(requestKey(config));
                const id = String(config.url || "").split("/").pop();
                return envelope({ asset: { id, title: "参考图", createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" } });
            }, async () => {
                const result = await persistDirectorLibraryAsset({
                    asset: panoramaAsset("参考图"),
                    expectedScope: captureUserScope(),
                    existingAssetId: "cache-only",
                });
                expect(result.assetId).toBe("cache-only");
                expect(result.created).toBe(false);
                expect(result.confirmed).toBe(true);
                expect(useAssetStore.getState().assets).toHaveLength(1);
                expect(urls).toEqual(["put /assets/cache-only"]);
            });
        } finally {
            restore();
        }
    });

    test("successful ensure receipt skips a second persist of the same asset", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const urls: string[] = [];
        try {
            await withAdapter(async (config) => {
                urls.push(requestKey(config));
                const id = String(config.url || "").split("/").pop();
                return envelope({ asset: { id, title: "参考图", createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" } });
            }, async () => {
                const first = await persistDirectorLibraryAsset({ asset: panoramaAsset("参考图"), expectedScope: captureUserScope() });
                const second = await persistDirectorLibraryAsset({
                    asset: panoramaAsset("参考图副本"),
                    expectedScope: captureUserScope(),
                    existingAssetId: first.assetId,
                    existingPersisted: true,
                });
                expect(second.assetId).toBe(first.assetId);
                expect(second.created).toBe(false);
                expect(second.confirmed).toBe(true);
                expect(useAssetStore.getState().assets).toHaveLength(1);
                expect(urls).toEqual([`put /assets/${first.assetId}`]);
            });
        } finally {
            restore();
        }
    });

    test("desktop IndexedDB fallback keeps a draft and does not claim a save", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const urls: string[] = [];
        const upload = spyOn(imageStorage, "uploadImage").mockResolvedValue({
            storageKey: "image:owner-a:draft",
            url: "blob:panorama",
            width: 8,
            height: 8,
            bytes: 1,
            mimeType: "image/png",
            pendingRemoteUpload: true,
            remoteUploadError: "资源服务暂时不可用",
        });
        try {
            await withAdapter(async (config) => {
                urls.push(requestKey(config));
                return envelope({ asset: { id: "unexpected" } });
            }, async () => {
                const { persist } = await persistDirectorImageUpload({
                    source: new Blob(["img"], { type: "image/png" }),
                    expectedScope: captureUserScope(),
                    toAsset: (uploaded) => panoramaAsset("全景图", uploaded.storageKey),
                });
                expect(persist.created).toBe(true);
                expect(persist.confirmed).toBe(false);
                expect(urls).toEqual([]);
                expect(useAssetStore.getState().assets).toHaveLength(1);
                expect(peekAssetStoreDraft(getActiveUserScope(), persist.assetId)?.kind).toBe("upsert");
            });
        } finally {
            upload.mockRestore();
            restore();
        }
    });

    test("desktop IDB-only model keeps a draft across restart and does not PUT", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const urls: string[] = [];
        const originalWindow = globalThis.window;
        globalThis.window = originalWindow ?? ({ localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } } as never);
        const memory = new Map<string, string>();
        const getItem = spyOn(localforage, "getItem").mockImplementation(async (key) => memory.get(String(key)) ?? null);
        const setItem = spyOn(localforage, "setItem").mockImplementation(async (key, value) => {
            memory.set(String(key), String(value));
            return value;
        });
        const removeItem = spyOn(localforage, "removeItem").mockImplementation(async (key) => {
            memory.delete(String(key));
        });
        try {
            await withAdapter(async (config) => {
                urls.push(requestKey(config));
                return envelope({ asset: { id: "unexpected" } });
            }, async () => {
                const result = await persistDirectorLibraryAsset({
                    asset: {
                        kind: "model",
                        title: "角色",
                        coverUrl: "",
                        tags: ["3D模型"],
                        source: "导演台",
                        data: { url: "blob:model", storageKey: "file:owner-a:model", bytes: 4, mimeType: "model/gltf-binary", fileName: "hero.glb" },
                        metadata: { source: "director" },
                    },
                    expectedScope: captureUserScope(),
                    pendingRemoteUpload: true,
                });
                expect(result.created).toBe(true);
                expect(result.confirmed).toBe(false);
                expect(urls).toEqual([]);
                expect(peekAssetStoreDraft(getActiveUserScope(), result.assetId)?.kind).toBe("upsert");
                await expect(persistWorkspaceAssetChanges(captureUserScope())).rejects.toThrow("素材文件尚未保存到工作区");
                expect(urls).toEqual([]);
                unloadAssetStoreDraftsForTests();
                useAssetStore.setState({ assets: [] });
                await hydrateAssetStoreDrafts("owner-a");
                expect(peekAssetStoreDraft("owner-a", result.assetId)?.kind).toBe("upsert");
                expect(useAssetStore.getState().assets.map((item) => item.id)).toEqual([result.assetId]);
            });
        } finally {
            getItem.mockRestore();
            setItem.mockRestore();
            removeItem.mockRestore();
            if (!originalWindow) delete (globalThis as { window?: unknown }).window;
            restore();
        }
    });

    test("capturing and restoring scope does not reset the identity clock", () => {
        const start = getActiveUserScopeEpoch();
        const restore = switchScope("owner-a");
        const mid = getActiveUserScopeEpoch();
        restore();
        expect(mid).toBeGreaterThan(start);
        expect(getActiveUserScopeEpoch()).toBeGreaterThan(mid);
        const source = readFileSync(resolve(import.meta.dir, "../src/lib/user-scope.ts"), "utf8");
        expect(source).not.toContain("resetActiveUserScopeForTests");
    });

    test("desktop image keys are not canonical persist sources", () => {
        desktopBackend();
        expect(isDirectorCanonicalPersistSource({ storageKey: "image:owner-a:draft", pendingRemoteUpload: true })).toBe(false);
        expect(isDirectorCanonicalPersistSource({ storageKey: "image:owner-a:draft" })).toBe(false);
        expect(isDirectorCanonicalPersistSource({ storageKey: "resource:res-1" })).toBe(true);
    });

    test("browser-local image keys remain the product persist path", () => {
        browserLocal();
        expect(isDirectorCanonicalPersistSource({ storageKey: "image:owner-a:draft" })).toBe(true);
        expect(isDirectorCanonicalPersistSource({ storageKey: "image:owner-a:draft", pendingRemoteUpload: true })).toBe(false);
    });

    test("browser-local persist flushes the local store and does not PUT assets", async () => {
        const restore = switchScope("owner-a");
        browserLocal();
        const remote = spyOn(localWorkspaceSync, "saveRemoteUserDataNow");
        const urls: string[] = [];
        try {
            await withAdapter(async (config) => {
                urls.push(requestKey(config));
                return envelope({});
            }, async () => {
                const result = await persistDirectorLibraryAsset({ asset: panoramaAsset(), expectedScope: captureUserScope() });
                expect(result.created).toBe(true);
                expect(result.confirmed).toBe(true);
                expect(urls).toEqual([]);
                expect(remote).not.toHaveBeenCalled();
                expect(useAssetStore.getState().assets.map((item) => item.id)).toEqual([result.assetId]);
            });
        } finally {
            remote.mockRestore();
            restore();
        }
    });
});

describe("director workbench wiring", () => {
    test("workbench no longer bulk-saves user data and carries the captured session scope", () => {
        const workbench = readFileSync(resolve(import.meta.dir, "../src/components/canvas/director/canvas-director-workbench.tsx"), "utf8");
        expect(workbench).not.toContain("saveRemoteUserDataNow");
        expect(workbench).not.toContain("hasRemoteUserDataSyncSession");
        expect(workbench).toContain("persistDirectorImageUpload");
        expect(workbench).toContain("persistDirectorMediaUpload");
        expect(workbench).toContain("persistDirectorLibraryAsset");
        expect(workbench).toContain("session.expectedScope");
        expect(workbench).toContain("uploadImage(file, undefined, session.expectedScope)");
        expect(workbench).toContain("uploadImage(beauty, undefined, session.expectedScope)");
        expect(workbench).toContain("existingAssetId: canvasHandoff?.assetId");
        expect(workbench).toContain("existingPersisted: canvasHandoff?.persisted");
        expect(workbench).toContain("pendingRemoteUpload: uploaded.pendingRemoteUpload");
        expect(workbench).toContain("persist.confirmed");
        expect(workbench).toContain('message[persist.confirmed ? "success" : "warning"]');
        expect(workbench).toContain("applyResult?.confirmed === false");
        expect(workbench).toContain("构图已回写画布，文件目前只在这台设备上");
        expect(workbench).toContain("白膜视频已导出，文件目前只在这台设备上");
        expect(workbench).toContain("截图期间场景或镜头已切换，请重试");
        expect(workbench).toContain("void onCaptureCover({ scene: current, shotId: shot.id, beauty })");
    });

    test("canvas reference handoff carries captured scope and returns persist confirmation", () => {
        const project = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/project.tsx"), "utf8");
        const dialogs = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/canvas-project-editor-dialogs.tsx"), "utf8");
        const editor = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/use-canvas-node-editor.ts"), "utf8");
        expect(project).toContain("expectedScope: CapturedUserScope = canvasCapturedScope");
        expect(project).toContain("ensureCanvasNodeAsset({ canvasId: projectId, domainProjectId: currentProject?.projectId, node, source: \"canvas-upload\", expectedScope: expected })");
        expect(project).toContain("findWorkspaceAssetIdByStorageKey(image.storageKey)");
        expect(project).toContain("return { assetId: result.assetId, persisted: result.confirmed };");
        expect(project).not.toContain("return { assetId: result.assetId, persisted: true };");
        expect(dialogs).toContain("expectedScope: CapturedUserScope");
        expect(dialogs).toContain("Promise<{ assetId?: string; persisted?: boolean } | void>");
        expect(dialogs).toContain("Promise<void | { confirmed?: boolean }>");
        expect(editor).toContain("if (!result.confirmed) message.warning");
        expect(editor).toContain("文件目前只在这台设备上");
    });
});
