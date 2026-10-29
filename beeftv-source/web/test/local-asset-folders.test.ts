import { afterEach, describe, expect, spyOn, test } from "bun:test";
import localforage from "localforage";

import * as runtimeMode from "@/lib/runtime-mode";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import { apiClient } from "@/services/api/request";
import {
    assignWorkspaceAssetsFolder,
    createWorkspaceAssetFolder,
    deleteWorkspaceAssetFolder,
    listWorkspaceAssetFolders,
    renameWorkspaceAssetFolder,
    WORKSPACE_ASSET_FOLDERS_KEY,
} from "@/services/workspace-asset-folders";
import { resetAssetStoreDraftsForTests, useAssetStore, type Asset } from "@/stores/use-asset-store";

function switchScope(userId: string) {
    const previous = getActiveUserScope();
    setActiveUserScope(userId);
    return () => setActiveUserScope(previous);
}

function envelope(data: unknown, status = 200) {
    return { data: { code: 0, msg: "", data }, status, statusText: "OK", headers: {}, config: {} as never };
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

function textAsset(id: string, folderId?: string): Asset {
    return {
        id,
        kind: "text",
        title: "文本",
        coverUrl: "",
        tags: [],
        category: "other",
        status: "confirmed",
        source: "手动添加",
        folderId,
        data: { content: "hello" },
        createdAt: "2026-10-02T00:00:00.000Z",
        updatedAt: "2026-10-02T00:00:00.000Z",
    };
}

afterEach(async () => {
    while (spies.length) spies.pop()?.mockRestore();
    useAssetStore.setState({ assets: [] });
    await resetAssetStoreDraftsForTests();
});

describe("workspace asset folders", () => {
    test("browser-local folder CRUD stays in IndexedDB and does not call folder APIs", async () => {
        const restore = switchScope("owner-a");
        browserLocal();
        const urls: string[] = [];
        const originalWindow = globalThis.window;
        globalThis.window = originalWindow ?? ({ localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } } as never);
        const folders = new Map<string, string>();
        const getItem = spyOn(localforage, "getItem").mockImplementation(async (key) => folders.get(String(key)) ?? null);
        const setItem = spyOn(localforage, "setItem").mockImplementation(async (key, value) => {
            folders.set(String(key), String(value));
            return value;
        });
        try {
            await withAdapter(async (config) => {
                urls.push(requestKey(config));
                return envelope({});
            }, async () => {
                const created = await createWorkspaceAssetFolder("灵感");
                expect(created.name).toBe("灵感");
                const listed = await listWorkspaceAssetFolders();
                expect(listed.map((folder) => folder.name)).toEqual(["灵感"]);
                await renameWorkspaceAssetFolder(created.id, "分镜");
                expect((await listWorkspaceAssetFolders())[0]?.name).toBe("分镜");
                await deleteWorkspaceAssetFolder(created.id);
                expect(await listWorkspaceAssetFolders()).toEqual([]);
            });
            expect(urls).toEqual([]);
            expect([...folders.keys()].some((key) => key.includes(WORKSPACE_ASSET_FOLDERS_KEY))).toBe(true);
        } finally {
            getItem.mockRestore();
            setItem.mockRestore();
            if (!originalWindow) delete (globalThis as { window?: unknown }).window;
            restore();
        }
    });

    test("desktop folder create/rename/delete use /asset-folders and do not treat asset PUT as the folder name", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const urls: string[] = [];
        try {
            await withAdapter(async (config) => {
                urls.push(requestKey(config));
                const method = String(config.method || "get").toLowerCase();
                const url = String(config.url || "");
                if (method === "post" && url === "/asset-folders") {
                    return envelope({ folder: { id: "folder-1", name: "灵感", position: 0, createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" } });
                }
                if (method === "patch" && url === "/asset-folders/folder-1") {
                    return envelope({ folder: { id: "folder-1", name: "分镜", position: 0, createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" } });
                }
                if (method === "delete" && url === "/asset-folders/folder-1") {
                    return envelope({ id: "folder-1" });
                }
                if (method === "get" && url === "/asset-folders") {
                    return envelope({ folders: [] });
                }
                throw new Error(`unexpected ${method} ${url}`);
            }, async () => {
                const created = await createWorkspaceAssetFolder("灵感");
                expect(created.id).toBe("folder-1");
                await renameWorkspaceAssetFolder(created.id, "分镜");
                await deleteWorkspaceAssetFolder(created.id);
            });
            expect(urls).toEqual(["post /asset-folders", "patch /asset-folders/folder-1", "delete /asset-folders/folder-1"]);
        } finally {
            restore();
        }
    });

    test("desktop move assigns folder via PATCH /assets/folder and does not PUT the asset payload", async () => {
        const restore = switchScope("owner-a");
        desktopBackend();
        const urls: string[] = [];
        useAssetStore.setState({ assets: [textAsset("asset-1")] });
        try {
            await withAdapter(async (config) => {
                urls.push(requestKey(config));
                if (String(config.url || "") === "/assets/folder") {
                    return envelope({ assetIds: ["asset-1"], folderId: "folder-1" });
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                await assignWorkspaceAssetsFolder(["asset-1"], "folder-1");
            });
            expect(urls).toEqual(["patch /assets/folder"]);
            expect(useAssetStore.getState().assets[0]?.folderId).toBe("folder-1");
        } finally {
            restore();
        }
    });
});
