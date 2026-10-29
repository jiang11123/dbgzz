import type { GenerationTask } from "@/services/api/task-center";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { ApiError } from "@/services/api/request";
import { getDiagnosticTraceId, recordDiagnosticEvent, sanitizeCanvasBindingEvidence } from "./client-diagnostics";

export function recordCanvasBindingDiagnostic(input: {
    phase: "requested" | "refused" | "confirmed";
    canvasId: string;
    nodeId: string;
    outputIndex: number;
    task: GenerationTask;
    project?: CanvasProject;
    error?: unknown;
}) {
    const node = input.project?.nodes.find((node) => node.id === input.nodeId);
    const metadata = node?.metadata;
    const server = input.error instanceof ApiError ? sanitizeCanvasBindingEvidence(input.error.details?.canvasBinding) : undefined;
    recordDiagnosticEvent({
        category: "task", level: input.phase === "refused" ? "error" : "info",
        code: `generation_bind_${input.phase}`, message: `画布结果绑定：${input.phase}`,
        canvasId: input.canvasId, taskId: input.task.id,
        nodeId: input.nodeId, clientOperationId: input.task.clientOperationId,
        traceId: input.task.traceId || getDiagnosticTraceId(input.task.id),
        reason: input.error instanceof ApiError ? input.error.reason : undefined,
        requestId: input.error instanceof ApiError ? input.error.requestId : undefined,
        canvasBinding: server ? { ...server, clientOperationId: input.task.clientOperationId } : {
            source: "client", nodeId: input.nodeId, outputIndex: input.outputIndex,
            clientOperationId: input.task.clientOperationId, nodeTaskId: metadata?.taskId,
            nodeClientOperationId: metadata?.taskClientOperationId, nodeType: node?.type,
            nodeStatus: metadata?.status, revision: input.project?.revision, nodePresent: input.project ? Boolean(node) : undefined,
            nodeHasMedia: node ? [node, metadata].some((fields) => {
                if (!fields) return false;
                const values = fields as Record<string, unknown>;
                return ["storageKey", "assetId", "resourceId"].some((key) => Boolean(values[key]))
                    || ["content", "url", "dataUrl"].some((key) => typeof values[key] === "string" && /^(https?:|data:|blob:|resource:|\/api\/resources\/)/i.test(values[key] as string));
            }) : undefined,
        },
    });
}
