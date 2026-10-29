import { afterEach, describe, expect, spyOn, test } from "bun:test";
import localforage from "localforage";

import * as runtimeMode from "@/lib/runtime-mode";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import { captureUserScope, UserScopeAbandonedError } from "@/lib/user-scope-guard";
import {
    CANVAS_FOLDER_PENDING_KEY,
    FolderPendingUnreadableError,
    createCanvasLibraryFolder,
    deleteCanvasLibraryFolder,
    hydrateCanvasLibraryFolders,
    peekCanvasFolderPendingForTests,
    peekCanvasFolderPendingHighWaterForTests,
    persistCanvasFolderCover,
    renameCanvasLibraryFolder,
    replaceCanvasFolderPendingStoreForTests,
    resetCanvasFolderStorageForTests,
    setCanvasFolderDigestDelayForTests,
} from "@/lib/canvas/canvas-folder-storage";
import { scopedStorageKey } from "@/lib/user-scope";
import { apiClient } from "@/services/api/request";
import { peekCanvasOperationJournal, resetCanvasOperationJournalMemory } from "@/services/canvas-operation-journal";
import { resetLocalCanvasBackendSaveState } from "@/services/local-workspace-repository";
import {
    canvasExternalRevisionConflict,
    clearCanvasDocumentBase,
    clearCanvasExternalRevisionConflict,
    recordCanvasDocumentBase,
    useCanvasStore,
    type CanvasFolder,
    type CanvasProject,
} from "@/stores/canvas/use-canvas-store";

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

function envelope(data: unknown, status = 200) {
    return { data: { code: 0, msg: "", data }, status, statusText: "OK", headers: {}, config: {} as never };
}

function failure(status: number, msg: string, reason?: string) {
    return { data: { code: status, msg, data: null, reason }, status, statusText: "ERR", headers: {}, config: {} as never };
}

function memoryPendingStore(values: Map<string, unknown>, hooks?: { beforeSet?: (key: string, value: unknown) => Promise<void> | void }) {
    return {
        async getItem(key: string) {
            return (values.get(key) as never) ?? null;
        },
        async setItem(key: string, value: unknown) {
            await hooks?.beforeSet?.(key, value);
            values.set(key, value);
            return value as never;
        },
        async removeItem(key: string) {
            values.delete(key);
        },
    };
}

function requestBody(config: { data?: unknown }) {
    const data = config.data;
    if (typeof data === "string") {
        try { return JSON.parse(data) as Record<string, unknown>; } catch { return {}; }
    }
    return data && typeof data === "object" ? data as Record<string, unknown> : {};
}

function record(id: string, name: string, extras: Partial<CanvasFolder> = {}): CanvasFolder {
    return {
        id,
        name,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
        ...extras,
    };
}

function canvasProject(id: string, folderId: string | undefined, revision: number, patch: Partial<CanvasProject> = {}): CanvasProject {
    return {
        id,
        folderId,
        revision,
        title: "画布",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        nodes: [{ id: "n1", type: "image", title: "镜头1", position: { x: 0, y: 0 }, width: 320, height: 220, metadata: { prompt: "基线" } }],
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "grid",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
        directorScenes: [],
        ...patch,
    } as CanvasProject;
}

