import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

export type CanvasDocumentRebaseResult = {
    project: CanvasProject;
    conflict: boolean;
};

const VIEW_PREFERENCE_KEYS = new Set(["viewport", "appearance", "backgroundMode", "showImageInfo"]);
const SERVER_OWNED_KEYS = new Set(["revision", "updatedAt", "remoteContentHash", "createdAt"]);
const ENTITY_LIST_KEYS = new Set(["nodes", "connections", "chatSessions"]);
const SKIP_GENERIC_KEYS = new Set(["id", ...VIEW_PREFERENCE_KEYS, ...SERVER_OWNED_KEYS, ...ENTITY_LIST_KEYS]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function equal(left: unknown, right: unknown) {
    if (Object.is(left, right)) return true;
    try {
        return JSON.stringify(left) === JSON.stringify(right);
    } catch {
        return false;
    }
}

function mergeField(base: unknown, local: unknown, remote: unknown, conflict: { value: boolean }): unknown {
    if (equal(local, base)) return remote;
    if (equal(remote, base) || equal(local, remote)) return local;
    if (isPlainObject(local) && isPlainObject(remote)) {
        return mergeObject(isPlainObject(base) ? base : {}, local, remote, conflict);
    }
    conflict.value = true;
    return local;
}

function mergeObject(
    base: Record<string, unknown>,
    local: Record<string, unknown>,
    remote: Record<string, unknown>,
    conflict: { value: boolean },
): Record<string, unknown> {
    const merged: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
        const baseHas = Object.prototype.hasOwnProperty.call(base, key);
        const localHas = Object.prototype.hasOwnProperty.call(local, key);
        const remoteHas = Object.prototype.hasOwnProperty.call(remote, key);
        if (!localHas && baseHas) {
            if (remoteHas && !equal(remote[key], base[key])) conflict.value = true;
            continue;
        }
        if (!localHas) {
            if (remoteHas) merged[key] = remote[key];
            continue;
        }
        if (!remoteHas) {
            if (baseHas && !equal(local[key], base[key])) {
                conflict.value = true;
                merged[key] = local[key];
            } else if (!baseHas) {
                merged[key] = local[key];
            }
            continue;
        }
        if (!baseHas) {
            merged[key] = mergeField(undefined, local[key], remote[key], conflict);
            continue;
        }
        merged[key] = mergeField(base[key], local[key], remote[key], conflict);
    }
    return merged;
}

const GENERATION_MEDIA_RESULT_KEYS = ["content", "storageKey", "assetId"] as const;
const GENERATION_MEDIA_RESULT_KEY_SET = new Set<string>(GENERATION_MEDIA_RESULT_KEYS);

const GENERATION_BIND_METADATA_KEYS = [
    ...GENERATION_MEDIA_RESULT_KEYS,
    "mimeType",
    "bytes",
    "naturalWidth",
    "naturalHeight",
    "durationMs",
    "nodeRole",
    "resultOrigin",
    "generationEffectKeys",
    "status",
    "taskStatus",
    "taskProgress",
    "taskStage",
    "taskCompletedAt",
    "taskUpdatedAt",
] as const;

const GENERATION_ERROR_METADATA_KEYS = [
    "errorDetails",
    "generationErrorCode",
    "generationErrorSummary",
    "resourceReloadAvailable",
    "failedPromptFingerprint",
    "failedInputFingerprint",
    "processingLabel",
] as const;

function nodeTaskId(node: CanvasNodeData | undefined) {
    const taskId = node?.metadata?.taskId;
    return typeof taskId === "string" ? taskId.trim() : "";
}

