import type { CapturedUserScope } from "@/lib/user-scope-guard";
import { http } from "./request";
import type { GenerationTask } from "./task-center";

export type UpscaleMode = "precision" | "generative" | "transparent";
export type UpscaleParams = { resourceId: string; channelId: string; mode: UpscaleMode; model: string; scale: number; outputFormat?: string; enhancementStrength?: "low" | "medium" | "high" };
export type UpscaleCapability = { mediaType: "image" | "video"; mode: UpscaleMode; models: string[]; scales: number[]; outputFormats: string[]; fixedScale?: number };
export type UpscaleCapabilities = { modes: UpscaleCapability[]; cloudProcessing: boolean; maxVideoDurationMs: number };
export type UpscaleEstimate = { mediaType: "image" | "video"; source: { width: number; height: number; durationMs?: number }; output: { width: number; height: number; durationMs?: number }; reservation: number; currency: "CNY"; generationSubmitted: false; cloudProcessing: boolean };
export const UPSCALE_ESTIMATE_TIMEOUT_MS = 120_000;
export const UPSCALE_CREATE_TIMEOUT_MS = 30_000;
export const UPSCALE_RECOVER_TIMEOUT_MS = 60_000;

export const getUpscaleCapabilities = () => http.get<UpscaleCapabilities>("/media-upscale/capabilities");
export const estimateUpscale = (params: UpscaleParams) => http.post<UpscaleEstimate>("/media-upscale/estimate", params, { timeout: UPSCALE_ESTIMATE_TIMEOUT_MS }).then(quote => {
    if (quote.currency !== "CNY" || !Number.isFinite(quote.reservation) || quote.reservation <= 0 || quote.generationSubmitted !== false) throw new Error("超分费用未能确认，请重新获取");
    return quote;
});
export function createUpscaleTask(params: UpscaleParams & { clientOperationId: string; projectId: string; nodeId: string }) {
    return http.post<GenerationTask>("/media-upscale/tasks", params, { timeout: UPSCALE_CREATE_TIMEOUT_MS }).then(task => {
        window.dispatchEvent(new CustomEvent("canvas:task-created", { detail: { task } }));
        return task;
    });
}
export function recoverUpscaleTask(taskId: string, expectedScope?: CapturedUserScope) {
    return http.post<GenerationTask>(`/media-upscale/tasks/${encodeURIComponent(taskId)}/recover`, {}, { expectedScope, timeout: UPSCALE_RECOVER_TIMEOUT_MS }).then(task => {
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("canvas:task-updated", { detail: { task } }));
        return task;
    });
}
export function validUpscaleScale(scale: number, fixedScale?: number) {
    return Number.isInteger(scale) && scale >= 1 && scale <= 4 && (!fixedScale || scale === fixedScale);
}
