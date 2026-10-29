import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import type { UpscaleMode, UpscaleParams } from "@/services/api/media-upscale";

export type CanvasUpscaleSettings = {
    channelId: string;
    scale: number;
    image: { mode: UpscaleMode; model: string; outputFormat: string; enhancementStrength?: "low" | "medium" | "high" };
    video: { mode: UpscaleMode; model: string };
};
export type CanvasUpscaleBatchItem = {
    sourceNodeId: string; sourceTitle: string; mediaType: "image" | "video";
    outputNodeId: string; clientOperationId: string;
    status: "waiting" | "submitting" | "accepted" | "rejected" | "unknown";
    taskId?: string; error?: string;
    reservation?: number; quotedAt?: number;
    /** Frozen request: resuming a waiting item must not adopt edited settings. */
    params?: UpscaleParams;
};
export type CanvasUpscaleBatch = { id: string; createdAt: number; items: CanvasUpscaleBatchItem[] };
export function createDefaultUpscaleSettings(channelId = "beefapi"): CanvasUpscaleSettings {
    return { channelId, scale: 2, image: { mode: "precision", model: "Standard V2", outputFormat: "png" }, video: { mode: "precision", model: "Proteus" } };
}
export function getUpscaleInputNodes(processorId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): CanvasNodeData[] {
    const ids = new Set(connections.filter(c => c.toNodeId === processorId).map(c => c.fromNodeId));
    return nodes.filter(n => ids.has(n.id) && (n.type === CanvasNodeType.Image || n.type === CanvasNodeType.Video) && n.metadata?.status !== "loading" && Boolean(n.metadata?.storageKey || n.metadata?.content));
}
export function upscaleParamsForNode(settings: CanvasUpscaleSettings, node: CanvasNodeData, resourceId: string): UpscaleParams {
    const config = node.type === CanvasNodeType.Video ? settings.video : settings.image;
    return { resourceId, channelId: settings.channelId, scale: config.mode === "transparent" ? 4 : settings.scale, ...config };
}
export function getUpscaleOutputPosition(processor: CanvasNodeData, index: number, nodes: CanvasNodeData[] = [], bounds = { width: 320, height: 320 }) {
    const x = processor.position.x + processor.width + 96;
    let y = processor.position.y + index * 360;
    while (nodes.some(n => n.position.x < x + bounds.width && n.position.x + n.width > x && n.position.y < y + bounds.height && n.position.y + n.height > y)) y += 360;
    return { x, y };
}
export function deriveUpscaleBatchState(batch: CanvasUpscaleBatch | undefined, nodes: CanvasNodeData[]) {
    const counts = { total: batch?.items.length ?? 0, waiting: 0, active: 0, succeeded: 0, failed: 0, unknown: 0 };
    for (const item of batch?.items ?? []) {
        const output = nodes.find(n => n.id === item.outputNodeId)?.metadata;
        if (output?.taskStatus === "succeeded" && (output.content || output.storageKey)) counts.succeeded++;
        else if (item.status === "rejected" || output?.taskStatus === "failed" || output?.taskStatus === "cancelled") counts.failed++;
        else if (item.status === "unknown" || item.status === "submitting") counts.unknown++;
        else if (item.status === "waiting") counts.waiting++;
        else counts.active++;
    }
    return { ...counts, running: counts.waiting + counts.active + counts.unknown > 0, complete: counts.total > 0 && counts.succeeded + counts.failed === counts.total };
}
