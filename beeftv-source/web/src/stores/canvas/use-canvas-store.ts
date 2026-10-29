import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { sameCanvasContent, sameCanvasDocument } from "@/lib/canvas/canvas-content";
import { traceCanvasGraph } from "@/lib/canvas/canvas-graph-trace";
import { DEFAULT_CANVAS_BACKGROUND_MODE, normalizeCanvasAppearance, readCanvasAppearanceDefault, type CanvasAppearance } from "@/lib/canvas/canvas-appearance";
import { decideExternalCanvasRevision } from "@/lib/canvas/canvas-external-revision";
import { parseCanvasStorageDocument, rebaseCanvasProjects, serializeCanvasStorageDocument, type CanvasStorageDocument } from "@/lib/canvas/canvas-storage-revision";
import { localForageStorageForScope } from "@/lib/localforage-storage";
import { scopedLocalStorage } from "@/lib/user-scope";
import { getActiveUserScope } from "@/lib/user-scope";
import { usesBrowserLocalResourceStore } from "@/services/workspace-resource-storage";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasStarterMode } from "@/lib/canvas/canvas-starter";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";
import type { DirectorScene } from "@/types/director";
import type { TimelineProject } from "@/types/timeline";

export type CanvasProject = {
    id: string;
    revision?: number;
    remoteContentHash?: string;
    /** Stable owner for the 1:N workspace-project -> canvases relationship. */
    workspaceProjectId?: string;
    projectId?: string;
    folderId?: string;
    title: string;
    /** Optional user-facing name for this canvas inside its workspace project. */
    canvasTitle?: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    starterMode?: CanvasStarterMode;
    appearance?: CanvasAppearance;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
    directorScenes: DirectorScene[];
    timeline?: TimelineProject;
};

export type CanvasFolder = {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    coverDataUrl?: string;
    coverResourceId?: string;
    unsaved?: boolean;
    saveError?: string;
};

type CanvasStore = {
    hydrated: boolean;
    projects: CanvasProject[];
    folders: CanvasFolder[];
    createProject: (title?: string, projectId?: string, workspaceProjectId?: string) => string;
    createFolder: (name?: string) => string;
    renameFolder: (id: string, name: string) => void;
    deleteFolder: (id: string) => void;
    setFolderCover: (id: string, coverDataUrl: string) => void;
    replaceFolders: (folders: CanvasFolder[]) => void;
    moveProjectsToFolder: (ids: string[], folderId?: string) => void;
    importProject: (project: Partial<CanvasProject>, workspaceProjectId?: string) => string;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    restoreProject: (project: CanvasProject) => void;
    replaceProjects: (projects: CanvasProject[]) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "workspaceProjectId" | "projectId" | "folderId" | "title" | "canvasTitle" | "nodes" | "connections" | "chatSessions" | "activeChatId" | "starterMode" | "appearance" | "backgroundMode" | "showImageInfo" | "viewport" | "directorScenes" | "timeline">>) => void;
};

export const CANVAS_FOLDERS_KEY = "infinite-canvas:canvas_folders";

function isStaleProcessCoverUrl(value: string) {
    if (value.startsWith("blob:")) return true;
    try {
        const parsed = new URL(value, "http://127.0.0.1");
        return (parsed.protocol === "http:" || parsed.protocol === "https:")
            && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
    } catch {
        return false;
    }
}

function readCanvasFolders(): CanvasFolder[] {
    try {
        const value = scopedLocalStorage.getItem(CANVAS_FOLDERS_KEY);
        const parsed = value ? JSON.parse(value) : [];
        return Array.isArray(parsed) ? parsed.filter((folder): folder is CanvasFolder => Boolean(folder && typeof folder.id === "string" && typeof folder.name === "string")).map((folder) => {
            const coverResourceId = typeof folder.coverResourceId === "string" ? folder.coverResourceId : undefined;
            const coverDataUrl = typeof folder.coverDataUrl === "string" && !isStaleProcessCoverUrl(folder.coverDataUrl) ? folder.coverDataUrl : undefined;
            return {
                ...folder,
                coverResourceId,
                coverDataUrl,
                unsaved: folder.unsaved === true ? true : undefined,
                saveError: typeof folder.saveError === "string" && folder.saveError ? folder.saveError : undefined,
            };
        }) : [];
    } catch {
        return [];
    }
}

function writeCanvasFolders(folders: CanvasFolder[]) {
    const persistable = usesBrowserLocalResourceStore()
        ? folders
        : folders.map((folder) => ({
            ...folder,
            coverDataUrl: folder.coverDataUrl?.startsWith("data:") ? undefined : folder.coverDataUrl,
        }));
    scopedLocalStorage.setItem(CANVAS_FOLDERS_KEY, JSON.stringify(persistable));
}

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
export const CANVAS_STORE_KEY = "infinite-canvas:canvas_store";

