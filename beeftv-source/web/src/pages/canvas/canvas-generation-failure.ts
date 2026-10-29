import { explainGenerationError, generationFailureMetadata, generationPromptFingerprint, shouldBlockManualRetry, unchangedModeratedPrompt } from "@/lib/generation-error";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";
import type { GenerationTask } from "@/services/api/task-center";
import { CanvasGenerationTargetSaveError } from "@/services/canvas-generation-errors";
import { generationTaskMetadata } from "@/lib/canvas/canvas-project-generation";
import { attachNodeEffectKey } from "@/services/generation-task-materializer";

type GenerationReference = { id?: string; storageKey?: string; url?: string; dataUrl?: string };
export type CanvasGenerationFailureInput = {
    mode?: "text" | "image" | "video" | "audio";
    prompt: string;
    referenceImages?: GenerationReference[];
    referenceVideos?: GenerationReference[];
    referenceAudios?: GenerationReference[];
    mask?: GenerationReference;
};

function submittedReferences(input: CanvasGenerationFailureInput) {
    if (input.mode === "audio") return [];
    const videos = input.mode === "image" ? [] : input.referenceVideos || [];
    const audios = input.mode === "image" || input.mode === "text" ? [] : input.referenceAudios || [];
    return [...(input.referenceImages || []), ...videos, ...audios, ...(input.mask ? [input.mask] : [])].map((reference) => ({
        id: reference.storageKey || reference.url || reference.dataUrl ? undefined : reference.id,
        // Blob URLs and signed download URLs may change while the stored input stays the same.
        ...(reference.storageKey ? { storageKey: reference.storageKey } : { url: reference.url || reference.dataUrl }),
    }));
}

// 已保存的结果必须先取回，不能再次提交付费生成。
const KEPT_GENERATION_RESULT_CODES = new Set(["canvas_conflict", "download_failed", "result_apply_failed", "result_target_unavailable"]);

export function isKeptGenerationResultCode(code: string | undefined) {
    return Boolean(code && KEPT_GENERATION_RESULT_CODES.has(code));
}

export function canvasGenerationFailureMetadata(error: unknown, input: CanvasGenerationFailureInput) {
    const failure = generationFailureMetadata(error, input.prompt, submittedReferences(input));
    if (failure.generationErrorCode === "result_target_unavailable") return { ...failure, resourceReloadAvailable: false };
    if (error instanceof CanvasGenerationTargetSaveError) return { ...failure, errorDetails: error.message, generationErrorSummary: error.message };
    return { ...failure, ...(isKeptGenerationResultCode(failure.generationErrorCode) ? { resourceReloadAvailable: true } : {}) };
}

export function canvasTaskFailureMetadata(task: GenerationTask, metadata?: CanvasNodeMetadata, error: unknown = { code: task.errorCode, message: task.error || (task.status === "cancelled" ? "任务已取消" : "任务失败") }) {
    let input: CanvasGenerationFailureInput = { prompt: task.prompt || metadata?.prompt || "" };
    try {
        const stored = JSON.parse(task.inputJson || "{}");
        if (stored && typeof stored === "object") {
            const references = (value: unknown): GenerationReference[] => (Array.isArray(value) ? value.filter((item): item is GenerationReference => Boolean(item && typeof item === "object")) : []);
            input = { ...input, referenceImages: references(stored.referenceImages), referenceVideos: references(stored.referenceVideos), referenceAudios: references(stored.referenceAudios), mask: references([stored.mask])[0] };
        }
    } catch {
        // Older task records may not carry a readable submission snapshot.
    }
    const failure = canvasGenerationFailureMetadata(error, input);
    if (failure.failedInputFingerprint && task.id === metadata?.taskId && metadata.failedInputFingerprint) {
        failure.failedInputFingerprint = metadata.failedInputFingerprint;
        failure.failedPromptFingerprint = metadata.failedPromptFingerprint;
    }
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    const diagnostics = task.status === "succeeded" ? { ...task.failureDiagnostics, source: "client_result" as const, executionResult: "completed" as const, summary: cause instanceof Error ? cause.message : failure.generationErrorSummary, stage: "画布应用结果", capturedAt: new Date().toISOString() } : task.failureDiagnostics;
    return { ...failure, taskFailureDiagnostics: diagnostics, taskProviderRequestId: task.providerRequestId };
}

export function canvasGenerationRetryBlocked(metadata: CanvasNodeMetadata | undefined, input?: CanvasGenerationFailureInput) {
    if (metadata?.resourceReloadAvailable) return true;
    const error = { code: metadata?.generationErrorCode || metadata?.taskErrorCode, message: metadata?.errorDetails };
    if (!shouldBlockManualRetry(error, metadata?.taskStage)) return false;
    // Only a resolved submission can prove that moderated input was changed.
    if (input && explainGenerationError(error).moderation) {
        if (!metadata?.failedInputFingerprint) return !metadata?.failedPromptFingerprint || metadata.failedPromptFingerprint === generationPromptFingerprint(input.prompt);
        return unchangedModeratedPrompt(metadata, input.prompt, submittedReferences(input));
    }
    if (input) {
        const category = explainGenerationError(error).category;
        return metadata?.taskStage === "submission_unknown" || isKeptGenerationResultCode(category) || ["submission_uncertain", "timeout", "results_missing", "partial_success"].includes(category);
    }
    return true;
}

