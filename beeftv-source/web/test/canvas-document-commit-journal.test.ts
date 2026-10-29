import { beforeEach, describe, expect, mock, test } from "bun:test";

type Stored = Map<string, string>;
const stored: Stored = new Map();
let activeScope = "guest";
let activeEpoch = 1;
let failNextSetItem = false;
let failSetItemOn = 0;
let setItemCount = 0;

function assertMockExpectedScope(config?: { expectedScope?: { userScope: string; epoch: number } }) {
    if (!config?.expectedScope) return;
    if (config.expectedScope.userScope !== activeScope || config.expectedScope.epoch !== activeEpoch) {
        const error = new Error("账号已切换，本次操作已停止");
        error.name = "UserScopeAbandonedError";
        throw error;
    }
}

function isRetryableStatus(status?: number) {
    return status === 408 || status === 425 || status === 429 || (status !== undefined && status >= 500 && status <= 599);
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
        this.retryable = options.retryable ?? isRetryableStatus(options.status ?? options.code);
    }
}

const server = {
    missingCreateReceipt: false,
    revision: 1,
    document: null as Record<string, unknown> | null,
    commits: [] as Array<{ opId: string; expectedRevision: number; title: string; nodeIds?: string[] }>,
    receipts: new Map<string, { revision: number; title: string }>(),
    failNext: null as { status?: number; retryable?: boolean; reason?: string; transport?: boolean } | null,
    hold: null as Promise<void> | null,
    holdDispatch: null as Promise<void> | null,
    dispatchWaiting: false,
    postStarted: 0,
    abortAfterCommit: false,
    deletes: [] as string[],
    deleteStarted: 0,
    deleteHold: null as Promise<void> | null,
    /** Opt-in compare-and-set: a commit without a receipt must name the current revision. */
    enforceRevision: false,
};

mock.module("@/lib/localforage-storage", () => ({
    localForageStorageForScope: (scope?: string) => ({
        getItem: async (name: string) => stored.get(`${scope ?? activeScope}:${name}`) ?? null,
        setItem: async (name: string, value: string) => {
            setItemCount += 1;
            if (failNextSetItem || (failSetItemOn > 0 && setItemCount === failSetItemOn)) {
                failNextSetItem = false;
                throw new Error("IndexedDB unavailable");
            }
            stored.set(`${scope ?? activeScope}:${name}`, value);
        },
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
        get: async (_path: string, config?: { expectedScope?: { userScope: string; epoch: number } }) => {
            if (server.holdDispatch) {
                server.dispatchWaiting = true;
                await server.holdDispatch;
                server.dispatchWaiting = false;
            }
            assertMockExpectedScope(config);
            return { project: server.document };
        },
        put: async (_path: string, _body: unknown, config?: { expectedScope?: { userScope: string; epoch: number } }) => {
            if (server.holdDispatch) {
                server.dispatchWaiting = true;
                await server.holdDispatch;
                server.dispatchWaiting = false;
            }
            assertMockExpectedScope(config);
            if (server.missingCreateReceipt) return {};
            return { project: { id: "c1", revision: 1 } };
        },
        post: async (_path: string, body: { opId: string; params: { expectedRevision: number; document: { title: string; nodes?: Array<{ id: string }> } } }, config?: { expectedScope?: { userScope: string; epoch: number } }) => {
            if (server.holdDispatch) {
                server.dispatchWaiting = true;
                await server.holdDispatch;
                server.dispatchWaiting = false;
            }
            assertMockExpectedScope(config);
            server.postStarted += 1;
            if (server.hold) await server.hold;
            if (server.failNext?.transport) {
                server.failNext = null;
                throw new TypeError("Failed to fetch");
            }
            if (server.failNext) {
                const failure = server.failNext;
                server.failNext = null;
                const options: { status?: number; reason?: string; retryable?: boolean } = { status: failure.status, reason: failure.reason };
                if (failure.retryable !== undefined) options.retryable = failure.retryable;
                throw new ApiError("保存失败", options);
            }
            const existing = server.receipts.get(body.opId);
            if (existing) {
                return {
                    op: "canvas.document.commit",
                    opId: body.opId,
                    replayed: true,
                    caller: "manual",
                    revision: existing.revision,
                    result: { canvasId: "c1", revision: existing.revision, updatedAt: "2026-01-01T00:00:00.000Z" },
                };
            }
            if (server.enforceRevision && body.params.expectedRevision !== server.revision) {
                throw new ApiError("画布已被其他入口修改", { status: 409, reason: "stale_revision" });
            }
            server.revision += 1;
            const document = body.params.document as { title: string; nodes?: Array<{ id: string }> };
            server.commits.push({
                opId: body.opId,
                expectedRevision: body.params.expectedRevision,
                title: document.title,
                nodeIds: (document.nodes ?? []).map((node) => node.id),
            });
            server.receipts.set(body.opId, { revision: server.revision, title: document.title });
            server.document = { ...body.params.document, id: "c1", revision: server.revision };
            if (server.abortAfterCommit) {
                server.abortAfterCommit = false;
                throw new DOMException("The operation was aborted", "AbortError");
            }
            return {
                op: "canvas.document.commit",
                opId: body.opId,
                replayed: false,
                caller: "manual",
                revision: server.revision,
                result: { canvasId: "c1", revision: server.revision, updatedAt: "2026-01-01T00:00:00.000Z" },
            };
        },
        delete: async (path: string, config?: { expectedScope?: { userScope: string; epoch: number } }) => {
            if (server.holdDispatch) {
                server.dispatchWaiting = true;
                await server.holdDispatch;
                server.dispatchWaiting = false;
            }
            assertMockExpectedScope(config);
            server.deleteStarted += 1;
            if (server.deleteHold) await server.deleteHold;
            server.deletes.push(path);
            return undefined;
        },
    },
}));

mock.module("@/services/local-workspace-sync", () => ({ notifyCanvasRefresh: () => {} }));
mock.module("@/services/canvas-sync-drafts", () => ({ preserveCanvasSyncDraft: async () => 1 }));
mock.module("@/stores/use-asset-store", () => ({ useAssetStore: { getState: () => ({ assets: [] }) } }));
mock.module("@/services/workspace-mode", () => ({ isLocalWorkspaceMode: () => true }));
mock.module("@/services/api/resources", () => ({ resourceIdFromStorageKey: () => "" }));

const { persistCanvasDocument, refreshLocalCanvasProjectIfChanged, resetLocalCanvasBackendSaveState, syncLocalCanvasProjectToBackend, hasUnconfirmedCanvasEdits, selectPreferredCanvasProject, deleteLocalCanvasProjects, adoptServerConfirmedGenerationPatch, openLocalCanvasProjectFromBackend, setCanvasProjectionStoreFlushForTest, CanvasStaleScopeError, CanvasBackendSubmitPausedError, CanvasProjectionError } = await import("@/services/local-workspace-repository");
const { setActiveUserScope } = await import("@/lib/user-scope");
const { captureUserScope } = await import("@/lib/user-scope-guard");
const { useCanvasStore, canvasDocumentBase, canvasExternalRevisionConflict, clearCanvasDocumentBase, clearCanvasExternalRevisionConflict, recordCanvasDocumentBase } = await import("@/stores/canvas/use-canvas-store");
const { CanvasJournalError, clearCanvasPendingProjection, loadCanvasOperationJournal, peekCanvasOperationJournal, recordConfirmedCanvasCommit, resetCanvasOperationJournalMemory, saveCanvasOperationJournal, setCanvasJournalStorageDelay, updateCanvasOperationJournal } = await import("@/services/canvas-operation-journal");
const { canvasBackendSubmitPaused, pauseCanvasBackendSubmit } = await import("@/services/canvas-revision-conflict");
const { projectSyncProgress, useSyncProgressStore } = await import("@/stores/use-sync-progress-store");
const { flushCanvasStorePersistence, canvasDurableSnapshot, registerCanvasGenerationPersistenceAttempt, withCanvasStorePersistenceSuppressed } = await import("@/stores/canvas/use-canvas-store");

function canvas(title: string, revision = 1, patch: Record<string, unknown> = {}) {
    return {
        id: "c1",
        revision,
        title,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        nodes: [],
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "grid",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
        directorScenes: [],
        ...patch,
    } as never;
}

function node(id: string, title: string, patch: Record<string, unknown> = {}) {
    return { id, type: "image", title, position: { x: 0, y: 0 }, width: 320, height: 220, metadata: {}, ...patch };
}

function connection(id: string, fromNodeId: string, toNodeId: string) {
    return { id, fromNodeId, toNodeId };
}

async function seedConfirmed(doc: ReturnType<typeof canvas> = canvas("基线", 1), scope = activeScope) {
    await saveCanvasOperationJournal({
        userScope: scope,
        canvasId: "c1",
        confirmedRevision: (doc as { revision: number }).revision,
        confirmedSnapshot: doc,
        inFlight: null,
    });
    recordCanvasDocumentBase(doc as never, scope);
    useCanvasStore.setState({ projects: [doc as never] });
}

test("真实保存途中删除图片节点会再次提交删除，且不启动生成", async () => {
    const { persistCanvasGenerationTarget } = await import("@/services/canvas-generation-target");
    const target = node("image-target", "新图片");
    await seedConfirmed(canvas("基线"));
    useCanvasStore.getState().updateProject("c1", { nodes: [target as never] });
    let release!: () => void;
    server.hold = new Promise<void>((resolve) => { release = resolve; });
    const saving = persistCanvasGenerationTarget({ projectId: "c1", nodeId: target.id, expectedScope: captureUserScope() });
    // Attach rejection before releasing the held HTTP acknowledgement.
    const rejected = saving.catch((error: unknown) => error);
    await waitUntil(() => server.postStarted === 1);
    useCanvasStore.getState().updateProject("c1", { nodes: [] });
    release();
    expect(await rejected).toMatchObject({ message: "生成节点已不存在，未开始生成" });
    expect((server.document as { nodes: unknown[] }).nodes).toEqual([]);
    expect(useCanvasStore.getState().openProject("c1")?.nodes).toEqual([]);
});

test("多张图片的真实保存串行读取最新画布，不覆盖已完成的另一张图", async () => {
    const { persistCanvasGenerationTarget } = await import("@/services/canvas-generation-target");
    const first = node("image-a", "A");
    const second = node("image-b", "B");
    await seedConfirmed(canvas("基线"));
    const connections = [connection("ab", first.id, second.id)];
    useCanvasStore.getState().updateProject("c1", { nodes: [first, second] as never, connections });
    let release!: () => void;
    server.hold = new Promise<void>((resolve) => { release = resolve; });
    const expectedScope = captureUserScope();
    const savingA = persistCanvasGenerationTarget({ projectId: "c1", nodeId: first.id, expectedScope });
    const savingB = persistCanvasGenerationTarget({ projectId: "c1", nodeId: second.id, expectedScope });
    await waitUntil(() => server.postStarted === 1);
    useCanvasStore.getState().updateProject("c1", { nodes: [node(first.id, "A", { metadata: { taskId: "task-a", status: "success", content: "/a.png" } }), second] as never });
    release();
    await Promise.all([savingA, savingB]);
    const document = server.document as { nodes: Array<{ id: string; metadata: Record<string, unknown> }>; connections: unknown[] };
    expect(document.nodes.find((item) => item.id === first.id)?.metadata).toMatchObject({ taskId: "task-a", status: "success", content: "/a.png" });
    expect(document.connections).toEqual(connections);
    expect(document.nodes.map((item) => item.id)).toEqual([first.id, second.id]);
});

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
        wait: () => waitUntil(() => waiting),
        resume: () => {
            setCanvasJournalStorageDelay(null);
            release();
        },
    };
}

