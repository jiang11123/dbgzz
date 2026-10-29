import { canvasNodeResourceId, canvasNodesMissingResourceAssetBinding } from "@/lib/canvas/canvas-node-asset";
import { assertUserScope, captureUserScope, isUserScopeAbandonedError, type CapturedUserScope } from "@/lib/user-scope-guard";
import type { CanvasNodeAssetResult } from "@/services/project-asset-sync";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

export class CanvasMediaPersistUnconfirmedError extends Error {
    constructor() {
        super("素材还没有保存完成，无法写入画布，请稍后重试");
        this.name = "CanvasMediaPersistUnconfirmedError";
    }
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

function isPersistStop(error: unknown) {
    return isUserScopeAbandonedError(error) || (error instanceof Error && error.name === "AbortError") || error instanceof CanvasMediaPersistUnconfirmedError;
}

export type PersistOwnedCanvasMediaNodesInput = {
    canvasId: string;
    domainProjectId?: string;
    mediaNodes: CanvasNodeData[];
    mediaConnections?: CanvasConnection[];
    expectedScope?: CapturedUserScope;
    signal?: AbortSignal;
};

export type PersistOwnedCanvasMediaNodesStore = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
};

export type PersistOwnedCanvasMediaNodesDeps = {
    ensureCanvasNodeAsset: (options: {
        canvasId: string;
        domainProjectId?: string;
        node: CanvasNodeData;
        source: "canvas-manual";
        signal?: AbortSignal;
        expectedScope?: CapturedUserScope;
    }) => Promise<CanvasNodeAssetResult>;
    getStoredProject: (canvasId: string) => PersistOwnedCanvasMediaNodesStore | undefined;
    hasProject: (canvasId: string) => boolean;
    openProject?: (canvasId: string, expectedScope: CapturedUserScope) => Promise<unknown>;
    updateProject: (canvasId: string, patch: PersistOwnedCanvasMediaNodesStore) => void;
    flushPersistence: (expectedScope: CapturedUserScope) => Promise<void>;
    syncSnapshot?: (canvasId: string, patch: PersistOwnedCanvasMediaNodesStore, expectedScope: CapturedUserScope) => Promise<unknown>;
    readSavedProject?: (canvasId: string, expectedScope: CapturedUserScope) => Promise<{ nodes: CanvasNodeData[] } | undefined>;
    setNodes: (updater: (current: CanvasNodeData[]) => CanvasNodeData[]) => void;
    getLiveProjectId: () => string;
    getLiveNodes: () => CanvasNodeData[];
    getLiveConnections: () => CanvasConnection[];
    isLocalWorkspace: () => boolean;
    warn?: (message: string) => void;
    error?: (message: string) => void;
};

