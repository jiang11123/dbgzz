import type { GenerationTask, TaskStatus } from "@/services/api/task-center";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeTypeId } from "@/types/canvas";

/**
 * 本地工作区不拥有服务端任务队列，因此任务历史从画布节点的本地快照派生。
 * 这让“创作历史”仍然有用，同时避免为了读取历史而重新触发云端请求。
 */
export function localTaskHistoryFromProjects(projects: CanvasProject[]): GenerationTask[] {
    const tasks: GenerationTask[] = [];
    for (const project of projects) {
        for (const node of project.nodes) {
            const metadata = node.metadata;
            const hasGenerationRecord = Boolean(metadata?.taskId || metadata?.prompt || metadata?.generationType || metadata?.taskCreatedAt);
            if (!hasGenerationRecord || node.type === CanvasNodeType.Config) continue;
            const createdAt = metadata?.taskCreatedAt || project.updatedAt || project.createdAt;
            const updatedAt = metadata?.taskUpdatedAt || metadata?.taskCompletedAt || project.updatedAt || createdAt;
            const status = localTaskStatus(metadata?.taskStatus, metadata?.status);
            const taskId = metadata?.taskId || `local:${project.id}:${node.id}`;
            const mode = nodeMode(node.type);
            const previewUrl = localPreviewUrl(metadata?.content);
            const resultJson = localResultJson(node, mode);
            tasks.push({
                id: taskId,
                clientOperationId: metadata?.taskClientOperationId,
                projectId: project.id,
                type: `canvas_${mode}`,
                status,
                progress: metadata?.taskProgress ?? (status === "succeeded" ? 100 : status === "running" ? 50 : undefined),
                stage: metadata?.taskStage,
                prompt: metadata?.prompt || node.title || "未命名本地任务",
                model: metadata?.model,
                provider: metadata?.taskProvider || "local",
                previewUrl,
                previewKind: mode === "video" ? "video" : mode === "image" ? "image" : undefined,
                textDraft: mode === "text" ? metadata?.content : undefined,
                resultJson,
                error: metadata?.errorDetails,
                attempts: 1,
                startedAt: metadata?.taskStartedAt || createdAt,
                completedAt: metadata?.taskCompletedAt || (status === "succeeded" ? updatedAt : undefined),
                createdAt,
                updatedAt,
            });
        }
    }
    return tasks.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
}

function localTaskStatus(taskStatus: unknown, nodeStatus: unknown): TaskStatus {
    if (taskStatus === "queued" || taskStatus === "running" || taskStatus === "succeeded" || taskStatus === "failed" || taskStatus === "cancelled") return taskStatus;
    if (nodeStatus === "success") return "succeeded";
    if (nodeStatus === "error") return "failed";
    if (nodeStatus === "loading") return "running";
    return "queued";
}

function nodeMode(type: CanvasNodeTypeId): "text" | "image" | "video" | "audio" {
    if (type === CanvasNodeType.Image) return "image";
    if (type === CanvasNodeType.Video) return "video";
    if (type === CanvasNodeType.Audio) return "audio";
    return "text";
}

function localResultJson(node: CanvasProject["nodes"][number], mode: ReturnType<typeof nodeMode>) {
    const content = node.metadata?.content;
    if (typeof content !== "string" || !content || mode === "text") return undefined;
    const storageKey = typeof node.metadata?.storageKey === "string" ? node.metadata.storageKey : undefined;
    const bytes = node.metadata?.bytes;
    if (mode === "image") {
        return JSON.stringify({ mode, images: [{ dataUrl: content, url: content, storageKey, width: node.metadata?.naturalWidth || node.width, height: node.metadata?.naturalHeight || node.height, bytes, mimeType: node.metadata?.mimeType || "image/png" }] });
    }
    if (mode === "video") {
        return JSON.stringify({ mode, video: { dataUrl: content, url: content, storageKey, previewUrl: node.metadata?.previewContent || node.metadata?.videoPreview?.content, width: node.metadata?.naturalWidth || node.width, height: node.metadata?.naturalHeight || node.height, durationMs: node.metadata?.durationMs, bytes, mimeType: node.metadata?.mimeType || "video/mp4" } });
    }
    return JSON.stringify({ mode, audio: { dataUrl: content, url: content, storageKey, durationMs: node.metadata?.durationMs, bytes, mimeType: node.metadata?.mimeType || "audio/mpeg", format: node.metadata?.audioFormat } });
}

function localPreviewUrl(value: unknown): string | undefined {
    if (typeof value !== "string" || !value) return undefined;
    return /^(data:|blob:|https?:\/\/)/u.test(value) ? value : undefined;
}