function cloneCanvasValue<T>(value: T): T {
    if (value == null) return value;
    try {
        return structuredClone(value);
    } catch {
        if (Array.isArray(value)) return [...value] as T;
        if (typeof value === "object") return { ...value } as T;
        return value;
    }
}

type PersistedCanvasState = Pick<CanvasStore, "projects">;
type QueuedCanvasPersist = {
    name: string;
    scope: string;
    baseProjects: CanvasProject[];
    baseRevision: number;
    state: PersistedCanvasState;
    token: number;
};

type ObservedCanvasPersist = {
    projects: CanvasProject[];
    revision: number;
};

let suppressCanvasStorePersistence = 0;
const canvasMemoryStates = new Map<string, PersistedCanvasState>();
const observedCanvasPersists = new Map<string, ObservedCanvasPersist>();
const queuedCanvasPersists = new Map<string, QueuedCanvasPersist>();
const canvasSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const canvasPersistTokens = new Map<string, number>();
type CanvasGenerationPersistenceAttempt = {
    previousNodes?: CanvasNodeData[];
    nodes?: CanvasNodeData[];
    previousConnections?: CanvasConnection[];
    connections?: CanvasConnection[];
    previousChatSessions?: CanvasAssistantSession[];
    chatSessions?: CanvasAssistantSession[];
};
const pendingCanvasGenerationAttempts = new Map<string, Map<string, CanvasGenerationPersistenceAttempt>>();

type AsyncCanvasStorageLock = {
    request<T>(name: string, callback: () => Promise<T>): Promise<T>;
};

type CanvasStorageLockOptions = {
    requireCrossRealmLock?: boolean;
};

const CANVAS_STORAGE_LOCK_PREFIX = "infinite-canvas:canvas-generation-storage-lock:";
const canvasStorageTails = new Map<string, Promise<void>>();

function runWithBrowserCanvasStorageLock<T>(scope: string, operation: () => Promise<T>, options: CanvasStorageLockOptions) {
    const locks = typeof window !== "undefined" && typeof navigator !== "undefined" ? (navigator.locks as AsyncCanvasStorageLock | undefined) : undefined;
    const lockName = `${CANVAS_STORAGE_LOCK_PREFIX}${scope}`;
    if (locks) return locks.request(lockName, operation);
    if (options.requireCrossRealmLock && typeof window !== "undefined" && typeof document !== "undefined") {
        throw new Error("当前浏览器不支持跨标签存储锁，已停止画布生成持久化");
    }
    return operation();
}

/**
 * 串行化同一用户作用域的画布持久化，并在一次失败后允许队列继续前进。
 *
 * `pending` 必须把当前写入的真实结果返回给调用方；只有前一个 tail 的失败被
 * 转换成已处理的 void，才不会让一次旧失败永久毒化后续保存队列。
 */
export function withCanvasStorePersistenceLock<T>(scope: string, operation: () => Promise<T>, options: CanvasStorageLockOptions = {}): Promise<T> {
    const previous = canvasStorageTails.get(scope) ?? Promise.resolve();
    const pending = previous.then(() => undefined, () => undefined).then(() => runWithBrowserCanvasStorageLock(scope, operation, options));
    const tail = pending.then(
        () => undefined,
        () => undefined,
    );
    canvasStorageTails.set(scope, tail);
    void tail.finally(() => {
        if (canvasStorageTails.get(scope) === tail) canvasStorageTails.delete(scope);
    });
    return pending;
}

function clearCanvasSaveTimer(scope: string) {
    const timer = canvasSaveTimers.get(scope);
    if (!timer) return;
    clearTimeout(timer);
    canvasSaveTimers.delete(scope);
}

/** 该作用域最近一次落进浏览器存储的画布内容；没有记录返回 undefined。 */
export function canvasDurableSnapshot(scope: string, projectId: string) {
    return observedCanvasPersists.get(scope)?.projects.find((project) => project.id === projectId);
}

type CanvasDocumentBase = {
    revision: number;
    snapshot: CanvasProject;
};

const canvasDocumentBases = new Map<string, CanvasDocumentBase>();

function canvasDocumentBaseKey(scope: string, projectId: string) {
    return `${scope}\0${projectId}`;
}

/** 最近一次被服务端确认的画布基线（revision + 文档），与 IndexedDB 存储队列无关。 */
export function recordCanvasDocumentBase(project: CanvasProject, scope = getActiveUserScope()) {
    canvasDocumentBases.set(canvasDocumentBaseKey(scope, project.id), {
        revision: project.revision ?? 0,
        snapshot: project,
    });
}

export function canvasDocumentBase(projectId: string, scope = getActiveUserScope()) {
    return canvasDocumentBases.get(canvasDocumentBaseKey(scope, projectId));
}

