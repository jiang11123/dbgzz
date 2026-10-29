import { describe, expect, test } from "bun:test";

import {
    canvasNodeRetryPlan,
    createImageNodeFromTextSource,
    createInsertingHistoryGate,
    insertCanvasGenerationHistoryTask,
    rebaseInsertedCanvasNode,
    reconcileImageBatchRootNodes,
    runImageBatchChildRetry,
    selectRetryableImageBatchChildren,
} from "@/pages/canvas/canvas-generation-orchestration";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { GenerationTask } from "@/services/api/task-center";

function imageNode(id: string, metadata: Partial<NonNullable<CanvasNodeData["metadata"]>> = {}): CanvasNodeData {
    return {
        id,
        type: CanvasNodeType.Image,
        title: id,
        position: { x: 0, y: 0 },
        width: 720,
        height: 405,
        metadata: { status: "error", ...metadata },
    };
}

describe("canvasNodeRetryPlan", () => {
    test("depth capture nodes retry through the depth path", () => {
        expect(canvasNodeRetryPlan(imageNode("depth", { depthSourceNodeId: "source" }), []).kind).toBe("depth");
    });

    test("script retry requires prompt content", () => {
        const empty: CanvasNodeData = {
            id: "script",
            type: CanvasNodeType.Script,
            title: "分镜",
            position: { x: 0, y: 0 },
            width: 920,
            height: 360,
            metadata: { prompt: "  " },
        };
        expect(canvasNodeRetryPlan(empty, []).kind).toBe("script-empty");
        expect(canvasNodeRetryPlan({ ...empty, metadata: { composerContent: "一场雨" } }, [])).toEqual({ kind: "script", prompt: "一场雨" });
    });

    test("image batch root and child plans keep the failed children and root id", () => {
        const root = imageNode("root", { isBatchRoot: true, batchChildIds: ["child-fail", "child-ok"] });
        const childFail = imageNode("child-fail", { batchRootId: "root", status: "error" });
        const childOk = imageNode("child-ok", { batchRootId: "root", status: "success", content: "image:ok" });
        const nodes = [root, childFail, childOk];
        expect(canvasNodeRetryPlan(root, nodes)).toEqual({ kind: "image-batch-root", children: [childFail] });
        const emptyRoot = imageNode("root-empty", { isBatchRoot: true, batchChildIds: ["child-ok"] });
        expect(canvasNodeRetryPlan(emptyRoot, [emptyRoot, childOk]).kind).toBe("image-batch-empty");
        expect(canvasNodeRetryPlan(childFail, nodes)).toEqual({ kind: "image-batch-child", rootId: "root" });
        expect(canvasNodeRetryPlan(imageNode("solo"), nodes).kind).toBe("single");
    });
});

describe("image batch child retry", () => {
    test("marks retrying, waits for every child, then reconciles the root once", async () => {
        const events: string[] = [];
        const childA = imageNode("a", { batchRootId: "root", generationErrorCode: "rate_limit_exceeded" });
        const childB = imageNode("b", { batchRootId: "root", generationErrorCode: "rate_limit_exceeded" });
        const blocked = imageNode("blocked", { batchRootId: "root", generationErrorCode: "sensitive_words_detected" });
        let nodes: CanvasNodeData[] = [imageNode("root", { isBatchRoot: true, batchChildIds: ["a", "b"] }), childA, childB];
        await runImageBatchChildRetry({
            rootId: "root",
            children: [childA, childB],
            retry: async (child) => {
                events.push(`retry:${child.id}`);
                await Promise.resolve();
            },
            setNodes: (value) => {
                nodes = typeof value === "function" ? value(nodes) : value;
                events.push("setNodes");
            },
            reconcile: (rootId) => {
                events.push(`reconcile:${rootId}`);
            },
        });
        expect(events[0]).toBe("setNodes");
        expect(events.filter((event) => event.startsWith("retry:")).sort()).toEqual(["retry:a", "retry:b"]);
        expect(events.at(-1)).toBe("reconcile:root");
        expect(selectRetryableImageBatchChildren([childA, childB, blocked])).toEqual({
            retryable: [childA, childB],
            blocked: true,
        });
        expect(reconcileImageBatchRootNodes("missing", nodes)).toBe(nodes);
    });
});

