import { expect, test } from "bun:test";

import { queueMediaNodeContentUpdate } from "@/pages/canvas/use-canvas-node-content";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

test("composes pending media updates for the same node instead of dropping the earlier patch", () => {
    const pending = new Map<string, (node: CanvasNodeData) => CanvasNodeData>();
    queueMediaNodeContentUpdate(pending, "video-1", (node) => ({ ...node, metadata: { ...node.metadata, durationMs: 1200 } }));
    queueMediaNodeContentUpdate(pending, "video-1", (node) => ({ ...node, metadata: { ...node.metadata, hasAudio: true } }));
    const current: CanvasNodeData = {
        id: "video-1",
        type: CanvasNodeType.Video,
        title: "视频",
        position: { x: 0, y: 0 },
        width: 720,
        height: 405,
        metadata: {},
    };
    expect(pending.get("video-1")?.(current).metadata).toMatchObject({ durationMs: 1200, hasAudio: true });
});