export function clearCanvasDocumentBase(projectId: string, scope = getActiveUserScope()) {
    canvasDocumentBases.delete(canvasDocumentBaseKey(scope, projectId));
}

export type CanvasExternalRevisionConflict = {
    projectId: string;
    localRevision: number;
    remoteRevision: number;
    detectedAt: string;
    /** 被挡下的外部内容：保留为候选，用户选择「以最新为准」时使用它。 */
    candidate: CanvasProject;
};

type CanvasExternalRevisionState = {
    conflicts: Map<string, CanvasExternalRevisionConflict>;
    /** 每次冲突集合变化都自增，供订阅方重新投影。 */
    version: number;
};

const canvasExternalRevisionState: CanvasExternalRevisionState = { conflicts: new Map(), version: 0 };
const canvasExternalRevisionListeners = new Set<() => void>();

function canvasExternalRevisionKey(scope: string, projectId: string) {
    return `${scope}\0${projectId}`;
}

export function canvasExternalRevisionVersion() {
    return canvasExternalRevisionState.version;
}

export function subscribeCanvasExternalRevision(listener: () => void) {
    canvasExternalRevisionListeners.add(listener);
    return () => { canvasExternalRevisionListeners.delete(listener); };
}

function publishCanvasExternalRevision() {
    canvasExternalRevisionState.version += 1;
    for (const listener of [...canvasExternalRevisionListeners]) listener();
}

/** 读某个画布当前是否处于「外部写入被本地编辑挡住」的冲突态。 */
export function canvasExternalRevisionConflict(scope: string, projectId: string) {
    const key = canvasExternalRevisionKey(scope, projectId);
    const conflict = canvasExternalRevisionState.conflicts.get(key);
    if (!conflict) return undefined;
    // 本地 revision 已前进说明这次提交被服务端接受，冲突前提消失；
    // 否则不同入口之间会一直提示同一份早已过时的冲突。
    const localRevision = useCanvasStore.getState().projects.find((project) => project.id === projectId)?.revision ?? 0;
    if (localRevision > conflict.remoteRevision) {
        canvasExternalRevisionState.conflicts.delete(key);
        return undefined;
    }
    return conflict;
}

/** 冲突解除：本地编辑已被服务端接受，或用户选择以最新内容为准。 */
export function clearCanvasExternalRevisionConflict(scope: string, projectId: string) {
    if (!canvasExternalRevisionState.conflicts.delete(canvasExternalRevisionKey(scope, projectId))) return;
    publishCanvasExternalRevision();
}

function markCanvasExternalRevisionConflict(scope: string, conflict: CanvasExternalRevisionConflict) {
    const key = canvasExternalRevisionKey(scope, conflict.projectId);
    const previous = canvasExternalRevisionState.conflicts.get(key);
    if (previous && previous.localRevision === conflict.localRevision && previous.remoteRevision === conflict.remoteRevision && sameCanvasDocument(previous.candidate, conflict.candidate)) return;
    canvasExternalRevisionState.conflicts.set(key, conflict);
    publishCanvasExternalRevision();
}

type ApplyExternalCanvasRevisionOptions = {
    scope?: string;
    /**
     * 本地是否有服务端尚未确认的编辑。必须由持有服务端确认基线与 HTTP 提交状态的
     * 调用方给出；本地存储队列为空并不能证明服务端已经保存。
     */
    hasUnsyncedEdits: boolean;
    onApplied?: (project: CanvasProject, previous: CanvasProject | undefined) => void;
};

/**
 * 把一次外部写入（内置助手回合、CLI/MCP 操作）投影到本地存储与编辑器。
 *
 * 无未确认编辑时安全应用外部内容（保留本机视角与外观偏好），并通过 `onApplied`
 * 把这次替换交给调用方通知编辑器；有未确认编辑时保留本地内容、把外部内容留作
 * 候选并记录冲突，绝不覆盖用户正在编辑的值。
 */
export function applyExternalCanvasRevision(remote: CanvasProject, options: ApplyExternalCanvasRevisionOptions) {
    const scope = options.scope ?? getActiveUserScope();
    const previous = useCanvasStore.getState().projects.find((project) => project.id === remote.id)
        ?? canvasMemoryStates.get(scope)?.projects.find((project) => project.id === remote.id);
    return applyCanvasExternalDecision(scope, decideExternalCanvasRevision({
        remote,
        local: previous,
        hasLocalEdits: options.hasUnsyncedEdits,
    }), previous, options.onApplied);
}

/**
 * 用户显式选择「以最新内容为准」：用保留的候选覆盖本地文档。
 *
 * 这是唯一允许在存在本地编辑时替换文档的路径，且只能由用户动作触发。
 */
