import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

/** Only explicit processing provenance can become a replayable operation. */
export function canvasProcessingRecipe(node: CanvasNodeData): CanvasNodeMetadata["workflowOperation"] {
    const m = node.metadata;
    if (!m || m.status === "loading") return;
    if (m.workflowOperation?.id.endsWith(".ai-upscale")) {
        const source = m.workflowOperation;
        const config = source.config;
        return { ...source, config: { channelId:String(config.channelId || ""), preset:`${config.mode}|${config.model}`, scale:Number(config.scale || 2), outputFormat:String(config.outputFormat || (node.type === "video" ? "mp4" : "png")) }, inputs:source.inputs.filter(input => input.port !== "processor") };
    }
    if (m.workflowOperation) return m.workflowOperation;
    const single = (id: string, source: string, port: string, config: Record<string, number>) => ({ id, version: 1, config, inputs: [{ nodeId: source, port }] });
    if (m.videoFrameSourceNodeId && typeof m.videoFrameTimeMs === "number") return single("video.frame", m.videoFrameSourceNodeId, "video", { seconds: m.videoFrameTimeMs / 1000 });
    if (m.videoTrimSourceNodeId && typeof m.videoTrimStartMs === "number" && typeof m.videoTrimEndMs === "number") return single("video.trim", m.videoTrimSourceNodeId, "video", { startSeconds: m.videoTrimStartMs / 1000, endSeconds: m.videoTrimEndMs / 1000 });
    if (m.videoMergeSourceNodeIds?.length) return { id: "video.merge", version: 1, config: {}, inputs: m.videoMergeSourceNodeIds.map((nodeId, order) => ({ nodeId, port: "videos", order })) };
}