function ownMetadataString(metadata: CanvasNodeData["metadata"] | undefined, key: string): string | undefined {
    if (!metadata || !Object.prototype.hasOwnProperty.call(metadata, key)) return undefined;
    const value = (metadata as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
}

function nonemptyMediaRef(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function isInFlightGenerationOverlay(node: CanvasNodeData) {
    const status = node.metadata?.status;
    return status === "loading" || status === "error";
}

function remoteHasBoundGenerationResult(node: CanvasNodeData | undefined) {
    const meta = node?.metadata;
    if (!meta || meta.status !== "success") return false;
    return nonemptyMediaRef(meta.content) || nonemptyMediaRef(meta.storageKey) || nonemptyMediaRef(meta.assetId);
}

function hasTrueGenerationContentConflict(base: CanvasNodeData | undefined, local: CanvasNodeData, remote: CanvasNodeData) {
    const localContent = ownMetadataString(local.metadata, "content");
    if (localContent === undefined) return false;
    // loading/error + 空串是恢复 overlay，不是人把已绑定 success 清掉。
    if (!nonemptyMediaRef(localContent) && isInFlightGenerationOverlay(local)) return false;
    const remoteContent = ownMetadataString(remote.metadata, "content") ?? "";
    const baseContent = ownMetadataString(base?.metadata, "content") ?? "";
    return localContent !== remoteContent && localContent !== baseContent;
}

/**
 * 只结算同一任务仍在 loading/error 展示层上的生成字段。
 * 远端必须 status=success 且带有效 media；taskStatus=succeeded 或空 content 不能当已绑定完成。
 * loading/error 上的空 content 是 overlay，不是人类清空，可被远端已绑定 success 结算。
 * 人类写过的非空 content 保留；非 overlay 上的空串按真实编辑保留。
 * 新任务删除 content 键视为正常清旧结果，不同 taskId 不会写回旧 storageKey。
 */
export function settleInFlightGenerationOverlay(input: {
    base: CanvasProject;
    local: CanvasProject;
    remote: CanvasProject;
}): CanvasProject {
    const baseById = new Map((input.base.nodes || []).map((node) => [node.id, node]));
    const remoteById = new Map((input.remote.nodes || []).map((node) => [node.id, node]));
    let changed = false;
    const nodes = (input.local.nodes || []).map((localNode) => {
        const remoteNode = remoteById.get(localNode.id);
        const taskId = nodeTaskId(localNode);
        if (!remoteNode || !taskId || nodeTaskId(remoteNode) !== taskId) return localNode;
        if (!isInFlightGenerationOverlay(localNode) || !remoteHasBoundGenerationResult(remoteNode)) return localNode;
        if (hasTrueGenerationContentConflict(baseById.get(localNode.id), localNode, remoteNode)) return localNode;
        const metadata: CanvasNodeData["metadata"] = { ...(localNode.metadata || {}) };
        const remoteMeta = remoteNode.metadata || {};
        for (const key of GENERATION_BIND_METADATA_KEYS) {
            if (GENERATION_MEDIA_RESULT_KEY_SET.has(key)) {
                const value = remoteMeta[key];
                if (nonemptyMediaRef(value)) {
                    (metadata as Record<string, unknown>)[key] = value;
                }
                continue;
            }
            if (Object.prototype.hasOwnProperty.call(remoteMeta, key) && remoteMeta[key] !== undefined) {
                (metadata as Record<string, unknown>)[key] = remoteMeta[key];
            } else {
                delete (metadata as Record<string, unknown>)[key];
            }
        }
        for (const key of GENERATION_ERROR_METADATA_KEYS) {
            delete (metadata as Record<string, unknown>)[key];
        }
        changed = true;
        return { ...localNode, metadata };
    });
    return changed ? { ...input.local, nodes } : input.local;
}

// 节点级 createdAt/updatedAt 由编辑器在打开和编辑时补写，服务端写入的节点常常没有；
// 它们不是用户编辑，远端删掉的节点不能只因为这两个字段不同就被留下。
function sameNodeIgnoringTimestamps(left: CanvasNodeData, right: CanvasNodeData) {
    const strip = ({ createdAt: _createdAt, updatedAt: _updatedAt, ...rest }: CanvasNodeData) => rest;
    return equal(strip(left), strip(right));
}

function mergeEntityList<T extends { id: string }>(
    base: T[] | undefined,
    local: T[] | undefined,
    remote: T[] | undefined,
    conflict: { value: boolean },
    sameAsBase: (local: T, base: T) => boolean = equal,
): T[] {
    const baseItems = Array.isArray(base) ? base : [];
    const localItems = Array.isArray(local) ? local : [];
    const remoteItems = Array.isArray(remote) ? remote : [];
    const baseById = new Map(baseItems.map((item) => [item.id, item]));
    const localById = new Map(localItems.map((item) => [item.id, item]));
    const remoteById = new Map(remoteItems.map((item) => [item.id, item]));
    const result: T[] = [];
    const seen = new Set<string>();

    const consider = (id: string) => {
        if (!id || seen.has(id)) return;
        seen.add(id);
        const baseItem = baseById.get(id);
        const localItem = localById.get(id);
        const remoteItem = remoteById.get(id);
        if (baseItem && !localItem) {
            if (remoteItem && !equal(remoteItem, baseItem)) conflict.value = true;
            return;
        }
        if (baseItem && !remoteItem) {
            if (localItem && !sameAsBase(localItem, baseItem)) {
                conflict.value = true;
                result.push(localItem);
            }
            return;
        }
        if (localItem && remoteItem) {
            result.push(mergeObject(
                (baseItem || {}) as unknown as Record<string, unknown>,
                localItem as unknown as Record<string, unknown>,
                remoteItem as unknown as Record<string, unknown>,
                conflict,
            ) as unknown as T);
            return;
        }
        if (localItem) {
            result.push(localItem);
            return;
        }
        if (remoteItem) result.push(remoteItem);
    };

    for (const item of localItems) consider(item.id);
    for (const item of remoteItems) consider(item.id);
    return result;
}

/**
 * 以已确认快照为基线的字段级三路合并。
 *
 * 本地相对基线的删除与未冲突编辑保留；服务端相对基线、本地未改的字段（含生成媒体）采纳。
 * 同一字段双方都改过时保留本地可见值并标冲突，不猜胜者。
 */
export function rebaseCanvasDocumentThreeWay(input: {
    base: CanvasProject;
    local: CanvasProject;
    remote: CanvasProject;
}): CanvasDocumentRebaseResult {
    const conflict = { value: false };
    const generic = mergeObject(
        Object.fromEntries(Object.entries(input.base).filter(([key]) => !SKIP_GENERIC_KEYS.has(key))),
        Object.fromEntries(Object.entries(input.local).filter(([key]) => !SKIP_GENERIC_KEYS.has(key))),
        Object.fromEntries(Object.entries(input.remote).filter(([key]) => !SKIP_GENERIC_KEYS.has(key))),
        conflict,
    );
    const project: CanvasProject = {
        ...input.remote,
        ...generic,
        id: input.local.id,
        title: (generic.title as string | undefined) ?? input.local.title,
        nodes: mergeEntityList<CanvasNodeData>(input.base.nodes, input.local.nodes, input.remote.nodes, conflict, sameNodeIgnoringTimestamps),
        connections: mergeEntityList<CanvasConnection>(input.base.connections, input.local.connections, input.remote.connections, conflict),
        chatSessions: mergeEntityList(input.base.chatSessions, input.local.chatSessions, input.remote.chatSessions, conflict),
        viewport: input.local.viewport || input.remote.viewport,
        appearance: input.local.appearance || input.remote.appearance,
        backgroundMode: input.local.backgroundMode || input.remote.backgroundMode,
        showImageInfo: input.local.showImageInfo,
        revision: input.remote.revision,
        updatedAt: input.remote.updatedAt,
        remoteContentHash: input.remote.remoteContentHash,
        createdAt: input.remote.createdAt || input.local.createdAt,
    };
    return { project, conflict: conflict.value };
}
