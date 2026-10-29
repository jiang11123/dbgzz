import { localForageStorageForScope } from "@/lib/localforage-storage";
import { captureUserScopeEpoch, getActiveUserScope, userScopeEpochMatches, type UserScopeEpoch } from "@/lib/user-scope";
import { assertUserScope, type CapturedUserScope } from "@/lib/user-scope-guard";
import { ApiError } from "@/services/api/request";
import { creationConversationsApi, type CreationConversationDocument, type CreationConversationRecord } from "@/services/api/creation-conversations";

export const CREATION_CONVERSATIONS_KEY = "creation-conversations-v1";
const CREATION_CONVERSATION_DRAFTS_KEY = "creation-conversation-drafts-v1";
const CREATION_CONVERSATION_DRAFT_INDEX_KEY = "creation-conversation-drafts-v1:index";
const CREATION_CONVERSATION_TOMBSTONES_KEY = "creation-conversation-tombstones-v1";
const SCOPE_SWITCHED_MESSAGE = "工作区已更换，这次操作没有继续。";

type PendingCreationMessage = {
    id: string;
    role: "user" | "assistant";
    mode?: string;
    status?: string;
    taskIds?: string[];
};

export type StoredCreationConversation = {
    id: string;
    messages: PendingCreationMessage[];
    conflictRemote?: { revision: number; document: StoredCreationConversation };
    [key: string]: unknown;
};

type ConversationDraft = {
    baseRevision: number;
    document: StoredCreationConversation;
    remote?: { revision: number; document: StoredCreationConversation };
};

type CommittedState = {
    revision: number;
    fingerprint: string;
    document: StoredCreationConversation;
};

type PendingWrite = {
    generation: number;
    document: StoredCreationConversation;
};

const committed = new Map<string, CommittedState>();
const writeQueues = new Map<string, Promise<unknown>>();
const storageQueues = new Map<string, Promise<unknown>>();
const pendingWrites = new Map<string, PendingWrite>();
const writeGenerations = new Map<string, number>();

const mediaURLKeys = new Set(["dataurl", "url", "previewurl", "poster", "src", "thumbnail", "thumbnailurl", "imageurl"]);

export function updateCreationConversationSnapshot<T extends { id: string }>(conversations: T[], conversationId: string, updater: (conversation: T) => T) {
    return conversations.map((conversation) => (conversation.id === conversationId ? updater(conversation) : conversation));
}

// 对话、生成任务与素材是独立持久状态；删除历史记录不能在这里级联清理任务或资源。
export function removeCreationConversationSnapshot<T extends { id: string }>(conversations: T[], conversationId: string) {
    if (!conversationId) throw new Error("缺少要删除的创作对话 ID");
    const next = conversations.filter((conversation) => conversation.id !== conversationId);
    if (next.length === conversations.length) throw new Error("要删除的创作对话不存在");
    return next;
}

function isRecoverableCreationMessage(message: PendingCreationMessage) {
    if (message.role !== "assistant" || !message.taskIds?.length) return false;
    return message.mode === "text" ? message.status === "streaming" || message.status === "pending" : message.status === "pending";
}

export function pendingCreationTaskKey(conversations: StoredCreationConversation[]) {
    return conversations
        .flatMap((conversation) => conversation.messages.flatMap((message) => (isRecoverableCreationMessage(message) ? [`${conversation.id}:${message.id}:${(message.taskIds || []).join(",")}`] : [])))
        .join("|");
}

export function pendingCreationTaskIds(conversations: StoredCreationConversation[]) {
    const taskIds = conversations.flatMap((conversation) =>
        conversation.messages.flatMap((message) => {
            if (!isRecoverableCreationMessage(message)) return [];
            return message.taskIds || [];
        }),
    );
    return Array.from(new Set(taskIds));
}

function scopeKey(scope: string, id: string) {
    return `${scope}:${id}`;
}

function draftItemKey(id: string) {
    return `${CREATION_CONVERSATION_DRAFTS_KEY}:${id}`;
}

function rememberCommitted(scope: string, id: string, revision: number, document: StoredCreationConversation) {
    committed.set(scopeKey(scope, id), { revision, fingerprint: fingerprintOf(document), document: cloneConversation(document) });
}

function commitIfCurrent(scope: string, id: string, revision: number, document: StoredCreationConversation) {
    const current = committed.get(scopeKey(scope, id));
    if (current && current.revision > revision) return false;
    rememberCommitted(scope, id, revision, document);
    return true;
}

