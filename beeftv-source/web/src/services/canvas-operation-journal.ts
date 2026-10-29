import { nanoid } from "nanoid";

import { sameCanvasDocument } from "@/lib/canvas/canvas-content";
import { localForageStorageForScope } from "@/lib/localforage-storage";
import { getActiveUserScope } from "@/lib/user-scope";
import { recordCanvasDocumentBase, type CanvasProject } from "@/stores/canvas/use-canvas-store";

const JOURNAL_PREFIX = "canvas-document-journal";

export type CanvasCommitPayload = {
    canvasId: string;
    expectedRevision: number;
    document: CanvasProject;
};

export type CanvasInFlightCommit = {
    operationId: string;
    expectedRevision: number;
    payload: CanvasCommitPayload;
};

/**
 * 服务端已确认、本地编辑器投影尚未落盘时的恢复状态。
 * confirmedSnapshot 是服务端已提交真相；base 是投影前的旧确认基线。
 */
export type CanvasPendingProjection = {
    identity: string;
    revision: number;
    base: CanvasProject;
    remote: CanvasProject;
};

export type CanvasOperationJournal = {
    userScope: string;
    canvasId: string;
    confirmedRevision: number;
    confirmedSnapshot: CanvasProject | null;
    inFlight: CanvasInFlightCommit | null;
    pendingProjection: CanvasPendingProjection | null;
};

export class CanvasJournalError extends Error {
    override cause?: unknown;

    constructor(message: string, options?: { cause?: unknown }) {
        super(message);
        this.name = "CanvasJournalError";
        this.cause = options?.cause;
    }
}

const memory = new Map<string, CanvasOperationJournal>();
const journalLocks = new Map<string, Promise<void>>();

type JournalStorageDelay = {
    beforeGet?: () => Promise<void>;
    beforeSet?: () => Promise<void>;
};

let journalStorageDelay: JournalStorageDelay | null = null;

export function setCanvasJournalStorageDelay(delay: JournalStorageDelay | null) {
    journalStorageDelay = delay;
}

function journalName(canvasId: string) {
    return `${JOURNAL_PREFIX}:${canvasId}`;
}

function cacheKey(scope: string, canvasId: string) {
    return `${scope}\0${canvasId}`;
}

function emptyJournal(scope: string, canvasId: string): CanvasOperationJournal {
    return { userScope: scope, canvasId, confirmedRevision: 0, confirmedSnapshot: null, inFlight: null, pendingProjection: null };
}

function cloneJournal(journal: CanvasOperationJournal): CanvasOperationJournal {
    return structuredClone(journal);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asNonNegativeInteger(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw new CanvasJournalError(`画布提交日记 ${label} 无效`);
    }
    return value;
}

function parseConfirmedSnapshot(value: unknown, canvasId: string): CanvasProject | null {
    if (value == null) return null;
    if (!isPlainObject(value) || typeof value.id !== "string" || value.id !== canvasId) {
        throw new CanvasJournalError("画布提交日记快照无效");
    }
    return value as unknown as CanvasProject;
}

function parseInFlight(value: unknown, canvasId: string): CanvasInFlightCommit | null {
    if (value == null) return null;
    if (!isPlainObject(value)) throw new CanvasJournalError("画布提交日记在途操作无效");
    const operationId = value.operationId;
    if (typeof operationId !== "string" || !operationId) {
        throw new CanvasJournalError("画布提交日记 operationId 无效");
    }
    const expectedRevision = asNonNegativeInteger(value.expectedRevision, "expectedRevision");
    if (!isPlainObject(value.payload)) throw new CanvasJournalError("画布提交日记 payload 无效");
    const payload = value.payload;
    if (payload.canvasId !== canvasId) throw new CanvasJournalError("画布提交日记 payload 作用域不匹配");
    const payloadExpected = asNonNegativeInteger(payload.expectedRevision, "payload.expectedRevision");
    if (payloadExpected !== expectedRevision) {
        throw new CanvasJournalError("画布提交日记 payload revision 不一致");
    }
    if (!isPlainObject(payload.document)) throw new CanvasJournalError("画布提交日记 payload 文档无效");
    return {
        operationId,
        expectedRevision,
        payload: {
            canvasId,
            expectedRevision: payloadExpected,
            document: payload.document as unknown as CanvasProject,
        },
    };
}

