import { describe, expect, test } from "bun:test";
import { createDefaultUpscaleSettings, deriveUpscaleBatchState, getUpscaleInputNodes, getUpscaleOutputPosition, upscaleParamsForNode, type CanvasUpscaleBatch } from "../src/lib/canvas/canvas-upscale";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
const node = (id: string, type = CanvasNodeType.Image): CanvasNodeData => ({ id, type, title: id, position: { x: 0, y: 0 }, width: 320, height: 280, metadata: { storageKey: "owned" } });
describe("upscale batch contract", () => {
    test("defaults are independent and transparent fixes scale", () => {
        const a = createDefaultUpscaleSettings("channel"); a.image.mode = "transparent";
        expect(createDefaultUpscaleSettings().image.mode).toBe("precision");
        expect(upscaleParamsForNode(a, node("image"), "resource").scale).toBe(4);
        expect(upscaleParamsForNode(a, node("video", CanvasNodeType.Video), "resource").model).toBe("Proteus");
    });
    test("only ready direct media inputs, deduplicated", () => {
        const a = node("a"), b = node("b", CanvasNodeType.Video), c = node("c"); c.metadata = { status: "loading", content: "x" };
        const links = ["a", "a", "c"].map((id, i) => ({ id: String(i), fromNodeId: id, toNodeId: "processor" }));
        expect(getUpscaleInputNodes("processor", [a, b, c], links).map(n => n.id)).toEqual(["a"]);
    });
    test("layout is stable and skips existing results", () => {
        const p = node("p"); const first = getUpscaleOutputPosition(p, 0);
        expect(getUpscaleOutputPosition(p, 0)).toEqual(first);
        expect(getUpscaleOutputPosition(p, 0, [{ ...node("old"), position: first }]).y).toBeGreaterThan(first.y);
    });
    test("task terminal status is distinct from submission acceptance", () => {
        const batch: CanvasUpscaleBatch = { id: "batch", createdAt: 1, items: [{ sourceNodeId: "a", sourceTitle: "a", mediaType: "image", outputNodeId: "output", clientOperationId: "op", status: "accepted" }] };
        expect(deriveUpscaleBatchState(batch, []).active).toBe(1);
        const output = node("output"); output.metadata = { taskStatus: "failed" };
        expect(deriveUpscaleBatchState(batch, [output]).failed).toBe(1);
        output.metadata = { taskStatus: "succeeded", storageKey: "owned" };
        expect(deriveUpscaleBatchState(batch, [output]).succeeded).toBe(1);
    });
});