function forgetCommitted(scope: string, id: string) {
    committed.delete(scopeKey(scope, id));
    pendingWrites.delete(scopeKey(scope, id));
}

function fingerprintOf(document: StoredCreationConversation) {
    return canonicalFingerprint(persistableDocument(document));
}

function persistableFingerprint(document: StoredCreationConversation) {
    try {
        return fingerprintOf(document);
    } catch {
        return null;
    }
}

function persistableDocument(conversation: StoredCreationConversation): CreationConversationDocument {
    const { revision: _revision, pending: _pending, conflictRemote: _conflictRemote, ...rest } = conversation;
    const stripped = stripEphemeralMedia(rest) as Record<string, unknown>;
    const title = typeof stripped.title === "string" ? stripped.title.trim() : "";
    stripped.title = title || "新创作";
    return stripped as CreationConversationDocument;
}

function cloneConversation<T>(value: T): T {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value)) as T;
}

export function conversationHasConflict(conversation: { conflictRemote?: unknown } | null | undefined) {
    return Boolean(conversation?.conflictRemote);
}

function parkedDraftKey(id: string) {
    return `${CREATION_CONVERSATION_DRAFTS_KEY}:${id}:replaced`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function samePersistable(left: unknown, right: unknown) {
    try {
        return canonicalFingerprint(left) === canonicalFingerprint(right);
    } catch {
        return false;
    }
}

function projectPendingOnCanonical(sent: StoredCreationConversation, pending: StoredCreationConversation, canonical: StoredCreationConversation): StoredCreationConversation {
    const pendingFingerprint = persistableFingerprint(pending);
    const sentFingerprint = persistableFingerprint(sent);
    if (pendingFingerprint && sentFingerprint && pendingFingerprint === sentFingerprint) return cloneConversation(canonical);
    const merged = threeWayValue(sent, pending, canonical);
    if (!isPlainObject(merged)) return cloneConversation(pending);
    const { conflictRemote: _conflictRemote, ...rest } = merged as StoredCreationConversation;
    const messages = Array.isArray(rest.messages) ? rest.messages : pending.messages;
    return { ...rest, id: pending.id || canonical.id, messages } as StoredCreationConversation;
}

function threeWayValue(base: unknown, ours: unknown, theirs: unknown): unknown {
    if (samePersistable(ours, base)) return theirs;
    if (samePersistable(theirs, base)) return ours;
    if (Array.isArray(ours) && Array.isArray(theirs) && Array.isArray(base) && looksLikeMessageList(ours)) {
        return threeWayMessages(base, ours, theirs);
    }
    if (isPlainObject(ours) && isPlainObject(theirs) && isPlainObject(base)) {
        const keys = new Set([...Object.keys(ours), ...Object.keys(theirs), ...Object.keys(base)]);
        const out: Record<string, unknown> = {};
        for (const key of keys) {
            if (key === "conflictRemote") continue;
            if (!(key in ours)) {
                if (samePersistable(theirs[key], base[key])) continue;
                out[key] = theirs[key];
                continue;
            }
            out[key] = threeWayValue(base[key], ours[key], key in theirs ? theirs[key] : ours[key]);
        }
        return out;
    }
    return ours;
}

function looksLikeMessageList(value: unknown[]) {
    return value.every((item) => !item || (isPlainObject(item) && typeof item.id === "string"));
}

function threeWayMessages(base: unknown[], ours: unknown[], theirs: unknown[]) {
    const baseById = messageMap(base);
    const oursById = messageMap(ours);
    const theirsById = messageMap(theirs);
    const seen = new Set<string>();
    const merged: unknown[] = [];
    for (const item of ours) {
        if (!isPlainObject(item) || typeof item.id !== "string") {
            merged.push(item);
            continue;
        }
        seen.add(item.id);
        const previous = baseById.get(item.id);
        const canonical = theirsById.get(item.id);
        if (!previous) {
            merged.push(item);
            continue;
        }
        if (samePersistable(item, previous)) {
            if (canonical) merged.push(canonical);
            continue;
        }
        merged.push(threeWayValue(previous, item, canonical ?? item));
    }
    for (const item of theirs) {
        if (!isPlainObject(item) || typeof item.id !== "string" || seen.has(item.id)) continue;
        if (baseById.has(item.id) && !oursById.has(item.id)) continue;
        merged.push(item);
    }
    return merged;
}

function messageMap(list: unknown[]) {
    const map = new Map<string, Record<string, unknown>>();
    for (const item of list) {
        if (isPlainObject(item) && typeof item.id === "string") map.set(item.id, item);
    }
    return map;
}

function fieldKey(key: string) {
    return key.trim().toLowerCase().replace(/_/g, "");
}

function isMediaURLKey(key: string) {
    return mediaURLKeys.has(fieldKey(key));
}

function isTempMediaBlob(value: string) {
    const trimmed = value.trim().toLowerCase();
    return trimmed.startsWith("data:") || trimmed.startsWith("blob:");
}

function stringField(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function stripEphemeralMedia(value: unknown, key = ""): unknown {
    if (typeof value === "string") {
        if (isMediaURLKey(key) && isTempMediaBlob(value)) return undefined;
        return value;
    }
    if (Array.isArray(value)) {
        if (fieldKey(key) === "attachments") return value.map((item) => persistAttachment(item));
        if (fieldKey(key) === "resulturls") {
            return value.map((item) => stripEphemeralMedia(item, "url")).filter((item) => item !== undefined);
        }
        return value.map((item) => stripEphemeralMedia(item)).filter((item) => item !== undefined);
    }
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [childKey, item] of Object.entries(value as Record<string, unknown>)) {
            const cleaned = stripEphemeralMedia(item, childKey);
            if (cleaned !== undefined) out[childKey] = cleaned;
        }
        return out;
    }
    return value;
}