function parsePendingProjection(value: unknown, canvasId: string): CanvasPendingProjection | null {
    if (value == null) return null;
    if (!isPlainObject(value)) throw new CanvasJournalError("画布投影恢复状态无效");
    if (typeof value.identity !== "string" || !value.identity) {
        throw new CanvasJournalError("画布投影 identity 无效");
    }
    const revision = asNonNegativeInteger(value.revision, "pendingProjection.revision");
    const base = parseConfirmedSnapshot(value.base, canvasId);
    const remote = parseConfirmedSnapshot(value.remote, canvasId);
    if (!base || !remote) throw new CanvasJournalError("画布投影恢复快照无效");
    return { identity: value.identity, revision, base, remote };
}

function parseCanvasOperationJournal(raw: unknown, scope: string, canvasId: string): CanvasOperationJournal {
    if (!isPlainObject(raw)) throw new CanvasJournalError("画布提交日记损坏");
    if (raw.userScope !== scope || raw.canvasId !== canvasId) {
        throw new CanvasJournalError("画布提交日记作用域不匹配");
    }
    return {
        userScope: scope,
        canvasId,
        confirmedRevision: asNonNegativeInteger(raw.confirmedRevision, "confirmedRevision"),
        confirmedSnapshot: parseConfirmedSnapshot(raw.confirmedSnapshot, canvasId),
        inFlight: parseInFlight(raw.inFlight, canvasId),
        pendingProjection: parsePendingProjection(raw.pendingProjection, canvasId),
    };
}

function withJournal<T>(scope: string, canvasId: string, fn: () => Promise<T>): Promise<T> {
    const key = cacheKey(scope, canvasId);
    const run = (journalLocks.get(key) ?? Promise.resolve()).then(fn, fn);
    journalLocks.set(key, run.then(() => undefined, () => undefined));
    return run;
}

async function readJournalUnlocked(canvasId: string, scope: string): Promise<CanvasOperationJournal> {
    const key = cacheKey(scope, canvasId);
    const cached = memory.get(key);
    if (cached) return cloneJournal(cached);
    await journalStorageDelay?.beforeGet?.();
    let raw: string | null = null;
    try {
        raw = await localForageStorageForScope(scope).getItem(journalName(canvasId));
    } catch (error) {
        throw new CanvasJournalError("画布提交日记读取失败", { cause: error });
    }
    if (raw == null || raw === "") {
        const journal = emptyJournal(scope, canvasId);
        memory.set(key, journal);
        return cloneJournal(journal);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new CanvasJournalError("画布提交日记无法解析", { cause: error });
    }
    const journal = parseCanvasOperationJournal(parsed, scope, canvasId);
    memory.set(key, journal);
    if (journal.confirmedSnapshot) recordCanvasDocumentBase(journal.confirmedSnapshot, scope);
    return cloneJournal(journal);
}

async function writeJournalUnlocked(journal: CanvasOperationJournal) {
    const scope = journal.userScope || getActiveUserScope();
    const validated = parseCanvasOperationJournal(journal, scope, journal.canvasId);
    if (validated.confirmedSnapshot && validated.confirmedSnapshot.revision !== validated.confirmedRevision) {
        validated.confirmedSnapshot = { ...validated.confirmedSnapshot, revision: validated.confirmedRevision };
    }
    const serialized = JSON.stringify(validated);
    await journalStorageDelay?.beforeSet?.();
    await localForageStorageForScope(scope).setItem(journalName(journal.canvasId), serialized);
    const detached = parseCanvasOperationJournal(JSON.parse(serialized), scope, journal.canvasId);
    memory.set(cacheKey(scope, journal.canvasId), detached);
    if (detached.confirmedSnapshot) recordCanvasDocumentBase(detached.confirmedSnapshot, scope);
    return cloneJournal(detached);
}

