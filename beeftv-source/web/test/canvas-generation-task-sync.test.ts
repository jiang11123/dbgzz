import { describe, expect, test } from "bun:test";

import { applyGeneratedMediaResultMetadata, applyRecoveredGenerationTaskResultToNodes, videoMetadata } from "@/lib/canvas/canvas-generation-task-sync";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function videoNode(assetId: string, storageKey: string): CanvasNodeData {
    return {
        id: "node-1",
        type: CanvasNodeType.Video,
        title: "镜头",
        position: { x: 0, y: 0 },
        width: 320,
        height: 180,
        metadata: { assetId, storageKey, content: "https://example.test/old.mp4", prompt: "旧提示词" },
    };
}

describe("applyGeneratedMediaResultMetadata", () => {
    test("clears the previous asset binding when a regenerated media result lands", () => {
        const node = videoNode("asset-old", "video:old");
        const next = applyGeneratedMediaResultMetadata(node, videoMetadata({
            url: "https://example.test/new.mp4",
            storageKey: "video:new",
            width: 1280,
            height: 720,
            bytes: 12,
            mimeType: "video/mp4",
            durationMs: 4000,
        }), { prompt: "新提示词" });

        expect(next.assetId).toBeUndefined();
        expect(next.storageKey).toBe("video:new");
        expect(next.content).toBe("https://example.test/new.mp4");
        expect(next.prompt).toBe("新提示词");
        expect(next.status).toBe("success");
    });
});

describe("recovered generation task results", () => {
    test("repairs the original text node and stamps the durable attach effect", async () => {
        const node: CanvasNodeData = {
            id: "text-node",
            type: CanvasNodeType.Text,
            title: "说明文字",
            position: { x: 10, y: 20 },
            width: 320,
            height: 180,
            metadata: { taskId: "task-1", status: "loading", taskStatus: "running", composerContent: "新提示词", prompt: "新提示词" },
        };
        const task = {
            id: "task-1",
            type: "canvas_text",
            status: "succeeded",
            resultJson: JSON.stringify({ text: "恢复后的结果" }),
            prompt: "新提示词",
            clientContext: { nodeId: "text-node" },
        } as never;

        const result = await applyRecoveredGenerationTaskResultToNodes([node], task, node.id);

        expect(result.nodes).toHaveLength(1);
        expect(result.node?.id).toBe(node.id);
        expect(result.node?.metadata?.content).toBe("恢复后的结果");
        expect(result.node?.metadata?.composerContent).toBe("新提示词");
        expect(result.node?.metadata?.status).toBe("success");
        expect(result.node?.metadata?.taskStatus).toBe("succeeded");
        expect(result.node?.metadata?.generationEffectKeys).toContain(result.effectKey);
    });
});