function persistAttachment(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("附件必须是对象");
    const attachment = value as Record<string, unknown>;
    const storageKey = stringField(attachment.storageKey) || stringField(attachment.storage_key);
    const out: Record<string, unknown> = {};
    for (const [childKey, item] of Object.entries(attachment)) {
        if (typeof item === "string" && isMediaURLKey(childKey) && isTempMediaBlob(item)) {
            if (!storageKey) throw new Error("附件没有可恢复的存储引用");
            continue;
        }
        const cleaned = stripEphemeralMedia(item, childKey);
        if (cleaned !== undefined) out[childKey] = cleaned;
    }
    return out;
}

function canonicalFingerprint(value: unknown): string {
    return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.keys(value as Record<string, unknown>)
                .sort()
                .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
        );
    }
    return value;
}

function rejectIfScopeChanged(epoch: UserScopeEpoch) {
    if (!userScopeEpochMatches(epoch)) throw new Error(SCOPE_SWITCHED_MESSAGE);
}

function captureScope(scope = getActiveUserScope()): UserScopeEpoch {
    return captureUserScopeEpoch(scope);
}

function enqueue(scope: string, id: string, work: () => Promise<void>) {
    const key = scopeKey(scope, id);
    const previous = writeQueues.get(key) || Promise.resolve();
    const next = previous.then(work, work);
    writeQueues.set(key, next.catch(() => undefined));
    return next;
}

function withScopeStorage<T>(scope: string, work: () => Promise<T>): Promise<T> {
    const previous = storageQueues.get(scope) || Promise.resolve();
    const current = previous.then(work, work) as Promise<T>;
    storageQueues.set(scope, current.then(() => undefined, () => undefined));
    return current;
}

function nextGeneration(key: string) {
    const generation = (writeGenerations.get(key) || 0) + 1;
    writeGenerations.set(key, generation);
    return generation;
}

async function readLegacyArray(scope: string): Promise<StoredCreationConversation[] | null> {
    const storage = localForageStorageForScope(scope);
    const value = await storage.getItem(CREATION_CONVERSATIONS_KEY);
    if (!value) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        throw new Error("创作对话持久状态无效");
    }
    if (!Array.isArray(parsed)) throw new Error("创作对话持久状态无效");
    return parsed as StoredCreationConversation[];
}

async function writeLegacyArray(scope: string, conversations: StoredCreationConversation[]) {
    const storage = localForageStorageForScope(scope);
    await storage.setItem(CREATION_CONVERSATIONS_KEY, JSON.stringify(conversations));
}

async function removeLegacyConversation(scope: string, id: string) {
    const legacy = await readLegacyArray(scope);
    if (!legacy?.some((item) => item.id === id)) return;
    await writeLegacyArray(scope, legacy.filter((item) => item.id !== id));
}

async function readJSON<T>(scope: string, key: string, fallback: T): Promise<T> {
    const storage = localForageStorageForScope(scope);
    const value = await storage.getItem(key);
    if (!value) return fallback;
    try {
        return JSON.parse(value) as T;
    } catch {
        throw new Error("创作对话本地状态无效");
    }
}

