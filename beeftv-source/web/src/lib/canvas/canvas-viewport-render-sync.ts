import type { ViewportTransform } from "@/types/canvas";

export const CANVAS_VIRTUALIZATION_REFRESH_INTERVAL_MS = 64;

export function shouldRefreshCanvasVirtualization(rendered: ViewportTransform, next: ViewportTransform, lastRefreshAt: number, now: number) {
    if (rendered.x === next.x && rendered.y === next.y && rendered.k === next.k) return false;
    return now - lastRefreshAt >= CANVAS_VIRTUALIZATION_REFRESH_INTERVAL_MS;
}
