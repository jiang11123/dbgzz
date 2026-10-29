import { beforeEach, expect, mock, test } from "bun:test";
import { ApiError } from "@/services/api/request";

type Stored = Map<string, string>;
const stored: Stored = new Map();
let activeScope = "guest";
let scopeGeneration = 1;
let storageHold: Promise<void> | null = null;
let releaseStorage: (() => void) | null = null;
let storageEntered = 0;
let draftHold: Promise<void> | null = null;
let releaseDraftHold: (() => void) | null = null;
let draftWriteEntered = 0;
let draftWriteError: Error | null = null;
let draftRemoveHold: Promise<void> | null = null;
let draftRemoveEntered = 0;

function switchScope(next: string) {
    if (next !== activeScope) scopeGeneration += 1;
    activeScope = next;
}

function holdLegacyWrites() {
    storageHold = new Promise((resolve) => {
        releaseStorage = resolve;
    });
}

type RecordShape = {
    id: string;
    revision: number;
    updatedAt: string;
    deleted?: boolean;
    document?: { id: string; title?: string; messages: Array<Record<string, unknown>> };
};

const server = {
    conversations: new Map<string, RecordShape>(),
    deleted: new Set<string>(),
    failNext: null as { status: number; reason?: string; message?: string } | null,
    puts: [] as Array<{ id: string; expectedRevision: number; title?: string; messageCount: number }>,
    imports: [] as string[],
    putHold: null as Promise<void> | null,
    releasePut: null as (() => void) | null,
    putEntered: 0,
};

function failIfNeeded() {
    if (!server.failNext) return;
    const failure = server.failNext;
    server.failNext = null;
    throw new ApiError(failure.message || "保存失败", { status: failure.status, reason: failure.reason });
}

function holdPuts() {
    server.putHold = new Promise((resolve) => {
        server.releasePut = resolve;
    });
}

function holdDraftWrites() {
    draftHold = new Promise((resolve) => {
        releaseDraftHold = resolve;
    });
}

function capturedGuest() {
    return { userScope: "guest", epoch: 1 };
}

mock.module("@/lib/localforage-storage", () => ({
    localForageStorageForScope: (scope?: string) => ({
        getItem: async (name: string) => stored.get(`${scope ?? activeScope}:${name}`) ?? null,
        setItem: async (name: string, value: string) => {
            if (storageHold && name === "creation-conversations-v1") {
                storageEntered += 1;
                await storageHold;
            }
            if (name.startsWith("creation-conversation-drafts-v1:")) {
                if (draftHold) {
                    draftWriteEntered += 1;
                    await draftHold;
                }
                if (draftWriteError) throw draftWriteError;
            }
            stored.set(`${scope ?? activeScope}:${name}`, value);
        },
        removeItem: async (name: string) => {
            if (draftRemoveHold && name.startsWith("creation-conversation-drafts-v1:")) {
                draftRemoveEntered += 1;
                await draftRemoveHold;
            }
            stored.delete(`${scope ?? activeScope}:${name}`);
        },
    }),
    localForageStorage: {
        getItem: async (name: string) => stored.get(`${activeScope}:${name}`) ?? null,
        setItem: async (name: string, value: string) => { stored.set(`${activeScope}:${name}`, value); },
        removeItem: async (name: string) => { stored.delete(`${activeScope}:${name}`); },
    },
}));