async function readDraftIndex(scope: string): Promise<string[]> {
    await migrateCombinedDrafts(scope);
    const index = await readJSON<string[]>(scope, CREATION_CONVERSATION_DRAFT_INDEX_KEY, []);
    return Array.isArray(index) ? index.filter((id) => typeof id === "string" && id) : [];
}

async function migrateCombinedDrafts(scope: string) {
    const storage = localForageStorageForScope(scope);
    const raw = await storage.getItem(CREATION_CONVERSATION_DRAFTS_KEY);
    if (!raw) return;
    let parsed: Record<string, ConversationDraft>;
    try {
        parsed = JSON.parse(raw) as Record<string, ConversationDraft>;
    } catch {
        await storage.removeItem(CREATION_CONVERSATION_DRAFTS_KEY);
        return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        await storage.removeItem(CREATION_CONVERSATION_DRAFTS_KEY);
        return;
    }
    const ids = Object.keys(parsed);
    for (const id of ids) {
        if (parsed[id]?.document) await storage.setItem(draftItemKey(id), JSON.stringify(parsed[id]));
    }
    await storage.setItem(CREATION_CONVERSATION_DRAFT_INDEX_KEY, JSON.stringify(ids));
    await storage.removeItem(CREATION_CONVERSATION_DRAFTS_KEY);
}

async function readDraft(scope: string, id: string): Promise<ConversationDraft | null> {
    const value = await readJSON<ConversationDraft | null>(scope, draftItemKey(id), null);
    if (!value?.document) return null;
    return value;
}

async function writeDraft(scope: string, id: string, draft: ConversationDraft) {
    const storage = localForageStorageForScope(scope);
    await storage.setItem(draftItemKey(id), JSON.stringify(draft));
    const index = await readDraftIndex(scope);
    if (!index.includes(id)) {
        index.push(id);
        await storage.setItem(CREATION_CONVERSATION_DRAFT_INDEX_KEY, JSON.stringify(index));
    }
}

async function removeDraft(scope: string, id: string) {
    const storage = localForageStorageForScope(scope);
    await storage.removeItem(draftItemKey(id));
    const index = (await readDraftIndex(scope)).filter((item) => item !== id);
    await storage.setItem(CREATION_CONVERSATION_DRAFT_INDEX_KEY, JSON.stringify(index));
}

async function listDrafts(scope: string): Promise<Record<string, ConversationDraft>> {
    const ids = await readDraftIndex(scope);
    const drafts: Record<string, ConversationDraft> = {};
    for (const id of ids) {
        const draft = await readDraft(scope, id);
        if (draft) drafts[id] = draft;
    }
    return drafts;
}

async function readTombstones(scope: string): Promise<Set<string>> {
    const ids = await readJSON<string[]>(scope, CREATION_CONVERSATION_TOMBSTONES_KEY, []);
    return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && id) : []);
}

async function writeTombstones(scope: string, ids: Set<string>) {
    const storage = localForageStorageForScope(scope);
    await storage.setItem(CREATION_CONVERSATION_TOMBSTONES_KEY, JSON.stringify(Array.from(ids)));
}

async function rememberTombstones(scope: string, ids: string[]) {
    await withScopeStorage(scope, async () => {
        const current = await readTombstones(scope);
        for (const id of ids) current.add(id);
        await writeTombstones(scope, current);
    });
}

async function captureDraft(scope: string, id: string, document: StoredCreationConversation) {
    await withScopeStorage(scope, async () => {
        const existing = await readDraft(scope, id);
        const committedRevision = committed.get(scopeKey(scope, id))?.revision ?? 0;
        const baseRevision = existing && existing.baseRevision < committedRevision ? existing.baseRevision : committedRevision;
        const { conflictRemote, ...rest } = document;
        await writeDraft(scope, id, {
            baseRevision,
            document: rest as StoredCreationConversation,
            remote: conflictRemote || existing?.remote,
        });
    });
}

async function draftBaseRevision(scope: string, id: string) {
    return withScopeStorage(scope, async () => {
        const existing = await readDraft(scope, id);
        const committedRevision = committed.get(scopeKey(scope, id))?.revision ?? 0;
        if (existing && existing.baseRevision < committedRevision) return existing.baseRevision;
        return committedRevision;
    });
}

