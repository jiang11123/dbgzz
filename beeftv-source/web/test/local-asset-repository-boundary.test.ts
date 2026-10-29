import { afterEach, describe, expect, spyOn, test } from "bun:test";
import axios from "axios";

import * as runtimeMode from "@/lib/runtime-mode";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import { captureUserScope } from "@/lib/user-scope-guard";
import { apiClient } from "@/services/api/request";
import * as localWorkspaceSync from "@/services/local-workspace-sync";
import { persistWorkspaceAssetChanges, persistWorkspaceAssetLink, deleteWorkspaceAsset, resetWorkspaceAssetCommitStateForTests } from "@/services/workspace-asset-repository";
import { resetAssetStoreDraftsForTests, useAssetStore, type Asset } from "@/stores/use-asset-store";

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

function sampleAsset(id = "asset-1"): Asset {
    return {
        id,
        kind: "image",
        title: "画布图片",
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

function envelope(data: unknown, status = 200) {
    return { data: { code: 0, msg: "", data }, status, statusText: "OK", headers: {}, config: {} as never };
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

function hostedSession() {
    spies.push(spyOn(runtimeMode, "isNativeDesktopRuntime").mockReturnValue(false));
    spies.push(spyOn(runtimeMode, "isLocalRuntimeMode").mockReturnValue(false));
}

afterEach(async () => {
    while (spies.length) spies.pop()?.mockRestore();
    useAssetStore.setState({ assets: [] });
    resetWorkspaceAssetCommitStateForTests();
    await resetAssetStoreDraftsForTests();
});

describe("workspace asset repository runtime boundary", () => {
    test("archived deletion passes its status guard to the backend before removing the projection", async () => {
        const restore = switchScope("delete-archived");
        desktopBackend();
        const asset = { ...sampleAsset(), kind: "text" as const, data: { content: "archived text" }, status: "archived" as const };
        useAssetStore.setState({ assets: [asset] });
        let deletes = 0;
        try {
            await withAdapter(async (config) => {
                if (config.method === "delete" && config.url === "/assets/asset-1") {
                    expect(config.params).toEqual({ expectedStatus: "archived" });
                    expect(useAssetStore.getState().assets).toHaveLength(1);
                    deletes++;
                    return envelope({ id: asset.id });
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, () => deleteWorkspaceAsset(asset.id, captureUserScope(), { expectedStatus: "archived" }));
            expect(deletes).toBe(1);
            expect(useAssetStore.getState().assets).toEqual([]);
        } finally { restore(); }
    });

    test("browser-local archived deletion refuses an asset that has become active", async () => {
        const restore = switchScope("delete-status-conflict");
        browserLocal();
        const asset = sampleAsset();
        useAssetStore.setState({ assets: [asset] });
        let writes = 0;
        try {
            await withAdapter(async (config) => {
                writes++;
                throw new Error("unexpected write");
            }, async () => {
                await expect(deleteWorkspaceAsset(asset.id, captureUserScope(), { expectedStatus: "archived" })).rejects.toMatchObject({ status: 409 });
            });
            expect(writes).toBe(0);
            expect(useAssetStore.getState().assets).toEqual([asset]);
        } finally { restore(); }
    });

    test("failed archived deletion keeps its projection until a successful retry", async () => {
        const restore = switchScope("delete-retry");
        desktopBackend();
        const asset = { ...sampleAsset(), kind: "text" as const, data: { content: "archived text" }, status: "archived" as const };
        useAssetStore.setState({ assets: [asset] });
        let attempts = 0;
        try {
            await withAdapter(async (config) => {
                if (config.method === "delete") {
                    attempts++;
                    if (attempts === 1) throw new Error("offline");
                    return envelope({ id: asset.id });
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                const scope = captureUserScope();
                await expect(deleteWorkspaceAsset(asset.id, scope, { expectedStatus: "archived" })).rejects.toThrow("offline");
                expect(useAssetStore.getState().assets.find((item) => item.id === asset.id)?.status).toBe("archived");
                await deleteWorkspaceAsset(asset.id, scope, { expectedStatus: "archived" });
            });
            expect(attempts).toBe(2);
            expect(useAssetStore.getState().assets).toEqual([]);
        } finally { restore(); }
    });

    test("browser-local linking writes projectIds locally and does not call project APIs", async () => {
        const restore = switchScope("owner-a");
        browserLocal();
        const remote = spyOn(localWorkspaceSync, "saveRemoteUserDataNow");
        const urls: string[] = [];
        useAssetStore.setState({ assets: [sampleAsset()] });
        try {
            await withAdapter(async (config) => {
                urls.push(`${config.method || "get"} ${String(config.url || "")}`);
                return envelope({});
            }, async () => {
                await persistWorkspaceAssetLink({ asset: sampleAsset(), domainProjectId: "project-1" });
            });
            expect(urls).toEqual([]);
            expect(remote).not.toHaveBeenCalled();
            const stored = useAssetStore.getState().assets.find((item) => item.id === "asset-1");
            expect(stored?.metadata?.projectIds).toEqual(["project-1"]);
        } finally {
            remote.mockRestore();
            restore();
        }
    });

    test("desktop local workspace commits asset upsert and project link through typed APIs", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const remote = spyOn(localWorkspaceSync, "saveRemoteUserDataNow");
        const urls: string[] = [];
        const asset = sampleAsset();
        useAssetStore.setState({ assets: [asset] });
        try {
            await withAdapter(async (config) => {
                urls.push(`${String(config.method || "get").toLowerCase()} ${String(config.url || "")}`);
                if (String(config.url || "").includes("/assets/asset-1") && String(config.method).toLowerCase() === "put") {
                    return envelope({ asset: { id: "asset-1", title: "画布图片", category: "material", status: "confirmed", createdAt: asset.createdAt, updatedAt: asset.updatedAt } });
                }
                if (String(config.url || "").includes("/projects/project-1/assets") && String(config.method).toLowerCase() === "post") {
                    return envelope({ asset: { id: "asset-1", title: "画布图片", category: "material", status: "confirmed", versionCount: 1, usages: [], position: 0, updatedAt: asset.updatedAt, mediaType: "image" } });
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                await persistWorkspaceAssetLink({ asset, domainProjectId: "project-1", category: "material", source: "canvas" });
            });
            expect(urls).toEqual(["put /assets/asset-1", "post /projects/project-1/assets"]);
            expect(remote).not.toHaveBeenCalled();
            expect(useAssetStore.getState().assets.find((item) => item.id === "asset-1")?.metadata?.projectIds).toEqual(["project-1"]);
        } finally {
            remote.mockRestore();
            restore();
        }
    });

    test("hosted writes use typed asset APIs instead of a bulk user-data snapshot", async () => {
        const restore = switchScope("owner-a");
        hostedSession();
        const remote = spyOn(localWorkspaceSync, "saveRemoteUserDataNow");
        const urls: string[] = [];
        const asset = sampleAsset();
        useAssetStore.setState({ assets: [asset] });
        try {
            await withAdapter(async (config) => {
                urls.push(`${String(config.method || "get").toLowerCase()} ${String(config.url || "")}`);
                return envelope({ asset: { id: "asset-1", title: "画布图片", category: "material", status: "confirmed", createdAt: asset.createdAt, updatedAt: asset.updatedAt } });
            }, async () => {
                await persistWorkspaceAssetLink({ asset });
            });
            expect(urls).toEqual(["put /assets/asset-1"]);
            expect(remote).not.toHaveBeenCalled();
        } finally {
            remote.mockRestore();
            restore();
        }
    });

    test("desktop delete commits DELETE then removes the local projection", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const urls: string[] = [];
        const asset: Asset = {
            id: "asset-1",
            kind: "text",
            title: "文本",
            coverUrl: "",
            tags: [],
            category: "other",
            status: "confirmed",
            source: "手动添加",
            data: { content: "hello" },
            createdAt: "2026-10-02T00:00:00.000Z",
            updatedAt: "2026-10-02T00:00:00.000Z",
        };
        useAssetStore.setState({ assets: [asset] });
        try {
            await withAdapter(async (config) => {
                urls.push(`${String(config.method || "get").toLowerCase()} ${String(config.url || "")}`);
                expect((config.params || {}) as Record<string, unknown>).not.toHaveProperty("expectedStatus");
                return envelope({ id: "asset-1" });
            }, async () => {
                await deleteWorkspaceAsset("asset-1");
            });
            expect(urls).toEqual(["delete /assets/asset-1"]);
            expect(useAssetStore.getState().assets.map((item) => item.id)).toEqual([]);
        } finally {
            restore();
        }
    });

    test("403 on desktop delete keeps the local record", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const asset: Asset = {
            id: "asset-1",
            kind: "text",
            title: "文本",
            coverUrl: "",
            tags: [],
            category: "other",
            status: "confirmed",
            source: "手动添加",
            data: { content: "hello" },
            createdAt: "2026-10-02T00:00:00.000Z",
            updatedAt: "2026-10-02T00:00:00.000Z",
        };
        useAssetStore.setState({ assets: [asset] });
        try {
            await withAdapter(async (config) => {
                throw new axios.AxiosError("没有权限", "ERR_BAD_REQUEST", config, undefined, {
                    data: { code: 403, data: null, msg: "没有权限" },
                    status: 403,
                    statusText: "Error",
                    headers: {},
                    config,
                });
            }, async () => {
                await expect(deleteWorkspaceAsset("asset-1")).rejects.toMatchObject({ status: 403 });
                expect(useAssetStore.getState().assets.map((item) => item.id)).toEqual(["asset-1"]);
            });
        } finally {
            restore();
        }
    });

    test("desktop persistWorkspaceAssetChanges puts dirty drafts and does not snapshot the whole library", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const remote = spyOn(localWorkspaceSync, "saveRemoteUserDataNow");
        const urls: string[] = [];
        try {
            const id = useAssetStore.getState().addAsset({
                kind: "text",
                title: "草稿",
                coverUrl: "",
                tags: [],
                category: "other",
                status: "confirmed",
                source: "手动添加",
                data: { content: "hello" },
            });
            await withAdapter(async (config) => {
                urls.push(`${String(config.method || "get").toLowerCase()} ${String(config.url || "")}`);
                return envelope({ asset: { id, title: "草稿", createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" } });
            }, async () => {
                await persistWorkspaceAssetChanges(captureUserScope());
            });
            expect(urls).toEqual([`put /assets/${id}`]);
            expect(remote).not.toHaveBeenCalled();
        } finally {
            remote.mockRestore();
            restore();
        }
    });

    test("deferred desktop PUT that is abandoned after an account change never starts the project link", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const entered = deferred();
        const gate = deferred();
        const urls: string[] = [];
        const asset = sampleAsset();
        useAssetStore.setState({ assets: [asset] });
        try {
            await withAdapter(async (config) => {
                urls.push(`${String(config.method || "get").toLowerCase()} ${String(config.url || "")}`);
                entered.resolve();
                await gate.promise;
                return envelope({ asset: { id: "asset-1", title: "画布图片", createdAt: asset.createdAt, updatedAt: asset.updatedAt } });
            }, async () => {
                const pending = persistWorkspaceAssetLink({ asset, domainProjectId: "project-1", expectedScope: captureUserScope() });
                await entered.promise;
                setActiveUserScope("owner-b");
                gate.resolve();
                await expect(pending).rejects.toMatchObject({ name: "UserScopeAbandonedError" });
                expect(urls).toEqual(["put /assets/asset-1"]);
            });
        } finally {
            restore();
        }
    });
});

test("desktop deletes all selected media without browser cleanup blocking the next item", async () => {
    const restore = switchScope("batch-media-delete");
    desktopBackend();
    const assets = [sampleAsset("batch-1"), sampleAsset("batch-2"), sampleAsset("batch-3")];
    useAssetStore.setState({ assets });
    const cleanup = spyOn(useAssetStore.getState(), "cleanupImages").mockRejectedValue(new Error("IndexedDB unavailable"));
    const deleted: string[] = [];
    try {
        await withAdapter(async config => {
            if (config.method !== "delete") throw new Error("Unexpected request");
            deleted.push(String(config.url));
            return envelope({});
        }, async () => {
            const scope = captureUserScope();
            for (const asset of assets) await deleteWorkspaceAsset(asset.id, scope);
        });
        expect(deleted).toEqual(["/assets/batch-1", "/assets/batch-2", "/assets/batch-3"]);
        expect(useAssetStore.getState().assets).toEqual([]);
        expect(cleanup).not.toHaveBeenCalled();
    } finally { cleanup.mockRestore(); restore(); }
});