export function acceptCanvasExternalRevisionCandidate(
    projectId: string,
    options: { scope?: string; onApplied?: (project: CanvasProject, previous: CanvasProject | undefined) => void } = {},
) {
    const scope = options.scope ?? getActiveUserScope();
    const conflict = canvasExternalRevisionState.conflicts.get(canvasExternalRevisionKey(scope, projectId));
    if (!conflict) return undefined;
    const previous = useCanvasStore.getState().projects.find((project) => project.id === projectId);
    return applyCanvasExternalDecision(scope, decideExternalCanvasRevision({
        remote: conflict.candidate,
        local: previous,
        hasLocalEdits: false,
    }), previous, options.onApplied);
}

function applyCanvasExternalDecision(
    scope: string,
    decision: ReturnType<typeof decideExternalCanvasRevision>,
    previous: CanvasProject | undefined,
    onApplied?: (project: CanvasProject, previous: CanvasProject | undefined) => void,
) {
    if (decision.kind === "keep-local") {
        markCanvasExternalRevisionConflict(scope, {
            projectId: decision.projectId,
            localRevision: decision.localRevision,
            remoteRevision: decision.remoteRevision,
            detectedAt: new Date().toISOString(),
            candidate: decision.candidate,
        });
        return decision;
    }
    const applied = decision.project;
    useCanvasStore.setState((state) => ({
        projects: state.projects.some((project) => project.id === applied.id)
            ? state.projects.map((project) => project.id === applied.id ? applied : project)
            : [...state.projects, applied],
    }));
    canvasMemoryStates.set(scope, { projects: useCanvasStore.getState().projects });
    clearCanvasExternalRevisionConflict(scope, applied.id);
    try {
        onApplied?.(applied, previous);
    } catch (error) {
        console.error("画布刷新通知失败", { id: applied.id, error });
    }
    return decision;
}

export function recordCanvasStorageDocument(scope: string, document: CanvasStorageDocument) {
    observedCanvasPersists.set(scope, {
        projects: document.state.projects,
        revision: document.storageRevision,
    });
}

export async function commitPendingCanvasStorePersistenceLocked(scope: string) {
    const storage = localForageStorageForScope(scope);
    let committed: CanvasStorageDocument | null = null;

    while (true) {
        const queued = queuedCanvasPersists.get(scope);
        if (!queued) return committed;

        const durable = parseCanvasStorageDocument(await storage.getItem(queued.name), queued.baseProjects);
        const rebased = rebaseCanvasProjects({
            document: durable,
            baseProjects: queued.baseProjects,
            localProjects: queued.state.projects,
            baseRevision: queued.baseRevision,
        }).document;
        await storage.setItem(queued.name, serializeCanvasStorageDocument(rebased));
        for (const project of rebased.state.projects) {
            const previous = durable.state.projects.find((item) => item.id === project.id);
            if (previous?.connections?.length !== project.connections?.length) traceCanvasGraph("cache.commit", { previous, queued: queued.state.projects.find((item) => item.id === project.id), saved: project });
        }
        committed = rebased;
        recordCanvasStorageDocument(scope, rebased);

        const latest = queuedCanvasPersists.get(scope);
        if (!latest || latest.token === queued.token) {
            if (latest?.token === queued.token) queuedCanvasPersists.delete(scope);
            return committed;
        }

        latest.baseProjects = queued.state.projects;
        latest.baseRevision = rebased.storageRevision;
    }
}

async function writeQueuedCanvasPersist(scope: string, _token: number) {
    await withCanvasStorePersistenceLock(scope, () => commitPendingCanvasStorePersistenceLocked(scope));
}

export function pendingCanvasStorePersistence(scope: string) {
    const queued = queuedCanvasPersists.get(scope);
    return queued ? { projects: queued.state.projects, token: queued.token } : null;
}

export function withCanvasStorePersistenceSuppressed<T>(operation: () => T) {
    suppressCanvasStorePersistence += 1;
    try {
        return operation();
    } finally {
        suppressCanvasStorePersistence -= 1;
    }
}

export function registerCanvasGenerationPersistenceAttempt(scope: string, projectId: string, effectKey: string, attempt: CanvasGenerationPersistenceAttempt) {
    const projectKey = `${scope}\0${projectId}`;
    const attempts = pendingCanvasGenerationAttempts.get(projectKey) ?? new Map<string, CanvasGenerationPersistenceAttempt>();
    attempts.set(effectKey, attempt);
    pendingCanvasGenerationAttempts.set(projectKey, attempts);
    const queued = queuedCanvasPersists.get(scope);
    if (queued) {
        const latestMemory = canvasMemoryStates.get(scope)?.projects ?? queued.state.projects;
        const durableProjects = observedCanvasPersists.get(scope)?.projects ?? queued.baseProjects;
        queued.state = ordinaryCanvasPersistenceState(scope, { projects: latestMemory }, durableProjects);
    }
    return () => {
        if (attempts.get(effectKey) !== attempt) return;
        attempts.delete(effectKey);
        if (!attempts.size) pendingCanvasGenerationAttempts.delete(projectKey);
    };
}

