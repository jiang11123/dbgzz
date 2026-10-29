import { canvasOwnerEpochMatches, type CanvasOwnerEpoch, type CanvasOwnerLifetime } from "@/pages/canvas/canvas-owner-epoch";
import { captureUserScope, isUserScopeAbandonedError, userScopeMatches, type CapturedUserScope } from "@/lib/user-scope-guard";
import type { CanvasNodeAssetResult, EnsureCanvasNodeAssetOptions } from "@/services/project-asset-sync";
import type { CanvasNodeData } from "@/types/canvas";

export type OwnedCanvasUploadGuard = {
    expectedScope: CapturedUserScope;
    owner: CanvasOwnerEpoch;
    signal: AbortSignal;
    abort: () => void;
    alive: () => boolean;
    suppress: (error?: unknown) => boolean;
};

export type PersistOwnedCanvasUploadNodeInput = {
    owner: CanvasOwnerEpoch;
    expectedScope: CapturedUserScope;
    getLiveCanvasId: () => string;
    getLiveLifetime?: () => number;
    mounted?: () => boolean;
    canvasId: string;
    domainProjectId?: string;
    node: CanvasNodeData;
    signal?: AbortSignal;
    source?: EnsureCanvasNodeAssetOptions["source"];
    category?: EnsureCanvasNodeAssetOptions["category"];
};

export type PersistOwnedCanvasUploadNodeResult = {
    applied: boolean;
    confirmed: boolean;
    assetId?: string;
    linkedToProject?: boolean;
    error?: unknown;
};

export type PersistOwnedCanvasUploadNodeDeps = {
    ensureCanvasNodeAsset: (options: EnsureCanvasNodeAssetOptions) => Promise<CanvasNodeAssetResult>;
    setNodes: (updater: (current: CanvasNodeData[]) => CanvasNodeData[]) => void;
    nodesRef?: { current: CanvasNodeData[] };
    invalidateProject?: (projectId: string) => Promise<void>;
    warn?: (message: string) => void;
};

function isAbortError(error: unknown) {
    return error instanceof Error && error.name === "AbortError";
}

export function isOwnedCanvasUploadStop(error: unknown) {
    return isUserScopeAbandonedError(error) || isAbortError(error);
}

export function ownedCanvasUploadMatches(input: {
    owner: CanvasOwnerEpoch;
    liveCanvasId: string;
    expectedScope: CapturedUserScope;
    liveLifetime?: number;
    mounted?: boolean;
    signal?: AbortSignal;
}) {
    if (input.mounted === false) return false;
    if (input.signal?.aborted) return false;
    return canvasOwnerEpochMatches(input.owner, input.liveCanvasId, undefined, input.liveLifetime)
        && userScopeMatches(input.expectedScope);
}

export function shouldSuppressOwnedCanvasCallback(
    error: unknown | undefined,
    input: {
        owner: CanvasOwnerEpoch;
        liveCanvasId: string;
        expectedScope: CapturedUserScope;
        liveLifetime?: number;
        mounted?: boolean;
        signal?: AbortSignal;
    },
) {
    if (!ownedCanvasUploadMatches(input)) return true;
    if (error === undefined) return false;
    return isOwnedCanvasUploadStop(error);
}

export function createOwnedCanvasUploadGuard(input: {
    lifetime: CanvasOwnerLifetime;
    canvasId: string;
    getLiveCanvasId: () => string;
    expectedScope?: CapturedUserScope;
    mounted?: () => boolean;
}): OwnedCanvasUploadGuard {
    const expectedScope = input.expectedScope ?? captureUserScope();
    const owner = input.lifetime.capture(input.canvasId);
    const controller = new AbortController();
    const alive = () => {
        const matches = ownedCanvasUploadMatches({
            owner,
            liveCanvasId: input.getLiveCanvasId(),
            expectedScope,
            liveLifetime: input.lifetime.current(),
            mounted: input.mounted?.(),
            signal: controller.signal,
        });
        if (!matches) controller.abort();
        return matches;
    };
    return {
        expectedScope,
        owner,
        signal: controller.signal,
        abort: () => controller.abort(),
        alive,
        suppress(error) {
            if (!alive()) return true;
            return error !== undefined && isOwnedCanvasUploadStop(error);
        },
    };
}

export async function persistOwnedCanvasUploadNode(
    input: PersistOwnedCanvasUploadNodeInput,
    deps: PersistOwnedCanvasUploadNodeDeps,
): Promise<PersistOwnedCanvasUploadNodeResult> {
    const abandoned: PersistOwnedCanvasUploadNodeResult = { applied: false, confirmed: false };
    const stillOwned = () => ownedCanvasUploadMatches({
        owner: input.owner,
        liveCanvasId: input.getLiveCanvasId(),
        expectedScope: input.expectedScope,
        liveLifetime: input.getLiveLifetime?.(),
        mounted: input.mounted?.(),
        signal: input.signal,
    });
    if (!stillOwned()) return abandoned;
    try {
        const result = await deps.ensureCanvasNodeAsset({
            canvasId: input.owner.canvasId,
            domainProjectId: input.domainProjectId,
            node: input.node,
            source: input.source ?? "canvas-upload",
            category: input.category,
            signal: input.signal,
            expectedScope: input.expectedScope,
        });
        if (!stillOwned()) return { ...abandoned, assetId: result.assetId };
        const stampAssetId = (current: CanvasNodeData[]) => current.map((item) => (
            item.id === input.node.id
                ? { ...item, metadata: { ...item.metadata, assetId: result.assetId } }
                : item
        ));
        if (deps.nodesRef) {
            deps.nodesRef.current = stampAssetId(deps.nodesRef.current);
        }
        deps.setNodes((current) => {
            if (!stillOwned()) return current;
            const next = stampAssetId(current);
            if (deps.nodesRef) deps.nodesRef.current = next;
            return next;
        });
        if (result.confirmed && input.domainProjectId) {
            await deps.invalidateProject?.(input.domainProjectId);
            if (!stillOwned()) return { applied: true, confirmed: false, assetId: result.assetId, linkedToProject: result.linkedToProject };
        }
        return { applied: true, confirmed: result.confirmed, assetId: result.assetId, linkedToProject: result.linkedToProject };
    } catch (error) {
        if (shouldSuppressOwnedCanvasCallback(error, {
            owner: input.owner,
            liveCanvasId: input.getLiveCanvasId(),
            expectedScope: input.expectedScope,
            liveLifetime: input.getLiveLifetime?.(),
            mounted: input.mounted?.(),
            signal: input.signal,
        })) {
            return abandoned;
        }
        deps.warn?.(error instanceof Error ? `媒体已添加到画布，但素材同步失败：${error.message}` : "媒体已添加到画布，但素材同步失败");
        return { ...abandoned, error };
    }
}
