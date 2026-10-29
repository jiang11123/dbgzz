import type { CanvasNodeData } from "@/types/canvas";

export type CanvasDrawingEngine = "excalidraw";

export const DEFAULT_DRAWING_ENGINE: CanvasDrawingEngine = "excalidraw";

export function drawingEngineForNode(node?: Pick<CanvasNodeData, "metadata"> | null): CanvasDrawingEngine {
    void node;
    return DEFAULT_DRAWING_ENGINE;
}

export function drawingEngineLabel(engine: CanvasDrawingEngine) {
    void engine;
    return "Excalidraw";
}