function hasUnconfirmedGenerationKey(localKeys?: string[], durableKeys?: string[]) {
    return Boolean(localKeys?.some((key) => !durableKeys?.includes(key)));
}

function samePersistenceValue(left: unknown, right: unknown) {
    return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function rollbackGenerationValue(previous: unknown, attempted: unknown, live: unknown, durable: unknown): unknown {
    if (samePersistenceValue(previous, attempted)) return live;
    if (samePersistenceValue(live, attempted)) return durable;
    if (!previous || !attempted || !live || !durable || Array.isArray(previous) || Array.isArray(attempted) || Array.isArray(live) || Array.isArray(durable) || typeof previous !== "object" || typeof attempted !== "object" || typeof live !== "object" || typeof durable !== "object") return live;

    const previousRecord = previous as Record<string, unknown>;
    const attemptedRecord = attempted as Record<string, unknown>;
    const liveRecord = live as Record<string, unknown>;
    const durableRecord = durable as Record<string, unknown>;
    const result: Record<string, unknown> = { ...durableRecord };
    for (const key of new Set([...Object.keys(previousRecord), ...Object.keys(attemptedRecord), ...Object.keys(liveRecord)])) {
        const previousHasKey = Object.hasOwn(previousRecord, key);
        const attemptedHasKey = Object.hasOwn(attemptedRecord, key);
        const liveHasKey = Object.hasOwn(liveRecord, key);
        if (!previousHasKey && !attemptedHasKey) {
            if (liveHasKey) result[key] = liveRecord[key];
            continue;
        }
        if (!previousHasKey && attemptedHasKey) {
            if (!liveHasKey || samePersistenceValue(liveRecord[key], attemptedRecord[key])) delete result[key];
            else result[key] = liveRecord[key];
            continue;
        }
        if (previousHasKey && !attemptedHasKey) {
            if (liveHasKey) result[key] = liveRecord[key];
            continue;
        }
        if (!liveHasKey) {
            delete result[key];
            continue;
        }
        const value = rollbackGenerationValue(previousRecord[key], attemptedRecord[key], liveRecord[key], durableRecord[key]);
        if (value === undefined) delete result[key];
        else result[key] = value;
    }
    return result;
}

function pendingGenerationAttempt(scope: string, projectId: string, effectKeys?: string[]) {
    const attempts = pendingCanvasGenerationAttempts.get(`${scope}\0${projectId}`);
    if (!attempts) return undefined;
    for (const effectKey of effectKeys || []) {
        const attempt = attempts.get(effectKey);
        if (attempt) return attempt;
    }
    return undefined;
}

function rollbackGenerationConnections(live: CanvasConnection[], attempt: CanvasGenerationPersistenceAttempt) {
    if (!attempt.previousConnections || !attempt.connections) return live;
    const previous = new Map(attempt.previousConnections.map((edge) => [edge.id, edge]));
    const attempted = new Map(attempt.connections.map((edge) => [edge.id, edge]));
    const liveIds = new Set(live.map((edge) => edge.id));
    const result: CanvasConnection[] = [];
    for (const edge of live) {
        const before = previous.get(edge.id);
        const after = attempted.get(edge.id);
        if (samePersistenceValue(before, after)) result.push(edge);
        else if (before) result.push(rollbackGenerationValue(before, after, edge, before) as CanvasConnection);
        // An edge created by this uncommitted effect must not escape through ordinary persistence.
    }
    for (const edge of attempt.previousConnections) {
        if (!attempted.has(edge.id) && !liveIds.has(edge.id)) result.push(edge);
    }
    return result;
}

function ordinaryCanvasProjectSnapshot(scope: string, project: CanvasProject, durableProject: CanvasProject | undefined) {
    if (!hasGenerationEffectKeys(project) && !hasGenerationEffectKeys(durableProject)) return project;
    const durableNodes = new Map((durableProject?.nodes || []).map((node) => [node.id, node]));
    const durableSessions = new Map((durableProject?.chatSessions || []).map((session) => [session.id, session]));
    // A confirmed backend projection may be ahead of IndexedDB. Its stamps are committed too;
    // treating them as speculative rolls the projection back while writing its new revision.
    const confirmed = canvasDocumentBase(project.id, scope)?.snapshot;
    for (const node of confirmed?.nodes || []) {
        const cachedKeys = durableNodes.get(node.id)?.metadata?.generationEffectKeys;
        if (hasUnconfirmedGenerationKey(node.metadata?.generationEffectKeys, cachedKeys)) {
            durableNodes.set(node.id, { ...node, metadata: { ...node.metadata, generationEffectKeys: [...new Set([...(cachedKeys || []), ...(node.metadata?.generationEffectKeys || [])])] } });
        }
    }
    for (const session of confirmed?.chatSessions || []) {
        const cachedKeys = durableSessions.get(session.id)?.generationEffectKeys;
        if (hasUnconfirmedGenerationKey(session.generationEffectKeys, cachedKeys)) {
            durableSessions.set(session.id, { ...session, generationEffectKeys: [...new Set([...(cachedKeys || []), ...(session.generationEffectKeys || [])])] });
        }
    }
    const unconfirmedAttempts = new Set<CanvasGenerationPersistenceAttempt>();
    let changed = false;
    let hasUnconfirmedGeneration = false;
    const nodes: CanvasNodeData[] = [];
    for (const node of project.nodes) {
        const durableNode = durableNodes.get(node.id);
        const durableKeys = durableNode?.metadata?.generationEffectKeys;
        const localKeys = node.metadata?.generationEffectKeys;
        if (durableProject && hasUnconfirmedGenerationKey(localKeys, durableKeys)) {
            hasUnconfirmedGeneration = true;
            changed = true;
            const attempt = pendingGenerationAttempt(scope, project.id, localKeys);
            if (attempt) unconfirmedAttempts.add(attempt);
            if (durableNode) {
                const previousNode = attempt?.previousNodes?.find((candidate) => candidate.id === node.id);
                const attemptedNode = attempt?.nodes?.find((candidate) => candidate.id === node.id);
                // durableNode comes from the observed storage snapshot. Never mutate that snapshot while
                // rebuilding a failed generation, otherwise a later retry observes a partially rolled-back base.
                const rolledBack = previousNode && attemptedNode
                    ? (rollbackGenerationValue(previousNode, attemptedNode, node, durableNode) as CanvasNodeData)
                    : { ...durableNode, metadata: durableNode.metadata ? { ...durableNode.metadata } : undefined };
                const metadata = { ...(rolledBack.metadata || {}) };
                if (durableKeys?.length) metadata.generationEffectKeys = [...durableKeys];
                else delete metadata.generationEffectKeys;
                nodes.push({ ...rolledBack, metadata });
            }
            continue;
        }
        if (sameGenerationEffectKeys(localKeys, durableKeys)) {
            nodes.push(node);
            continue;
        }
        changed = true;
        const metadata = { ...(node.metadata || {}) };
        if (durableKeys?.length) metadata.generationEffectKeys = [...durableKeys];
        else delete metadata.generationEffectKeys;
        nodes.push({ ...node, metadata });
    }
    const chatSessions: CanvasAssistantSession[] = [];
    // Backend-created canvases may omit assistant sessions. Treat the missing
    // optional collection like an empty one, as document hydration does.
    for (const session of project.chatSessions || []) {
        const durableSession = durableSessions.get(session.id);
        const durableKeys = durableSession?.generationEffectKeys;
        if (durableProject && hasUnconfirmedGenerationKey(session.generationEffectKeys, durableKeys)) {
            hasUnconfirmedGeneration = true;
            changed = true;
            const attempt = pendingGenerationAttempt(scope, project.id, session.generationEffectKeys);
            if (attempt) unconfirmedAttempts.add(attempt);
            if (durableSession) {
                const previousSession = attempt?.previousChatSessions?.find((candidate) => candidate.id === session.id);
                const attemptedSession = attempt?.chatSessions?.find((candidate) => candidate.id === session.id);
                const rolledBack = previousSession && attemptedSession
                    ? (rollbackGenerationValue(previousSession, attemptedSession, session, durableSession) as CanvasAssistantSession)
                    : { ...durableSession, generationEffectKeys: durableSession.generationEffectKeys ? [...durableSession.generationEffectKeys] : undefined };
                if (durableKeys?.length) rolledBack.generationEffectKeys = [...durableKeys];
                else delete rolledBack.generationEffectKeys;
                chatSessions.push(rolledBack);
            }
            continue;
        }
        if (sameGenerationEffectKeys(session.generationEffectKeys, durableKeys)) {
            chatSessions.push(session);
            continue;
        }
        changed = true;
        const nextSession = { ...session };
        if (durableKeys?.length) nextSession.generationEffectKeys = [...durableKeys];
        else delete nextSession.generationEffectKeys;
        chatSessions.push(nextSession);
    }
    if (durableProject && hasUnconfirmedGeneration) {
        let connections = project.connections;
        for (const attempt of unconfirmedAttempts) connections = rollbackGenerationConnections(connections, attempt);
        const nodeIds = new Set(nodes.map((node) => node.id));
        return {
            ...project,
            nodes,
            connections: connections.filter((edge) => nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId)),
            chatSessions,
            activeChatId: durableProject.activeChatId,
        };
    }
    return changed ? { ...project, nodes, chatSessions } : project;
}