mock.module("@/lib/user-scope", () => ({
    getActiveUserScope: () => activeScope,
    getActiveUserScopeEpoch: () => scopeGeneration,
    getUserScopeGeneration: () => scopeGeneration,
    captureUserScopeEpoch: (scope = activeScope) => ({ scope, generation: scopeGeneration }),
    userScopeEpochMatches: (epoch: { scope: string; generation: number }, live?: { scope: string; generation: number }) => {
        const current = live || { scope: activeScope, generation: scopeGeneration };
        return epoch.scope === current.scope && epoch.generation === current.generation;
    },
    setActiveUserScope: (userId?: string | null) => switchScope(userId || "guest"),
    subscribeUserScope: () => () => undefined,
    scopedStorageKey: (name: string, scope = activeScope) => `${name}:user:${scope}`,
    scopedLocalStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

mock.module("@/services/api/creation-conversations", () => ({
    creationConversationsApi: {
        list: async () => {
            failIfNeeded();
            return {
                conversations: Array.from(server.conversations.values()).filter((item) => !item.deleted),
                deletedIds: Array.from(server.deleted),
            };
        },
        get: async (id: string) => {
            failIfNeeded();
            const existing = server.conversations.get(id);
            if (!existing || existing.deleted) throw new ApiError("创作对话不存在", { status: 404, reason: "not_found" });
            return existing;
        },
        put: async (id: string, input: { expectedRevision: number; document: { id: string; title?: string; messages: Array<Record<string, unknown>> } }) => {
            server.putEntered += 1;
            if (server.putHold) await server.putHold;
            failIfNeeded();
            const title = typeof input.document.title === "string" && input.document.title.trim() ? input.document.title.trim() : "新创作";
            server.puts.push({ id, expectedRevision: input.expectedRevision, title, messageCount: input.document.messages?.length ?? 0 });
            const existing = server.conversations.get(id);
            if (!existing && input.expectedRevision !== 0) throw new ApiError("对话已更新，当前草稿未覆盖已保存内容", { status: 409, reason: "conflict" });
            if (existing?.deleted) throw new ApiError("对话已删除，无法再写入", { status: 409, reason: "conflict" });
            const normalizedDocument = {
                messages: input.document.messages,
                title,
                id: input.document.id,
            };
            if (existing && existing.revision !== input.expectedRevision) {
                if (existing.revision === input.expectedRevision + 1 && JSON.stringify(existing.document) === JSON.stringify(normalizedDocument)) return existing;
                throw new ApiError("对话已更新，当前草稿未覆盖已保存内容", { status: 409, reason: "conflict" });
            }
            const record: RecordShape = {
                id,
                revision: (existing?.revision ?? 0) + 1,
                updatedAt: "2026-10-02T00:00:00.000Z",
                document: normalizedDocument,
            };
            server.conversations.set(id, record);
            return record;
        },
        remove: async (id: string) => {
            failIfNeeded();
            const existing = server.conversations.get(id);
            if (!existing) throw new ApiError("创作对话不存在", { status: 404, reason: "not_found" });
            existing.deleted = true;
            existing.revision += 1;
            server.deleted.add(id);
            return { id, revision: existing.revision, updatedAt: "2026-10-02T00:00:00.000Z", deleted: true };
        },
        importLegacy: async (input: { operationId: string; document: { id: string } }) => {
            failIfNeeded();
            server.imports.push(input.operationId);
            if (server.deleted.has(input.document.id)) {
                return { imported: false, id: input.document.id, deleted: true, conversation: { id: input.document.id, revision: 1, updatedAt: "2026-10-02T00:00:00.000Z", deleted: true } };
            }
            const existing = server.conversations.get(input.document.id);
            if (existing) return { imported: false, id: existing.id, conversation: existing };
            const record: RecordShape = {
                id: input.document.id,
                revision: 1,
                updatedAt: "2026-10-02T00:00:00.000Z",
                document: input.document as RecordShape["document"],
            };
            server.conversations.set(record.id, record);
            return { imported: true, id: record.id, conversation: record };
        },
    },
}));

const {
    CREATION_CONVERSATIONS_KEY,
    loadCreationConversations,
    loadLocalCreationConversationDrafts,
    saveCreationConversations,
    deleteCreationConversation,
    resetCreationConversationStoreForTests,
    acceptSavedCreationConversation,
    restoreParkedCreationConversation,
    hasParkedCreationConversationDraft,
    adoptServerConfirmedConversationDocument,
} = await import("@/services/creation-conversation-store");

beforeEach(() => {
    stored.clear();
    server.conversations.clear();
    server.deleted.clear();
    server.failNext = null;
    server.puts = [];
    server.imports = [];
    server.putHold = null;
    server.releasePut = null;
    server.putEntered = 0;
    activeScope = "guest";
    scopeGeneration = 1;
    storageHold = null;
    releaseStorage = null;
    storageEntered = 0;
    draftHold = null;
    releaseDraftHold = null;
    draftWriteEntered = 0;
    draftWriteError = null;
    draftRemoveHold = null;
    draftRemoveEntered = 0;
    resetCreationConversationStoreForTests();
});

test("load imports IndexedDB only when backend has no record or tombstone", async () => {
    server.conversations.set("kept", { id: "kept", revision: 4, updatedAt: "2026-10-02T00:00:00.000Z", document: { id: "kept", title: "后端", messages: [] } });
    server.deleted.add("gone");
    stored.set(`guest:${CREATION_CONVERSATIONS_KEY}`, JSON.stringify([
        { id: "kept", title: "本地旧稿", messages: [] },
        { id: "gone", title: "已删", messages: [] },
        { id: "fresh", title: "待导入", messages: [{ id: "m1", role: "user", content: "hi" }] },
    ]));
    const loaded = await loadCreationConversations();
    expect(server.imports).toEqual(["creation-conversations-v1:fresh"]);
    expect(loaded?.map((item) => item.id).sort()).toEqual(["fresh", "kept"]);
    expect(loaded?.find((item) => item.id === "kept")).toMatchObject({ title: "本地旧稿" });
    expect(loaded?.find((item) => item.id === "kept")?.conflictRemote).toMatchObject({ revision: 4, document: { title: "后端" } });
    const leftover = JSON.parse(stored.get(`guest:${CREATION_CONVERSATIONS_KEY}`) || "[]") as Array<{ id: string }>;
    expect(leftover.map((item) => item.id)).toEqual(["gone"]);
});

test("save failure keeps visible draft and does not mark server success", async () => {
    const draft = { id: "draft-1", title: "未发出", messages: [{ id: "m1", role: "user" as const, content: "镜头" }] };
    stored.set(`guest:${CREATION_CONVERSATIONS_KEY}`, JSON.stringify([draft]));
    server.failNext = { status: 500, message: "对话保存失败" };
    await expect(saveCreationConversations([draft])).rejects.toThrow("对话保存失败");
    expect(server.puts).toHaveLength(0);
    const local = await loadLocalCreationConversationDrafts();
    expect(local?.find((item) => item.id === "draft-1")).toMatchObject({ title: "未发出" });
    server.failNext = null;
    await saveCreationConversations([draft]);
    expect(server.puts).toEqual([{ id: "draft-1", expectedRevision: 0, title: "未发出", messageCount: 1 }]);
    expect(server.conversations.get("draft-1")?.revision).toBe(1);
    server.puts = [];
    await saveCreationConversations([draft]);
    expect(server.puts).toHaveLength(0);
});

test("scope switch rejects outstanding save", async () => {
    const draft = { id: "scope-1", title: "原工作区", messages: [] };
    const pending = saveCreationConversations([draft]);
    switchScope("other-workspace");
    await expect(pending).rejects.toThrow("工作区已更换，这次操作没有继续。");
    expect(server.puts).toHaveLength(0);
});

test("deleted tombstone is not resurrected by later save of local cache", async () => {
    await saveCreationConversations([{ id: "dead", title: "旧", messages: [] }]);
    await deleteCreationConversation("dead");
    expect(server.deleted.has("dead")).toBe(true);
    await expect(saveCreationConversations([{ id: "dead", title: "复活", messages: [] }])).rejects.toThrow("对话已删除，无法再写入");
    expect(server.conversations.get("dead")?.deleted).toBe(true);
    expect(server.conversations.get("dead")?.document?.title).toBe("旧");
});

test("held write then later save still persists the latest document", async () => {
    holdPuts();
    const first = saveCreationConversations([{ id: "shared", title: "A", messages: [] }]);
    while (server.putEntered === 0) await Promise.resolve();
    const second = saveCreationConversations([{ id: "shared", title: "B", messages: [] }]);
    server.releasePut?.();
    await Promise.all([first, second]);
    expect(server.conversations.get("shared")?.document?.title).toBe("B");
    expect(server.puts.map((item) => item.title)).toEqual(["A", "B"]);
});

test("different conversation drafts survive concurrent saves", async () => {
    await Promise.all([
        saveCreationConversations([{ id: "left", title: "左", messages: [] }]),
        saveCreationConversations([{ id: "right", title: "右", messages: [] }]),
    ]);
    expect(server.conversations.get("left")?.document?.title).toBe("左");
    expect(server.conversations.get("right")?.document?.title).toBe("右");
});

test("failed write then reload recovers the latest draft", async () => {
    const latest = { id: "recover", title: "最新草稿", messages: [{ id: "m1", role: "user" as const, content: "data: keep this prompt" }] };
    server.failNext = { status: 500, message: "对话保存失败" };
    await expect(saveCreationConversations([latest])).rejects.toThrow("对话保存失败");
    resetCreationConversationStoreForTests();
    const recovered = await loadLocalCreationConversationDrafts("guest");
    expect(recovered?.find((item) => item.id === "recover")).toMatchObject({ title: "最新草稿" });
    expect(recovered?.find((item) => item.id === "recover")?.messages[0]).toMatchObject({ content: "data: keep this prompt" });
});

test("conflicting local draft stays visible and does not overwrite remote", async () => {
    server.conversations.set("live", { id: "live", revision: 5, updatedAt: "2026-10-02T00:00:00.000Z", document: { id: "live", title: "后端", messages: [] } });
    stored.set("guest:creation-conversation-drafts-v1:live", JSON.stringify({
        baseRevision: 4,
        document: { id: "live", title: "本地编辑", messages: [{ id: "m1", role: "user", content: "未提交" }] },
    }));
    stored.set("guest:creation-conversation-drafts-v1:index", JSON.stringify(["live"]));
    const loaded = await loadCreationConversations();
    expect(loaded?.find((item) => item.id === "live")).toMatchObject({ title: "本地编辑" });
    expect(loaded?.find((item) => item.id === "live")?.conflictRemote).toMatchObject({ revision: 5, document: { title: "后端" } });
    await saveCreationConversations(loaded || []);
    expect(server.puts).toHaveLength(0);
    expect(server.conversations.get("live")?.document?.title).toBe("后端");
    expect(server.conversations.get("live")?.revision).toBe(5);
    await saveCreationConversations(loaded || [], "guest", { resolveConflictIds: ["live"] });
    expect(server.puts).toEqual([{ id: "live", expectedRevision: 5, title: "本地编辑", messageCount: 1 }]);
    expect(server.conversations.get("live")?.revision).toBe(6);
    expect(server.conversations.get("live")?.document?.title).toBe("本地编辑");
});

test("fallback after remote reject keeps original scope and skips cached tombstones", async () => {
    server.conversations.set("kept", { id: "kept", revision: 1, updatedAt: "2026-10-02T00:00:00.000Z", document: { id: "kept", title: "后端", messages: [] } });
    server.deleted.add("gone");
    stored.set(`guest:${CREATION_CONVERSATIONS_KEY}`, JSON.stringify([
        { id: "gone", title: "墓碑", messages: [] },
    ]));
    stored.set("guest:creation-conversation-drafts-v1:drafty", JSON.stringify({
        baseRevision: 0,
        document: { id: "drafty", title: "原工作区草稿", messages: [] },
    }));
    stored.set("guest:creation-conversation-drafts-v1:index", JSON.stringify(["drafty"]));
    stored.set("other-workspace:creation-conversation-drafts-v1:other", JSON.stringify({
        baseRevision: 0,
        document: { id: "other", title: "新工作区", messages: [] },
    }));
    stored.set("other-workspace:creation-conversation-drafts-v1:index", JSON.stringify(["other"]));
    await loadCreationConversations("guest");
    server.failNext = { status: 500, message: "对话加载失败" };
    await expect(loadCreationConversations("guest")).rejects.toThrow("对话加载失败");
    activeScope = "other-workspace";
    const fallback = await loadLocalCreationConversationDrafts("guest");
    expect(fallback?.map((item) => item.id).sort()).toEqual(["drafty"]);
    expect(fallback?.find((item) => item.id === "gone")).toBeUndefined();
});

test("lost ack of the same document is recovered without a permanent 409", async () => {
    const draft = { id: "replay", title: "原稿", messages: [{ id: "m1", role: "user" as const, content: "hi" }] };
    await saveCreationConversations([draft]);
    expect(server.conversations.get("replay")?.revision).toBe(1);
    resetCreationConversationStoreForTests();
    await saveCreationConversations([draft]);
    expect(server.conversations.get("replay")?.revision).toBe(1);
    expect(server.conversations.get("replay")?.document?.title).toBe("原稿");
});

test("blob-only attachment is a recoverable persist failure", async () => {
    const draft = {
        id: "blob-only",
        title: "附件",
        messages: [{ id: "m1", role: "user" as const, content: "hi", attachments: [{ id: "a1", dataUrl: "data:image/png;base64,aaaa" }] }],
    };
    await expect(saveCreationConversations([draft])).rejects.toThrow("附件没有可恢复的存储引用");
    expect(server.puts).toHaveLength(0);
    const local = await loadLocalCreationConversationDrafts();
    expect(local?.find((item) => item.id === "blob-only")).toMatchObject({ title: "附件" });
});

test("caller mutation during delayed PUT cannot change in-flight payload", async () => {
    holdPuts();
    const draft = { id: "mut", title: "原", messages: [{ id: "m1", role: "user" as const, content: "one" }] };
    const pending = saveCreationConversations([draft]);
    while (server.putEntered === 0) await Promise.resolve();
    draft.messages.push({ id: "m2", role: "user" as const, content: "two" });
    draft.title = "changed";
    server.releasePut?.();
    await pending;
    expect(server.puts[0]).toMatchObject({ id: "mut", title: "原", messageCount: 1 });
    expect(server.conversations.get("mut")?.document?.title).toBe("原");
    expect(server.conversations.get("mut")?.document?.messages).toHaveLength(1);
});

test("delayed first cleanup does not import after account switch including A-B-A", async () => {
    server.conversations.set("kept", { id: "kept", revision: 1, updatedAt: "2026-10-02T00:00:00.000Z", document: { id: "kept", title: "后端", messages: [] } });
    stored.set(`guest:${CREATION_CONVERSATIONS_KEY}`, JSON.stringify([
        { id: "kept", title: "后端", messages: [] },
        { id: "fresh", title: "待导入", messages: [{ id: "m1", role: "user", content: "hi" }] },
    ]));
    holdLegacyWrites();
    const pending = loadCreationConversations("guest");
    for (let turn = 0; turn < 50 && storageEntered === 0; turn += 1) await Promise.resolve();
    expect(storageEntered).toBeGreaterThan(0);
    switchScope("other-workspace");
    switchScope("guest");
    releaseStorage?.();
    await expect(pending).rejects.toThrow("工作区已更换，这次操作没有继续。");
    expect(server.imports).toEqual([]);
    expect(server.conversations.has("fresh")).toBe(false);
});

test("canonical untitled ack skips a second PUT", async () => {
    await saveCreationConversations([{ id: "untitled", messages: [] }]);
    expect(server.puts).toEqual([{ id: "untitled", expectedRevision: 0, title: "新创作", messageCount: 0 }]);
    expect(server.conversations.get("untitled")?.document?.title).toBe("新创作");
    server.puts = [];
    await saveCreationConversations([{ id: "untitled", messages: [] }]);
    expect(server.puts).toHaveLength(0);
    const loaded = await loadCreationConversations();
    expect(loaded?.find((item) => item.id === "untitled")).toMatchObject({ title: "新创作" });
});

test("accepting saved version parks local draft and restore brings conflict back", async () => {
    server.conversations.set("live", { id: "live", revision: 5, updatedAt: "2026-10-02T00:00:00.000Z", document: { id: "live", title: "后端", messages: [] } });
    stored.set("guest:creation-conversation-drafts-v1:live", JSON.stringify({
        baseRevision: 4,
        document: { id: "live", title: "本地编辑", messages: [{ id: "m1", role: "user", content: "未提交" }] },
    }));
    stored.set("guest:creation-conversation-drafts-v1:index", JSON.stringify(["live"]));
    const loaded = await loadCreationConversations();
    const live = loaded?.find((item) => item.id === "live");
    expect(live?.conflictRemote?.revision).toBe(5);
    await acceptSavedCreationConversation("live", live!, live!.conflictRemote!);
    expect(await hasParkedCreationConversationDraft("live")).toBe(true);
    server.puts = [];
    await saveCreationConversations([{ id: "live", title: "后端", messages: [] }]);
    expect(server.puts).toHaveLength(0);
    resetCreationConversationStoreForTests();
    const afterAccept = await loadCreationConversations();
    expect(afterAccept?.find((item) => item.id === "live")).toMatchObject({ title: "后端" });
    expect(afterAccept?.find((item) => item.id === "live")?.conflictRemote).toBeUndefined();
    const restored = await restoreParkedCreationConversation("live");
    expect(restored).toMatchObject({ title: "本地编辑" });
    expect(restored?.conflictRemote).toMatchObject({ revision: 5, document: { title: "后端" } });
    resetCreationConversationStoreForTests();
    const afterRestore = await loadCreationConversations();
    expect(afterRestore?.find((item) => item.id === "live")).toMatchObject({ title: "本地编辑" });
    expect(afterRestore?.find((item) => item.id === "live")?.conflictRemote?.revision).toBe(5);
});

test("matching legacy of an existing server record is cleared without conflict", async () => {
    server.conversations.set("same", { id: "same", revision: 2, updatedAt: "2026-10-02T00:00:00.000Z", document: { id: "same", title: "一样", messages: [] } });
    stored.set(`guest:${CREATION_CONVERSATIONS_KEY}`, JSON.stringify([{ id: "same", title: "一样", messages: [] }]));
    const loaded = await loadCreationConversations();
    expect(loaded?.find((item) => item.id === "same")).toMatchObject({ title: "一样" });
    expect(loaded?.find((item) => item.id === "same")?.conflictRemote).toBeUndefined();
    expect(server.imports).toEqual([]);
    const leftover = JSON.parse(stored.get(`guest:${CREATION_CONVERSATIONS_KEY}`) || "[]") as Array<{ id: string }>;
    expect(leftover).toEqual([]);
});

test("later generation is projected onto the canonical untitled ack", async () => {
    holdPuts();
    const first = saveCreationConversations([{ id: "proj", messages: [{ id: "m1", role: "user" as const, content: "a" }] }]);
    while (server.putEntered === 0) await Promise.resolve();
    const second = saveCreationConversations([{
        id: "proj",
        messages: [
            { id: "m1", role: "user" as const, content: "a" },
            { id: "m2", role: "user" as const, content: "b" },
        ],
    }]);
    server.releasePut?.();
    await Promise.all([first, second]);
    expect(server.puts.map((item) => item.title)).toEqual(["新创作", "新创作"]);
    expect(server.puts.map((item) => item.messageCount)).toEqual([1, 2]);
    expect(server.conversations.get("proj")?.document?.title).toBe("新创作");
    expect(server.conversations.get("proj")?.document?.messages).toHaveLength(2);
});

test("adoptServerConfirmedConversationDocument uses the entry captured scope and does not PUT", async () => {
    const captured = { userScope: "guest", epoch: 1 };
    const adopted = await adoptServerConfirmedConversationDocument("conv-1", {
        id: "conv-1",
        title: "已绑定",
        messages: [{ id: "msg-1", role: "assistant", content: "图片已生成" }],
    }, 4, captured);
    expect(adopted.title).toBe("已绑定");
    expect(server.puts).toEqual([]);

    await expect(adoptServerConfirmedConversationDocument("conv-1", {
        id: "conv-1",
        title: "下一账号",
        messages: [],
    }, 5, { userScope: "guest", epoch: 1 })).resolves.toMatchObject({ title: "下一账号" });

    switchScope("user-b");
    await expect(adoptServerConfirmedConversationDocument("conv-1", {
        id: "conv-1",
        title: "不该写入",
        messages: [],
    }, 6, captured)).rejects.toMatchObject({ name: "UserScopeAbandonedError" });
    expect(server.puts).toEqual([]);
});

test("adopt keeps deferred user edits instead of dropping the draft", async () => {
    server.conversations.set("conv-1", {
        id: "conv-1",
        revision: 3,
        updatedAt: "2026-10-02T00:00:00.000Z",
        document: {
            id: "conv-1",
            title: "原稿",
            messages: [
                { id: "user-1", role: "user", content: "镜头" },
                { id: "msg-1", role: "assistant", status: "pending", content: "", taskIds: ["task-1"] },
            ],
        },
    });
    await loadCreationConversations();
    holdPuts();
    const saveP = saveCreationConversations([{
        id: "conv-1",
        title: "改名",
        messages: [
            { id: "user-1", role: "user", content: "镜头" },
            { id: "msg-1", role: "assistant", status: "pending", content: "", taskIds: ["task-1"] },
            { id: "user-2", role: "user", content: "补充" },
        ],
    }]);
    while (server.putEntered === 0) await Promise.resolve();
    const adopted = await adoptServerConfirmedConversationDocument("conv-1", {
        id: "conv-1",
        title: "原稿",
        messages: [
            { id: "user-1", role: "user", content: "镜头" },
            { id: "msg-1", role: "assistant", status: "done", content: "图片已生成", taskIds: ["task-1"], resultUrls: ["/api/resources/res-1/file"] },
        ],
    }, 5, capturedGuest());
    expect(adopted.title).toBe("改名");
    expect((adopted.messages as Array<{ id: string; content?: string }>).map((item) => item.id)).toEqual(["user-1", "msg-1", "user-2"]);
    expect((adopted.messages as Array<{ id: string; content?: string }>).find((item) => item.id === "msg-1")?.content).toBe("图片已生成");
    expect((adopted.messages as Array<{ id: string; content?: string }>).find((item) => item.id === "user-2")?.content).toBe("补充");
    const drafts = await loadLocalCreationConversationDrafts();
    expect(drafts?.find((item) => item.id === "conv-1")).toMatchObject({ title: "改名" });
    expect(drafts?.find((item) => item.id === "conv-1")?.messages).toHaveLength(3);
    server.releasePut?.();
    await saveP;
    const afterFlush = await loadLocalCreationConversationDrafts();
    expect(afterFlush?.find((item) => item.id === "conv-1")?.messages).toHaveLength(3);
    expect(server.conversations.get("conv-1")?.document?.title).toBe("改名");
});

test("adopt keeps a local title edit without resurrecting a remotely deleted message", async () => {
    server.conversations.set("conv-1", {
        id: "conv-1", revision: 3, updatedAt: "2026-10-02T00:00:00.000Z",
        document: { id: "conv-1", title: "原稿", messages: [{ id: "msg-1", role: "user", content: "旧消息" }] },
    });
    await loadCreationConversations();
    holdPuts();
    const saving = saveCreationConversations([{ id: "conv-1", title: "本地标题", messages: [{ id: "msg-1", role: "user", content: "旧消息" }] }]);
    while (!server.putEntered) await Promise.resolve();
    const adopted = await adoptServerConfirmedConversationDocument("conv-1", { id: "conv-1", title: "原稿", messages: [] }, 5, capturedGuest());
    expect(adopted.title).toBe("本地标题");
    expect(adopted.messages).toEqual([]);
    server.releasePut?.();
    await saving;
});

test("adopt refuses an older receipt instead of rolling back committed truth", async () => {
    const newer = await adoptServerConfirmedConversationDocument("conv-1", {
        id: "conv-1",
        title: "新确认",
        messages: [{ id: "msg-1", role: "assistant", content: "图片已生成" }],
    }, 5, capturedGuest());
    expect(newer.title).toBe("新确认");
    const older = await adoptServerConfirmedConversationDocument("conv-1", {
        id: "conv-1",
        title: "旧回执",
        messages: [{ id: "msg-1", role: "assistant", content: "旧内容" }],
    }, 3, capturedGuest());
    expect(older.title).toBe("新确认");
    expect((older.messages as Array<{ content?: string }>)[0]?.content).toBe("图片已生成");
    const drafts = await loadLocalCreationConversationDrafts();
    expect(drafts?.find((item) => item.id === "conv-1")).toBeUndefined();
});

test("adopt IDB failure keeps the user draft and retry merges after restart", async () => {
    server.conversations.set("conv-1", {
        id: "conv-1",
        revision: 3,
        updatedAt: "2026-10-02T00:00:00.000Z",
        document: {
            id: "conv-1",
            title: "原稿",
            messages: [
                { id: "user-1", role: "user", content: "镜头" },
                { id: "msg-1", role: "assistant", status: "pending", content: "", taskIds: ["task-1"] },
            ],
        },
    });
    await loadCreationConversations();
    holdPuts();
    const saveP = saveCreationConversations([{
        id: "conv-1",
        title: "改名",
        messages: [
            { id: "user-1", role: "user", content: "镜头" },
            { id: "msg-1", role: "assistant", status: "pending", content: "", taskIds: ["task-1"] },
            { id: "user-2", role: "user", content: "补充" },
        ],
    }]);
    while (server.putEntered === 0) await Promise.resolve();
    draftWriteError = new Error("IndexedDB unavailable");
    await expect(adoptServerConfirmedConversationDocument("conv-1", {
        id: "conv-1",
        title: "原稿",
        messages: [
            { id: "user-1", role: "user", content: "镜头" },
            { id: "msg-1", role: "assistant", status: "done", content: "图片已生成", taskIds: ["task-1"] },
        ],
    }, 5, capturedGuest())).rejects.toThrow("IndexedDB unavailable");
    const kept = JSON.parse(stored.get("guest:creation-conversation-drafts-v1:conv-1") || "null") as { document?: { title?: string; messages?: unknown[] } };
    expect(kept.document?.title).toBe("改名");
    expect(kept.document?.messages).toHaveLength(3);
    draftWriteError = null;
    resetCreationConversationStoreForTests();
    const afterRestart = await loadLocalCreationConversationDrafts();
    expect(afterRestart?.find((item) => item.id === "conv-1")).toMatchObject({ title: "改名" });
    expect(afterRestart?.find((item) => item.id === "conv-1")?.messages).toHaveLength(3);
    await loadCreationConversations();
    const retried = await adoptServerConfirmedConversationDocument("conv-1", {
        id: "conv-1",
        title: "原稿",
        messages: [
            { id: "user-1", role: "user", content: "镜头" },
            { id: "msg-1", role: "assistant", status: "done", content: "图片已生成", taskIds: ["task-1"] },
        ],
    }, 5, capturedGuest());
    expect(retried.title).toBe("改名");
    expect((retried.messages as Array<{ id: string; content?: string }>).find((item) => item.id === "msg-1")?.content).toBe("图片已生成");
    expect((retried.messages as Array<{ id: string }>).find((item) => item.id === "user-2")).toBeDefined();
    server.releasePut?.();
    await saveP.catch(() => undefined);
});

test("adopt keeps an edit arriving during the final draft removal", async () => {
    server.conversations.set("conv-1", { id: "conv-1", revision: 3, updatedAt: "2026-10-02T00:00:00.000Z", document: { id: "conv-1", title: "原稿", messages: [] } });
    await loadCreationConversations();
    let release!: () => void;
    draftRemoveHold = new Promise<void>((resolve) => { release = resolve; });
    holdPuts();
    const adoptP = adoptServerConfirmedConversationDocument("conv-1", { id: "conv-1", title: "原稿", messages: [] }, 5, capturedGuest());
    while (!draftRemoveEntered) await Promise.resolve();
    const saveP = saveCreationConversations([{ id: "conv-1", title: "最后一步的新编辑", messages: [{ id: "new", role: "user", content: "保留" }] }]);
    release();
    const adopted = await adoptP;
    server.releasePut?.();
    await saveP.catch(() => undefined);
    expect(adopted.title).toBe("最后一步的新编辑");
    expect(adopted.messages).toHaveLength(1);
});

test("adopt keeps a newer draft that arrives while receipt persistence is in flight", async () => {
    server.conversations.set("conv-1", {
        id: "conv-1",
        revision: 3,
        updatedAt: "2026-10-02T00:00:00.000Z",
        document: {
            id: "conv-1",
            title: "原稿",
            messages: [
                { id: "user-1", role: "user", content: "镜头" },
                { id: "msg-1", role: "assistant", status: "pending", content: "", taskIds: ["task-1"] },
            ],
        },
    });
    await loadCreationConversations();
    holdDraftWrites();
    const adoptP = adoptServerConfirmedConversationDocument("conv-1", {
        id: "conv-1",
        title: "原稿",
        messages: [
            { id: "user-1", role: "user", content: "镜头" },
            { id: "msg-1", role: "assistant", status: "done", content: "图片已生成", taskIds: ["task-1"] },
        ],
    }, 5, capturedGuest());
    while (draftWriteEntered === 0) await Promise.resolve();
    const saveP = saveCreationConversations([{
        id: "conv-1",
        title: "途中改名",
        messages: [
            { id: "user-1", role: "user", content: "镜头" },
            { id: "msg-1", role: "assistant", status: "pending", content: "", taskIds: ["task-1"] },
            { id: "user-2", role: "user", content: "途中补充" },
        ],
    }]);
    await Promise.resolve();
    releaseDraftHold?.();
    const adopted = await adoptP;
    expect(adopted.title).toBe("途中改名");
    expect((adopted.messages as Array<{ id: string; content?: string }>).find((item) => item.id === "msg-1")?.content).toBe("图片已生成");
    expect((adopted.messages as Array<{ id: string; content?: string }>).find((item) => item.id === "user-2")?.content).toBe("途中补充");
    await saveP.catch(() => undefined);
    const drafts = await loadLocalCreationConversationDrafts();
    expect(drafts?.find((item) => item.id === "conv-1")).toMatchObject({ title: "途中改名" });
    expect((drafts?.find((item) => item.id === "conv-1")?.messages as Array<{ id: string }> | undefined)?.some((item) => item.id === "user-2")).toBe(true);
});