function documentFromRecord(record: { id: string; document?: CreationConversationDocument }): StoredCreationConversation {
    const document = record.document;
    if (!document || typeof document !== "object") {
        return { id: record.id, messages: [] };
    }
    const messages = Array.isArray(document.messages) ? document.messages : [];
    return { ...document, id: record.id, messages } as StoredCreationConversation;
}

function withConflict(document: StoredCreationConversation, remote: { revision: number; document: StoredCreationConversation }): StoredCreationConversation {
    const { conflictRemote: _conflictRemote, ...rest } = document;
    return { ...rest, conflictRemote: remote };
}

export async function loadLocalCreationConversationDrafts<T extends StoredCreationConversation>(scope = getActiveUserScope()) {
    const drafts = await withScopeStorage(scope, () => listDrafts(scope));
    const tombstones = await withScopeStorage(scope, () => readTombstones(scope));
    const legacy = await withScopeStorage(scope, () => readLegacyArray(scope));
    const byId = new Map<string, T>();
    for (const item of legacy || []) {
        if (item?.id && !tombstones.has(item.id)) byId.set(item.id, item as T);
    }
    for (const [id, draft] of Object.entries(drafts)) {
        if (draft?.document?.id && !tombstones.has(id)) {
            byId.set(id, (draft.remote ? withConflict(draft.document, draft.remote) : draft.document) as T);
        }
    }
    return byId.size ? Array.from(byId.values()) : null;
}

export async function loadCreationConversations<T extends StoredCreationConversation>(scope = getActiveUserScope()) {
    const epoch = captureScope(scope);
    rejectIfScopeChanged(epoch);
    const listed = await creationConversationsApi.list();
    rejectIfScopeChanged(epoch);
    const deleted = new Set(listed.deletedIds || []);
    await rememberTombstones(scope, listed.deletedIds || []);
    rejectIfScopeChanged(epoch);
    const committedRecords = new Map((listed.conversations || []).map((item) => [item.id, item]));
    const tombstones = await withScopeStorage(scope, () => readTombstones(scope));
    const legacy = await withScopeStorage(scope, () => readLegacyArray(scope));
    rejectIfScopeChanged(epoch);
    for (const local of legacy || []) {
        rejectIfScopeChanged(epoch);
        if (!local?.id || deleted.has(local.id) || tombstones.has(local.id)) continue;
        const existing = committedRecords.get(local.id);
        if (existing && !existing.deleted) {
            const remoteDocument = documentFromRecord(existing);
            const localFingerprint = persistableFingerprint(local);
            const remoteFingerprint = persistableFingerprint(remoteDocument);
            if (localFingerprint && remoteFingerprint && localFingerprint === remoteFingerprint) {
                rejectIfScopeChanged(epoch);
                await withScopeStorage(scope, () => removeLegacyConversation(scope, local.id));
                rejectIfScopeChanged(epoch);
                continue;
            }
            rejectIfScopeChanged(epoch);
            await withScopeStorage(scope, () => writeDraft(scope, local.id, {
                baseRevision: existing.revision,
                document: cloneConversation(local),
                remote: { revision: existing.revision, document: remoteDocument },
            }));
            rejectIfScopeChanged(epoch);
            await withScopeStorage(scope, () => removeLegacyConversation(scope, local.id));
            rejectIfScopeChanged(epoch);
            continue;
        }
        let document: CreationConversationDocument;
        try {
            document = persistableDocument(local);
        } catch {
            await withScopeStorage(scope, () => writeDraft(scope, local.id, { baseRevision: 0, document: cloneConversation(local) }));
            rejectIfScopeChanged(epoch);
            continue;
        }
        rejectIfScopeChanged(epoch);
        const imported = await creationConversationsApi.importLegacy({
            operationId: `${CREATION_CONVERSATIONS_KEY}:${local.id}`,
            document,
        });
        rejectIfScopeChanged(epoch);
        if (imported.deleted) {
            deleted.add(imported.id);
            await rememberTombstones(scope, [imported.id]);
            rejectIfScopeChanged(epoch);
            continue;
        }
        if (imported.conversation?.id) {
            committedRecords.set(imported.conversation.id, imported.conversation);
            await withScopeStorage(scope, () => removeLegacyConversation(scope, imported.conversation.id));
            rejectIfScopeChanged(epoch);
        }
    }
    const drafts = await withScopeStorage(scope, () => listDrafts(scope));
    rejectIfScopeChanged(epoch);
    const loaded: T[] = [];
    for (const record of committedRecords.values()) {
        if (record.deleted || deleted.has(record.id) || tombstones.has(record.id)) continue;
        const document = documentFromRecord(record);
        rememberCommitted(scope, record.id, record.revision, document);
        const draft = drafts[record.id];
        if (draft?.document) {
            const draftFingerprint = persistableFingerprint(draft.document);
            const remoteFingerprint = persistableFingerprint(document);
            if (draftFingerprint && remoteFingerprint && draftFingerprint === remoteFingerprint) {
                await withScopeStorage(scope, () => removeDraft(scope, record.id));
                loaded.push(document as T);
                continue;
            }
            if (draft.baseRevision !== record.revision || draft.remote || !draftFingerprint) {
                const remote = draft.remote || { revision: record.revision, document };
                await withScopeStorage(scope, () => writeDraft(scope, record.id, { ...draft, remote }));
                loaded.push(withConflict(draft.document, remote) as T);
                continue;
            }
            loaded.push(draft.document as T);
            continue;
        }
        loaded.push(document as T);
    }
    for (const [id, draft] of Object.entries(drafts)) {
        if (!draft?.document || committedRecords.has(id) || deleted.has(id) || tombstones.has(id)) continue;
        loaded.push((draft.remote ? withConflict(draft.document, draft.remote) : draft.document) as T);
        rememberCommitted(scope, id, 0, { id, messages: [] });
    }
    return loaded.length ? loaded : null;
}

