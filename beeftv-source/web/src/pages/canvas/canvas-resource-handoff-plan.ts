import type { InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { canvasAssetHandoffAttempt, consumeCanvasAssetHandoff, uninsertedCanvasAssetHandoffPayloads } from "@/lib/canvas/canvas-asset-handoff";
import type { Asset } from "@/stores/use-asset-store";
import type { CanvasFolderStyle, CanvasFolderTheme } from "@/types/canvas";

export type CanvasAssetHandoffPlan =
    | { kind: "idle" }
    | { kind: "wait"; key: string }
    | { kind: "commit"; key: string; payloads: InsertAssetPayload[] };

export type CanvasHandoffEffectDecision =
    | { kind: "idle" }
    | { kind: "consume-foreign"; searchParams: URLSearchParams }
    | { kind: "wait"; key: string }
    | { kind: "blocked-until-retry"; key: string }
    | { kind: "commit"; key: string; payloads: InsertAssetPayload[] };

export function canStartCanvasHandoffAttempt(input: {
    planKey: string;
    currentAttemptKey: string;
    failedKey: string;
    retryNonce: number;
    nonceAtFail: number;
}) {
    if (input.currentAttemptKey === input.planKey) return false;
    if (input.failedKey === input.planKey && input.retryNonce === input.nonceAtFail) return false;
    return true;
}

export function requestCanvasHandoffRetry(state: { nonce: number }) {
    return { nonce: state.nonce + 1 };
}

/**
 * Decide whether the handoff effect should start, wait for a user retry, or
 * drop an intent that now belongs to a different account. Clearing the attempt
 * ref alone must not restart a failed persist.
 */
export function planCanvasHandoffEffect(input: {
    plan: CanvasAssetHandoffPlan;
    searchParams: URLSearchParams;
    ownerUserScope: string | null;
    liveUserScope: string;
    currentAttemptKey: string;
    failedKey: string;
    retryNonce: number;
    nonceAtFail: number;
}): CanvasHandoffEffectDecision {
    if (input.ownerUserScope && input.ownerUserScope !== input.liveUserScope && input.searchParams.get("mode") === "handoff") {
        return { kind: "consume-foreign", searchParams: consumeCanvasAssetHandoff(input.searchParams) };
    }
    if (input.plan.kind === "idle") return { kind: "idle" };
    if (input.plan.kind === "wait") return { kind: "wait", key: input.plan.key };
    if (!canStartCanvasHandoffAttempt({
        planKey: input.plan.key,
        currentAttemptKey: input.currentAttemptKey,
        failedKey: input.failedKey,
        retryNonce: input.retryNonce,
        nonceAtFail: input.nonceAtFail,
    })) {
        return { kind: "blocked-until-retry", key: input.plan.key };
    }
    return { kind: "commit", key: input.plan.key, payloads: input.plan.payloads };
}

export function canvasAssetHandoffReadiness(assetIds: readonly string[], assets: Asset[]) {
    return assetIds
        .map((assetId) => {
            const asset = assets.find((candidate) => candidate.id === assetId);
            return `${assetId}:${asset?.kind || "missing"}`;
        })
        .join("|");
}

export function resolveCanvasAssetHandoffPlan(input: {
    projectLoaded: boolean;
    assetsHydrated: boolean;
    mode: string | null;
    projectId: string;
    assets: Asset[];
    searchParams: URLSearchParams;
    currentKey: string;
    nodes: Iterable<{ metadata?: { assetId?: unknown } }>;
}): CanvasAssetHandoffPlan {
    if (!input.projectLoaded || !input.assetsHydrated || input.mode !== "handoff") return { kind: "idle" };
    const attempt = canvasAssetHandoffAttempt(input.assets, input.searchParams);
    if (!attempt.assetIds.length) return { kind: "idle" };
    const key = `${input.projectId}:${canvasAssetHandoffReadiness(attempt.assetIds, input.assets)}`;
    if (input.currentKey === key) return { kind: "idle" };
    if (attempt.kind === "retry") return { kind: "wait", key };
    return {
        kind: "commit",
        key,
        payloads: uninsertedCanvasAssetHandoffPayloads(input.nodes, attempt.payloads),
    };
}

export function linkedFolderPresentation(folder: { style?: string; theme?: string }): { style: CanvasFolderStyle; theme: CanvasFolderTheme } {
    const style: CanvasFolderStyle = folder.style === "stacked" || folder.style === "midnight" || folder.style === "paper" || folder.style === "cinema" || folder.style === "compact" ? folder.style : "glass";
    const theme: CanvasFolderTheme = folder.theme === "obsidian" || folder.theme === "ember" || folder.theme === "pearl" ? folder.theme : "aurora";
    return { style, theme };
}
