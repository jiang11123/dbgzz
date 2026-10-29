import { beforeEach, describe, expect, mock, test } from "bun:test";

type Stored = Map<string, string>;
const stored: Stored = new Map();
let activeScope = "guest";
let activeEpoch = 1;

function assertMockExpectedScope(config?: { expectedScope?: { userScope: string; epoch: number } }) {
    if (!config?.expectedScope) return;
    if (config.expectedScope.userScope !== activeScope || config.expectedScope.epoch !== activeEpoch) {
        const error = new Error("账号已切换，本次操作已停止");
        error.name = "UserScopeAbandonedError";
        throw error;
    }
}

class ApiError extends Error {
    status?: number;
    code?: number;
    reason?: string;
    retryable: boolean;
    constructor(message: string, options: { status?: number; code?: number; reason?: string; retryable?: boolean } = {}) {
        super(message);
        this.name = "ApiError";
        this.status = options.status;
        this.code = options.code;
        this.reason = options.reason;
        this.retryable = options.retryable ?? false;
    }
}

const server = {
    revision: 21,
    document: null as Record<string, unknown> | null,
    posts: [] as Array<{ path: string; revision?: number }>,
    gets: [] as string[],
    restore: null as { status?: number; project?: Record<string, unknown> | null; transport?: boolean } | null,
    getAfterRestore: null as Record<string, unknown> | null,
    hold: null as Promise<void> | null,
    postStarted: 0,
};

mock.module("@/lib/localforage-storage", () => ({
    localForageStorageForScope: (scope?: string) => ({
        getItem: async (name: string) => stored.get(`${scope ?? activeScope}:${name}`) ?? null,
        setItem: async (name: string, value: string) => { stored.set(`${scope ?? activeScope}:${name}`, value); },
        removeItem: async (name: string) => { stored.delete(`${scope ?? activeScope}:${name}`); },
    }),
    localForageStorage: {
        getItem: async (name: string) => stored.get(`${activeScope}:${name}`) ?? null,
        setItem: async (name: string, value: string) => { stored.set(`${activeScope}:${name}`, value); },
        removeItem: async (name: string) => { stored.delete(`${activeScope}:${name}`); },
    },
}));