async function putConversation(id: string, expectedRevision: number, document: StoredCreationConversation) {
    return creationConversationsApi.put(id, {
        expectedRevision,
        document: persistableDocument(document),
    });
}

function isConflictError(error: unknown) {
    return error instanceof ApiError && (error.status === 409 || error.reason === "conflict");
}

async function recoverLostAck(scope: string, epoch: UserScopeEpoch, id: string, document: StoredCreationConversation): Promise<CreationConversationRecord | null> {
    rejectIfScopeChanged(epoch);
    let remote: CreationConversationRecord;
    try {
        remote = await creationConversationsApi.get(id);
    } catch (error) {
        if (error instanceof ApiError && (error.status === 404 || error.reason === "not_found")) return null;
        throw error;
    }
    rejectIfScopeChanged(epoch);
    if (remote.deleted) return null;
    const remoteDocument = documentFromRecord(remote);
    const localFingerprint = persistableFingerprint(document);
    const remoteFingerprint = persistableFingerprint(remoteDocument);
    if (localFingerprint && remoteFingerprint && localFingerprint === remoteFingerprint) {
        return remote;
    }
    await withScopeStorage(scope, async () => {
        const existing = await readDraft(scope, id);
        await writeDraft(scope, id, {
            baseRevision: existing?.baseRevision ?? committed.get(scopeKey(scope, id))?.revision ?? 0,
            document,
            remote: { revision: remote.revision, document: remoteDocument },
        });
    });
    return null;
}

async function flushConversation(scope: string, epoch: UserScopeEpoch, id: string, resolveConflict: boolean) {
    rejectIfScopeChanged(epoch);
    const key = scopeKey(scope, id);
    for (;;) {
        const snapshot = pendingWrites.get(key);
        if (!snapshot) return;
        const state = committed.get(key);
        if (state && fingerprintOf(snapshot.document) === state.fingerprint) {
            if (pendingWrites.get(key)?.generation === snapshot.generation) {
                pendingWrites.delete(key);
                await withScopeStorage(scope, () => removeDraft(scope, id));
            }
            if ((pendingWrites.get(key)?.generation ?? 0) > snapshot.generation) continue;
            return;
        }
        const draft = await withScopeStorage(scope, () => readDraft(scope, id));
        rejectIfScopeChanged(epoch);
        if (!resolveConflict && draft?.remote) return;
        const expectedRevision = resolveConflict
            ? (draft?.remote?.revision ?? committed.get(key)?.revision ?? 0)
            : await draftBaseRevision(scope, id);
        rejectIfScopeChanged(epoch);
        let saved: CreationConversationRecord;
        try {
            saved = await putConversation(id, expectedRevision, snapshot.document);
        } catch (error) {
            if (!isConflictError(error)) throw error;
            const recovered = await recoverLostAck(scope, epoch, id, snapshot.document);
            if (!recovered) throw error;
            saved = recovered;
        }
        rejectIfScopeChanged(epoch);
        const canonical = documentFromRecord(saved);
        if (!commitIfCurrent(scope, id, saved.revision, canonical)) return;
        const latest = pendingWrites.get(key);
        if (latest && latest.generation > snapshot.generation) {
            const projected = projectPendingOnCanonical(snapshot.document, latest.document, canonical);
            pendingWrites.set(key, { generation: latest.generation, document: projected });
            await withScopeStorage(scope, () => writeDraft(scope, id, {
                baseRevision: saved.revision,
                document: projected,
            }));
            continue;
        }
        if (latest?.generation === snapshot.generation) {
            pendingWrites.delete(key);
            await withScopeStorage(scope, () => removeDraft(scope, id));
        }
        return;
    }
}

