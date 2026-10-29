import { expect, test } from "bun:test";

import { canOpenCanvasNodePromptPanel } from "../src/lib/canvas/canvas-node-semantics";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

const directorNode: CanvasNodeData = {
    id: "director-1",
    type: CanvasNodeType.Director,
    title: "导演台 1",
    position: { x: 0, y: 0 },
    width: 560,
    height: 560,
    metadata: { directorSceneId: "scene-1", workflowKind: "shot" },
};

test("director nodes never open the generic generation prompt panel", () => {
    expect(canOpenCanvasNodePromptPanel(directorNode)).toBe(false);
});

test("numbering selects the first unused director title index", async () => {
    const { nextDirectorNodeIndex } = await import("../src/lib/canvas/director/director-node-naming");
    const nodes: CanvasNodeData[] = [
        directorNode,
        { ...directorNode, id: "director-3", title: "导演台 3", metadata: { ...directorNode.metadata, shotIndex: 3 } },
    ];

    expect(nextDirectorNodeIndex(nodes)).toBe(2);
    expect(nextDirectorNodeIndex([{ ...directorNode, title: "导演台" }])).toBe(2);
});