export function peekCanvasOperationJournal(canvasId: string, scope = getActiveUserScope()) {
    const cached = memory.get(cacheKey(scope, canvasId));
    return cached ? cloneJournal(cached) : undefined;
}

export async function loadCanvasOperationJournal(canvasId: string, scope = getActiveUserScope()) {
    return withJournal(scope, canvasId, () => readJournalUnlocked(canvasId, scope));
}

export async function saveCanvasOperationJournal(journal: CanvasOperationJournal) {
    const scope = journal.userScope || getActiveUserScope();
    return withJournal(scope, journal.canvasId, () => writeJournalUnlocked(journal));
}

export async function updateCanvasOperationJournal(
    canvasId: string,
    scope: string,
    updater: (current: CanvasOperationJournal) => CanvasOperationJournal | void | Promise<CanvasOperationJournal | void>,
) {
    return withJournal(scope, canvasId, async () => {
        const current = await readJournalUnlocked(canvasId, scope);
        const next = await updater(current);
        if (next == null) return current;
        return writeJournalUnlocked(next);
    });
}

export async function recordConfirmedCanvasCommit(
    project: CanvasProject,
    scope = getActiveUserScope(),
    options: { ackOperationId?: string; unflushedProjection?: boolean } = {},
) {
    return updateCanvasOperationJournal(project.id, scope, (current) => {
        const incomingRevision = typeof project.revision === "number" && Number.isInteger(project.revision) && project.revision >= 0
            ? project.revision
            : current.confirmedRevision;
        const ackMatches = Boolean(options.ackOperationId && current.inFlight?.operationId === options.ackOperationId);
        if (incomingRevision < current.confirmedRevision) {
            if (ackMatches && current.inFlight) return { ...current, inFlight: null };
            return;
        }
        if (
            incomingRevision === current.confirmedRevision
            && current.confirmedSnapshot
            && sameCanvasDocument(current.confirmedSnapshot, project)
        ) {
            if (ackMatches && current.inFlight) return { ...current, inFlight: null };
            return;
        }
        const confirmedSnapshot = structuredClone(project);
        confirmedSnapshot.revision = incomingRevision;
        const recoveryBase = current.pendingProjection?.base ?? current.confirmedSnapshot;
        const pendingProjection = options.unflushedProjection && recoveryBase
            ? {
                identity: newCanvasProjectionIdentity(),
                revision: incomingRevision,
                base: structuredClone(recoveryBase),
                remote: structuredClone(confirmedSnapshot),
            }
            : current.pendingProjection;
        return {
            ...current,
            confirmedRevision: incomingRevision,
            confirmedSnapshot,
            inFlight: ackMatches ? null : current.inFlight,
            pendingProjection,
        };
    });
}

export async function clearCanvasPendingProjection(canvasId: string, scope: string, identity: string) {
    return updateCanvasOperationJournal(canvasId, scope, (current) => {
        if (current.pendingProjection?.identity !== identity) return;
        return { ...current, pendingProjection: null };
    });
}

export function newCanvasProjectionIdentity() {
    return `canvas-projection-${nanoid()}`;
}

export async function abandonCanvasInFlight(canvasId: string, scope = getActiveUserScope()) {
    await updateCanvasOperationJournal(canvasId, scope, (current) => {
        if (!current.inFlight) return;
        return { ...current, inFlight: null };
    });
}

export async function clearCanvasOperationJournal(canvasId: string, scope = getActiveUserScope()) {
    return withJournal(scope, canvasId, async () => {
        await journalStorageDelay?.beforeSet?.();
        await localForageStorageForScope(scope).removeItem(journalName(canvasId));
        memory.delete(cacheKey(scope, canvasId));
    });
}

export function newCanvasCommitOperationId() {
    return `canvas-commit-${nanoid()}`;
}

export function resetCanvasOperationJournalMemory() {
    memory.clear();
    journalLocks.clear();
    journalStorageDelay = null;
}