export async function saveCreationConversations<T extends StoredCreationConversation>(
    conversations: T[],
    scope = getActiveUserScope(),
    options?: { resolveConflictIds?: string[] },
) {
    const epoch = captureScope(scope);
    const resolveIds = new Set(options?.resolveConflictIds || []);
    const jobs = conversations.map((conversation) => {
        if (!conversation?.id) throw new Error("缺少要保存的创作对话 ID");
        const cloned = cloneConversation(conversation);
        const key = scopeKey(scope, cloned.id);
        const generation = nextGeneration(key);
        pendingWrites.set(key, { generation, document: cloned });
        const resolveConflict = resolveIds.has(cloned.id);
        return captureDraft(scope, cloned.id, cloned).then(() => {
            rejectIfScopeChanged(epoch);
            if (conversationHasConflict(cloned) && !resolveConflict) return;
            return enqueue(scope, cloned.id, () => flushConversation(scope, epoch, cloned.id, resolveConflict));
        });
    });
    await Promise.all(jobs);
}

export async function parkCreationConversationDraft(
    id: string,
    document: StoredCreationConversation,
    remote: { revision: number; document: StoredCreationConversation } | undefined,
    scope = getActiveUserScope(),
) {
    const epoch = captureScope(scope);
    rejectIfScopeChanged(epoch);
    const storage = localForageStorageForScope(scope);
    const { conflictRemote: _conflictRemote, ...local } = document;
    await storage.setItem(parkedDraftKey(id), JSON.stringify({
        document: cloneConversation(local),
        remote: remote ? cloneConversation(remote) : undefined,
    }));
}

function liveFromCommittedAndDraft(state: CommittedState | undefined, ours: StoredCreationConversation | undefined) {
    if (!ours) return state ? cloneConversation(state.document) : undefined;
    if (!state) return cloneConversation(ours);
    return projectPendingOnCanonical(state.document, ours, state.document);
}

export async function adoptServerConfirmedConversationDocument(
    conversationId: string,
    document: StoredCreationConversation,
    revision: number,
    entryCapturedScope: CapturedUserScope,
) {
    assertUserScope(entryCapturedScope);
    const scope = entryCapturedScope.userScope;
    const id = conversationId.trim();
    if (!id) throw new Error("缺少要采纳的创作对话 ID");
    if (!Number.isInteger(revision) || revision < 1) throw new Error("对话版本无效");
    const canonical = cloneConversation({ ...document, id });
    let adopted: StoredCreationConversation | undefined;

    await withScopeStorage(scope, async () => {
        assertUserScope(entryCapturedScope);
        const key = scopeKey(scope, id);
        const current = committed.get(key);
        if (current && current.revision > revision) {
            const ours = pendingWrites.get(key)?.document ?? (await readDraft(scope, id))?.document;
            adopted = liveFromCommittedAndDraft(current, ours) ?? cloneConversation(current.document);
            return;
        }

        const draft = await readDraft(scope, id);
        const base = current?.document ?? draft?.remote?.document;
        // Every storage await can admit another edit, including the final
        // remove. Only publish/ack a generation still current after its I/O.
        for (;;) {
            assertUserScope(entryCapturedScope);
            const generation = writeGenerations.get(key) ?? 0;
            const pending = pendingWrites.get(key);
            const ours = pending?.document ?? draft?.document;
            let live: StoredCreationConversation;
            let remote: ConversationDraft["remote"];
            let keepDraft = false;
            if (!ours || persistableFingerprint(ours) === persistableFingerprint(canonical)) {
                live = cloneConversation(canonical);
            } else if (!base) {
                live = cloneConversation(ours);
                remote = { revision, document: cloneConversation(canonical) };
                keepDraft = true;
            } else {
                live = projectPendingOnCanonical(base, ours, canonical);
                keepDraft = persistableFingerprint(live) !== persistableFingerprint(canonical);
            }
            await writeDraft(scope, id, { baseRevision: revision, document: cloneConversation(live), remote });
            if ((writeGenerations.get(key) ?? 0) !== generation) continue;
            if (!commitIfCurrent(scope, id, revision, canonical)) {
                const latestCommitted = committed.get(key);
                adopted = liveFromCommittedAndDraft(latestCommitted, pendingWrites.get(key)?.document ?? ours) ?? cloneConversation(canonical);
                return;
            }
            if (keepDraft) {
                if (pending) pendingWrites.set(key, { generation: pending.generation, document: live });
                adopted = remote ? withConflict(live, remote) : live;
                return;
            }
            await removeDraft(scope, id);
            if ((writeGenerations.get(key) ?? 0) !== generation) continue;
            if (pendingWrites.get(key)?.generation === pending?.generation) pendingWrites.delete(key);
            adopted = cloneConversation(canonical);
            return;
        }
    });

    assertUserScope(entryCapturedScope);
    if (!adopted) throw new Error("这次生成结果没能写进对话。请再试一次。");
    return adopted;
}