export async function persistOwnedCanvasMediaNodes(
    input: PersistOwnedCanvasMediaNodesInput,
    deps: PersistOwnedCanvasMediaNodesDeps,
): Promise<Map<string, string>> {
    const expected = input.expectedScope ?? captureUserScope();
    const originalProjectId = input.canvasId;
    const mediaConnections = input.mediaConnections ?? [];
    const assetIds = new Map<string, string>();

    const assertPersistOwnership = () => {
        throwIfAborted(input.signal);
        assertUserScope(expected);
        if (deps.getLiveProjectId() !== originalProjectId) {
            throw new DOMException("Aborted", "AbortError");
        }
    };

    const persistAsset = async (node: CanvasNodeData, required: boolean) => {
        assertPersistOwnership();
        try {
            const result = await deps.ensureCanvasNodeAsset({
                canvasId: originalProjectId,
                domainProjectId: input.domainProjectId,
                node,
                source: "canvas-manual",
                signal: input.signal,
                expectedScope: expected,
            });
            assertPersistOwnership();
            if (!result.confirmed) throw new CanvasMediaPersistUnconfirmedError();
            assetIds.set(node.id, result.assetId);
            return result.assetId;
        } catch (error) {
            if (isPersistStop(error)) throw error;
            assertPersistOwnership();
            const details = error instanceof Error ? error.message : "未知错误";
            if (required) {
                deps.warn?.(`已有媒体节点尚未完成素材库绑定，无法保存本次结果：${details}`);
                throw error;
            }
            deps.warn?.(`媒体节点已创建，但素材库写入失败：${details}`);
            return undefined;
        }
    };

    for (const mediaNode of input.mediaNodes) {
        await persistAsset(mediaNode, false);
    }

    assertPersistOwnership();
    const latestNodes = new Map(deps.getLiveNodes().map((node) => [node.id, node]));
    const storedProject = deps.getStoredProject(originalProjectId);
    for (const node of storedProject?.nodes || []) {
        if (!latestNodes.has(node.id)) latestNodes.set(node.id, node);
    }
    for (const mediaNode of input.mediaNodes) {
        const assetId = assetIds.get(mediaNode.id);
        latestNodes.set(mediaNode.id, assetId ? { ...mediaNode, metadata: { ...mediaNode.metadata, assetId } } : mediaNode);
    }
    for (const [id, node] of latestNodes.entries()) {
        if (node.metadata?.assetId) continue;
        const primaryId = node.metadata?.isBatchRoot ? node.metadata.primaryImageId : undefined;
        const primaryNode = primaryId ? latestNodes.get(primaryId) : undefined;
        const primaryAssetId = primaryId ? (assetIds.get(primaryId) || primaryNode?.metadata?.assetId) : undefined;
        const rootResourceId = canvasNodeResourceId(node);
        const primaryResourceId = primaryNode ? canvasNodeResourceId(primaryNode) : "";
        if (primaryAssetId && rootResourceId && primaryResourceId && rootResourceId === primaryResourceId) {
            assetIds.set(id, primaryAssetId);
            latestNodes.set(id, { ...node, metadata: { ...node.metadata, assetId: primaryAssetId } });
        }
    }

    for (const node of canvasNodesMissingResourceAssetBinding([...latestNodes.values()])) {
        const assetId = await persistAsset(node, true);
        if (assetId) latestNodes.set(node.id, { ...node, metadata: { ...node.metadata, assetId } });
    }

    assertPersistOwnership();
    if (assetIds.size > 0) {
        deps.setNodes((current) => current.map((item) => {
            const assetId = assetIds.get(item.id);
            return assetId ? { ...item, metadata: { ...item.metadata, assetId } } : item;
        }));
    }

    assertPersistOwnership();
    if (!deps.hasProject(originalProjectId) && deps.isLocalWorkspace()) {
        await deps.openProject?.(originalProjectId, expected);
        assertPersistOwnership();
    }
    if (!deps.hasProject(originalProjectId)) {
        throw new Error("当前画布未载入本地项目库，无法保存媒体结果");
    }

    assertPersistOwnership();
    const storedAfterOpen = deps.getStoredProject(originalProjectId);
    const latestConnections = new Map((storedAfterOpen?.connections || []).map((connection) => [connection.id, connection]));
    for (const connection of deps.getLiveConnections()) latestConnections.set(connection.id, connection);
    for (const connection of mediaConnections) latestConnections.set(connection.id, connection);
    const snapshot = { nodes: [...latestNodes.values()], connections: [...latestConnections.values()] };
    deps.updateProject(originalProjectId, snapshot);
    try {
        assertPersistOwnership();
        await deps.flushPersistence(expected);
        assertPersistOwnership();
        if (deps.isLocalWorkspace()) {
            await deps.syncSnapshot?.(originalProjectId, snapshot, expected);
            assertPersistOwnership();
            const saved = await deps.readSavedProject?.(originalProjectId, expected);
            assertPersistOwnership();
            if (!saved || input.mediaNodes.some((node) => !saved.nodes.some((savedNode) => savedNode.id === node.id))) {
                throw new Error("本地项目库回读校验未包含刚生成的媒体节点");
            }
        }
    } catch (error) {
        if (isPersistStop(error)) throw error;
        assertPersistOwnership();
        deps.error?.(`媒体结果已生成，但本地画布保存失败：${error instanceof Error ? error.message : "未知错误"}`);
        throw error;
    }
    return assetIds;
}
