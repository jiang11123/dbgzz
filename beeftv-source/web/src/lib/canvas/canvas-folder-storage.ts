import { nanoid } from "nanoid";

import { CANVAS_FOLDER_PENDING_STORE_NAME, localForageInstance } from "@/lib/localforage-storage";
import { scopedStorageKey } from "@/lib/user-scope";
import { assertUserScope, captureUserScope, isUserScopeAbandonedError, type CapturedUserScope } from "@/lib/user-scope-guard";
import { ApiError } from "@/services/api/request";
import { resourceFileUrl, uploadResourceFile } from "@/services/api/resources";
import { deleteCanvasLibraryFolder as deleteCanvasLibraryFolderRemote, listCanvasLibraryFolders as listCanvasLibraryFoldersRemote, putCanvasLibraryFolder } from "@/services/api/workspace-data";
import { usesBrowserLocalResourceStore } from "@/services/workspace-resource-storage";
import { useCanvasStore, type CanvasFolder } from "@/stores/canvas/use-canvas-store";

export const CANVAS_FOLDER_PENDING_KEY = "infinite-canvas:canvas_folder_pending";

export class FolderPendingUnreadableError extends Error {
    constructor() {
        super("文件夹未保存的修改无法读取");
        this.name = "FolderPendingUnreadableError";
    }
}

type FolderPendingIntent = {
    generation: number;
    kind: "upsert" | "delete";
    folder?: CanvasFolder;
    error?: string;
    blockedReimport?: boolean;
};

type FolderPendingMap = Record<string, FolderPendingIntent>;

type FolderPendingRecord = {
    version: 1;
    intents: FolderPendingMap;
    highWater: Record<string, number>;
};

type FolderPendingStore = {
    getItem(key: string): Promise<FolderPendingRecord | FolderPendingMap | null>;
    setItem(key: string, value: FolderPendingRecord): Promise<FolderPendingRecord>;
    removeItem(key: string): Promise<void>;
};

const defaultFolderPendingStore: FolderPendingStore = localForageInstance(CANVAS_FOLDER_PENDING_STORE_NAME) as FolderPendingStore;

let folderPendingStore: FolderPendingStore = defaultFolderPendingStore;
const folderCommitChains = new Map<string, Promise<unknown>>();
const pendingLocks = new Map<string, Promise<unknown>>();
const folderRemovedAt = new Map<string, number>();
let folderOpClock = 0;
let folderHydrateGeneration = 0;
let digestDelayForTests: (() => Promise<void>) | undefined;

function captureScope(expectedScope?: CapturedUserScope) {
    const expected = expectedScope ?? captureUserScope();
    assertUserScope(expected);
    return expected;
}

function folderCommitKey(userScope: string, id: string) {
    return `${userScope}\0${id}`;
}

function enqueueFolderCommit<T>(userScope: string, id: string, job: () => Promise<T>): Promise<T> {
    const key = folderCommitKey(userScope, id);
    const previous = folderCommitChains.get(key) ?? Promise.resolve();
    const run = previous.then(undefined, () => undefined).then(job);
    folderCommitChains.set(key, run.then(() => undefined, () => undefined));
    return run;
}

function withPendingLock<T>(userScope: string, job: () => Promise<T>): Promise<T> {
    const previous = pendingLocks.get(userScope) ?? Promise.resolve();
    const run = previous.then(undefined, () => undefined).then(job);
    pendingLocks.set(userScope, run.then(() => undefined, () => undefined));
    return run;
}

function parsePendingMap(raw: unknown): FolderPendingMap {
    if (raw == null) return {};
    if (typeof raw !== "object" || Array.isArray(raw)) throw new FolderPendingUnreadableError();
    const result: FolderPendingMap = {};
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!id || !value || typeof value !== "object" || Array.isArray(value)) throw new FolderPendingUnreadableError();
        const intent = value as FolderPendingIntent;
        if (intent.kind !== "upsert" && intent.kind !== "delete") throw new FolderPendingUnreadableError();
        result[id] = {
            generation: Number(intent.generation) || 0,
            kind: intent.kind,
            folder: intent.folder,
            error: typeof intent.error === "string" ? intent.error : undefined,
            blockedReimport: intent.blockedReimport === true,
        };
    }
    return result;
}

