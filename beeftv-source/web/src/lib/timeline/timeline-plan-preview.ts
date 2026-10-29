import { ApiError } from "@/services/api/request";

export const RENDER_PLAN_PREVIEW_DEBOUNCE_MS = 600;

export function isIgnorablePlanPreviewError(error: unknown, signal?: AbortSignal): boolean {
    if (signal?.aborted) return true;
    if (error instanceof DOMException && error.name === "AbortError") return true;
    if (error instanceof Error && error.name === "AbortError") return true;
    return error instanceof ApiError && error.status === 429;
}
