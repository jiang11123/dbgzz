import type { CanvasNodeData } from "@/types/canvas";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { getDiagnosticTraceId, recordDiagnosticEvent } from "./client-diagnostics";

export function canvasNodeDiagnosticContext(node: CanvasNodeData) {
    const candidates = useCanvasStore.getState().projects.filter(project => project.nodes.some(item => item.id === node.id && item.metadata?.taskId === node.metadata?.taskId));
    return { nodeId: node.id, taskId: node.metadata?.taskId, clientOperationId: node.metadata?.taskClientOperationId, canvasId: candidates.length === 1 ? candidates[0].id : undefined, traceId: getDiagnosticTraceId(node.metadata?.taskId) };
}

export function recordCanvasVideoDiagnostic(node: CanvasNodeData, phase: "load_requested" | "metadata_loaded" | "first_frame" | "playback_failed" | "source_failed" | "load_stalled", video?: HTMLVideoElement | null) {
    recordDiagnosticEvent({
        ...canvasNodeDiagnosticContext(node), category: "runtime", level: phase.endsWith("failed") ? "error" : phase === "load_stalled" ? "warning" : "info",
        code: `canvas_video_${phase}`, message: `画布视频：${phase}`,
        media: { phase, readyState: video?.readyState, networkState: video?.networkState, errorCode: video?.error?.code, width: video?.videoWidth, height: video?.videoHeight },
    });
}