describe("createImageNodeFromTextSource", () => {
    test("does not create a node or start generation when the text is empty", () => {
        const source: CanvasNodeData = {
            id: "text-1",
            type: CanvasNodeType.Text,
            title: "文本",
            position: { x: 10, y: 20 },
            width: 350,
            height: 350,
            metadata: { content: "   " },
        };
        expect(createImageNodeFromTextSource({ sourceId: source.id, prompt: "  ", nodes: [source], connections: [], config: {} })).toEqual({
            ok: false,
            reason: "empty-prompt",
        });
    });

    test("creates a connected image node without submitting a generation task", () => {
        const source: CanvasNodeData = {
            id: "text-1",
            type: CanvasNodeType.Text,
            title: "文本",
            position: { x: 10, y: 20 },
            width: 350,
            height: 350,
            metadata: { content: "一座桥" },
        };
        const created = createImageNodeFromTextSource({
            sourceId: source.id,
            prompt: "一座桥",
            nodes: [source],
            connections: [],
            config: { imageModel: "test-model", size: "720x405" },
            connectionId: "conn-1",
        });
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        expect(created.imageNode.type).toBe(CanvasNodeType.Image);
        expect(created.imageNode.metadata?.taskId).toBeUndefined();
        expect(created.imageNode.metadata?.status).not.toBe("loading");
        expect(created.connection).toEqual({ id: "conn-1", fromNodeId: "text-1", toNodeId: created.imageNode.id });
        expect(created.nextNodes.find((node) => node.id === "text-1")?.metadata?.status).toBe("success");
    });
});

describe("insertCanvasGenerationHistoryTask", () => {
    test("blocks overlapping inserts and persists the document before returning", async () => {
        const gate = createInsertingHistoryGate();
        expect(gate.tryEnter()).toBe(true);
        expect(gate.tryEnter()).toBe(false);
        gate.exit();
        expect(gate.tryEnter()).toBe(true);

        const order: string[] = [];
        const task = {
            id: "task-history",
            type: "canvas_image",
            status: "succeeded",
            prompt: "历史图片",
            resultJson: JSON.stringify({ mode: "image", images: [{ dataUrl: "data:image/png;base64,abc", storageKey: "resource:history" }] }),
            createdAt: "2026-10-01T00:00:00.000Z",
            updatedAt: "2026-10-01T00:00:00.000Z",
        } as GenerationTask;
        const result = await insertCanvasGenerationHistoryTask({
            task,
            projectId: "canvas-1",
            domainProjectId: "project-1",
            center: { x: 100, y: 80 },
            nodes: [],
            assets: [],
            readLiveNodes: () => [],
            persist: async (nodes) => {
                order.push("persist");
                expect(nodes).toHaveLength(1);
                expect(nodes[0]?.metadata?.assetId).toBe("asset-history");
            },
            ensureAsset: async () => {
                order.push("ensure");
                return { assetId: "asset-history" };
            },
            applyResult: async (nodes, appliedTask, targetNodeId) => {
                const node = nodes.find((item) => item.id === targetNodeId) || nodes[0];
                if (!node) return { nodes, updated: false, nodeId: "", node: null };
                const next = {
                    ...node,
                    metadata: {
                        ...node.metadata,
                        content: "/api/resources/history/file",
                        storageKey: "resource:history",
                        status: "success" as const,
                        taskId: appliedTask.id,
                    },
                };
                return { nodes: [next], updated: true, nodeId: next.id, node: next };
            },
        });
        expect(order).toEqual(["ensure", "persist"]);
        expect(result.node.metadata?.taskId).toBe("task-history");
        expect(result.nextNodes).toHaveLength(1);
    });
});

describe("rebaseInsertedCanvasNode", () => {
    test("replaces an existing id and otherwise appends", () => {
        const live = [imageNode("keep"), imageNode("target", { content: "old" })];
        const inserted = imageNode("target", { content: "new" });
        expect(rebaseInsertedCanvasNode(live, inserted).map((node) => `${node.id}:${node.metadata?.content}`)).toEqual(["keep:undefined", "target:new"]);
        expect(rebaseInsertedCanvasNode([imageNode("keep")], inserted).map((node) => node.id)).toEqual(["keep", "target"]);
    });
});


test("Midjourney history inserts all four indexed images and preserves concurrent nodes", async () => {
    const task = { id: "mj-history", type: "canvas_image", model: "beefapi::midjourney-v8.2", prompt: "red cube", status: "succeeded" } as GenerationTask;
    const indices: number[] = [];
    let persisted: CanvasNodeData[] = [];
    const result = await insertCanvasGenerationHistoryTask({
        task, projectId: "canvas-mj", center: { x: 0, y: 0 }, nodes: [], assets: [],
        readLiveNodes: () => [imageNode("concurrent")],
        persist: async (nodes) => { persisted = nodes; },
        ensureAsset: async (node) => ({ assetId: `asset-${node.metadata?.taskOutputIndex}` }),
        applyResult: async (nodes, _task, nodeId) => {
            const node = nodes.find((node) => node.id === nodeId)!;
            const index = node.metadata?.taskOutputIndex ?? -1;
            indices.push(index);
            const updated = { ...node, metadata: { ...node.metadata, content: `/api/resources/mj-${index}/file`, storageKey: `resource:mj-${index}`, status: "success" as const } };
            return { nodes: [updated], node: updated, updated: true, nodeId: updated.id };
        },
    });
    expect(indices).toEqual([0, 1, 2, 3]);
    expect(persisted).toHaveLength(5);
    expect(result.nextNodes).toEqual(persisted);
    expect(persisted.slice(1).map((node) => node.metadata?.assetId)).toEqual(["asset-0", "asset-1", "asset-2", "asset-3"]);
});