mock.module("@/lib/user-scope", () => ({
    getActiveUserScope: () => activeScope,
    getActiveUserScopeEpoch: () => activeEpoch,
    getUserScopeGeneration: () => activeEpoch,
    captureUserScopeEpoch: (scope = activeScope) => ({ scope, generation: activeEpoch }),
    userScopeEpochMatches: (epoch: { scope: string; generation: number }) => epoch.scope === activeScope && epoch.generation === activeEpoch,
    setActiveUserScope: (userId?: string | null) => {
        activeScope = userId || "guest";
        activeEpoch += 1;
    },
    subscribeUserScope: () => () => {},
    scopedStorageKey: (name: string, scope = activeScope) => `${name}:user:${scope}`,
    scopedLocalStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

const actualRequest = await import("@/services/api/request");
mock.module("@/services/api/request", () => ({
    ...actualRequest,
    ApiError,
    apiBaseURL: "/api",
    compactApiParams: (params: Record<string, unknown>) => params,
    http: {
        get: async (path: string, config?: { expectedScope?: { userScope: string; epoch: number } }) => {
            assertMockExpectedScope(config);
            server.gets.push(path);
            return { project: server.getAfterRestore ?? server.document };
        },
        post: async (path: string, body: { revision?: number }, config?: { expectedScope?: { userScope: string; epoch: number } }) => {
            assertMockExpectedScope(config);
            server.postStarted += 1;
            if (server.hold) await server.hold;
            assertMockExpectedScope(config);
            server.posts.push({ path, revision: body?.revision });
            if (server.restore?.transport) throw new TypeError("Failed to fetch");
            if (server.restore?.status) {
                throw new ApiError("云端画布已有更新，已停止覆盖；请保留本地草稿并加载最新版本", {
                    status: server.restore.status,
                    reason: "stale_revision",
                });
            }
            if (server.restore && "project" in server.restore) return { project: server.restore.project };
            return {
                project: {
                    id: "c1",
                    title: "已恢复",
                    createdAt: "2026-01-01T00:00:00.000Z",
                    updatedAt: "2026-01-01T00:00:00.000Z",
                    revision: (body?.revision ?? 0) + 1,
                },
            };
        },
        put: async () => ({ project: { id: "c1", revision: server.revision } }),
        delete: async () => undefined,
    },
}));

mock.module("@/services/local-workspace-sync", () => ({ notifyCanvasRefresh: () => {} }));
mock.module("@/services/canvas-sync-drafts", () => ({ preserveCanvasSyncDraft: async () => 1 }));
mock.module("@/stores/use-asset-store", () => ({ useAssetStore: { getState: () => ({ assets: [] }) } }));
mock.module("@/services/workspace-mode", () => ({ isLocalWorkspaceMode: () => true }));
mock.module("@/services/api/resources", () => ({
    resourceIdFromStorageKey: (storageKey?: string) => storageKey?.startsWith("resource:") ? storageKey.slice("resource:".length) : "",
    ownedResourceIdFromMediaRef: () => "",
    resourceFileUrl: () => "",
    resourceStorageKey: () => "",
}));

const { restoreLocalCanvasProjectFromHistory, openLocalCanvasProjectFromBackend, resetLocalCanvasBackendSaveState, setCanvasProjectionStoreFlushForTest } = await import("@/services/local-workspace-repository");
const { useCanvasStore, recordCanvasDocumentBase, canvasDocumentBase, clearCanvasExternalRevisionConflict } = await import("@/stores/canvas/use-canvas-store");
const { loadCanvasOperationJournal, peekCanvasOperationJournal, resetCanvasOperationJournalMemory, saveCanvasOperationJournal, setCanvasJournalStorageDelay } = await import("@/services/canvas-operation-journal");
const { setActiveUserScope } = await import("@/lib/user-scope");
const { canvasBackendSubmitPaused, pauseCanvasBackendSubmit } = await import("@/services/canvas-revision-conflict");
const { useSyncProgressStore } = await import("@/stores/use-sync-progress-store");

function canvas(title: string, revision: number, patch: Record<string, unknown> = {}) {
    return {
        id: "c1",
        revision,
        title,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        nodes: [{ id: "n1", type: "image", title, position: { x: 0, y: 0 }, width: 320, height: 220, metadata: patch.metadata ?? {} }],
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "grid",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
        directorScenes: [],
        ...patch,
    };
}

async function seedLive(doc: ReturnType<typeof canvas>, inFlight = false) {
    await saveCanvasOperationJournal({
        userScope: activeScope,
        canvasId: "c1",
        confirmedRevision: doc.revision,
        confirmedSnapshot: doc,
        inFlight: inFlight
            ? {
                operationId: "op-old",
                expectedRevision: 9,
                payload: { canvasId: "c1", expectedRevision: 9, document: canvas("生成中", 9) },
            }
            : null,
    });
    recordCanvasDocumentBase(doc as never, activeScope);
    useCanvasStore.setState({ projects: [doc as never] });
    server.revision = doc.revision;
    server.document = doc;
}

async function holdJournalWrite() {
    let release = () => {};
    let waiting = false;
    let held = false;
    setCanvasJournalStorageDelay({
        beforeSet: async () => {
            if (held) return;
            held = true;
            waiting = true;
            await new Promise<void>((resolve) => { release = resolve; });
        },
    });
    return {
        wait: async () => {
            for (let i = 0; i < 80 && !waiting; i += 1) await Promise.resolve();
            expect(waiting).toBe(true);
        },
        resume: () => {
            setCanvasJournalStorageDelay(null);
            release();
        },
    };
}

beforeEach(() => {
    stored.clear();
    resetCanvasOperationJournalMemory();
    resetLocalCanvasBackendSaveState();
    setCanvasJournalStorageDelay(null);
    setCanvasProjectionStoreFlushForTest(async () => {});
    activeScope = "guest";
    activeEpoch = 1;
    server.revision = 21;
    server.document = canvas("当前稿", 21);
    server.posts = [];
    server.gets = [];
    server.restore = null;
    server.getAfterRestore = null;
    server.hold = null;
    server.postStarted = 0;
    useSyncProgressStore.getState().clearAll();
    clearCanvasExternalRevisionConflict("guest", "c1");
    useCanvasStore.setState({ projects: [canvas("当前稿", 21) as never] });
    recordCanvasDocumentBase(canvas("当前稿", 21) as never);
});

describe("restoreLocalCanvasProjectFromHistory", () => {
    test("成功恢复：POST CAS 后读取新版本并写入 journal", async () => {
        const current = canvas("当前稿", 21, { metadata: { status: "loading" } });
        await seedLive(current, true);
        const restored = canvas("三节点", 22, { metadata: { status: "success", content: "/api/resources/r1/file" } });
        restored.nodes = [
            restored.nodes[0],
            { id: "n2", type: "image", title: "露营桌", position: { x: 1, y: 0 }, width: 320, height: 220, metadata: {} },
            { id: "n3", type: "video", title: "湖畔横移", position: { x: 2, y: 0 }, width: 320, height: 220, metadata: {} },
        ] as never;
        server.getAfterRestore = restored;

        const project = await restoreLocalCanvasProjectFromHistory("c1", { snapshotId: "snap-14", revision: 21 });

        expect(server.posts).toEqual([{ path: "/canvas-projects/c1/history/snap-14/restore", revision: 21 }]);
        expect(server.gets).toEqual(["/canvas-projects/c1"]);
        expect(project.revision).toBe(22);
        expect(project.title).toBe("三节点");
        expect(project.nodes).toHaveLength(3);
        expect(useCanvasStore.getState().projects[0].title).toBe("三节点");
        expect(useCanvasStore.getState().projects[0].revision).toBe(22);
        const journal = await loadCanvasOperationJournal("c1");
        expect(journal.confirmedRevision).toBe(22);
        expect(journal.confirmedSnapshot?.title).toBe("三节点");
        expect(journal.inFlight).toBeNull();
        expect(journal.pendingProjection).toBeNull();
        expect(canvasDocumentBase("c1")?.revision).toBe(22);
    });

    test("409 抛错、不打开当前稿、保留本地编辑", async () => {
        const current = canvas("未保存的标题", 21);
        await seedLive(current);
        server.restore = { status: 409 };

        await expect(restoreLocalCanvasProjectFromHistory("c1", { snapshotId: "snap-14", revision: 21 }))
            .rejects.toThrow("当前画布已有更新，这次没有恢复。请重新打开版本记录后再试。");

        expect(server.posts).toHaveLength(1);
        expect(server.gets).toEqual([]);
        expect(useCanvasStore.getState().projects[0].title).toBe("未保存的标题");
        expect((await loadCanvasOperationJournal("c1")).confirmedRevision).toBe(21);
    });

    test("缺少 snapshotId 或 revision 时不发恢复请求", async () => {
        await seedLive(canvas("当前稿", 21));

        await expect(restoreLocalCanvasProjectFromHistory("c1", { snapshotId: "  ", revision: 21 }))
            .rejects.toThrow("历史版本不存在或已过期，请刷新历史列表");
        await expect(restoreLocalCanvasProjectFromHistory("c1", { snapshotId: "snap-14", revision: 1.5 }))
            .rejects.toThrow("请先刷新画布版本再恢复");

        expect(server.posts).toEqual([]);
        expect(server.gets).toEqual([]);
        expect(useCanvasStore.getState().projects[0].title).toBe("当前稿");
    });

    test("回执 revision 未前进时不把当前稿当成恢复成功", async () => {
        await seedLive(canvas("当前稿", 21));
        server.restore = {
            project: {
                id: "c1",
                title: "当前稿",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
                revision: 21,
            },
        };

        await expect(restoreLocalCanvasProjectFromHistory("c1", { snapshotId: "snap-14", revision: 21 }))
            .rejects.toThrow("恢复没有完成，画布内容没有被替换。");

        expect(server.gets).toEqual([]);
        expect(useCanvasStore.getState().projects[0].title).toBe("当前稿");
    });

    test("POST 成功但随后读到的 revision 与回执不一致时失败", async () => {
        await seedLive(canvas("当前稿", 21));
        server.getAfterRestore = canvas("当前稿", 21);

        await expect(restoreLocalCanvasProjectFromHistory("c1", { snapshotId: "snap-14", revision: 21 }))
            .rejects.toThrow("恢复后没有读到新版本，请重试。");

        expect(server.posts).toHaveLength(1);
        expect(server.gets).toEqual(["/canvas-projects/c1"]);
        expect(useCanvasStore.getState().projects[0].title).toBe("当前稿");
        expect(peekCanvasOperationJournal("c1")?.confirmedRevision).toBe(21);
    });

    test("账号切换后拒绝把恢复写进新账号", async () => {
        await seedLive(canvas("当前稿", 21));
        let release = () => {};
        server.hold = new Promise<void>((resolve) => { release = resolve; });
        const pending = restoreLocalCanvasProjectFromHistory("c1", { snapshotId: "snap-14", revision: 21 });
        for (let i = 0; i < 50 && server.postStarted === 0; i += 1) await Promise.resolve();
        expect(server.postStarted).toBe(1);
        setActiveUserScope("user-b");
        release();
        await expect(pending).rejects.toMatchObject({ name: "CanvasStaleScopeError" });
        expect(useCanvasStore.getState().projects[0].title).toBe("当前稿");
    });

    test("journal 写入等待期间切账号：不 applyLive、不清新账号状态", async () => {
        const current = canvas("当前稿", 21);
        await seedLive(current, true);
        server.getAfterRestore = canvas("三节点", 22);
        const hold = await holdJournalWrite();
        const pending = restoreLocalCanvasProjectFromHistory("c1", { snapshotId: "snap-14", revision: 21 });
        await hold.wait();

        setActiveUserScope("user-b");
        const other = canvas("新账号稿", 3);
        await saveCanvasOperationJournal({
            userScope: "user-b",
            canvasId: "c1",
            confirmedRevision: 3,
            confirmedSnapshot: other,
            inFlight: {
                operationId: "op-b",
                expectedRevision: 3,
                payload: { canvasId: "c1", expectedRevision: 3, document: other },
            },
        });
        recordCanvasDocumentBase(other as never, "user-b");
        useCanvasStore.setState({ projects: [other as never] });
        pauseCanvasBackendSubmit("c1", "user-b");

        hold.resume();
        await expect(pending).rejects.toMatchObject({ name: "CanvasStaleScopeError" });

        expect(useCanvasStore.getState().projects[0].title).toBe("新账号稿");
        expect(useCanvasStore.getState().projects[0].revision).toBe(3);
        const otherJournal = await loadCanvasOperationJournal("c1", "user-b");
        expect(otherJournal.confirmedRevision).toBe(3);
        expect(otherJournal.confirmedSnapshot?.title).toBe("新账号稿");
        expect(otherJournal.inFlight?.operationId).toBe("op-b");
        expect(canvasDocumentBase("c1", "user-b")?.snapshot.title).toBe("新账号稿");
        expect(canvasBackendSubmitPaused("c1", "user-b")).toBe(true);
        expect(peekCanvasOperationJournal("c1", "guest")?.confirmedRevision).toBe(22);
    });

    test("openLocalCanvasProjectFromBackend 失败时仍可能退回当前稿；恢复路径不得走这条", async () => {
        await seedLive(canvas("当前稿", 21));
        server.restore = { transport: true };
        await expect(restoreLocalCanvasProjectFromHistory("c1", { snapshotId: "snap-14", revision: 21 }))
            .rejects.toBeInstanceOf(TypeError);
        const opened = await openLocalCanvasProjectFromBackend("c1");
        expect(opened?.title).toBe("当前稿");
        expect(useCanvasStore.getState().projects[0].title).toBe("当前稿");
    });
});
