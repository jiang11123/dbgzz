import { describe, expect, it } from "bun:test";

import { drawingEngineForNode } from "../src/lib/canvas/canvas-drawing-engine";
import { summarizeCanvasDrawing } from "../src/lib/canvas/canvas-drawing-storage";

describe("canvas drawing engines", () => {
    it("uses Excalidraw for drawings without an explicit engine", () => {
        expect(drawingEngineForNode({ metadata: {} } as never)).toBe("excalidraw");
        expect(drawingEngineForNode({ metadata: { drawingEngine: "excalidraw" } } as never)).toBe("excalidraw");
    });

    it("summarizes Excalidraw elements without deleted records", () => {
        expect(summarizeCanvasDrawing("excalidraw", {
            elements: [{ id: "visible", isDeleted: false }, { id: "deleted", isDeleted: true }],
        })).toEqual({ shapeCount: 1, pageCount: 1 });
    });
});