async function waitUntil(predicate: () => boolean, attempts = 80) {
    for (let attempt = 0; attempt < attempts && !predicate(); attempt += 1) await Promise.resolve();
    expect(predicate()).toBe(true);
}

beforeEach(() => {
    stored.clear();
    resetCanvasOperationJournalMemory();
    resetLocalCanvasBackendSaveState();
    activeScope = "guest";
    activeEpoch = 1;
    failNextSetItem = false;
    failSetItemOn = 0;
    setItemCount = 0;
    server.revision = 1;
    server.missingCreateReceipt = false;
    server.document = canvas("基线", 1);
    server.commits = [];
    server.receipts.clear();
    server.failNext = null;
    server.hold = null;
    server.holdDispatch = null;
    server.dispatchWaiting = false;
    server.postStarted = 0;
    server.abortAfterCommit = false;
    server.deletes = [];
    server.deleteStarted = 0;
    server.deleteHold = null;
    server.enforceRevision = false;
    useSyncProgressStore.getState().clearAll();
    clearCanvasExternalRevisionConflict("guest", "c1");
    clearCanvasExternalRevisionConflict("user-a", "c1");
    clearCanvasExternalRevisionConflict("user-b", "c1");
    useCanvasStore.setState({ projects: [canvas("基线", 1)] });
    recordCanvasDocumentBase(canvas("基线", 1));
});

