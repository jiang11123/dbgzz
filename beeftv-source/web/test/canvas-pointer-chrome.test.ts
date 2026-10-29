import { expect, test } from "bun:test";

import { canvasNodeDragEndChrome, canvasNodeInteractionStartChrome } from "@/pages/canvas/canvas-pointer-chrome";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function node(id: string, type: CanvasNodeData["type"], metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData {
    return { id, type, title: id, position: { x: 0, y: 0 }, width: 720, height: 405, metadata };
}

test("drag end keeps the prompt panel on a generator and the media toolbar on a result", () => {
    expect(canvasNodeDragEndChrome(undefined)).toEqual({ dialogNodeId: null, toolbarNodeId: undefined });
    expect(canvasNodeDragEndChrome(node("gen", CanvasNodeType.Image))).toEqual({ dialogNodeId: "gen" });
    expect(canvasNodeDragEndChrome(node("result", CanvasNodeType.Image, { content: "resource:1", nodeRole: "result" }))).toEqual({
        dialogNodeId: null,
        toolbarNodeId: "result",
    });
});

test("audio extraction does not close toolbar chrome", () => {
    expect(canvasNodeInteractionStartChrome({ segmentRunningAudio: true, selectionModifier: true })).toEqual({
        ignore: true,
        closeToolbar: false,
        closeDialog: false,
    });
    expect(canvasNodeInteractionStartChrome({ segmentRunningAudio: false, selectionModifier: true })).toEqual({
        ignore: false,
        closeToolbar: true,
        closeDialog: true,
    });
});