function hasGenerationEffectKeys(value: CanvasProject | undefined) {
    if (!value) return false;
    return (value.nodes || []).some((node) => Boolean(node.metadata?.generationEffectKeys?.length))
        || (value.chatSessions || []).some((session) => Boolean(session.generationEffectKeys?.length));
}

function sameGenerationEffectKeys(left?: readonly string[], right?: readonly string[]) {
    if (left === right) return true;
    if (!left?.length && !right?.length) return true;
    if (!left || !right || left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
}

function ordinaryCanvasPersistenceState(scope: string, state: PersistedCanvasState, durableProjects: CanvasProject[]) {
    const durableById = new Map(durableProjects.map((project) => [project.id, project]));
    return {
        projects: state.projects.map((project) => ordinaryCanvasProjectSnapshot(scope, project, durableById.get(project.id))),
    };
}

const canvasStorage: PersistStorage<CanvasStore> = {
    getItem: async (name) => {
        const scope = getActiveUserScope();
        const value = await localForageStorageForScope(scope).getItem(name);
        if (!value) {
            canvasMemoryStates.set(scope, { projects: [] });
            observedCanvasPersists.set(scope, { projects: [], revision: 0 });
            return null;
        }
        const document = parseCanvasStorageDocument(value);
        const state = document.state as PersistedCanvasState;
        for (const project of state.projects) traceCanvasGraph("cache.rehydrate", { project });
        canvasMemoryStates.set(scope, state);
        recordCanvasStorageDocument(scope, document);
        return document as unknown as StorageValue<CanvasStore>;
    },
    setItem: (name, value) => {
        const scope = getActiveUserScope();
        const nextState = value.state as PersistedCanvasState;
        if (canvasMemoryStates.get(scope)?.projects === nextState.projects) return;
        canvasMemoryStates.set(scope, nextState);
        if (suppressCanvasStorePersistence) return;

        const queued = queuedCanvasPersists.get(scope);
        const observed = observedCanvasPersists.get(scope);
        const token = (canvasPersistTokens.get(scope) || 0) + 1;
        canvasPersistTokens.set(scope, token);
        const baseProjects = queued?.baseProjects ?? observed?.projects ?? [];
        queuedCanvasPersists.set(scope, {
            name,
            scope,
            baseProjects,
            baseRevision: queued?.baseRevision ?? observed?.revision ?? 0,
            // generationEffectKeys 由专用 generation durable commit 管理；普通队列只能携带已确认 stamp。
            state: ordinaryCanvasPersistenceState(scope, nextState, observed?.projects ?? baseProjects),
            token,
        });
        clearCanvasSaveTimer(scope);
        const timer = setTimeout(() => {
            if (canvasSaveTimers.get(scope) === timer) canvasSaveTimers.delete(scope);
            void writeQueuedCanvasPersist(scope, token).catch((error) => {
                // 自动保存无法把异常返回给原始状态更新调用方，但失败队列仍会保留给下一次写入或显式 flush 重试。
                console.error("画布本地持久化失败，已保留待写队列", { scope, error });
            });
        }, 400);
        canvasSaveTimers.set(scope, timer);
    },
    removeItem: (name) => {
        const scope = getActiveUserScope();
        return localForageStorageForScope(scope).removeItem(name);
    },
};

export async function flushCanvasStorePersistence() {
    while (canvasStorageTails.size || queuedCanvasPersists.size || canvasSaveTimers.size) {
        for (const scope of [...canvasSaveTimers.keys()]) clearCanvasSaveTimer(scope);
        const writes = [...queuedCanvasPersists.values()].map(({ scope, token }) => writeQueuedCanvasPersist(scope, token));
        if (writes.length) await Promise.all(writes);
        else if (canvasStorageTails.size) await Promise.all([...canvasStorageTails.values()]);
    }
}

export function hasActiveCanvasStorePersistence() {
    // Failed queues remain retryable, but only a timer or storage tail can
    // still perform IO without another explicit save request.
    return canvasStorageTails.size > 0 || canvasSaveTimers.size > 0;
}

export const useCanvasStore = create<CanvasStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            projects: [],
            folders: [],
            createProject: (title = "未命名画布", projectId, workspaceProjectId) => {
                const now = new Date().toISOString();
                const id = nanoid();
                const appearanceDefault = readCanvasAppearanceDefault();
                const project: CanvasProject = {
                    id,
                    revision: 0,
                    workspaceProjectId: workspaceProjectId || id,
                    projectId,
                    title,
                    createdAt: now,
                    updatedAt: now,
                    nodes: [],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    appearance: appearanceDefault?.appearance ?? { mode: "follow" },
                    backgroundMode: appearanceDefault?.backgroundMode || DEFAULT_CANVAS_BACKGROUND_MODE,
                    showImageInfo: false,
                    viewport: initialViewport,
                    directorScenes: [],
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return id;
            },
            createFolder: (name = "未命名文件夹") => {
                const now = new Date().toISOString();
                const folder = { id: nanoid(), name: name.trim() || "未命名文件夹", createdAt: now, updatedAt: now };
                set((state) => {
                    const folders = [folder, ...state.folders];
                    writeCanvasFolders(folders);
                    return { folders };
                });
                return folder.id;
            },
            renameFolder: (id, name) => set((state) => {
                const nextName = name.trim();
                if (!nextName) return state;
                const folders = state.folders.map((folder) => folder.id === id ? { ...folder, name: nextName, updatedAt: new Date().toISOString() } : folder);
                writeCanvasFolders(folders);
                return { folders };
            }),
            deleteFolder: (id) => set((state) => {
                const folders = state.folders.filter((folder) => folder.id !== id);
                const projects = state.projects.map((project) => project.folderId === id ? { ...project, folderId: undefined, updatedAt: new Date().toISOString() } : project);
                writeCanvasFolders(folders);
                return { folders, projects };
            }),
            setFolderCover: (id, coverDataUrl) => set((state) => {
                const folders = state.folders.map((folder) => folder.id === id ? { ...folder, coverDataUrl, updatedAt: new Date().toISOString() } : folder);
                writeCanvasFolders(folders);
                return { folders };
            }),
            replaceFolders: (folders) => {
                writeCanvasFolders(folders);
                set({ folders });
            },
            moveProjectsToFolder: (ids, folderId) => set((state) => ({ projects: state.projects.map((project) => ids.includes(project.id) ? { ...project, folderId, updatedAt: new Date().toISOString() } : project) })),
            importProject: (source, workspaceProjectId) => {
                const now = new Date().toISOString();
                const project: CanvasProject = {
                    id: nanoid(),
                    revision: 0,
                    workspaceProjectId: undefined,
                    projectId: source.projectId,
                    folderId: source.folderId,
                    title: source.title || "导入画布",
                    canvasTitle: source.canvasTitle,
                    createdAt: source.createdAt || now,
                    updatedAt: now,
                    nodes: cloneCanvasValue(source.nodes || []),
                    connections: cloneCanvasValue(source.connections || []),
                    chatSessions: cloneCanvasValue(source.chatSessions || []),
                    activeChatId: source.activeChatId || null,
                    starterMode: source.starterMode,
                    appearance: source.appearance ? normalizeCanvasAppearance(source.appearance, "dark") : undefined,
                    backgroundMode: source.backgroundMode || DEFAULT_CANVAS_BACKGROUND_MODE,
                    showImageInfo: source.showImageInfo || false,
                    viewport: cloneCanvasValue(source.viewport || initialViewport),
                    directorScenes: cloneCanvasValue(source.directorScenes || []),
                    timeline: source.timeline ? cloneCanvasValue(source.timeline) : undefined,
                };
                project.workspaceProjectId = workspaceProjectId || project.id;
                set((state) => ({ projects: [project, ...state.projects] }));
                return project.id;
            },
            openProject: (id) => {
                return get().projects.find((item) => item.id === id) || null;
            },
            renameProject: (id, title) => set((state) => {
                const current = state.projects.find((project) => project.id === id);
                const nextTitle = title.trim() || current?.title;
                if (!current || current.title === nextTitle) return state;
                return { projects: state.projects.map((project) => project === current ? { ...project, title: nextTitle!, updatedAt: new Date().toISOString() } : project) };
            }),
            deleteProjects: (ids) =>
                set((state) => {
                    const projects = state.projects.filter((project) => !ids.includes(project.id));
                    return { projects };
                }),
            restoreProject: (project) => set((state) => {
                if (state.projects.some((item) => item.id === project.id)) return state;
                return { projects: [project, ...state.projects] };
            }),
            replaceProjects: (projects) => set({ projects }),
            updateProject: (id, patch) => set((state) => {
                const current = state.projects.find((project) => project.id === id);
                if (!current) return state;
                const next = { ...current, ...patch };
                const contentChanged = !sameCanvasContent(current, next);
                if (!contentChanged && samePersistenceValue(current.viewport, next.viewport)) return state;
                if (patch.connections && current.connections.length !== patch.connections.length) traceCanvasGraph("store.updateProject", { previous: current, next });
                if (contentChanged) next.updatedAt = new Date().toISOString();
                return { projects: state.projects.map((project) => project === current ? next : project) };
            }),
        }),
        {
            name: CANVAS_STORE_KEY,
            storage: canvasStorage,
            partialize: (state) =>
                ({
                    projects: state.projects,
                }) as StorageValue<CanvasStore>["state"],
            onRehydrateStorage: () => () => {
                useCanvasStore.setState({ folders: readCanvasFolders(), hydrated: true });
            },
        },
    ),
);
