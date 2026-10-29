import { describe, expect, test } from "bun:test";

import { ensureDirectorOutputConnections, resolveDirectorOutputPositions } from "../src/lib/canvas/director/director-output-layout";

describe("导演台输出布局与连线方向", () => {
    test("截图和视频首次生成时都排在导演台右侧，从左向右流出", () => {
        const layout = resolveDirectorOutputPositions({
            source: { position: { x: 100, y: 200 }, width: 520 },
            previewSize: { width: 720, height: 405 },
        });

        expect(layout.previewPosition).toEqual({ x: 668, y: 200 });
        expect(layout.videoPosition).toEqual({ x: 668, y: 653 });
    });

    test("把旧版反向输出边纠正为导演台到素材节点，并保留无关连线及稳定边 ID", () => {
        const oldImageEdge = { id: "old-image", fromNodeId: "image", toNodeId: "director" };
        const stableVideoEdge = { id: "stable-video", fromNodeId: "director", toNodeId: "video" };
        const unrelated = { id: "input", fromNodeId: "reference", toNodeId: "director" };
        const existing = [oldImageEdge, stableVideoEdge, unrelated];

        const result = ensureDirectorOutputConnections(existing, "director", ["image", "video"], () => "new-image");

        expect(result).toEqual([
            { id: "stable-video", fromNodeId: "director", toNodeId: "video" },
            unrelated,
            { id: "new-image", fromNodeId: "director", toNodeId: "image" },
        ]);
        expect(ensureDirectorOutputConnections(result, "director", ["image", "video"], () => "unused")).toEqual(result);
    });
});