export function canvasImageGenerationHasPendingResult(node: CanvasNodeData | undefined, nodes: CanvasNodeData[]) {
    const pending = (item: CanvasNodeData | undefined) => Boolean(imageSubmissionUnknown(item?.metadata) || item?.metadata?.generationErrorCode === "results_missing" || item?.metadata?.resourceReloadAvailable || isKeptGenerationResultCode(item?.metadata?.generationErrorCode));
    return pending(node) || nodes.some((item) => (node?.metadata?.batchChildIds?.includes(item.id) || item.metadata?.generatedFromNodeId === node?.id) && pending(item));
}

export function canvasImagePendingResultMessage(node: CanvasNodeData | undefined, nodes: CanvasNodeData[]) {
    const related = [node, ...nodes.filter((item) => node?.metadata?.batchChildIds?.includes(item.id) || item.metadata?.generatedFromNodeId === node?.id)];
    const unavailable = related.find((item) => item?.metadata?.generationErrorCode === "result_target_unavailable");
    if (unavailable) return explainGenerationError({ code: "result_target_unavailable" }).message;
    if (related.some((item) => imageSubmissionUnknown(item?.metadata))) return "提交结果尚未确认，请查询原任务";
    const missing = related.find((item) => item?.metadata?.generationErrorCode === "results_missing");
    return missing?.metadata?.errorDetails || node?.metadata?.errorDetails || "生成结果已保留，请点击「继续取回」";
}

export function imageSubmissionUnknown(metadata: CanvasNodeMetadata | undefined) {
    return metadata?.generationSubmissionState === "unknown" || metadata?.taskStage === "submission_unknown" || metadata?.generationErrorCode === "submission_uncertain";
}

export function canvasGenerationTaskNodes(nodes: CanvasNodeData[], targetNodeId: string, task: GenerationTask): CanvasNodeData[] {
    return nodes.map((node) => {
        const failed = task.status === "failed" || task.status === "cancelled";
        if (node.id !== targetNodeId && !(failed && node.metadata?.taskId === task.id)) return node;
        const outputIndex = node.metadata?.taskOutputIndex ?? 0;
        const output = task.outputs?.find((item) => item.outputIndex === outputIndex);
        const paused = task.status === "succeeded" && !output?.materializedAssetId && [task.stage, output?.materializationErrorCode].some((code) => code === "delivery_paused" || code === "delivery_timed_out");
        // Videos keep their previous media while the next task runs. A task's
        // success alone cannot identify that retained media as its new output.
        const hasCurrentVideoOutput = node.type !== CanvasNodeType.Video
            || node.metadata?.generationEffectKeys?.includes(attachNodeEffectKey(task.id, node.id, outputIndex))
            || Boolean(output?.materializedAssetId && output.materializedAssetId === node.metadata?.assetId);
        const hasCompletedContent = task.status === "succeeded" && !paused && hasCurrentVideoOutput && (!output || Boolean(output.materializedAssetId)) && Boolean(node.metadata?.content || node.metadata?.storageKey);
        const retainRecovery = task.status === "succeeded" && !hasCompletedContent && Boolean(node.metadata?.resourceReloadAvailable || isKeptGenerationResultCode(node.metadata?.generationErrorCode));
        const targetUnavailable = node.metadata?.generationErrorCode === "result_target_unavailable";
        const failure = paused ? { resourceReloadAvailable: true, generationErrorCode: "download_failed", errorDetails: task.stage === "delivery_timed_out" ? "取回结果已超时，可以继续取回" : "已停止取回，可以继续取回" } : failed ? canvasTaskFailureMetadata(task, node.metadata) : undefined;
        return {
            ...node,
            metadata: {
                ...node.metadata,
                ...generationTaskMetadata(task),
                status: failed || paused || retainRecovery ? "error" : hasCompletedContent ? "success" : "loading",
                ...(failure || (retainRecovery
                    ? { resourceReloadAvailable: !targetUnavailable, generationErrorCode: node.metadata?.generationErrorCode, errorDetails: node.metadata?.errorDetails || (targetUnavailable ? explainGenerationError({ code: "result_target_unavailable" }).message : "生成结果已保留，请点击「继续取回」") }
                    : { errorDetails: undefined, generationErrorCode: undefined, resourceReloadAvailable: undefined, failedPromptFingerprint: undefined, failedInputFingerprint: undefined })),
            },
        };
    });
}
