import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";
import type { GenerationTask } from "@/services/api/task-center";

// A stopped observer says nothing about the paid task's execution state.
export const UPSCALE_OBSERVATION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export function isAIUpscaleTask(task: Pick<GenerationTask, "type" | "model">): boolean {
    return (task.type === "canvas_image" && ["topaz-standard-v2", "topaz-wonder-3.5"].includes(task.model || "")) ||
        (task.type === "canvas_video" && ["topaz-proteus", "topaz-starlight-fast-2"].includes(task.model || ""));
}

export function hasPendingUpscaleTask(metadata?: CanvasNodeMetadata): boolean {
    if (!metadata) return false;
    // Only a failure before calling the task API proves that no paid task exists.
    if (metadata.generationSubmissionState === "rejected" && !metadata.taskId) return false;
    if (metadata.taskStatus === "succeeded") return !metadata.content && !metadata.storageKey;
    if (metadata.taskId || metadata.taskClientOperationId) return true;
    return metadata.generationSubmissionState === "unknown" || metadata.generationSubmissionState === "submitting";
}

export function upscaleObservationFailureMetadata(task: Pick<GenerationTask, "id" | "status">, errorDetails: string): Partial<CanvasNodeMetadata> {
    const terminal = task.status === "failed" || task.status === "cancelled" || task.status === "succeeded";
    return {
        taskId: task.id,
        taskStatus: task.status,
        status: terminal ? "error" : "loading",
        ...(terminal ? {
            errorDetails: task.status === "succeeded" ? `云端已完成，结果暂未载入。请从任务详情取回结果，或重新打开画布恢复。${errorDetails}` : `请先在任务详情核对原任务与扣费状态，暂勿重复提交。${errorDetails}`,
            ...(task.status === "succeeded" ? { resourceReloadAvailable: true } : {}),
        } : {
            processingLabel: "超分任务状态待确认",
            taskStage: "状态同步中断，请重新打开画布查询",
            errorDetails: "暂时无法同步进度，云端任务可能仍在处理。请重新打开画布查询，暂勿重复提交。",
        }),
    };
}

export function canRecoverUpscaleNode(node: CanvasNodeData): boolean {
    const metadata = node.metadata;
    return Boolean(metadata?.workflowOperation?.id.endsWith(".ai-upscale") && metadata.taskId &&
        (metadata.status === "error" || metadata.taskStatus === "failed" || (metadata.taskStatus === "succeeded" && !metadata.content && !metadata.storageKey)));
}