describe("画布文档提交日记", () => {
    test("revision 76 confirmed graph survives cache projection, restart and revision 77 ordinary save", async () => {
        await useCanvasStore.persist.rehydrate();
        const nodes = Array.from({ length: 10 }, (_, index) => node(`n${index}`, `Node ${index}`));
        nodes[0]!.metadata = { generationEffectKeys: ["old-broken-result"], status: "error" } as never;
        // Revision 69 precedes the Agent's node creation (70) and six edge writes (71-76).
        const base = canvas("基线", 69, { nodes: nodes.slice(0, 4) });
        await seedConfirmed(base);
        await flushCanvasStorePersistence();
        const edges = Array.from({ length: 6 }, (_, index) => connection(`e${index}`, `n${index}`, `n${index + 1}`));
        const remoteNodes = structuredClone(nodes);
        remoteNodes[2]!.metadata = { generationEffectKeys: ["attach-result"], content: "/api/resources/video/file", status: "success" } as never;
        server.revision = 76;
        server.document = canvas("基线", 76, { nodes: remoteNodes, connections: edges });
        await openLocalCanvasProjectFromBackend("c1");
        expect(canvasDurableSnapshot(activeScope, "c1")?.nodes).toHaveLength(10);
        expect(canvasDurableSnapshot(activeScope, "c1")?.connections).toEqual(edges);
        expect(canvasDurableSnapshot(activeScope, "c1")?.nodes[2]?.metadata).toEqual(remoteNodes[2]!.metadata);
        // Restart consumes persisted browser data and the durable journal, not the old live store.
        withCanvasStorePersistenceSuppressed(() => useCanvasStore.setState({ projects: [] }));
        resetCanvasOperationJournalMemory();
        resetLocalCanvasBackendSaveState();
        await useCanvasStore.persist.rehydrate();
        await openLocalCanvasProjectFromBackend("c1");
        useCanvasStore.getState().updateProject("c1", { title: "人工改名" });
        await syncLocalCanvasProjectToBackend("c1");
        expect(server.revision).toBe(77);
        expect(server.document?.connections).toEqual(edges);
        expect((server.document?.nodes as typeof nodes)[2]!.metadata).toEqual(remoteNodes[2]!.metadata);
        expect(peekCanvasOperationJournal("c1")?.confirmedRevision).toBe(77);
    });

    test("unconfirmed generation rolls back only its edges and nodes while keeping manual edits and deletions", async () => {
        await useCanvasStore.persist.rehydrate();
        const nodes = [node("n1", "One"), node("n2", "Two")];
        const removed = connection("manual-delete", "n1", "n2");
        const modified = connection("manual-edit", "n1", "n2");
        await seedConfirmed(canvas("基线", 1, { nodes, connections: [removed, modified] }));
        await flushCanvasStorePersistence();
        const generated = node("generated", "Unconfirmed", { metadata: { generationEffectKeys: ["pending"] } });
        const genEdge = connection("generation-existing-endpoints", "n1", "n2");
        const unregister = registerCanvasGenerationPersistenceAttempt(activeScope, "c1", "pending", {
            previousNodes: nodes as never, nodes: [...nodes, generated] as never,
            previousConnections: [removed, modified], connections: [removed, modified, genEdge],
        });
        try {
            const manual = { ...modified, toNodeId: "n1" };
            const added = connection("manual-add", "n2", "n1");
            useCanvasStore.getState().updateProject("c1", {
                nodes: [{ ...nodes[0]!, title: "Manual title" }, nodes[1]!, generated] as never,
                connections: [manual, added, genEdge, connection("rolled-back-endpoint", "n1", "generated"), connection("invalid", "missing", "n2")],
            });
            await flushCanvasStorePersistence();
            const saved = canvasDurableSnapshot(activeScope, "c1")!;
            expect(saved.connections).toEqual([manual, added]);
            expect(saved.nodes.map((item) => item.id)).toEqual(["n1", "n2"]);
            expect(saved.nodes[0]!.title).toBe("Manual title");
        } finally { unregister(); }
    });

    test("an unrelated unconfirmed stamp cannot restore a manually deleted confirmed edge", async () => {
        await useCanvasStore.persist.rehydrate();
        const nodes = [node("n1", "One"), node("n2", "Two")];
        await seedConfirmed(canvas("基线", 1, { nodes, connections: [connection("e", "n1", "n2")] }));
        await flushCanvasStorePersistence();
        useCanvasStore.getState().updateProject("c1", {
            nodes: [{ ...nodes[0]!, metadata: { generationEffectKeys: ["not-confirmed"] } }, nodes[1]!] as never,
            connections: [],
        });
        await flushCanvasStorePersistence();
        expect(canvasDurableSnapshot(activeScope, "c1")?.connections).toEqual([]);
        expect(canvasDurableSnapshot(activeScope, "c1")?.nodes[0]?.metadata?.generationEffectKeys).toBeUndefined();
    });

    test("首次保存 200 但缺少画布回执不能确认成功，草稿保留可重试", async () => {
        clearCanvasDocumentBase("c1");
        useCanvasStore.setState({ projects: [canvas("新画布", 0)] });
        server.missingCreateReceipt = true;
        await expect(syncLocalCanvasProjectToBackend("c1")).rejects.toThrow("画布保存回执无效");
        expect(useCanvasStore.getState().openProject("c1")?.title).toBe("新画布");
        expect(useCanvasStore.getState().openProject("c1")?.revision).toBe(0);
        expect(peekCanvasOperationJournal("c1")?.confirmedRevision || 0).toBe(0);
        server.missingCreateReceipt = false;
        await syncLocalCanvasProjectToBackend("c1");
        expect(useCanvasStore.getState().openProject("c1")?.revision).toBe(1);
    });

    test("干净缓存采用后端，脏草稿相对已记录基线保留", () => {
        const localClean = canvas("基线", 1);
        const backend = canvas("助手改过", 2);
        recordCanvasDocumentBase(localClean);
        expect(selectPreferredCanvasProject(localClean, backend).title).toBe("助手改过");

        const localDirty = canvas("本地草稿", 1);
        recordCanvasDocumentBase(canvas("基线", 1));
        expect(selectPreferredCanvasProject(localDirty, backend).title).toBe("本地草稿");
    });

    test("启动恢复提交不能用 loading 空 overlay 覆盖已确认 success+storageKey", async () => {
        const node1 = node("image-1790921196364-0djku", "图片", {
            metadata: {
                taskId: "016077a262cc8f86b127e1cad4b6bf9f",
                status: "loading",
                taskStatus: "succeeded",
                content: "",
                errorDetails: "正在从任务中心恢复生成状态...",
            },
        });
        const node2 = node("node-dlu63hran9ns-43e87554d6", "图片", {
            metadata: {
                taskId: "e24cb37f0a7d146afc8560456d88a550",
                status: "success",
                taskStatus: "succeeded",
                content: "/api/resources/8edbd8862c4714bbe42424d83e63bc08/file",
                storageKey: "resource:8edbd8862c4714bbe42424d83e63bc08",
                assetId: "generation_b4ef53b7ce14b86365c28d172bd64fc5591175be1667e8ecc9717775babc87d5",
            },
        });
        const confirmed = canvas("未命名项目", 34, { nodes: [node1, node2] });
        await seedConfirmed(confirmed);
        server.revision = 34;
        server.document = confirmed as never;
        const overlay = [
            { ...node1, metadata: { ...node1.metadata, errorDetails: undefined } },
            { ...node2, metadata: { taskId: node2.metadata.taskId, status: "loading", taskStatus: "succeeded", content: "" } },
        ];
        expect("resultJson" in overlay[1].metadata).toBe(false);
        await persistCanvasDocument("c1", { nodes: overlay });
        const committed = server.document as { nodes: Array<{ id: string; metadata?: Record<string, unknown> }> };
        const second = committed.nodes.find((item) => item.id === node2.id);
        expect(second?.metadata?.status).toBe("success");
        expect(second?.metadata?.storageKey).toBe("resource:8edbd8862c4714bbe42424d83e63bc08");
        expect(second?.metadata?.content).toBe("/api/resources/8edbd8862c4714bbe42424d83e63bc08/file");
        const live = useCanvasStore.getState().openProject("c1")?.nodes.find((item) => item.id === node2.id);
        expect(live?.metadata?.storageKey).toBe("resource:8edbd8862c4714bbe42424d83e63bc08");
        expect(live?.metadata?.status).toBe("success");
    });

    test("打开画布时本地 loading 空 overlay 不能挡住后端同 task 的 success", async () => {
        const node2 = node("node-dlu63hran9ns-43e87554d6", "图片", {
            metadata: {
                taskId: "e24cb37f0a7d146afc8560456d88a550",
                status: "success",
                taskStatus: "succeeded",
                content: "/api/resources/8edbd8862c4714bbe42424d83e63bc08/file",
                storageKey: "resource:8edbd8862c4714bbe42424d83e63bc08",
            },
        });
        const confirmed = canvas("未命名项目", 34, { nodes: [node2] });
        const overlay = canvas("未命名项目", 34, {
            nodes: [{ ...node2, metadata: { taskId: node2.metadata.taskId, status: "loading", taskStatus: "succeeded", content: "" } }],
        });
        await seedConfirmed(confirmed);
        useCanvasStore.setState({ projects: [overlay as never] });
        server.revision = 34;
        server.document = confirmed as never;
        const opened = await openLocalCanvasProjectFromBackend("c1");
        const openedNode = opened?.nodes.find((item) => item.id === node2.id);
        expect(openedNode?.metadata?.status).toBe("success");
        expect(openedNode?.metadata?.storageKey).toBe("resource:8edbd8862c4714bbe42424d83e63bc08");
        expect(useCanvasStore.getState().openProject("c1")?.nodes[0]?.metadata?.storageKey).toBe("resource:8edbd8862c4714bbe42424d83e63bc08");
    });

    test("新任务清掉 content 键后提交不会把旧 task 的 storageKey 写回", async () => {
        const oldNode = node("node-dlu63hran9ns-43e87554d6", "图片", {
            metadata: {
                taskId: "e24cb37f0a7d146afc8560456d88a550",
                status: "success",
                taskStatus: "succeeded",
                content: "/api/resources/8edbd8862c4714bbe42424d83e63bc08/file",
                storageKey: "resource:8edbd8862c4714bbe42424d83e63bc08",
            },
        });
        await seedConfirmed(canvas("未命名项目", 34, { nodes: [oldNode] }));
        server.revision = 34;
        await persistCanvasDocument("c1", {
            nodes: [{ ...oldNode, metadata: { taskId: "task-new", status: "loading", taskStatus: "running", prompt: "新提示" } }],
        });
        const committed = (server.document as { nodes: Array<{ metadata?: Record<string, unknown> }> }).nodes[0];
        expect(committed.metadata?.taskId).toBe("task-new");
        expect(committed.metadata?.status).toBe("loading");
        expect(committed.metadata?.storageKey).toBeUndefined();
    });

    test("网络未知时重试复用同一 operationId 与 payload，后续编辑另开一笔", async () => {
        useCanvasStore.getState().updateProject("c1", { title: "第一次" });
        server.failNext = { status: 503 };
        await expect(syncLocalCanvasProjectToBackend("c1")).rejects.toThrow();
        const journal = await loadCanvasOperationJournal("c1");
        expect(journal.inFlight?.operationId).toBeTruthy();
        expect(journal.inFlight?.payload.document.title).toBe("第一次");
        const firstId = journal.inFlight!.operationId;

        useCanvasStore.getState().updateProject("c1", { title: "第二次" });
        await syncLocalCanvasProjectToBackend("c1");

        expect(server.commits[0]?.opId).toBe(firstId);
        expect(server.commits[0]?.title).toBe("第一次");
        expect(server.commits[1]?.opId).not.toBe(firstId);
        expect(server.commits[1]?.title).toBe("第二次");
        expect(hasUnconfirmedCanvasEdits("c1")).toBe(false);
    });

    test("没有 HTTP 响应时同样复用同一 operationId", async () => {
        useCanvasStore.getState().updateProject("c1", { title: "断线提交" });
        server.failNext = { retryable: false };
        await expect(syncLocalCanvasProjectToBackend("c1")).rejects.toThrow();
        const firstId = (await loadCanvasOperationJournal("c1")).inFlight?.operationId;
        expect(firstId).toBeTruthy();
        await syncLocalCanvasProjectToBackend("c1");
        expect(server.commits).toEqual([expect.objectContaining({ opId: firstId, title: "断线提交" })]);
    });

    test("传输层 TypeError 保留同一 operationId 与草稿", async () => {
        useCanvasStore.getState().updateProject("c1", { title: "传输失败" });
        server.failNext = { transport: true };
        await expect(syncLocalCanvasProjectToBackend("c1")).rejects.toBeInstanceOf(TypeError);
        const firstId = (await loadCanvasOperationJournal("c1")).inFlight?.operationId;
        expect(firstId).toBeTruthy();
        expect(useCanvasStore.getState().projects[0].title).toBe("传输失败");
        await syncLocalCanvasProjectToBackend("c1");
        expect(server.commits).toEqual([expect.objectContaining({ opId: firstId, title: "传输失败" })]);
    });

    test("服务端已提交后取消：保留 operationId，回放不另开 revision", async () => {
        useCanvasStore.getState().updateProject("c1", { title: "取消后仍在" });
        server.abortAfterCommit = true;
        await expect(syncLocalCanvasProjectToBackend("c1")).rejects.toBeInstanceOf(DOMException);
        const journal = await loadCanvasOperationJournal("c1");
        expect(journal.inFlight?.operationId).toBeTruthy();
        expect(journal.inFlight?.payload.document.title).toBe("取消后仍在");
        expect(useCanvasStore.getState().projects[0].title).toBe("取消后仍在");
        const firstId = journal.inFlight!.operationId;
        expect(server.commits).toEqual([expect.objectContaining({ opId: firstId, title: "取消后仍在" })]);

        await syncLocalCanvasProjectToBackend("c1");
        expect(server.commits).toHaveLength(1);
        expect((await loadCanvasOperationJournal("c1")).inFlight).toBeNull();
        expect(useCanvasStore.getState().projects[0].title).toBe("取消后仍在");
    });

    test("被拒绝的远端写入不得记成已保存", async () => {
        useCanvasStore.getState().updateProject("c1", { title: "冲突草稿" });
        server.failNext = { status: 409, reason: "stale_revision" };
        await expect(syncLocalCanvasProjectToBackend("c1")).rejects.toThrow();
        expect(useCanvasStore.getState().projects[0].title).toBe("冲突草稿");
        expect(hasUnconfirmedCanvasEdits("c1")).toBe(true);
        expect(canvasDocumentBase("c1")?.snapshot.title).toBe("基线");
        expect((await loadCanvasOperationJournal("c1")).inFlight).toBeNull();
    });

    test("显式 persist 遇到陈旧 revision 时保留本地草稿", async () => {
        useCanvasStore.getState().updateProject("c1", { title: "冲突草稿" });
        server.failNext = { status: 409, reason: "stale_revision" };
        await expect(persistCanvasDocument("c1", { nodes: [] })).rejects.toThrow();
        expect(useCanvasStore.getState().projects[0].title).toBe("冲突草稿");
        expect(hasUnconfirmedCanvasEdits("c1")).toBe(true);
        expect(canvasDocumentBase("c1")?.snapshot.title).toBe("基线");
    });

    test("用户作用域隔离：不会重放另一用户的 payload", async () => {
        await saveCanvasOperationJournal({
            userScope: "user-b",
            canvasId: "c1",
            confirmedRevision: 9,
            confirmedSnapshot: canvas("别人的", 9),
            inFlight: {
                operationId: "foreign-op",
                expectedRevision: 9,
                payload: { canvasId: "c1", expectedRevision: 9, document: canvas("别人的", 9) },
            },
        });
        activeScope = "user-a";
        resetCanvasOperationJournalMemory();
        const loaded = await loadCanvasOperationJournal("c1", "user-a");
        expect(loaded.inFlight).toBeNull();
        expect(loaded.confirmedSnapshot).toBeNull();
    });

    test("账号切换时进行中的提交写回原作用域，不污染新账号", async () => {
        activeScope = "user-a";
        resetCanvasOperationJournalMemory();
        useCanvasStore.setState({ projects: [canvas("用户A基线", 1)] });
        recordCanvasDocumentBase(canvas("用户A基线", 1), "user-a");
        await saveCanvasOperationJournal({
            userScope: "user-a",
            canvasId: "c1",
            confirmedRevision: 1,
            confirmedSnapshot: canvas("用户A基线", 1),
            inFlight: null,
        });
        useCanvasStore.getState().updateProject("c1", { title: "用户A草稿" });

        let release = () => {};
        server.hold = new Promise<void>((resolve) => { release = resolve; });
        const pending = persistCanvasDocument("c1", { title: "用户A草稿" });
        await waitUntil(() => server.postStarted === 1);

        activeScope = "user-b";
        useCanvasStore.setState({ projects: [canvas("用户B画布", 1)] });
        recordCanvasDocumentBase(canvas("用户B画布", 1), "user-b");
        release();
        await pending;

        const journalA = await loadCanvasOperationJournal("c1", "user-a");
        expect(journalA.inFlight).toBeNull();
        expect(journalA.confirmedRevision).toBeGreaterThan(1);
        expect(journalA.confirmedSnapshot?.title).toBe("用户A草稿");
        expect(canvasDocumentBase("c1", "user-a")?.snapshot.title).toBe("用户A草稿");

        expect(useCanvasStore.getState().projects[0].title).toBe("用户B画布");
        expect(canvasDocumentBase("c1", "user-b")?.snapshot.title).toBe("用户B画布");
        const journalB = await loadCanvasOperationJournal("c1", "user-b");
        expect(journalB.inFlight).toBeNull();
        expect(journalB.confirmedSnapshot).toBeNull();
    });

    test("重启后脏草稿仍相对记录基线未确认", async () => {
        await saveCanvasOperationJournal({
            userScope: "guest",
            canvasId: "c1",
            confirmedRevision: 1,
            confirmedSnapshot: canvas("基线", 1),
            inFlight: null,
        });
        useCanvasStore.getState().updateProject("c1", { title: "未确认草稿" });
        expect(hasUnconfirmedCanvasEdits("c1")).toBe(true);
        resetCanvasOperationJournalMemory();
        clearCanvasDocumentBase("c1");
        await loadCanvasOperationJournal("c1");
        useCanvasStore.setState({ projects: [canvas("未确认草稿", 1)] });
        expect(hasUnconfirmedCanvasEdits("c1")).toBe(true);
        expect(selectPreferredCanvasProject(canvas("未确认草稿", 1), canvas("助手改过", 2)).title).toBe("未确认草稿");
    });

    test("损坏的日记 fail-closed，不发明空操作", async () => {
        stored.set("guest:canvas-document-journal:c1", "{not-json");
        await expect(loadCanvasOperationJournal("c1")).rejects.toBeInstanceOf(CanvasJournalError);
        expect(peekCanvasOperationJournal("c1")).toBeUndefined();

        stored.set("guest:canvas-document-journal:c1", JSON.stringify({ userScope: "guest", canvasId: "c1" }));
        await expect(loadCanvasOperationJournal("c1")).rejects.toBeInstanceOf(CanvasJournalError);
        expect(peekCanvasOperationJournal("c1")).toBeUndefined();
    });

    test("IndexedDB 写入失败时不发布内存日记，下次保存使用新 operationId", async () => {
        useCanvasStore.getState().updateProject("c1", { title: "未落盘" });
        failNextSetItem = true;
        await expect(syncLocalCanvasProjectToBackend("c1")).rejects.toThrow("IndexedDB unavailable");
        expect(server.postStarted).toBe(0);
        expect(peekCanvasOperationJournal("c1")?.inFlight).toBeFalsy();
        expect(useCanvasStore.getState().projects[0].title).toBe("未落盘");

        await syncLocalCanvasProjectToBackend("c1");
        expect(server.commits).toHaveLength(1);
        expect(server.commits[0]?.title).toBe("未落盘");
        expect((await loadCanvasOperationJournal("c1")).inFlight).toBeNull();
    });

    test("刷新与非匹配 ack 不得清除未确认操作，confirmedRevision 不回退", async () => {
        await saveCanvasOperationJournal({
            userScope: "guest",
            canvasId: "c1",
            confirmedRevision: 1,
            confirmedSnapshot: canvas("基线", 1),
            inFlight: {
                operationId: "op-keep",
                expectedRevision: 1,
                payload: { canvasId: "c1", expectedRevision: 1, document: canvas("在途", 1) },
            },
        });
        await recordConfirmedCanvasCommit(canvas("刷新", 4));
        let journal = await loadCanvasOperationJournal("c1");
        expect(journal.inFlight?.operationId).toBe("op-keep");
        expect(journal.confirmedRevision).toBe(4);
        expect(journal.confirmedSnapshot?.title).toBe("刷新");

        await recordConfirmedCanvasCommit(canvas("更旧回执", 2), "guest", { ackOperationId: "other-op" });
        journal = await loadCanvasOperationJournal("c1");
        expect(journal.inFlight?.operationId).toBe("op-keep");
        expect(journal.confirmedRevision).toBe(4);
        expect(journal.confirmedSnapshot?.title).toBe("刷新");

        await recordConfirmedCanvasCommit(canvas("确认", 6), "guest", { ackOperationId: "op-keep" });
        journal = await loadCanvasOperationJournal("c1");
        expect(journal.inFlight).toBeNull();
        expect(journal.confirmedRevision).toBe(6);
    });

    test("丢失响应后外部写入再回放：原操作按回执确认，后来的编辑与远端同字段冲突时保留本地并暂停", async () => {
        server.enforceRevision = true;
        await saveCanvasOperationJournal({
            userScope: "guest",
            canvasId: "c1",
            confirmedRevision: 1,
            confirmedSnapshot: canvas("基线", 1),
            inFlight: null,
        });
        useCanvasStore.getState().updateProject("c1", { title: "第一次" });
        server.abortAfterCommit = true;
        await expect(syncLocalCanvasProjectToBackend("c1")).rejects.toBeInstanceOf(DOMException);
        const firstId = (await loadCanvasOperationJournal("c1")).inFlight?.operationId;
        expect(firstId).toBeTruthy();

        useCanvasStore.getState().updateProject("c1", { title: "后来的编辑" });
        server.revision = 5;
        server.document = canvas("助手改过", 5);
        // 在途提交结果未知：刷新既不合并也不暂停，先等原 operationId 重放拿到真实回执。
        expect(await refreshLocalCanvasProjectIfChanged("c1")).toBeUndefined();
        expect(useCanvasStore.getState().projects[0].title).toBe("后来的编辑");
        expect((await loadCanvasOperationJournal("c1")).inFlight?.operationId).toBe(firstId);
        expect((await loadCanvasOperationJournal("c1")).confirmedRevision).toBe(1);
        expect(canvasBackendSubmitPaused("c1")).toBe(false);
        expect(canvasExternalRevisionConflict("guest", "c1")).toBeUndefined();

        // 重放拿到原回执；后来的编辑按 revision 2 提交被拒，读回 revision 5 后标题两边都改过：保留本地并暂停。
        await expect(syncLocalCanvasProjectToBackend("c1")).rejects.toThrow();
        const journal = await loadCanvasOperationJournal("c1");
        expect(journal.inFlight).toBeNull();
        expect(journal.confirmedRevision).toBe(2);
        expect(journal.confirmedSnapshot?.title).toBe("第一次");
        expect(useCanvasStore.getState().projects[0].title).toBe("后来的编辑");
        expect(canvasBackendSubmitPaused("c1")).toBe(true);
        expect(canvasExternalRevisionConflict("guest", "c1")?.remoteRevision).toBe(5);
        await expect(syncLocalCanvasProjectToBackend("c1")).rejects.toBeInstanceOf(CanvasBackendSubmitPausedError);
        expect(server.commits).toEqual([
            expect.objectContaining({ opId: firstId, title: "第一次" }),
        ]);
        expect((server.document as { title: string }).title).toBe("助手改过");
    });

    test("外部新增节点时本地改了另一节点：刷新三路合并两边都保留，并按最新 revision 提交", async () => {
        server.enforceRevision = true;
        const localNode = node("n1", "镜头1");
        const remoteAdded = node("n2", "助手加的");
        useCanvasStore.setState({ projects: [canvas("基线", 1, { nodes: [localNode] })] });
        recordCanvasDocumentBase(canvas("基线", 1, { nodes: [localNode] }));
        await saveCanvasOperationJournal({
            userScope: "guest",
            canvasId: "c1",
            confirmedRevision: 1,
            confirmedSnapshot: canvas("基线", 1, { nodes: [localNode] }),
            inFlight: null,
        });
        useCanvasStore.getState().updateProject("c1", { nodes: [{ ...localNode, title: "本地改名" }] as never });

        server.revision = 5;
        server.document = canvas("助手加了节点", 5, { nodes: [localNode, remoteAdded] });
        const applied = await refreshLocalCanvasProjectIfChanged("c1");
        expect(applied?.nodes.map((item) => item.id)).toEqual(["n1", "n2"]);

        const live = useCanvasStore.getState().projects[0];
        expect(live.nodes.map((item) => item.id)).toEqual(["n1", "n2"]);
        expect(live.nodes[0].title).toBe("本地改名");
        expect(live.title).toBe("助手加了节点");
        expect((await loadCanvasOperationJournal("c1")).confirmedRevision).toBe(5);
        expect(canvasDocumentBase("c1")?.snapshot.title).toBe("助手加了节点");
        expect(canvasBackendSubmitPaused("c1")).toBe(false);
        expect(canvasExternalRevisionConflict("guest", "c1")).toBeUndefined();
        expect(projectSyncProgress("c1")?.phase).toBe("pending");

        await syncLocalCanvasProjectToBackend("c1");
        expect(server.commits).toEqual([expect.objectContaining({ expectedRevision: 5, nodeIds: ["n1", "n2"] })]);
        const saved = server.document as { title: string; nodes: Array<{ id: string; title: string }> };
        expect(saved.nodes.map((item) => item.title)).toEqual(["本地改名", "助手加的"]);
        expect(saved.title).toBe("助手加了节点");
        expect(useCanvasStore.getState().projects[0].nodes[0].title).toBe("本地改名");
    });

    test("同画布日记更新串行，后写基于队列内最新快照", async () => {
        let releaseGet = () => {};
        const getHold = new Promise<void>((resolve) => { releaseGet = resolve; });
        let gets = 0;
        resetCanvasOperationJournalMemory();
        setCanvasJournalStorageDelay({
            beforeGet: async () => {
                gets += 1;
                if (gets === 1) await getHold;
            },
        });

        const first = updateCanvasOperationJournal("c1", "guest", (current) => ({
            ...current,
            confirmedRevision: 1,
            confirmedSnapshot: canvas("基线", 1),
        }));
        await waitUntil(() => gets === 1);
        const second = updateCanvasOperationJournal("c1", "guest", (current) => ({
            ...current,
            inFlight: {
                operationId: "op-keep",
                expectedRevision: current.confirmedRevision,
                payload: { canvasId: "c1", expectedRevision: current.confirmedRevision, document: canvas("在途", current.confirmedRevision) },
            },
        }));
        releaseGet();
        await first;
        await second;
        const journal = await loadCanvasOperationJournal("c1");
        expect(journal.confirmedRevision).toBe(1);
        expect(journal.inFlight?.operationId).toBe("op-keep");
        expect(journal.confirmedSnapshot?.title).toBe("基线");
    });

    test("peek 给出的在途 payload 被篡改不会改写已序列化请求", async () => {
        await saveCanvasOperationJournal({
            userScope: "guest",
            canvasId: "c1",
            confirmedRevision: 1,
            confirmedSnapshot: canvas("基线", 1),
            inFlight: {
                operationId: "op-keep",
                expectedRevision: 1,
                payload: { canvasId: "c1", expectedRevision: 1, document: canvas("在途", 1) },
            },
        });
        const peeked = peekCanvasOperationJournal("c1");
        expect(peeked?.inFlight?.payload.document.title).toBe("在途");
        (peeked!.inFlight!.payload.document as { title: string }).title = "篡改";
        expect(peekCanvasOperationJournal("c1")?.inFlight?.payload.document.title).toBe("在途");
    });

    test("日记确认写入失败时不把 HTTP 回执当成已保存", async () => {
        useCanvasStore.getState().updateProject("c1", { title: "未确认回执" });
        failSetItemOn = 2;
        await expect(syncLocalCanvasProjectToBackend("c1")).rejects.toThrow("IndexedDB unavailable");
        expect(server.postStarted).toBe(1);
        expect(server.commits).toHaveLength(1);
        expect(peekCanvasOperationJournal("c1")?.inFlight?.payload.document.title).toBe("未确认回执");
        expect(canvasDocumentBase("c1")?.snapshot.title).toBe("基线");
        expect(hasUnconfirmedCanvasEdits("c1")).toBe(true);
    });

    test("账号切换后未发出的提交返回过期作用域错误，不是成功", async () => {
        activeScope = "user-a";
        resetCanvasOperationJournalMemory();
        useCanvasStore.setState({ projects: [canvas("用户A基线", 1)] });
        recordCanvasDocumentBase(canvas("用户A基线", 1), "user-a");
        await saveCanvasOperationJournal({
            userScope: "user-a",
            canvasId: "c1",
            confirmedRevision: 1,
            confirmedSnapshot: canvas("用户A基线", 1),
            inFlight: null,
        });
        useCanvasStore.getState().updateProject("c1", { title: "用户A草稿" });

        let release = () => {};
        server.hold = new Promise<void>((resolve) => { release = resolve; });
        const first = persistCanvasDocument("c1", { title: "用户A草稿" });
        await waitUntil(() => server.postStarted === 1);

        useCanvasStore.getState().updateProject("c1", { title: "用户A再改" });
        const second = persistCanvasDocument("c1", { title: "用户A再改" });
        activeScope = "user-b";
        useCanvasStore.setState({ projects: [canvas("用户B画布", 1)] });
        recordCanvasDocumentBase(canvas("用户B画布", 1), "user-b");
        release();
        await first;
        await expect(second).rejects.toBeInstanceOf(CanvasStaleScopeError);
        expect(server.commits).toHaveLength(1);
        expect(useCanvasStore.getState().projects[0].title).toBe("用户B画布");
    });

    test("删除与未完成提交串行，账号切换后不以新凭证删除同一 id", async () => {
        activeScope = "user-a";
        resetCanvasOperationJournalMemory();
        useCanvasStore.setState({ projects: [canvas("用户A基线", 1)] });
        recordCanvasDocumentBase(canvas("用户A基线", 1), "user-a");
        await saveCanvasOperationJournal({
            userScope: "user-a",
            canvasId: "c1",
            confirmedRevision: 1,
            confirmedSnapshot: canvas("用户A基线", 1),
            inFlight: null,
        });
        useCanvasStore.getState().updateProject("c1", { title: "用户A草稿" });

        let release = () => {};
        server.hold = new Promise<void>((resolve) => { release = resolve; });
        const save = persistCanvasDocument("c1", { title: "用户A草稿" });
        await waitUntil(() => server.postStarted === 1);

        const pendingDelete = deleteLocalCanvasProjects(["c1"]);
        await Promise.resolve();
        expect(server.deleteStarted).toBe(0);

        activeScope = "user-b";
        useCanvasStore.setState({ projects: [canvas("用户B画布", 1)] });
        recordCanvasDocumentBase(canvas("用户B画布", 1), "user-b");
        release();
        await save;
        await expect(pendingDelete).rejects.toBeInstanceOf(CanvasStaleScopeError);
        expect(server.deleteStarted).toBe(0);
        expect(server.deletes).toEqual([]);
        expect(useCanvasStore.getState().projects[0].title).toBe("用户B画布");
        expect(canvasDocumentBase("c1", "user-b")?.snapshot.title).toBe("用户B画布");
    });

    async function seedUserACanvas() {
        activeScope = "user-a";
        activeEpoch = 1;
        resetCanvasOperationJournalMemory();
        useCanvasStore.setState({ projects: [canvas("用户A基线", 1)] });
        recordCanvasDocumentBase(canvas("用户A基线", 1), "user-a");
        await saveCanvasOperationJournal({
            userScope: "user-a",
            canvasId: "c1",
            confirmedRevision: 1,
            confirmedSnapshot: canvas("用户A基线", 1),
            inFlight: null,
        });
    }

    function bounceAccountBackToA(title = "用户A回来") {
        setActiveUserScope("user-b");
        useCanvasStore.setState({ projects: [canvas("用户B画布", 1)] });
        recordCanvasDocumentBase(canvas("用户B画布", 1), "user-b");
        setActiveUserScope("user-a");
        useCanvasStore.setState({ projects: [canvas(title, 1)] });
        recordCanvasDocumentBase(canvas(title, 1), "user-a");
    }

    test("A→B→A 未发出的提交不再自己 dispatch，日记在途留给新 epoch 显式重放", async () => {
        await seedUserACanvas();
        useCanvasStore.getState().updateProject("c1", { title: "用户A草稿" });
        let release = () => {};
        server.holdDispatch = new Promise<void>((resolve) => { release = resolve; });
        const pending = persistCanvasDocument("c1", { title: "用户A草稿" });
        await waitUntil(() => server.dispatchWaiting);
        bounceAccountBackToA();
        release();
        await expect(pending).rejects.toBeInstanceOf(CanvasStaleScopeError);
        expect(server.postStarted).toBe(0);
        expect(server.commits).toEqual([]);
        const journal = await loadCanvasOperationJournal("c1", "user-a");
        expect(journal.inFlight?.payload.document.title).toBe("用户A草稿");
        expect(useCanvasStore.getState().projects[0].title).toBe("用户A回来");

        useCanvasStore.getState().updateProject("c1", { title: "用户A草稿" });
        await syncLocalCanvasProjectToBackend("c1");
        expect(server.commits).toEqual([expect.objectContaining({ title: "用户A草稿" })]);
        expect((await loadCanvasOperationJournal("c1", "user-a")).inFlight).toBeNull();
    });

    test("A→B→A 队列里的后续提交不得跟着旧执行流发出", async () => {
        await seedUserACanvas();
        useCanvasStore.getState().updateProject("c1", { title: "用户A草稿" });
        let release = () => {};
        server.hold = new Promise<void>((resolve) => { release = resolve; });
        const first = persistCanvasDocument("c1", { title: "用户A草稿" });
        await waitUntil(() => server.postStarted === 1);
        const second = persistCanvasDocument("c1", { title: "用户A再改" });
        bounceAccountBackToA();
        release();
        await first;
        await expect(second).rejects.toBeInstanceOf(CanvasStaleScopeError);
        expect(server.commits).toHaveLength(1);
        expect(server.commits[0]?.title).toBe("用户A草稿");
        expect(useCanvasStore.getState().projects[0].title).toBe("用户A回来");
        expect((await loadCanvasOperationJournal("c1", "user-b")).confirmedSnapshot).toBeNull();
    });

    test("A→B→A 旧响应不得投影到当前账号 live", async () => {
        await seedUserACanvas();
        useCanvasStore.getState().updateProject("c1", { title: "用户A草稿" });
        let release = () => {};
        server.hold = new Promise<void>((resolve) => { release = resolve; });
        const pending = persistCanvasDocument("c1", { title: "用户A草稿" });
        await waitUntil(() => server.postStarted === 1);
        bounceAccountBackToA();
        release();
        await pending;
        expect(useCanvasStore.getState().projects[0].title).toBe("用户A回来");
        const journalA = await loadCanvasOperationJournal("c1", "user-a");
        expect(journalA.confirmedSnapshot?.title).toBe("用户A草稿");
        expect(journalA.inFlight).toBeNull();
    });

    test("A→B→A 失败仍保留原账号 receipt，新 epoch 显式动作才重放", async () => {
        await seedUserACanvas();
        useCanvasStore.getState().updateProject("c1", { title: "用户A草稿" });
        let release = () => {};
        server.hold = new Promise<void>((resolve) => { release = resolve; });
        server.failNext = { status: 503 };
        const pending = persistCanvasDocument("c1", { title: "用户A草稿" });
        await waitUntil(() => server.postStarted === 1);
        bounceAccountBackToA();
        release();
        await expect(pending).rejects.toThrow();
        const journal = await loadCanvasOperationJournal("c1", "user-a");
        const opId = journal.inFlight?.operationId;
        expect(opId).toBeTruthy();
        expect(journal.inFlight?.payload.document.title).toBe("用户A草稿");
        expect(useCanvasStore.getState().projects[0].title).toBe("用户A回来");
        expect(server.commits).toEqual([]);

        useCanvasStore.getState().updateProject("c1", { title: "用户A草稿" });
        await syncLocalCanvasProjectToBackend("c1");
        expect(server.commits).toEqual([expect.objectContaining({ opId, title: "用户A草稿" })]);
        expect((await loadCanvasOperationJournal("c1", "user-a")).inFlight).toBeNull();
    });

    test("A→B→A 旧生成回写不得写入当前账号投影", async () => {
        await seedUserACanvas();
        const hold = await holdJournalWrite();
        const pending = adoptServerConfirmedGenerationPatch(canvas("生成", 4, { nodes: [node("n-gen", "生成结果")] }), "user-a");
        await hold.wait();
        bounceAccountBackToA();
        hold.resume();
        expect(await pending).toBeUndefined();
        expect(useCanvasStore.getState().projects[0].title).toBe("用户A回来");
        expect(useCanvasStore.getState().projects[0].nodes).toEqual([]);
        const journalA = await loadCanvasOperationJournal("c1", "user-a");
        expect(journalA.confirmedRevision).toBe(4);
        expect(journalA.pendingProjection?.remote.nodes.map((item) => item.id)).toEqual(["n-gen"]);
    });

    test("传入过期 expectedScope 的 persist 立即拒绝，不改当前账号", async () => {
        await seedUserACanvas();
        const captured = captureUserScope();
        bounceAccountBackToA();
        await expect(persistCanvasDocument("c1", { title: "旧epoch写入" }, captured)).rejects.toBeInstanceOf(CanvasStaleScopeError);
        expect(useCanvasStore.getState().projects[0].title).toBe("用户A回来");
        expect(server.postStarted).toBe(0);
    });

    test("A→B→A 删除不得用旧执行流发出", async () => {
        await seedUserACanvas();
        let release = () => {};
        server.holdDispatch = new Promise<void>((resolve) => { release = resolve; });
        const pending = deleteLocalCanvasProjects(["c1"]);
        await waitUntil(() => server.dispatchWaiting);
        bounceAccountBackToA();
        release();
        await expect(pending).rejects.toBeInstanceOf(CanvasStaleScopeError);
        expect(server.deleteStarted).toBe(0);
        expect(server.deletes).toEqual([]);
        expect(useCanvasStore.getState().projects[0].title).toBe("用户A回来");
    });

    test("A→B→A 读取后投影不得写入当前账号", async () => {
        await seedUserACanvas();
        server.document = canvas("远端", 5, { nodes: [node("n-remote", "远端节点")] });
        let release = () => {};
        server.holdDispatch = new Promise<void>((resolve) => { release = resolve; });
        const pending = openLocalCanvasProjectFromBackend("c1");
        await waitUntil(() => server.dispatchWaiting);
        bounceAccountBackToA();
        release();
        const opened = await pending;
        expect(opened?.title).toBe("用户A回来");
        expect(useCanvasStore.getState().projects[0].title).toBe("用户A回来");
        expect(useCanvasStore.getState().projects[0].nodes).toEqual([]);
        expect((await loadCanvasOperationJournal("c1", "user-a")).confirmedRevision).toBe(1);
    });

    test("未落盘投影 flush 失败时文档提交不得发出，pending 不被 ack", async () => {
        const generated = node("n-gen", "生成结果", { metadata: { storageKey: "res-gen" } });
        const base = canvas("基线", 1, { nodes: [node("n1", "镜头1")] });
        const remote = canvas("生成", 4, { nodes: [node("n1", "镜头1"), generated] });
        await saveCanvasOperationJournal({
            userScope: "guest",
            canvasId: "c1",
            confirmedRevision: 4,
            confirmedSnapshot: remote,
            inFlight: null,
            pendingProjection: { identity: "proj-keep", revision: 4, base, remote },
        });
        useCanvasStore.setState({ projects: [canvas("本地草稿", 1, { nodes: [{ ...node("n1", "镜头1"), title: "本地改名" }] })] });
        setCanvasProjectionStoreFlushForTest(async () => { throw new Error("IndexedDB hung"); });
        await expect(persistCanvasDocument("c1", { title: "本地草稿" })).rejects.toBeInstanceOf(CanvasProjectionError);
        expect(server.postStarted).toBe(0);
        expect(server.commits).toEqual([]);
        const journal = await loadCanvasOperationJournal("c1");
        expect(journal.pendingProjection?.identity).toBe("proj-keep");
        expect(journal.confirmedRevision).toBe(4);
    });

    test("A→B→A 投影 flush 期间切账号不得 ack pending", async () => {
        await seedUserACanvas();
        let release = () => {};
        let waiting = false;
        setCanvasProjectionStoreFlushForTest(async () => {
            waiting = true;
            await new Promise<void>((resolve) => { release = resolve; });
        });
        const pending = adoptServerConfirmedGenerationPatch(canvas("生成", 4, { nodes: [node("n-gen", "生成结果")] }), "user-a");
        await waitUntil(() => waiting);
        bounceAccountBackToA();
        release();
        await expect(pending).rejects.toBeInstanceOf(CanvasStaleScopeError);
        expect(useCanvasStore.getState().projects[0].title).toBe("用户A回来");
        expect(useCanvasStore.getState().projects[0].nodes).toEqual([]);
        const journalA = await loadCanvasOperationJournal("c1", "user-a");
        expect(journalA.confirmedRevision).toBe(4);
        expect(journalA.pendingProjection?.remote.nodes.map((item) => item.id)).toEqual(["n-gen"]);
    });

    test("生成回写入草稿时按 id 合并，不丢掉本地额外节点", async () => {
        const localOnly = node("n-local", "本地节点");
        const generated = node("n-gen", "生成结果");
        useCanvasStore.setState({ projects: [canvas("草稿", 1, { nodes: [localOnly] })] });
        recordCanvasDocumentBase(canvas("基线", 1));
        await saveCanvasOperationJournal({
            userScope: "guest",
            canvasId: "c1",
            confirmedRevision: 1,
            confirmedSnapshot: canvas("基线", 1),
            inFlight: null,
        });

        const adopted = await adoptServerConfirmedGenerationPatch(canvas("生成", 4, { nodes: [generated] }));
        expect(adopted.nodes.map((item) => item.id).sort()).toEqual(["n-gen", "n-local"]);
        expect(useCanvasStore.getState().projects[0].title).toBe("草稿");
        const journal = await loadCanvasOperationJournal("c1");
        expect(journal.confirmedRevision).toBe(4);
        expect(journal.confirmedSnapshot?.nodes.map((item) => item.id)).toEqual(["n-gen"]);
        expect(journal.inFlight).toBeNull();
    });

    test("本地删除的节点和连线不会被生成回写复活", async () => {
        const n1 = node("n1", "镜头1");
        const n2 = node("n2", "镜头2");
        const generated = node("n-gen", "生成结果", { metadata: { storageKey: "res-gen" } });
        const c1 = connection("c1", "n1", "n2");
        const base = canvas("基线", 1, { nodes: [n1, n2], connections: [c1] });
        await seedConfirmed(base);
        useCanvasStore.getState().updateProject("c1", { nodes: [n1] as never, connections: [] as never });

        await adoptServerConfirmedGenerationPatch(canvas("生成", 4, { nodes: [n1, n2, generated], connections: [c1] }));

        const live = useCanvasStore.getState().projects[0];
        expect(live.nodes.map((item) => item.id)).toEqual(["n1", "n-gen"]);
        expect(live.connections.map((item) => item.id)).toEqual([]);
        expect(canvasBackendSubmitPaused("c1")).toBe(false);
        expect((await loadCanvasOperationJournal("c1")).confirmedRevision).toBe(4);
    });

    test("本地改过的文案保留，未改动字段采纳生成媒体", async () => {
        const baseNode = node("n1", "镜头1", { metadata: { prompt: "基线提示" } });
        await seedConfirmed(canvas("基线", 1, { nodes: [baseNode] }));
        useCanvasStore.getState().updateProject("c1", {
            nodes: [{ ...baseNode, title: "本地改名", metadata: { prompt: "本地提示" } }] as never,
        });

        await adoptServerConfirmedGenerationPatch(canvas("生成", 4, {
            nodes: [{ ...baseNode, metadata: { prompt: "基线提示", storageKey: "res-gen", content: "https://media/gen" } }],
        }));

        const liveNode = useCanvasStore.getState().projects[0].nodes[0];
        expect(liveNode.title).toBe("本地改名");
        expect(liveNode.metadata?.prompt).toBe("本地提示");
        expect(liveNode.metadata?.storageKey).toBe("res-gen");
        expect(liveNode.metadata?.content).toBe("https://media/gen");
        expect(canvasBackendSubmitPaused("c1")).toBe(false);
    });

    test("本地清空的数组不会被基线填回，服务端新增实体仍采纳", async () => {
        const n1 = node("n1", "镜头1");
        const generated = node("n-gen", "生成结果");
        const c1 = connection("c1", "n1", "n1");
        const cGen = connection("c-gen", "n-gen", "n1");
        await seedConfirmed(canvas("基线", 1, { nodes: [n1], connections: [c1] }));
        useCanvasStore.getState().updateProject("c1", { nodes: [] as never, connections: [] as never });

        await adoptServerConfirmedGenerationPatch(canvas("生成", 4, {
            nodes: [n1, generated],
            connections: [c1, cGen],
        }));

        const live = useCanvasStore.getState().projects[0];
        expect(live.nodes.map((item) => item.id)).toEqual(["n-gen"]);
        expect(live.connections.map((item) => item.id)).toEqual(["c-gen"]);
    });

    test("服务端删除且本地未改的节点会随生成回写去掉", async () => {
        const n1 = node("n1", "镜头1");
        const n2 = node("n2", "镜头2");
        await seedConfirmed(canvas("基线", 1, { nodes: [n1, n2] }));

        await adoptServerConfirmedGenerationPatch(canvas("生成", 4, { nodes: [n1] }));

        expect(useCanvasStore.getState().projects[0].nodes.map((item) => item.id)).toEqual(["n1"]);
        expect(canvasBackendSubmitPaused("c1")).toBe(false);
    });

    test("同一节点本地位移与服务端生成结果一并保留", async () => {
        const baseNode = node("n1", "镜头1");
        await seedConfirmed(canvas("基线", 1, { nodes: [baseNode] }));
        useCanvasStore.getState().updateProject("c1", {
            nodes: [{ ...baseNode, position: { x: 40, y: 80 } }] as never,
        });

        await adoptServerConfirmedGenerationPatch(canvas("生成", 4, {
            nodes: [{ ...baseNode, metadata: { storageKey: "res-gen", content: "https://media/gen" } }],
        }));

        const liveNode = useCanvasStore.getState().projects[0].nodes[0];
        expect(liveNode.position).toEqual({ x: 40, y: 80 });
        expect(liveNode.metadata?.storageKey).toBe("res-gen");
        expect(liveNode.title).toBe("镜头1");
        expect(canvasBackendSubmitPaused("c1")).toBe(false);
    });

    test("任务进行中 Agent 加了其它节点并加载最新后，成功结果绑定且新节点保留", async () => {
        const original = node("image-origin", "原图", { metadata: { taskId: "task-1", status: "idle", prompt: "猫" } });
        const camp = node("node-camp", "秋日旅行·露营桌");
        const lake = node("node-lake", "秋日旅行·湖畔横移");
        await seedConfirmed(canvas("已加载最新", 10, { nodes: [original, camp, lake] }));
        useCanvasStore.getState().updateProject("c1", {
            nodes: [
                { ...original, metadata: { taskId: "task-1", status: "loading", taskStatus: "running", taskProgress: 42, taskStage: "出图中", prompt: "猫" } },
                camp,
                lake,
            ] as never,
        });
        pauseCanvasBackendSubmit("c1");

        const adopted = await adoptServerConfirmedGenerationPatch(canvas("生成", 14, {
            nodes: [
                { ...original, metadata: { taskId: "task-1", status: "success", taskStatus: "succeeded", taskProgress: 100, content: "https://media/gen", storageKey: "res-gen", prompt: "猫" } },
                camp,
                lake,
            ],
        }));

        expect(adopted.nodes.map((item) => item.id)).toEqual(["image-origin", "node-camp", "node-lake"]);
        const live = useCanvasStore.getState().projects[0];
        const origin = live.nodes.find((item) => item.id === "image-origin");
        expect(origin?.metadata?.status).toBe("success");
        expect(origin?.metadata?.content).toBe("https://media/gen");
        expect(origin?.metadata?.storageKey).toBe("res-gen");
        expect(origin?.title).toBe("原图");
        expect(live.nodes.find((item) => item.id === "node-camp")?.title).toBe("秋日旅行·露营桌");
        expect(live.nodes.find((item) => item.id === "node-lake")?.title).toBe("秋日旅行·湖畔横移");
        expect(canvasBackendSubmitPaused("c1")).toBe(false);
        expect(canvasExternalRevisionConflict("guest", "c1")).toBeUndefined();
        expect((await loadCanvasOperationJournal("c1")).confirmedRevision).toBe(14);
    });

    test("同一节点人类改过生成内容时保留本地值并说明冲突，不伪装成功", async () => {
        const original = node("image-origin", "原图", { metadata: { taskId: "task-1", status: "idle", content: "旧图" } });
        await seedConfirmed(canvas("基线", 10, { nodes: [original] }));
        useCanvasStore.getState().updateProject("c1", {
            nodes: [{ ...original, metadata: { taskId: "task-1", status: "loading", content: "人类改过的内容" } }] as never,
        });

        await adoptServerConfirmedGenerationPatch(canvas("生成", 14, {
            nodes: [{ ...original, metadata: { taskId: "task-1", status: "success", content: "https://media/gen", storageKey: "res-gen" } }],
        }));

        const live = useCanvasStore.getState().projects[0];
        expect(live.nodes[0].metadata?.content).toBe("人类改过的内容");
        expect(live.nodes[0].metadata?.status).not.toBe("success");
        expect(canvasBackendSubmitPaused("c1")).toBe(true);
        expect(canvasExternalRevisionConflict("guest", "c1")?.candidate.nodes[0].metadata?.content).toBe("https://media/gen");
        expect(canvasExternalRevisionConflict("guest", "c1")?.candidate.nodes[0].metadata?.storageKey).toBe("res-gen");
        expect((await loadCanvasOperationJournal("c1")).confirmedRevision).toBe(14);
    });

    test("新任务删除 content 后绑定成功结果，store 与 adopted 一致", async () => {
        const original = node("image-origin", "原图", { metadata: { taskId: "task-old", status: "success", content: "旧图", storageKey: "old-key" } });
        await seedConfirmed(canvas("已有旧图", 10, { nodes: [original] }));
        useCanvasStore.getState().updateProject("c1", {
            nodes: [{ ...original, metadata: { taskId: "task-2", status: "loading", taskStatus: "running", prompt: "猫" } }] as never,
        });

        const adopted = await adoptServerConfirmedGenerationPatch(canvas("生成", 14, {
            nodes: [{ ...original, metadata: { taskId: "task-2", status: "success", taskStatus: "succeeded", content: "https://media/new", storageKey: "res-new", prompt: "猫" } }],
        }));

        const live = useCanvasStore.getState().projects[0];
        expect(adopted.nodes[0].metadata?.status).toBe("success");
        expect(adopted.nodes[0].metadata?.content).toBe("https://media/new");
        expect(live.nodes).toEqual(adopted.nodes);
        expect(live.nodes[0].metadata?.storageKey).toBe("res-new");
        expect(canvasBackendSubmitPaused("c1")).toBe(false);
        expect((await loadCanvasOperationJournal("c1")).confirmedRevision).toBe(14);
    });

    test("同一任务 in-flight 空串 overlay 采纳远端已绑定 success", async () => {
        const original = node("image-origin", "原图", { metadata: { taskId: "task-1", status: "idle", content: "旧图" } });
        await seedConfirmed(canvas("基线", 10, { nodes: [original] }));
        useCanvasStore.getState().updateProject("c1", {
            nodes: [{ ...original, metadata: { taskId: "task-1", status: "loading", content: "" } }] as never,
        });

        const adopted = await adoptServerConfirmedGenerationPatch(canvas("生成", 14, {
            nodes: [{ ...original, metadata: { taskId: "task-1", status: "success", content: "https://media/gen", storageKey: "res-gen" } }],
        }));

        const live = useCanvasStore.getState().projects[0];
        expect(live.nodes).toEqual(adopted.nodes);
        expect(live.nodes[0].metadata?.status).toBe("success");
        expect(live.nodes[0].metadata?.content).toBe("https://media/gen");
        expect(live.nodes[0].metadata?.storageKey).toBe("res-gen");
        expect(canvasBackendSubmitPaused("c1")).toBe(false);
        expect(canvasExternalRevisionConflict("guest", "c1")).toBeUndefined();
        expect((await loadCanvasOperationJournal("c1")).confirmedRevision).toBe(14);
    });

    test("远端仅有 taskStatus succeeded、无绑定媒体时不得当成成功并清掉本地媒体", async () => {
        const original = node("image-origin", "原图", { metadata: { taskId: "task-1", status: "idle", content: "旧图" } });
        await seedConfirmed(canvas("基线", 10, { nodes: [original] }));
        useCanvasStore.getState().updateProject("c1", {
            nodes: [{ ...original, metadata: { taskId: "task-1", status: "loading", content: "https://local-kept", storageKey: "local-key", taskStatus: "running" } }] as never,
        });

        const adopted = await adoptServerConfirmedGenerationPatch(canvas("残缺远端", 21, {
            nodes: [{ ...original, metadata: { taskId: "task-1", status: "loading", taskStatus: "succeeded", taskProgress: 100, content: "" } }],
        }));

        const live = useCanvasStore.getState().projects[0];
        expect(live.nodes).toEqual(adopted.nodes);
        expect(live.nodes[0].metadata?.status).not.toBe("success");
        expect(live.nodes[0].metadata?.content).toBe("https://local-kept");
        expect(live.nodes[0].metadata?.storageKey).toBe("local-key");
        expect((await loadCanvasOperationJournal("c1")).confirmedRevision).toBe(21);
    });

    test("idle 节点不被 settle 改写；未改的生成字段仍由三路合并采纳", async () => {
        const original = node("image-origin", "原图", { metadata: { taskId: "task-1", status: "idle", content: "旧图", prompt: "原提示" } });
        await seedConfirmed(canvas("基线", 10, { nodes: [original] }));
        useCanvasStore.getState().updateProject("c1", {
            nodes: [{ ...original, metadata: { taskId: "task-1", status: "idle", content: "旧图", prompt: "人类改了提示" } }] as never,
        });

        const adopted = await adoptServerConfirmedGenerationPatch(canvas("生成", 14, {
            nodes: [{ ...original, metadata: { taskId: "task-1", status: "success", content: "https://media/gen", storageKey: "res-gen", prompt: "原提示" } }],
        }));

        const live = useCanvasStore.getState().projects[0];
        expect(live.nodes).toEqual(adopted.nodes);
        expect(live.nodes[0].metadata?.prompt).toBe("人类改了提示");
        expect(live.nodes[0].metadata?.content).toBe("https://media/gen");
        expect(live.nodes[0].metadata?.status).toBe("success");
        expect(canvasBackendSubmitPaused("c1")).toBe(false);
        expect((await loadCanvasOperationJournal("c1")).confirmedRevision).toBe(14);
    });

    test("人类已把节点改成 success 时 settle 不覆盖，本地媒体保留", async () => {
        const original = node("image-origin", "原图", { metadata: { taskId: "task-1", status: "idle", content: "旧图" } });
        await seedConfirmed(canvas("基线", 10, { nodes: [original] }));
        useCanvasStore.getState().updateProject("c1", {
            nodes: [{ ...original, metadata: { taskId: "task-1", status: "success", content: "人类留下的图" } }] as never,
        });

        const adopted = await adoptServerConfirmedGenerationPatch(canvas("生成", 14, {
            nodes: [{ ...original, metadata: { taskId: "task-1", status: "success", content: "https://media/gen", storageKey: "res-gen" } }],
        }));

        const live = useCanvasStore.getState().projects[0];
        expect(live.nodes).toEqual(adopted.nodes);
        expect(live.nodes[0].metadata?.content).toBe("人类留下的图");
        expect(canvasBackendSubmitPaused("c1")).toBe(true);
        expect(canvasExternalRevisionConflict("guest", "c1")?.candidate.nodes[0].metadata?.content).toBe("https://media/gen");
        expect((await loadCanvasOperationJournal("c1")).confirmedRevision).toBe(14);
    });

    test("同一字段本地元数据与服务端元数据冲突时暂停，不猜胜者", async () => {
        const baseNode = node("n1", "镜头1", { metadata: { prompt: "基线提示" } });
        await seedConfirmed(canvas("基线", 1, { nodes: [baseNode] }));
        useCanvasStore.getState().updateProject("c1", {
            nodes: [{ ...baseNode, metadata: { prompt: "本地提示" } }] as never,
        });

        await adoptServerConfirmedGenerationPatch(canvas("生成", 4, {
            nodes: [{ ...baseNode, metadata: { prompt: "服务端提示" } }],
        }));

        const live = useCanvasStore.getState().projects[0];
        expect(live.nodes[0].metadata?.prompt).toBe("本地提示");
        expect(canvasBackendSubmitPaused("c1")).toBe(true);
        expect(canvasExternalRevisionConflict("guest", "c1")?.remoteRevision).toBe(4);
        expect(canvasExternalRevisionConflict("guest", "c1")?.candidate.nodes[0].metadata?.prompt).toBe("服务端提示");
        expect((await loadCanvasOperationJournal("c1")).confirmedRevision).toBe(4);
    });

    test("无已确认快照时不把生成结果静默并进草稿", async () => {
        resetCanvasOperationJournalMemory();
        clearCanvasDocumentBase("c1");
        const localOnly = node("n-local", "本地节点");
        useCanvasStore.setState({ projects: [canvas("草稿", 1, { nodes: [localOnly] })] });

        const adopted = await adoptServerConfirmedGenerationPatch(canvas("生成", 4, { nodes: [node("n-gen", "生成结果")] }));

        expect(adopted.nodes.map((item) => item.id)).toEqual(["n-local"]);
        expect(useCanvasStore.getState().projects[0].nodes.map((item) => item.id)).toEqual(["n-local"]);
        expect((await loadCanvasOperationJournal("c1")).confirmedRevision).toBe(0);
        expect(canvasDocumentBase("c1")).toBeUndefined();
        expect(canvasBackendSubmitPaused("c1")).toBe(true);
    });

    test("日记写入等待期间的手工编辑在生成回写后仍在", async () => {
        await seedConfirmed(canvas("基线", 1));
        const hold = await holdJournalWrite();
        const pending = adoptServerConfirmedGenerationPatch(canvas("基线", 4, { nodes: [node("n-gen", "生成结果")] }));
        await hold.wait();
        useCanvasStore.getState().updateProject("c1", { title: "手工改了" });
        hold.resume();
        await pending;

        const live = useCanvasStore.getState().projects[0];
        expect(live.title).toBe("手工改了");
        expect(live.nodes.map((item) => item.id)).toEqual(["n-gen"]);
        expect((await loadCanvasOperationJournal("c1")).confirmedRevision).toBe(4);
        expect(canvasDocumentBase("c1")?.revision).toBe(4);
        expect(canvasBackendSubmitPaused("c1")).toBe(false);
    });

    test("生成回写日记失败时不发布基线，等待期间的编辑仍在", async () => {
        await seedConfirmed(canvas("基线", 1));
        const hold = await holdJournalWrite();
        failNextSetItem = true;
        const pending = adoptServerConfirmedGenerationPatch(canvas("生成", 4, { nodes: [node("n-gen", "生成结果")] }));
        await hold.wait();
        useCanvasStore.getState().updateProject("c1", { title: "手工改了" });
        hold.resume();
        await expect(pending).rejects.toMatchObject({
            name: "CanvasProjectionError",
            message: "服务端已保存，本地画布还没写完。请重试这次回写，不要重新生成。",
        });

        expect(useCanvasStore.getState().projects[0].title).toBe("手工改了");
        expect(useCanvasStore.getState().projects[0].nodes).toEqual([]);
        expect((await loadCanvasOperationJournal("c1")).confirmedRevision).toBe(1);
        expect((await loadCanvasOperationJournal("c1")).pendingProjection).toBeNull();
        expect(canvasDocumentBase("c1")?.snapshot.title).toBe("基线");
        expect(canvasDocumentBase("c1")?.revision).toBe(1);
    });

    test("等待生成回写时画布被删掉则不再写回 store", async () => {
        await seedConfirmed(canvas("基线", 1));
        const hold = await holdJournalWrite();
        const pending = adoptServerConfirmedGenerationPatch(canvas("生成", 4, { nodes: [node("n-gen", "生成结果")] }));
        await hold.wait();
        useCanvasStore.setState({ projects: [] });
        hold.resume();
        expect(await pending).toBeUndefined();

        expect(useCanvasStore.getState().projects).toEqual([]);
        expect((await loadCanvasOperationJournal("c1")).confirmedRevision).toBe(4);
    });

    test("等待生成回写时切换账号，不改新账号的 store", async () => {
        activeScope = "user-a";
        resetCanvasOperationJournalMemory();
        await seedConfirmed(canvas("用户A基线", 1), "user-a");
        const hold = await holdJournalWrite();
        const pending = adoptServerConfirmedGenerationPatch(canvas("生成", 4, { nodes: [node("n-gen", "生成结果")] }), "user-a");
        await hold.wait();
        activeScope = "user-b";
        useCanvasStore.setState({ projects: [canvas("用户B画布", 1)] });
        recordCanvasDocumentBase(canvas("用户B画布", 1), "user-b");
        hold.resume();
        expect(await pending).toBeUndefined();

        expect(useCanvasStore.getState().projects[0].title).toBe("用户B画布");
        expect(useCanvasStore.getState().projects[0].nodes).toEqual([]);
        const journalA = await loadCanvasOperationJournal("c1", "user-a");
        expect(journalA.confirmedRevision).toBe(4);
        expect(journalA.confirmedSnapshot?.revision).toBe(4);
        expect(canvasDocumentBase("c1", "user-b")?.snapshot.title).toBe("用户B画布");
        expect((await loadCanvasOperationJournal("c1", "user-b")).confirmedSnapshot).toBeNull();
    });

    test("过期生成响应不改确认快照，在途回执仍可回放，revision 与 snapshot 对齐", async () => {
        await saveCanvasOperationJournal({
            userScope: "guest",
            canvasId: "c1",
            confirmedRevision: 4,
            confirmedSnapshot: canvas("已确认", 4),
            inFlight: {
                operationId: "op-keep",
                expectedRevision: 1,
                payload: { canvasId: "c1", expectedRevision: 1, document: canvas("在途", 1) },
            },
        });
        useCanvasStore.setState({ projects: [canvas("本地草稿", 4)] });
        recordCanvasDocumentBase(canvas("已确认", 4));

        const adopted = await adoptServerConfirmedGenerationPatch(canvas("过期生成", 2, { nodes: [node("n-stale", "旧结果")] }));

        expect(adopted.title).toBe("本地草稿");
        expect(useCanvasStore.getState().projects[0].title).toBe("本地草稿");
        expect(useCanvasStore.getState().projects[0].nodes).toEqual([]);
        const journal = await loadCanvasOperationJournal("c1");
        expect(journal.confirmedRevision).toBe(4);
        expect(journal.confirmedSnapshot?.title).toBe("已确认");
        expect(journal.confirmedSnapshot?.revision).toBe(4);
        expect(journal.inFlight?.operationId).toBe("op-keep");
        expect(canvasDocumentBase("c1")?.revision).toBe(4);
        expect(canvasDocumentBase("c1")?.snapshot.title).toBe("已确认");
    });

    test("日记写入会把 snapshot.revision 对齐到 confirmedRevision", async () => {
        await saveCanvasOperationJournal({
            userScope: "guest",
            canvasId: "c1",
            confirmedRevision: 3,
            confirmedSnapshot: canvas("基线", 1),
            inFlight: null,
        });
        const journal = await loadCanvasOperationJournal("c1");
        expect(journal.confirmedRevision).toBe(3);
        expect(journal.confirmedSnapshot?.revision).toBe(3);
    });

    test.each([8, 9])("轮询读到已确认或更旧的版本 %i 时保留待保存编辑且不制造冲突", async (remoteRevision) => {
        await seedConfirmed(canvas("已确认", 9));
        server.revision = remoteRevision;
        server.document = canvas("已确认", remoteRevision);
        useCanvasStore.getState().updateProject("c1", { title: "尚未自动保存的编辑" });
        expect(hasUnconfirmedCanvasEdits("c1")).toBe(true);

        await refreshLocalCanvasProjectIfChanged("c1");

        expect(canvasExternalRevisionConflict("guest", "c1")).toBeUndefined();
        expect(canvasBackendSubmitPaused("c1")).toBe(false);
        expect(useCanvasStore.getState().projects[0].title).toBe("尚未自动保存的编辑");
        expect((await loadCanvasOperationJournal("c1")).confirmedRevision).toBe(9);
    });

    test("刷新在日记写入等待期间保留手工编辑并采纳未冲突的远端节点", async () => {
        await seedConfirmed(canvas("基线", 1));
        server.document = canvas("基线", 5, { nodes: [node("n-ext", "外部节点")] });
        const hold = await holdJournalWrite();
        const pending = refreshLocalCanvasProjectIfChanged("c1");
        await hold.wait();
        useCanvasStore.getState().updateProject("c1", { title: "手工改了" });
        hold.resume();
        const applied = await pending;

        expect(applied?.title).toBe("手工改了");
        expect(useCanvasStore.getState().projects[0].title).toBe("手工改了");
        expect(useCanvasStore.getState().projects[0].nodes.map((item) => item.id)).toEqual(["n-ext"]);
        expect((await loadCanvasOperationJournal("c1")).confirmedRevision).toBe(5);
        expect(canvasDocumentBase("c1")?.revision).toBe(5);
        expect(canvasBackendSubmitPaused("c1")).toBe(false);
    });

    test("刷新日记写入失败时不发布基线", async () => {
        await seedConfirmed(canvas("基线", 1));
        server.document = canvas("助手改过", 5);
        failNextSetItem = true;
        expect(await refreshLocalCanvasProjectIfChanged("c1")).toBeUndefined();
        expect(useCanvasStore.getState().projects[0].title).toBe("基线");
        expect((await loadCanvasOperationJournal("c1")).confirmedRevision).toBe(1);
        expect(canvasDocumentBase("c1")?.snapshot.title).toBe("基线");
        expect(canvasDocumentBase("c1")?.revision).toBe(1);
    });

    test("打开后端文档时日记写入等待期间的手工编辑不会丢", async () => {
        await seedConfirmed(canvas("基线", 1));
        server.document = canvas("基线", 5, { nodes: [node("n-ext", "外部节点")] });
        const hold = await holdJournalWrite();
        const pending = openLocalCanvasProjectFromBackend("c1");
        await hold.wait();
        useCanvasStore.getState().updateProject("c1", { title: "手工改了" });
        hold.resume();
        await pending;

        const live = useCanvasStore.getState().projects[0];
        expect(live.title).toBe("手工改了");
        expect(live.nodes.map((item) => item.id)).toEqual(["n-ext"]);
        expect((await loadCanvasOperationJournal("c1")).confirmedRevision).toBe(5);
        expect(canvasDocumentBase("c1")?.revision).toBe(5);
    });

    test("打开后端文档时日记写入失败不发布基线", async () => {
        await seedConfirmed(canvas("基线", 1));
        server.document = canvas("助手改过", 5);
        failNextSetItem = true;
        await openLocalCanvasProjectFromBackend("c1");
        expect(useCanvasStore.getState().projects[0].title).toBe("基线");
        expect((await loadCanvasOperationJournal("c1")).confirmedRevision).toBe(1);
        expect(canvasDocumentBase("c1")?.snapshot.title).toBe("基线");
    });

    test("进程内存在日记落盘与 store flush 之间丢失：重载后三路投影并保留本地草稿，自动保存不覆盖服务端结果", async () => {
        const n1 = node("n1", "镜头1");
        const n2 = node("n2", "镜头2");
        const generated = node("n-gen", "生成结果", { metadata: { storageKey: "res-gen" } });
        const base = canvas("基线", 1, { nodes: [n1, n2] });
        const draft = canvas("基线", 1, { nodes: [{ ...n1, title: "本地改名" }] });
        const remote = canvas("基线", 4, { nodes: [n1, n2, generated] });
        await saveCanvasOperationJournal({
            userScope: "guest",
            canvasId: "c1",
            confirmedRevision: 4,
            confirmedSnapshot: remote,
            inFlight: null,
            pendingProjection: { identity: "proj-1", revision: 4, base, remote },
        });
        resetCanvasOperationJournalMemory();
        resetLocalCanvasBackendSaveState();
        clearCanvasDocumentBase("c1");
        useCanvasStore.setState({ projects: [draft as never] });

        await loadCanvasOperationJournal("c1");
        await syncLocalCanvasProjectToBackend("c1");

        const live = useCanvasStore.getState().projects[0];
        expect(live.title).toBe("基线");
        expect(live.nodes.map((item) => item.id).sort()).toEqual(["n-gen", "n1"]);
        expect(live.nodes.find((item) => item.id === "n1")?.title).toBe("本地改名");
        expect(live.nodes.find((item) => item.id === "n-gen")?.metadata?.storageKey).toBe("res-gen");
        expect((await loadCanvasOperationJournal("c1")).pendingProjection).toBeNull();
        expect(server.commits).toEqual([
            expect.objectContaining({ expectedRevision: 4, title: "基线", nodeIds: expect.arrayContaining(["n1", "n-gen"]) }),
        ]);
        expect(server.commits[0]?.nodeIds).not.toContain("n2");
    });

    test("投影 flush 失败时保留恢复状态，重放幂等且可重试原回执", async () => {
        const generated = node("n-gen", "生成结果", { metadata: { storageKey: "res-gen" } });
        await seedConfirmed(canvas("基线", 1, { nodes: [node("n1", "镜头1")] }));
        useCanvasStore.getState().updateProject("c1", { title: "本地草稿" });
        const remote = canvas("生成", 4, { nodes: [node("n1", "镜头1"), generated] });
        setCanvasProjectionStoreFlushForTest(async () => { throw new Error("IndexedDB hung"); });

        await expect(adoptServerConfirmedGenerationPatch(remote)).rejects.toBeInstanceOf(CanvasProjectionError);
        const afterFirst = structuredClone(useCanvasStore.getState().projects[0]);
        expect(afterFirst.title).toBe("本地草稿");
        expect(afterFirst.nodes.map((item) => item.id).sort()).toEqual(["n-gen", "n1"]);
        const pendingFirst = (await loadCanvasOperationJournal("c1")).pendingProjection;
        expect(pendingFirst?.identity).toBeTruthy();
        expect(pendingFirst?.revision).toBe(4);
        expect(pendingFirst?.base.title).toBe("基线");

        await expect(adoptServerConfirmedGenerationPatch(remote)).rejects.toBeInstanceOf(CanvasProjectionError);
        const afterSecond = useCanvasStore.getState().projects[0];
        expect(afterSecond.title).toBe("本地草稿");
        expect(afterSecond.nodes.map((item) => item.id).sort()).toEqual(["n-gen", "n1"]);
        expect((await loadCanvasOperationJournal("c1")).pendingProjection?.identity).toBe(pendingFirst?.identity);
        expect((await loadCanvasOperationJournal("c1")).confirmedRevision).toBe(4);
    });

    test("第一次投影尚未 flush 时又来了更新的远端 revision：恢复基线不变，晚到的 clear 不能丢掉新投影", async () => {
        const n1 = node("n1", "镜头1");
        const gen4 = node("n-gen-4", "第四版");
        const gen5 = node("n-gen-5", "第五版", { metadata: { storageKey: "res-5" } });
        const base = canvas("基线", 1, { nodes: [n1] });
        const remote4 = canvas("基线", 4, { nodes: [n1, gen4] });
        const remote5 = canvas("基线", 5, { nodes: [n1, gen5] });
        const draft = canvas("基线", 1, { nodes: [{ ...n1, title: "本地改名" }] });
        await saveCanvasOperationJournal({
            userScope: "guest",
            canvasId: "c1",
            confirmedRevision: 4,
            confirmedSnapshot: remote4,
            inFlight: null,
            pendingProjection: { identity: "proj-a", revision: 4, base, remote: remote4 },
        });
        await recordConfirmedCanvasCommit(remote5, "guest", { unflushedProjection: true });
        const replaced = await loadCanvasOperationJournal("c1");
        expect(replaced.confirmedRevision).toBe(5);
        expect(replaced.pendingProjection?.identity).not.toBe("proj-a");
        expect(replaced.pendingProjection?.base.nodes.map((item) => item.id)).toEqual(["n1"]);
        expect(replaced.pendingProjection?.remote.nodes.map((item) => item.id).sort()).toEqual(["n-gen-5", "n1"]);

        await clearCanvasPendingProjection("c1", "guest", "proj-a");
        expect((await loadCanvasOperationJournal("c1")).pendingProjection?.remote.nodes.map((item) => item.id).sort()).toEqual(["n-gen-5", "n1"]);

        resetCanvasOperationJournalMemory();
        resetLocalCanvasBackendSaveState();
        clearCanvasDocumentBase("c1");
        useCanvasStore.setState({ projects: [draft as never] });
        await loadCanvasOperationJournal("c1");
        await syncLocalCanvasProjectToBackend("c1");

        const live = useCanvasStore.getState().projects[0];
        expect(live.nodes.map((item) => item.id).sort()).toEqual(["n-gen-5", "n1"]);
        expect(live.nodes.find((item) => item.id === "n1")?.title).toBe("本地改名");
        expect(live.nodes.find((item) => item.id === "n-gen-5")?.metadata?.storageKey).toBe("res-5");
        expect(server.commits[0]?.nodeIds).not.toContain("n-gen-4");
        expect((await loadCanvasOperationJournal("c1")).pendingProjection).toBeNull();
    });
});