function parseHighWater(raw: unknown): Record<string, number> {
    if (raw == null) return {};
    if (typeof raw !== "object" || Array.isArray(raw)) throw new FolderPendingUnreadableError();
    const result: Record<string, number> = {};
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
        const generation = Number(value);
        if (!id || !Number.isFinite(generation) || generation < 0) throw new FolderPendingUnreadableError();
        result[id] = generation;
    }
    return result;
}

function emptyPendingRecord(): FolderPendingRecord {
    return { version: 1, intents: {}, highWater: {} };
}

function scanHighWater(intents: FolderPendingMap, highWater: Record<string, number> = {}): Record<string, number> {
    const next = { ...highWater };
    for (const [id, intent] of Object.entries(intents)) {
        next[id] = Math.max(next[id] || 0, intent.generation || 0);
    }
    return next;
}

function parsePendingRecord(raw: unknown): FolderPendingRecord {
    if (raw == null) return emptyPendingRecord();
    if (typeof raw !== "object" || Array.isArray(raw)) throw new FolderPendingUnreadableError();
    const value = raw as { version?: unknown; intents?: unknown; highWater?: unknown };
    if (value.version === 1 && value.intents && typeof value.intents === "object" && !Array.isArray(value.intents)) {
        const intents = parsePendingMap(value.intents);
        return { version: 1, intents, highWater: scanHighWater(intents, parseHighWater(value.highWater)) };
    }
    const intents = parsePendingMap(raw);
    return { version: 1, intents, highWater: scanHighWater(intents) };
}

function migrateLegacyPending(userScope: string): FolderPendingRecord | null {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage?.getItem(scopedStorageKey(CANVAS_FOLDER_PENDING_KEY, userScope));
    if (!raw) return null;
    try {
        return parsePendingRecord(JSON.parse(raw));
    } catch (error) {
        if (error instanceof FolderPendingUnreadableError) throw error;
        throw new FolderPendingUnreadableError();
    }
}

async function readPendingRecord(userScope: string): Promise<FolderPendingRecord> {
    let raw: unknown;
    try {
        raw = await folderPendingStore.getItem(userScope);
    } catch {
        throw new FolderPendingUnreadableError();
    }
    if (raw != null) return parsePendingRecord(raw);
    const migrated = migrateLegacyPending(userScope);
    if (!migrated) return emptyPendingRecord();
    try {
        await folderPendingStore.setItem(userScope, migrated);
        window.localStorage?.removeItem(scopedStorageKey(CANVAS_FOLDER_PENDING_KEY, userScope));
    } catch {
        throw new FolderPendingUnreadableError();
    }
    return migrated;
}

async function readPending(userScope: string): Promise<FolderPendingMap> {
    return (await readPendingRecord(userScope)).intents;
}

function persistablePending(record: FolderPendingRecord): FolderPendingRecord {
    return {
        version: 1,
        intents: record.intents,
        highWater: scanHighWater(record.intents, record.highWater),
    };
}

async function mutatePending(
    userScope: string,
    expected: CapturedUserScope,
    mutator: (live: FolderPendingRecord) => FolderPendingRecord,
): Promise<FolderPendingRecord> {
    return withPendingLock(userScope, async () => {
        assertUserScope(expected);
        const live = await readPendingRecord(userScope);
        assertUserScope(expected);
        const next = persistablePending(mutator({
            version: 1,
            intents: { ...live.intents },
            highWater: { ...live.highWater },
        }));
        const empty = !Object.keys(next.intents).length && !Object.keys(next.highWater).length;
        if (empty) await folderPendingStore.removeItem(userScope);
        else await folderPendingStore.setItem(userScope, next);
        assertUserScope(expected);
        return next;
    });
}

function nextGeneration(id: string, record: FolderPendingRecord) {
    return Math.max(record.intents[id]?.generation || 0, record.highWater[id] || 0) + 1;
}

function rememberGeneration(record: FolderPendingRecord, id: string, generation: number) {
    record.highWater[id] = Math.max(record.highWater[id] || 0, generation);
}

function folderReceiptMatches(saved: { folder?: { id?: string; name?: string } } | null | undefined, id: string, name?: string) {
    if (!saved?.folder || saved.folder.id !== id) return false;
    if (name !== undefined && saved.folder.name !== name) return false;
    return true;
}