function stubJournalStorage() {
    spies.push(spyOn(localforage, "getItem").mockResolvedValue(null as never));
    spies.push(spyOn(localforage, "setItem").mockImplementation(async (_key, value) => value as never));
    spies.push(spyOn(localforage, "removeItem").mockResolvedValue(undefined as never));
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
const memory = new Map<string, string>();
const pendingValues = new Map<string, unknown>();

function desktopBackend() {
    spies.push(spyOn(runtimeMode, "isNativeDesktopRuntime").mockReturnValue(true));
    spies.push(spyOn(runtimeMode, "isLocalRuntimeMode").mockReturnValue(true));
}

function installPendingStore(hooks?: { beforeSet?: (key: string, value: unknown) => Promise<void> | void }) {
    replaceCanvasFolderPendingStoreForTests(memoryPendingStore(pendingValues, hooks));
}

function installWindow() {
    const original = globalThis.window;
    globalThis.window = {
        localStorage: {
            getItem: (key: string) => memory.get(String(key)) ?? null,
            setItem: (key: string, value: string) => { memory.set(String(key), String(value)); },
            removeItem: (key: string) => { memory.delete(String(key)); },
        },
        location: { protocol: "wails:" },
    } as never;
    return () => {
        if (original) globalThis.window = original;
        else delete (globalThis as { window?: unknown }).window;
    };
}

afterEach(() => {
    while (spies.length) spies.pop()?.mockRestore();
    resetCanvasFolderStorageForTests();
    resetCanvasOperationJournalMemory();
    resetLocalCanvasBackendSaveState();
    clearCanvasDocumentBase("c1");
    clearCanvasDocumentBase("c2");
    clearCanvasExternalRevisionConflict(getActiveUserScope(), "c1");
    clearCanvasExternalRevisionConflict(getActiveUserScope(), "c2");
    useCanvasStore.setState({ folders: [], projects: [] });
    memory.clear();
    pendingValues.clear();
    setCanvasFolderDigestDelayForTests();
});

describe("canvas folder storage", () => {
    test("hydrate preserves cache-only folders as unsaved pending", async () => {
        const restore = switchScope("owner-a");
        const restoreWindow = installWindow();
        desktopBackend();
        installPendingStore();
        useCanvasStore.setState({
            folders: [record("legacy", "本地剧集"), record("remote-1", "已同步")],
            hydrated: true,
        });
        try {
            await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "get" && String(config.url).includes("/canvas-folders")) {
                    return envelope({ folders: [record("remote-1", "已同步")] });
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                await hydrateCanvasLibraryFolders(captureUserScope());
            });
            const folders = useCanvasStore.getState().folders;
            expect(folders.find((folder) => folder.id === "legacy")?.name).toBe("本地剧集");
            expect(folders.find((folder) => folder.id === "legacy")?.unsaved).toBe(true);
            expect(folders.find((folder) => folder.id === "remote-1")?.unsaved).toBeUndefined();
            expect((await peekCanvasFolderPendingForTests("owner-a")).legacy?.kind).toBe("upsert");
        } finally {
            restoreWindow();
            restore();
        }
    });

    test("read error is not success and does not drop pending folders", async () => {
        const restore = switchScope("owner-a");
        const restoreWindow = installWindow();
        desktopBackend();
        installPendingStore();
        useCanvasStore.setState({ folders: [record("legacy", "本地剧集")], hydrated: true });
        try {
            await withAdapter(async () => failure(503, "服务暂时不可用，请稍后重试"), async () => {
                await expect(hydrateCanvasLibraryFolders(captureUserScope())).rejects.toThrow(/服务暂时不可用/);
            });
            expect(useCanvasStore.getState().folders.some((folder) => folder.id === "legacy")).toBe(true);
        } finally {
            restoreWindow();
            restore();
        }
    });

    test("concurrent rename keeps the later edit when an older PUT returns", async () => {
        const restore = switchScope("owner-a");
        const restoreWindow = installWindow();
        desktopBackend();
        installPendingStore();
        useCanvasStore.setState({ folders: [record("folder-1", "原名")], hydrated: true });
        const entered = deferred();
        const gate = deferred();
        const names: string[] = [];
        try {
            await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "put" && String(config.url).includes("/canvas-folders/folder-1")) {
                    const body = requestBody(config) as { folder: { name: string } };
                    names.push(body.folder.name);
                    if (body.folder.name === "第一次") {
                        entered.resolve();
                        await gate.promise;
                        return failure(500, "保存失败");
                    }
                    return envelope({ folder: record("folder-1", body.folder.name, { updatedAt: "2026-10-02T00:00:00.000Z" }) });
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                const first = renameCanvasLibraryFolder("folder-1", "第一次", captureUserScope());
                await entered.promise;
                const second = renameCanvasLibraryFolder("folder-1", "第二次", captureUserScope());
                gate.resolve();
                await expect(first).rejects.toThrow(/保存失败/);
                await second;
                expect(useCanvasStore.getState().folders.find((folder) => folder.id === "folder-1")?.name).toBe("第二次");
                expect(useCanvasStore.getState().folders.find((folder) => folder.id === "folder-1")?.unsaved).toBeUndefined();
                expect(names).toEqual(["第一次", "第二次"]);
            });
        } finally {
            restoreWindow();
            restore();
        }
    });

    test("delete pending prevents a stale list read from restoring the folder", async () => {
        const restore = switchScope("owner-a");
        const restoreWindow = installWindow();
        desktopBackend();
        installPendingStore();
        useCanvasStore.setState({ folders: [record("folder-1", "待删")], hydrated: true });
        const entered = deferred();
        const gate = deferred();
        try {
            await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "get") {
                    entered.resolve();
                    await gate.promise;
                    return envelope({ folders: [record("folder-1", "待删")] });
                }
                if (String(config.method).toLowerCase() === "delete") return envelope({ id: "folder-1" });
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                const hydrating = hydrateCanvasLibraryFolders(captureUserScope());
                await entered.promise;
                await deleteCanvasLibraryFolder("folder-1", captureUserScope());
                expect(useCanvasStore.getState().folders.some((folder) => folder.id === "folder-1")).toBe(false);
                gate.resolve();
                await hydrating;
                expect(useCanvasStore.getState().folders.some((folder) => folder.id === "folder-1")).toBe(false);
            });
        } finally {
            restoreWindow();
            restore();
        }
    });

    test("A-B-A during cover hash does not write the new epoch", async () => {
        const restore = switchScope("owner-a");
        const restoreWindow = installWindow();
        desktopBackend();
        installPendingStore();
        useCanvasStore.setState({ folders: [record("folder-1", "封面")], hydrated: true });
        const digest = deferred();
        const puts: string[] = [];
        let delayedOnce = false;
        setCanvasFolderDigestDelayForTests(async () => {
            if (delayedOnce) return;
            delayedOnce = true;
            await digest.promise;
        });
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async () => ({ blob: async () => new Blob(["cover"], { type: "image/jpeg" }) })) as never;
        try {
            const firstEpoch = captureUserScope();
            const pending = withAdapter(async (config) => {
                puts.push(`${String(config.method)} ${String(config.url)}`);
                if (String(config.url).includes("/resources")) return envelope({ resource: { id: "cover-1", status: "ready" } });
                return envelope({ folder: record("folder-1", "封面", { coverResourceId: "cover-1" }) });
            }, async () => persistCanvasFolderCover("folder-1", "data:image/jpeg;base64,aaaa", firstEpoch));

            await new Promise((resolve) => setTimeout(resolve, 10));
            setActiveUserScope("owner-b");
            setActiveUserScope("owner-a");
            digest.resolve();
            await expect(pending).rejects.toBeInstanceOf(UserScopeAbandonedError);
            expect(puts.some((item) => String(item).includes("/canvas-folders/"))).toBe(false);
            expect(useCanvasStore.getState().folders.find((folder) => folder.id === "folder-1")?.coverResourceId).toBeUndefined();
        } finally {
            globalThis.fetch = originalFetch;
            restoreWindow();
            restore();
        }
    });

    test("create stays visible as unsaved when the backend write fails", async () => {
        const restore = switchScope("owner-a");
        const restoreWindow = installWindow();
        desktopBackend();
        installPendingStore();
        try {
            await withAdapter(async () => failure(500, "文件夹没有保存成功"), async () => {
                await expect(createCanvasLibraryFolder("新建", captureUserScope())).rejects.toThrow(/文件夹没有保存成功/);
            });
            const created = useCanvasStore.getState().folders.find((folder) => folder.name === "新建");
            expect(created?.unsaved).toBe(true);
            expect(created?.saveError).toMatch(/文件夹没有保存成功/);
        } finally {
            restoreWindow();
            restore();
        }
    });

    test("hydrate does not PUT legacy cache-only folders", async () => {
        const restore = switchScope("owner-a");
        const restoreWindow = installWindow();
        desktopBackend();
        installPendingStore();
        useCanvasStore.setState({ folders: [record("legacy", "本地剧集")], hydrated: true });
        const methods: string[] = [];
        try {
            await withAdapter(async (config) => {
                methods.push(`${String(config.method)} ${String(config.url)}`);
                if (String(config.method).toLowerCase() === "get") return envelope({ folders: [] });
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                await hydrateCanvasLibraryFolders(captureUserScope());
            });
            expect(methods.some((item) => item.toLowerCase().startsWith("put "))).toBe(false);
            expect(useCanvasStore.getState().folders.find((folder) => folder.id === "legacy")?.unsaved).toBe(true);
        } finally {
            restoreWindow();
            restore();
        }
    });

    test("cover snapshot stays out of localStorage and survives restart", async () => {
        const restore = switchScope("owner-a");
        const restoreWindow = installWindow();
        desktopBackend();
        installPendingStore();
        useCanvasStore.setState({ folders: [record("folder-1", "封面")], hydrated: true });
        const cover = `data:image/jpeg;base64,${"A".repeat(6 * 1024 * 1024)}`;
        try {
            await withAdapter(async () => failure(500, "封面没有保存成功"), async () => {
                await expect(persistCanvasFolderCover("folder-1", cover, captureUserScope())).rejects.toThrow(/封面没有保存成功/);
            });
            const pendingKey = scopedStorageKey(CANVAS_FOLDER_PENDING_KEY, "owner-a");
            expect(memory.get(pendingKey)).toBeUndefined();
            expect(JSON.stringify([...memory.values()])).not.toContain("AAAA");
            expect((await peekCanvasFolderPendingForTests("owner-a"))["folder-1"]?.folder?.coverDataUrl).toBe(cover);

            resetCanvasFolderStorageForTests();
            installPendingStore();
            useCanvasStore.setState({ folders: [], hydrated: true });
            await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "get") return envelope({ folders: [record("folder-1", "封面")] });
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                await hydrateCanvasLibraryFolders(captureUserScope());
            });
            expect(useCanvasStore.getState().folders.find((folder) => folder.id === "folder-1")?.coverDataUrl).toBe(cover);
            expect(useCanvasStore.getState().folders.find((folder) => folder.id === "folder-1")?.unsaved).toBe(true);
        } finally {
            restoreWindow();
            restore();
        }
    });

    test("persistence failure stops dispatch", async () => {
        const restore = switchScope("owner-a");
        const restoreWindow = installWindow();
        desktopBackend();
        replaceCanvasFolderPendingStoreForTests(memoryPendingStore(pendingValues, {
            beforeSet: async () => { throw new Error("存储空间不足"); },
        }));
        const puts: string[] = [];
        try {
            await withAdapter(async (config) => {
                puts.push(`${String(config.method)} ${String(config.url)}`);
                return envelope({ folder: record("x", "x") });
            }, async () => {
                await expect(createCanvasLibraryFolder("新建", captureUserScope())).rejects.toThrow(/存储空间不足/);
            });
            expect(puts).toEqual([]);
            expect(useCanvasStore.getState().folders.some((folder) => folder.name === "新建")).toBe(false);
        } finally {
            restoreWindow();
            restore();
        }
    });

    test("unreadable pending persistence does not wipe unsaved folders", async () => {
        const restore = switchScope("owner-a");
        const restoreWindow = installWindow();
        desktopBackend();
        pendingValues.set("owner-a", { broken: true });
        installPendingStore();
        useCanvasStore.setState({ folders: [record("legacy", "本地剧集")], hydrated: true });
        try {
            await withAdapter(async () => envelope({ folders: [] }), async () => {
                await expect(hydrateCanvasLibraryFolders(captureUserScope())).rejects.toBeInstanceOf(FolderPendingUnreadableError);
            });
            expect(useCanvasStore.getState().folders.find((folder) => folder.id === "legacy")?.name).toBe("本地剧集");
        } finally {
            restoreWindow();
            restore();
        }
    });

    test("deleted folder PUT keeps the unsaved snapshot and does not retry the old id", async () => {
        const restore = switchScope("owner-a");
        const restoreWindow = installWindow();
        desktopBackend();
        installPendingStore();
        useCanvasStore.setState({ folders: [record("folder-1", "原名")], hydrated: true });
        const puts: string[] = [];
        try {
            await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "put") {
                    puts.push(String(config.url));
                    return failure(409, "文件夹已删除，不能重新导入", "failed_precondition");
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                await expect(renameCanvasLibraryFolder("folder-1", "新名", captureUserScope())).rejects.toThrow(/未保存的修改还在本机/);
                await expect(renameCanvasLibraryFolder("folder-1", "再改", captureUserScope())).rejects.toThrow(/未保存的修改还在本机/);
            });
            expect(puts).toHaveLength(1);
            const folder = useCanvasStore.getState().folders.find((item) => item.id === "folder-1");
            expect(folder?.name).toBe("再改");
            expect(folder?.unsaved).toBe(true);
            expect((await peekCanvasFolderPendingForTests("owner-a"))["folder-1"]?.blockedReimport).toBe(true);
        } finally {
            restoreWindow();
            restore();
        }
    });

    test("empty or wrong-id PUT keeps the draft and is not success", async () => {
        const restore = switchScope("owner-a");
        const restoreWindow = installWindow();
        desktopBackend();
        installPendingStore();
        useCanvasStore.setState({ folders: [record("folder-1", "原名")], hydrated: true });
        try {
            await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "put") return envelope({});
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                await expect(renameCanvasLibraryFolder("folder-1", "空回执", captureUserScope())).rejects.toThrow(/文件夹没有保存成功/);
            });
            const emptyReceipt = useCanvasStore.getState().folders.find((item) => item.id === "folder-1");
            expect(emptyReceipt?.name).toBe("空回执");
            expect(emptyReceipt?.unsaved).toBe(true);
            expect((await peekCanvasFolderPendingForTests("owner-a"))["folder-1"]?.kind).toBe("upsert");

            await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "put") return envelope({ folder: record("other-id", "错身份") });
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                await expect(renameCanvasLibraryFolder("folder-1", "错身份", captureUserScope())).rejects.toThrow(/文件夹没有保存成功/);
            });
            const wrongId = useCanvasStore.getState().folders.find((item) => item.id === "folder-1");
            expect(wrongId?.name).toBe("错身份");
            expect(wrongId?.unsaved).toBe(true);
            expect((await peekCanvasFolderPendingForTests("owner-a"))["folder-1"]?.folder?.name).toBe("错身份");
        } finally {
            restoreWindow();
            restore();
        }
    });

    test("folder generation high water survives ack and reload", async () => {
        const restore = switchScope("owner-a");
        const restoreWindow = installWindow();
        desktopBackend();
        installPendingStore();
        useCanvasStore.setState({ folders: [record("folder-1", "原名")], hydrated: true });
        const generations: number[] = [];
        try {
            await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "put") {
                    const pending = await peekCanvasFolderPendingForTests("owner-a");
                    generations.push(pending["folder-1"]?.generation || 0);
                    const body = requestBody(config) as { folder: { name: string } };
                    return envelope({ folder: record("folder-1", body.folder.name, { updatedAt: "2026-10-02T00:00:00.000Z" }) });
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                await renameCanvasLibraryFolder("folder-1", "第一次", captureUserScope());
                expect(useCanvasStore.getState().folders.find((folder) => folder.id === "folder-1")?.unsaved).toBeUndefined();
                expect((await peekCanvasFolderPendingForTests("owner-a"))["folder-1"]).toBeUndefined();
                expect((await peekCanvasFolderPendingHighWaterForTests("owner-a"))["folder-1"]).toBeGreaterThanOrEqual(1);

                resetCanvasFolderStorageForTests();
                installPendingStore();
                await renameCanvasLibraryFolder("folder-1", "第二次", captureUserScope());
            });
            expect(generations).toEqual([1, 2]);
            expect((await peekCanvasFolderPendingHighWaterForTests("owner-a"))["folder-1"]).toBeGreaterThanOrEqual(2);
            expect(useCanvasStore.getState().folders.find((folder) => folder.id === "folder-1")?.name).toBe("第二次");
            expect(useCanvasStore.getState().folders.find((folder) => folder.id === "folder-1")?.unsaved).toBeUndefined();
        } finally {
            restoreWindow();
            restore();
        }
    });

    test("folder delete applies canonical canvas receipt and keeps a newer local edit", async () => {
        const restore = switchScope("owner-a");
        const restoreWindow = installWindow();
        desktopBackend();
        installPendingStore();
        stubJournalStorage();
        const clean = canvasProject("c1", "folder-1", 1);
        const unrelated = canvasProject("c2", "other-folder", 3, { title: "别的画布", nodes: [{ id: "n2", type: "image", title: "别的镜头", position: { x: 1, y: 1 }, width: 320, height: 220, metadata: { prompt: "别的" } }] });
        useCanvasStore.setState({
            folders: [record("folder-1", "待删")],
            projects: [clean, unrelated],
            hydrated: true,
        });
        recordCanvasDocumentBase(clean, "owner-a");
        recordCanvasDocumentBase(unrelated, "owner-a");
        const receipt = canvasProject("c1", undefined, 2, { updatedAt: "2026-10-02T00:00:00.000Z" });
        try {
            await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "delete" && String(config.url).includes("/canvas-folders/folder-1")) {
                    return envelope({ id: "folder-1" });
                }
                if (String(config.method).toLowerCase() === "get" && String(config.url).includes("/canvas-projects/c1")) {
                    return envelope({ project: receipt });
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                await deleteCanvasLibraryFolder("folder-1", captureUserScope());
            });
            const applied = useCanvasStore.getState().projects.find((project) => project.id === "c1");
            expect(applied?.folderId).toBeUndefined();
            expect(applied?.revision).toBe(2);
            expect(applied?.nodes).toEqual(receipt.nodes);
            expect(useCanvasStore.getState().projects.find((project) => project.id === "c2")?.folderId).toBe("other-folder");
            expect(useCanvasStore.getState().folders.some((folder) => folder.id === "folder-1")).toBe(false);
        } finally {
            restoreWindow();
            restore();
        }
    });

    test("folder delete keeps a newer unsaved canvas edit, merges the disjoint remote receipt and records it", async () => {
        const restore = switchScope("owner-a");
        const restoreWindow = installWindow();
        desktopBackend();
        installPendingStore();
        stubJournalStorage();
        const baseline = canvasProject("c1", "folder-1", 1);
        const localNodes = [{ id: "n-local", type: "image" as const, title: "用户刚改", position: { x: 8, y: 8 }, width: 320, height: 220, metadata: { prompt: "未保存" } }];
        const live = { ...baseline, nodes: localNodes };
        useCanvasStore.setState({
            folders: [record("folder-1", "待删")],
            projects: [live],
            hydrated: true,
        });
        recordCanvasDocumentBase(baseline, "owner-a");
        const receipt = canvasProject("c1", undefined, 4, {
            nodes: [{ id: "n-remote", type: "image", title: "服务端改过", position: { x: 0, y: 0 }, width: 320, height: 220, metadata: { prompt: "远端" } }],
        });
        try {
            await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "delete" && String(config.url).includes("/canvas-folders/folder-1")) {
                    return envelope({ id: "folder-1" });
                }
                if (String(config.method).toLowerCase() === "get" && String(config.url).includes("/canvas-projects/c1")) {
                    return envelope({ project: receipt });
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                await deleteCanvasLibraryFolder("folder-1", captureUserScope());
            });
            // The local node edit and the server's folder removal touch different fields: both survive.
            const kept = useCanvasStore.getState().projects.find((project) => project.id === "c1");
            expect(kept?.nodes.map((node) => node.id)).toEqual(["n-local", "n-remote"]);
            expect(kept?.nodes[0]).toEqual(localNodes[0]);
            expect(kept?.folderId).toBeUndefined();
            expect(canvasExternalRevisionConflict("owner-a", "c1")).toBeUndefined();
            expect(peekCanvasOperationJournal("c1", "owner-a")?.confirmedRevision).toBe(4);
        } finally {
            restoreWindow();
            restore();
        }
    });
});