export async function acceptSavedCreationConversation(
    id: string,
    document: StoredCreationConversation,
    remote: { revision: number; document: StoredCreationConversation },
    scope = getActiveUserScope(),
) {
    const epoch = captureScope(scope);
    rejectIfScopeChanged(epoch);
    await parkCreationConversationDraft(id, document, remote, scope);
    rejectIfScopeChanged(epoch);
    pendingWrites.delete(scopeKey(scope, id));
    rememberCommitted(scope, id, remote.revision, remote.document);
    await withScopeStorage(scope, () => removeDraft(scope, id));
}

export async function restoreParkedCreationConversation<T extends StoredCreationConversation>(id: string, scope = getActiveUserScope()) {
    const epoch = captureScope(scope);
    rejectIfScopeChanged(epoch);
    const parked = await takeParkedCreationConversationDraft<T>(id, scope);
    rejectIfScopeChanged(epoch);
    if (!parked) return null;
    const remote = parked.conflictRemote;
    const document = cloneConversation(parked);
    delete document.conflictRemote;
    await withScopeStorage(scope, () => writeDraft(scope, id, {
        baseRevision: remote?.revision ?? committed.get(scopeKey(scope, id))?.revision ?? 0,
        document,
        remote,
    }));
    pendingWrites.delete(scopeKey(scope, id));
    return parked;
}

export async function takeParkedCreationConversationDraft<T extends StoredCreationConversation>(id: string, scope = getActiveUserScope()) {
    const epoch = captureScope(scope);
    rejectIfScopeChanged(epoch);
    const storage = localForageStorageForScope(scope);
    const raw = await storage.getItem(parkedDraftKey(id));
    rejectIfScopeChanged(epoch);
    await storage.removeItem(parkedDraftKey(id));
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as { document?: T; remote?: { revision: number; document: T } };
        if (!parsed?.document?.id) return null;
        return parsed.remote ? withConflict(parsed.document, parsed.remote) as T : parsed.document;
    } catch {
        return null;
    }
}

export async function hasParkedCreationConversationDraft(id: string, scope = getActiveUserScope()) {
    const storage = localForageStorageForScope(scope);
    return Boolean(await storage.getItem(parkedDraftKey(id)));
}

export async function deleteCreationConversation(conversationId: string, scope = getActiveUserScope()) {
    if (!conversationId) throw new Error("缺少要删除的创作对话 ID");
    const epoch = captureScope(scope);
    return enqueue(scope, conversationId, async () => {
        rejectIfScopeChanged(epoch);
        const expectedRevision = committed.get(scopeKey(scope, conversationId))?.revision ?? 0;
        try {
            await creationConversationsApi.remove(conversationId, expectedRevision);
        } catch (error) {
            if (!(error instanceof ApiError) || error.status !== 404) throw error;
        }
        rejectIfScopeChanged(epoch);
        forgetCommitted(scope, conversationId);
        await rememberTombstones(scope, [conversationId]);
        await withScopeStorage(scope, async () => {
            await removeDraft(scope, conversationId);
            await removeLegacyConversation(scope, conversationId);
        });
        const storage = localForageStorageForScope(scope);
        await storage.removeItem(parkedDraftKey(conversationId));
    });
}

export function resetCreationConversationStoreForTests() {
    committed.clear();
    writeQueues.clear();
    storageQueues.clear();
    pendingWrites.clear();
    writeGenerations.clear();
}
