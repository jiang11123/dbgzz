import { http, type HttpRequestConfig } from "@/services/api/request";
import type { GenerationTask } from "@/services/api/task-center";

export type DepthCaptureCreateRequest = { projectId?: string; nodeId?: string; resourceId: string; clientOperationId?: string };
export type DepthCaptureResult = { resourceId: string; fileName: string; size: number; durationMs: number; width: number; height: number; fps?: number };

export function createDepthCaptureTask(payload: DepthCaptureCreateRequest, config?: HttpRequestConfig) {
    return http.post<GenerationTask>("/depth-captures", payload, config);
}
