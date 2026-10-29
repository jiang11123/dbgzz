import { finalizeCanvasAssetHandoff } from "@/lib/canvas/canvas-asset-handoff";
import type { CanvasNodeData } from "@/types/canvas";

import { CanvasOwnerAbandonedError, canvasOwnerCanPersist, canvasOwnerEpochMatches, type CanvasOwnerEpoch } from "./canvas-owner-epoch";

export const CANVAS_HANDOFF_PERSIST_FAILED_MESSAGE = "画布保存失败，请稍后重试";

export function rebaseCreatedCanvasNodes<T extends { id: string }>(live: T[], created: T[]) {
    const createdIds = new Set(created.map((node) => node.id));
    return [...live.filter((node) => !createdIds.has(node.id)), ...created];
}

export function applyArchivedCanvasNodeAssets(
    current: CanvasNodeData[],
    archivedByNodeId: Map<string, { assetId: string; content: unknown; previousAssetId: unknown }>,
) {
    return current.map((node) => {
        const archived = archivedByNodeId.get(node.id);
        if (!archived || node.metadata?.content !== archived.content || node.metadata?.assetId !== archived.previousAssetId) return node;
        return { ...node, metadata: { ...node.metadata, assetId: archived.assetId } };
    });
}

export async function commitOwnedCanvasAssetHandoff<T extends { id: string }>(input: {
    owner: CanvasOwnerEpoch;
    getLiveCanvasId: () => string;
    getLiveUserScope?: () => string;
    getLiveLifetime?: () => number;
    stillOwnsPage?: () => boolean;
    attemptKey?: string;
    getAttemptKey?: () => string;
    searchParams: URLSearchParams;
    createdNodes: T[];
    readLiveNodes: () => T[];
    persist: (nodes: T[]) => Promise<void>;
    consumeUrl: (searchParams: URLSearchParams) => void;
    applyCreated: (createdNodes: T[]) => void;
    resetAttempt: () => void;
    onPersistError?: (error: unknown) => void;
}): Promise<"committed" | "abandoned" | "failed"> {
    const liveUser = () => input.getLiveUserScope?.();
    const liveLifetime = () => input.getLiveLifetime?.();
    const canPersist = () => canvasOwnerCanPersist(input.owner, input.getLiveCanvasId(), liveUser(), liveLifetime());
    if (!canPersist()) return "abandoned";
    const currentNodes = input.readLiveNodes();
    if (!canPersist()) return "abandoned";
    try {
        const finalized = await finalizeCanvasAssetHandoff({
            searchParams: input.searchParams,
            currentNodes,
            createdNodes: input.createdNodes,
            persist: async (nodes) => {
                if (!canPersist()) throw new CanvasOwnerAbandonedError();
                await input.persist(nodes);
            },
        });
        const stillOwns = input.stillOwnsPage
            ? input.stillOwnsPage()
            : canvasOwnerEpochMatches(input.owner, input.getLiveCanvasId(), liveUser(), liveLifetime());
        if (!stillOwns) return "abandoned";
        input.applyCreated(input.createdNodes);
        input.consumeUrl(finalized.searchParams);
        return "committed";
    } catch (error) {
        if (error instanceof CanvasOwnerAbandonedError) return "abandoned";
        if (input.attemptKey === undefined || input.getAttemptKey?.() === input.attemptKey) {
            input.resetAttempt();
        }
        input.onPersistError?.(error);
        return "failed";
    }
}