function isStaleProcessCoverUrl(value?: string) {
    if (!value) return false;
    if (value.startsWith("blob:")) return true;
    try {
        const parsed = new URL(value, "http://127.0.0.1");
        return (parsed.protocol === "http:" || parsed.protocol === "https:")
            && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
    } catch {
        return false;
    }
}

function liveCover(folder: CanvasFolder): CanvasFolder {
    if (folder.coverResourceId) {
        return { ...folder, coverDataUrl: resourceFileUrl(folder.coverResourceId) };
    }
    if (isStaleProcessCoverUrl(folder.coverDataUrl)) {
        return { ...folder, coverDataUrl: undefined };
    }
    return folder;
}

function mapRecord(record: { id: string; name: string; coverResourceId?: string; createdAt: string; updatedAt: string }, previous?: CanvasFolder): CanvasFolder {
    return liveCover({
        id: record.id,
        name: record.name,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        coverResourceId: record.coverResourceId,
        coverDataUrl: previous?.coverDataUrl,
        unsaved: undefined,
        saveError: undefined,
    });
}

function projectFolders(canonical: CanvasFolder[], pending: FolderPendingMap): CanvasFolder[] {
    const byId = new Map(canonical.map((folder) => [folder.id, liveCover({ ...folder, unsaved: undefined, saveError: undefined })]));
    for (const [id, intent] of Object.entries(pending)) {
        if (intent.kind === "delete") {
            byId.delete(id);
            continue;
        }
        if (!intent.folder) continue;
        const current = byId.get(id);
        byId.set(id, liveCover({
            ...intent.folder,
            coverResourceId: intent.folder.coverResourceId || current?.coverResourceId,
            unsaved: true,
            saveError: intent.error,
        }));
    }
    return [...byId.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
}

function publishFolders(canonical: CanvasFolder[], pending: FolderPendingMap, expected: CapturedUserScope) {
    assertUserScope(expected);
    useCanvasStore.getState().replaceFolders(projectFolders(canonical, pending));
}

function canonicalFromProjection(pending: FolderPendingMap): CanvasFolder[] {
    const folders = useCanvasStore.getState().folders;
    return folders
        .filter((folder) => {
            const intent = pending[folder.id];
            if (intent?.kind === "delete") return false;
            if (intent?.kind === "upsert") return false;
            return true;
        })
        .map((folder) => liveCover({ ...folder, unsaved: undefined, saveError: undefined }));
}

async function contentDigest(blob: Blob) {
    if (digestDelayForTests) await digestDelayForTests();
    const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function folderCoverResourceId(folder: CanvasFolder, expected: CapturedUserScope) {
    if (folder.coverResourceId) return folder.coverResourceId;
    const dataUrl = folder.coverDataUrl;
    if (!dataUrl?.startsWith("data:image")) return undefined;
    assertUserScope(expected);
    const blob = await (await fetch(dataUrl)).blob();
    assertUserScope(expected);
    const digest = await contentDigest(blob);
    assertUserScope(expected);
    const resource = await uploadResourceFile(blob, "image", {
        fileName: "folder-cover.jpg",
        idempotencyKey: `canvas-folder-cover:sha256:${digest}`,
        expectedScope: expected,
    });
    assertUserScope(expected);
    return resource.id;
}

function isFailedPrecondition(error: unknown) {
    return error instanceof ApiError && error.reason === "failed_precondition";
}

function persistErrorMessage(error: unknown) {
    if (isUserScopeAbandonedError(error)) return error.message;
    if (isFailedPrecondition(error)) return "文件夹已删除，未保存的修改还在本机";
    if (error instanceof Error && error.message) return error.message;
    return "文件夹没有保存成功";
}

async function commitFolderIntent(id: string, generation: number, expected: CapturedUserScope) {
    assertUserScope(expected);
    const pending = await readPendingRecord(expected.userScope);
    const intent = pending.intents[id];
    if (!intent || intent.generation !== generation) return;
    if (intent.blockedReimport) throw new Error(intent.error || "文件夹已删除，未保存的修改还在本机");
    if (intent.kind === "delete") {
        try {
            await deleteCanvasLibraryFolderRemote(id, { expectedScope: expected });
        } catch (error) {
            if (isUserScopeAbandonedError(error)) throw error;
            if (!(error instanceof ApiError) || (error.status !== 404 && error.code !== 404)) throw error;
        }
        assertUserScope(expected);
        await reconcileCanvasesAfterFolderDelete(id, expected);
        assertUserScope(expected);
        const live = await readPendingRecord(expected.userScope);
        publishFolders(canonicalFromProjection(live.intents), live.intents, expected);
        return;
    }
    if (!intent.folder) return;
    const coverResourceId = await folderCoverResourceId(intent.folder, expected);
    assertUserScope(expected);
    const latest = await readPendingRecord(expected.userScope);
    if (latest.intents[id]?.generation !== generation) return;
    const saved = await putCanvasLibraryFolder(id, {
        id,
        name: latest.intents[id].folder?.name || intent.folder.name,
        coverResourceId,
        createdAt: latest.intents[id].folder?.createdAt || intent.folder.createdAt,
        updatedAt: latest.intents[id].folder?.updatedAt || intent.folder.updatedAt,
    }, { expectedScope: expected });
    assertUserScope(expected);
    const staged = latest.intents[id];
    if (!folderReceiptMatches(saved, id, staged?.folder?.name || intent.folder.name)) {
        throw new Error("文件夹没有保存成功");
    }
    const live = await mutatePending(expected.userScope, expected, (current) => {
        if (current.intents[id]?.generation !== generation) return current;
        delete current.intents[id];
        rememberGeneration(current, id, generation);
        return current;
    });
    const receipt = mapRecord(saved.folder, staged?.folder || intent.folder);
    const canonical = canonicalFromProjection(live.intents);
    publishFolders(canonical.some((folder) => folder.id === id) ? canonical.map((folder) => folder.id === id ? receipt : folder) : [receipt, ...canonical], live.intents, expected);
}

async function stageUpsert(folder: CanvasFolder, expected: CapturedUserScope) {
    let generation = 0;
    const pending = await mutatePending(expected.userScope, expected, (live) => {
        generation = nextGeneration(folder.id, live);
        live.intents[folder.id] = {
            generation,
            kind: "upsert",
            folder: { ...folder, unsaved: undefined, saveError: undefined },
            blockedReimport: live.intents[folder.id]?.blockedReimport === true,
        };
        rememberGeneration(live, folder.id, generation);
        return live;
    });
    publishFolders(canonicalFromProjection(pending.intents), pending.intents, expected);
    return generation;
}

async function markPendingError(id: string, generation: number, error: unknown, expected: CapturedUserScope) {
    const pending = await mutatePending(expected.userScope, expected, (live) => {
        if (live.intents[id]?.generation !== generation) return live;
        live.intents[id] = {
            ...live.intents[id],
            error: persistErrorMessage(error),
            blockedReimport: live.intents[id].blockedReimport === true || isFailedPrecondition(error),
        };
        return live;
    });
    publishFolders(canonicalFromProjection(pending.intents), pending.intents, expected);
}

async function reconcileCanvasesAfterFolderDelete(folderId: string, expected: CapturedUserScope) {
    const affected = useCanvasStore.getState().projects.filter((project) => project.folderId === folderId);
    if (!affected.length) return;
    const { refreshLocalCanvasProjectIfChanged } = await import("@/services/local-workspace-repository");
    for (const project of affected) {
        try {
            await refreshLocalCanvasProjectIfChanged(project.id, expected);
        } catch (error) {
            if (isUserScopeAbandonedError(error)) throw error;
        }
    }
}

export async function persistCanvasLibraryFolder(folder: CanvasFolder, expectedScope?: CapturedUserScope): Promise<CanvasFolder> {
    const expected = captureScope(expectedScope);
    if (usesBrowserLocalResourceStore()) {
        publishFolders(useCanvasStore.getState().folders.map((item) => item.id === folder.id ? liveCover(folder) : item), {}, expected);
        return liveCover(folder);
    }
    const generation = await stageUpsert(folder, expected);
    try {
        await enqueueFolderCommit(expected.userScope, folder.id, () => commitFolderIntent(folder.id, generation, expected));
    } catch (error) {
        if (isUserScopeAbandonedError(error)) throw error;
        assertUserScope(expected);
        await markPendingError(folder.id, generation, error, expected);
        if (isFailedPrecondition(error)) throw new Error(persistErrorMessage(error));
        throw error;
    }
    const live = useCanvasStore.getState().folders.find((item) => item.id === folder.id);
    return live || liveCover(folder);
}

export async function createCanvasLibraryFolder(name = "未命名文件夹", expectedScope?: CapturedUserScope) {
    const expected = captureScope(expectedScope);
    const now = new Date().toISOString();
    const folder: CanvasFolder = { id: nanoid(), name: name.trim() || "未命名文件夹", createdAt: now, updatedAt: now };
    if (usesBrowserLocalResourceStore()) {
        const id = useCanvasStore.getState().createFolder(folder.name);
        assertUserScope(expected);
        return id;
    }
    const generation = await stageUpsert(folder, expected);
    try {
        await enqueueFolderCommit(expected.userScope, folder.id, () => commitFolderIntent(folder.id, generation, expected));
        return folder.id;
    } catch (error) {
        if (isUserScopeAbandonedError(error)) throw error;
        assertUserScope(expected);
        await markPendingError(folder.id, generation, error, expected);
        if (isFailedPrecondition(error)) throw new Error(persistErrorMessage(error));
        throw error;
    }
}

export async function renameCanvasLibraryFolder(id: string, name: string, expectedScope?: CapturedUserScope) {
    const expected = captureScope(expectedScope);
    const nextName = name.trim() || "未命名文件夹";
    if (usesBrowserLocalResourceStore()) {
        useCanvasStore.getState().renameFolder(id, nextName);
        assertUserScope(expected);
        return;
    }
    const current = useCanvasStore.getState().folders.find((folder) => folder.id === id);
    if (!current) throw new Error("文件夹没有保存成功");
    const generation = await stageUpsert({ ...current, name: nextName, updatedAt: new Date().toISOString() }, expected);
    try {
        await enqueueFolderCommit(expected.userScope, id, () => commitFolderIntent(id, generation, expected));
    } catch (error) {
        if (isUserScopeAbandonedError(error)) throw error;
        assertUserScope(expected);
        await markPendingError(id, generation, error, expected);
        if (isFailedPrecondition(error)) throw new Error(persistErrorMessage(error));
        throw error;
    }
}

export async function deleteCanvasLibraryFolder(id: string, expectedScope?: CapturedUserScope) {
    const expected = captureScope(expectedScope);
    if (usesBrowserLocalResourceStore()) {
        useCanvasStore.getState().deleteFolder(id);
        return;
    }
    let generation = 0;
    folderRemovedAt.set(`${expected.userScope}:${id}`, ++folderOpClock);
    const pending = await mutatePending(expected.userScope, expected, (live) => {
        generation = nextGeneration(id, live);
        live.intents[id] = { generation, kind: "delete" };
        rememberGeneration(live, id, generation);
        return live;
    });
    publishFolders(canonicalFromProjection(pending.intents), pending.intents, expected);
    try {
        await enqueueFolderCommit(expected.userScope, id, () => commitFolderIntent(id, generation, expected));
    } catch (error) {
        if (isUserScopeAbandonedError(error)) throw error;
        assertUserScope(expected);
        await markPendingError(id, generation, error, expected);
        if (isFailedPrecondition(error)) throw new Error(persistErrorMessage(error));
        throw error;
    }
}

export async function persistCanvasFolderCover(id: string, coverDataUrl: string, expectedScope?: CapturedUserScope) {
    const expected = captureScope(expectedScope);
    if (usesBrowserLocalResourceStore()) {
        useCanvasStore.getState().setFolderCover(id, coverDataUrl);
        return;
    }
    const current = useCanvasStore.getState().folders.find((folder) => folder.id === id);
    if (!current) throw new Error("封面没有保存成功");
    const generation = await stageUpsert({
        ...current,
        coverResourceId: undefined,
        coverDataUrl,
        updatedAt: new Date().toISOString(),
    }, expected);
    try {
        await enqueueFolderCommit(expected.userScope, id, () => commitFolderIntent(id, generation, expected));
    } catch (error) {
        if (isUserScopeAbandonedError(error)) throw error;
        assertUserScope(expected);
        await markPendingError(id, generation, error, expected);
        if (isFailedPrecondition(error)) throw new Error(persistErrorMessage(error));
        throw error;
    }
}

export async function hydrateCanvasLibraryFolders(expectedScope?: CapturedUserScope) {
    const expected = captureScope(expectedScope);
    if (usesBrowserLocalResourceStore()) return;
    const hydrateId = ++folderHydrateGeneration;
    const startedAt = folderOpClock;
    const local = useCanvasStore.getState().folders;
    const existingPending = await readPendingRecord(expected.userScope);
    let remoteFolders: CanvasFolder[] = [];
    let listedIds = new Set<string>();
    try {
        const data = await listCanvasLibraryFoldersRemote({ expectedScope: expected });
        assertUserScope(expected);
        if (hydrateId !== folderHydrateGeneration) return;
        const latestLocal = useCanvasStore.getState().folders;
        listedIds = new Set((data.folders || []).map((folder) => folder.id));
        remoteFolders = (data.folders || []).map((folder) => mapRecord(folder, latestLocal.find((item) => item.id === folder.id)))
            .filter((folder) => (folderRemovedAt.get(`${expected.userScope}:${folder.id}`) || 0) <= startedAt);
    } catch (error) {
        if (isUserScopeAbandonedError(error)) throw error;
        assertUserScope(expected);
        const covers = useCanvasStore.getState().folders.map(liveCover);
        const livePending = await readPendingRecord(expected.userScope);
        publishFolders(covers.filter((folder) => livePending.intents[folder.id]?.kind !== "delete"), livePending.intents, expected);
        throw error;
    }

    const remoteIds = new Set(remoteFolders.map((folder) => folder.id));
    const nextPending = await mutatePending(expected.userScope, expected, (live) => {
        for (const [id, intent] of Object.entries(live.intents)) {
            if (intent.kind !== "delete") continue;
            const removedAt = folderRemovedAt.get(`${expected.userScope}:${id}`) || 0;
            if (!listedIds.has(id) && removedAt <= startedAt) {
                rememberGeneration(live, id, intent.generation);
                delete live.intents[id];
                folderRemovedAt.delete(`${expected.userScope}:${id}`);
            }
        }
        for (const [key, removedAt] of [...folderRemovedAt.entries()]) {
            if (!key.startsWith(`${expected.userScope}:`)) continue;
            const id = key.slice(expected.userScope.length + 1);
            if (!listedIds.has(id) && removedAt <= startedAt && live.intents[id]?.kind !== "delete") folderRemovedAt.delete(key);
        }
        for (const folder of [...local, ...useCanvasStore.getState().folders]) {
            if (remoteIds.has(folder.id) || live.intents[folder.id]) continue;
            if ((folderRemovedAt.get(`${expected.userScope}:${folder.id}`) || 0) > startedAt) continue;
            if (existingPending.intents[folder.id]?.kind === "delete") continue;
            const generation = nextGeneration(folder.id, live);
            live.intents[folder.id] = {
                generation,
                kind: "upsert",
                folder: { ...folder, unsaved: undefined, saveError: undefined },
            };
            rememberGeneration(live, folder.id, generation);
        }
        return live;
    });
    publishFolders(remoteFolders, nextPending.intents, expected);
}

export async function peekCanvasFolderPendingForTests(userScope: string) {
    return (await readPendingRecord(userScope)).intents;
}

export async function peekCanvasFolderPendingHighWaterForTests(userScope: string) {
    return (await readPendingRecord(userScope)).highWater;
}

export function setCanvasFolderDigestDelayForTests(delay?: () => Promise<void>) {
    digestDelayForTests = delay;
}

export function replaceCanvasFolderPendingStoreForTests(store?: FolderPendingStore) {
    folderPendingStore = store ?? defaultFolderPendingStore;
}

export function resetCanvasFolderStorageForTests() {
    folderCommitChains.clear();
    pendingLocks.clear();
    folderRemovedAt.clear();
    folderOpClock = 0;
    folderHydrateGeneration = 0;
    digestDelayForTests = undefined;
    folderPendingStore = defaultFolderPendingStore;
}
