import { beforeEach, describe, expect, mock, test } from "bun:test";

type Stored = Map<string, string>;
const stored: Stored = new Map();

mock.module("@/lib/localforage-storage", () => ({
    localForageStorageForScope: () => ({
        getItem: async (name: string) => stored.get(name) ?? null,
        setItem: async (name: string, value: string) => { stored.set(name, value); },
        removeItem: async (name: string) => { stored.delete(name); },
    }),
    localForageStorage: {
        getItem: async (name: string) => stored.get(name) ?? null,
        setItem: async (name: string, value: string) => { stored.set(name, value); },
        removeItem: async (name: string) => { stored.delete(name); },
    },
}));

const {
    acceptCanvasExternalRevisionCandidate,
    applyExternalCanvasRevision,
    canvasExternalRevisionConflict,
    flushCanvasStorePersistence,
    useCanvasStore,
    CANVAS_STORE_KEY,
} = await import("@/stores/canvas/use-canvas-store");
const { serializeCanvasStorageDocument } = await import("@/lib/canvas/canvas-storage-revision");
const { getActiveUserScope } = await import("@/lib/user-scope");

const scope = getActiveUserScope();

function project(id: string, revision: number, patch: Record<string, unknown> = {}) {
    return {
        id,
        revision,
        title: "画布",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: `2026-01-01T00:00:0${revision}.000Z`,
        nodes: [{ id: "n1", type: "image", title: "镜头1", position: { x: 0, y: 0 }, width: 320, height: 220, metadata: { prompt: "服务端提示" } }],
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

/** 建立「服务端已确认」的本地起点：先写存储，再让 store 与它一致。 */
async function seedConfirmedProject(canvas: unknown, revision: number) {
    stored.set(CANVAS_STORE_KEY, serializeCanvasStorageDocument({
        state: { projects: [canvas] },
        version: 0,
        storageRevision: revision,
        tombstones: { projects: {}, nodes: {}, connections: {}, sessions: {}, messages: {} },
    } as never));
    await useCanvasStore.persist.rehydrate();
    await flushCanvasStorePersistence();
}

beforeEach(() => {
    stored.clear();
    useCanvasStore.setState({ projects: [] });
});

describe("画布刷新接缝", () => {
    test("服务端确认基线一致时应用外部新 revision，并保留本机视角", async () => {
        await seedConfirmedProject(project("c1", 3, { viewport: { x: 420, y: -80, k: 1.5 } }), 7);

        const decision = applyExternalCanvasRevision(project("c1", 4, { title: "外部改名" }) as never, { hasUnsyncedEdits: false });

        expect(decision.kind).toBe("apply");
        const live = useCanvasStore.getState().projects[0];
        expect(live.title).toBe("外部改名");
        expect(live.revision).toBe(4);
        expect(live.viewport).toEqual({ x: 420, y: -80, k: 1.5 });
        expect(canvasExternalRevisionConflict(scope, "c1")).toBeUndefined();
    });

    test("有未确认编辑时不覆盖用户值，并把远端保留为候选", async () => {
        await seedConfirmedProject(project("c1", 3), 7);
        const remote = project("c1", 9, {
            title: "外部改名",
            nodes: [{ id: "n1", type: "image", title: "镜头1", position: { x: 0, y: 0 }, width: 320, height: 220, metadata: { prompt: "外部提示" } }],
        });

        const decision = applyExternalCanvasRevision(remote as never, { hasUnsyncedEdits: true });

        expect(decision.kind).toBe("keep-local");
        const live = useCanvasStore.getState().projects[0];
        expect(live.nodes[0].metadata?.prompt).toBe("服务端提示");
        expect(live.title).toBe("画布");
        expect(live.revision).toBe(3);
        const conflict = canvasExternalRevisionConflict(scope, "c1");
        expect(conflict?.localRevision).toBe(3);
        expect(conflict?.remoteRevision).toBe(9);
        expect(conflict?.candidate.nodes[0].metadata?.prompt).toBe("外部提示");
    });

    test("用户显式选择以最新为准时才替换文档，并清除冲突", async () => {
        await seedConfirmedProject(project("c1", 3), 7);
        applyExternalCanvasRevision(project("c1", 9, { title: "外部改名" }) as never, { hasUnsyncedEdits: true });
        expect(canvasExternalRevisionConflict(scope, "c1")?.remoteRevision).toBe(9);

        const decision = acceptCanvasExternalRevisionCandidate("c1");

        expect(decision?.kind).toBe("apply");
        const live = useCanvasStore.getState().projects[0];
        expect(live.title).toBe("外部改名");
        expect(live.revision).toBe(9);
        expect(canvasExternalRevisionConflict(scope, "c1")).toBeUndefined();
    });

    test("冲突随本地 revision 前进自动解除，不需要额外清理动作", async () => {
        await seedConfirmedProject(project("c1", 3), 7);
        applyExternalCanvasRevision(project("c1", 9) as never, { hasUnsyncedEdits: true });
        expect(canvasExternalRevisionConflict(scope, "c1")?.remoteRevision).toBe(9);

        useCanvasStore.setState((state) => ({ projects: state.projects.map((item) => item.id === "c1" ? { ...item, revision: 10 } : item) }));

        expect(canvasExternalRevisionConflict(scope, "c1")).toBeUndefined();
    });
});
