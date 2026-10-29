import { applyCanvasNodeDragPreview } from "../src/lib/canvas/canvas-live-viewport";
import { ensureMediaNodeMinimumSize } from "../src/lib/canvas/canvas-node-size";
import { removeCanvasNodes } from "../src/lib/canvas/canvas-project-domain";
import { describe, expect, test } from "bun:test";
import { isWorkflowMaterialSource, canExportWorkflowResult, createWorkflowResultNode, workflowAtPoint, createWorkflowInstance, normalizeWorkflowContainers, workflowDropSlot, workflowInstanceInputs, workflowInstanceLocked, workflowSlotTitle } from "../src/lib/canvas/reusable-workflow-instance";
import { canOpenCanvasNodePromptPanel } from "../src/lib/canvas/canvas-node-semantics";
import { isFrameNode } from "../src/lib/canvas/canvas-frame";
import { getNodeGenerationMode } from "../src/lib/canvas/node-registry";
import { canvasNodeDragEndChrome } from "../src/pages/canvas/canvas-pointer-chrome";
import type { CanvasWorkflow, WorkflowRun } from "../src/services/api/canvas-workflows";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

const workflow: CanvasWorkflow = {
    id: "template", name: "人物动作替换", description: "", createdAt: "", updatedAt: "",
    definition: { version: 1, nodes: [
        { id: "person", title: "帮我生成一个短发可爱女生的三视图", mediaType: "image", role: "input", resourceId: "original-person" },
        { id: "motion", title: "41972924987-1-192.mp4 · 剪辑片段", mediaType: "video", role: "input", resourceId: "original-motion" },
        { id: "prompt", title: "固定提示词", mediaType: "text", role: "constant", text: "保持身份" },
        { id: "depth", title: "原视频", mediaType: "video", role: "depth" },
        { id: "out", title: "动作结果", mediaType: "video", role: "generation", sourceTaskId: "task" },
    ], edges: [{ fromNodeId: "motion", toNodeId: "depth" }, { fromNodeId: "person", toNodeId: "out" }, { fromNodeId: "depth", toNodeId: "out" }, { fromNodeId: "prompt", toNodeId: "out" }], outputNodeIds: ["out"] },
};

describe("canvas workflow instances", () => {
    test("workflow containers never consume small moves as material drops inside their original bounds", () => {
        const graph = createWorkflowInstance(workflow, { x: 0, y: 0 });
        const point = { x: 10, y: 10 };
        expect(workflowAtPoint(graph.nodes, point)?.id).toBe(graph.frame.id);
        expect(isWorkflowMaterialSource(graph.frame)).toBe(false);
        expect(isWorkflowMaterialSource(graph.control)).toBe(false);
        expect(workflowDropSlot(graph.nodes, graph.frame, point)).toBeUndefined();
        for (const type of [CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio, CanvasNodeType.Text]) {
            expect(isWorkflowMaterialSource({ ...graph.frame, type })).toBe(true);
        }
    });
    test("workflow and progress nodes have their own types and cannot open a generator after selection or drag", () => {
        const graph = createWorkflowInstance(workflow, { x: 0, y: 0 });
        expect(graph.frame.type).toBe(CanvasNodeType.Workflow);
        expect(graph.control.type).toBe(CanvasNodeType.WorkflowControl);
        expect(isFrameNode(graph.frame)).toBe(true);
        for (const node of graph.nodes) {
            expect(canOpenCanvasNodePromptPanel(node)).toBe(false);
            expect(getNodeGenerationMode(node)).toBeNull();
            expect(canvasNodeDragEndChrome(node).dialogNodeId).toBeNull();
        }
        expect(graph.control.position.y).toBeGreaterThan(graph.frame.position.y + 36);
        expect(graph.control.width).toBe(graph.frame.width - 80);
        expect(graph.nodes.filter(node => node.metadata?.workflowSlot).every(node => node.position.y - 32 > graph.control.position.y + graph.control.height)).toBe(true);
    });
    test("upgrades saved frame/config instances without losing input resources or run receipts", () => {
        const graph = createWorkflowInstance(workflow, { x: 100, y: 100 });
        graph.frame.type = CanvasNodeType.Frame;
        graph.control.type = CanvasNodeType.Config;
        graph.control.position.y = 140;
        graph.control.width = 680;
        graph.control.metadata!.reusableWorkflow!.run = { id: "existing-run", status: "running", steps: [] } as unknown as WorkflowRun;
        const slot = graph.nodes.find(node => node.metadata?.workflowSlot?.nodeId === "person")!;
        slot.metadata!.storageKey = "resource:new-person";
        const result = normalizeWorkflowContainers(graph.nodes);
        const container = result.find(node => node.id === graph.frame.id)!;
        const control = result.find(node => node.id === graph.control.id)!;
        expect(container.type).toBe(CanvasNodeType.Workflow);
        expect(control.type).toBe(CanvasNodeType.WorkflowControl);
        expect(control.metadata?.reusableWorkflow?.run?.id).toBe("existing-run");
        expect(result.find(node => node.id === slot.id)?.metadata?.storageKey).toBe("resource:new-person");
        expect(normalizeWorkflowContainers(result)).toBe(result);
        const resized = result.map(node => node.id === container.id ? { ...node, width: node.width + 200 } : node);
        expect(normalizeWorkflowContainers(resized).find(node => node.id === control.id)?.width).toBe(container.width + 200 - 80);
    });
    test("ordinary boards and special viewers are never assumed to be image generators", () => {
        const template = createWorkflowInstance(workflow, { x: 0, y: 0 }).frame;
        for (const type of [CanvasNodeType.Frame, CanvasNodeType.Markdown, CanvasNodeType.Html, CanvasNodeType.Chart, CanvasNodeType.Compare, CanvasNodeType.ColorGrade, CanvasNodeType.MediaConversion, "unknown-special-node"]) {
            const node = { ...template, type };
            expect(canOpenCanvasNodePromptPanel(node)).toBe(false);
            expect(canvasNodeDragEndChrome(node).dialogNodeId).toBeNull();
        }
        const board = [{ ...template, type: CanvasNodeType.Frame }];
        expect(normalizeWorkflowContainers(board)).toBe(board);
        expect(canOpenCanvasNodePromptPanel({ ...template, type: CanvasNodeType.Image })).toBe(true);
        expect(canOpenCanvasNodePromptPanel({ ...template, type: CanvasNodeType.Config })).toBe(true);
    });
    test("instantiates a new independent graph with empty media inputs and result placeholders", () => {
        const a = createWorkflowInstance(workflow, { x: 100, y: 100 });
        const b = createWorkflowInstance(workflow, { x: 100, y: 100 });
        expect(a.nodes).toHaveLength(7);
        expect(a.nodes.some(node => b.nodes.some(other => other.id === node.id))).toBe(false);
        const slots = a.nodes.filter(node => node.metadata?.workflowSlot);
        expect(slots.filter(node => node.metadata?.storageKey)).toHaveLength(0);
        expect(slots.find(node => node.metadata?.workflowSlot?.nodeId === "prompt")?.metadata?.content).toBe("保持身份");
        expect(a.connections).toHaveLength(4);
        expect(a.connections.every(edge => slots.some(node => node.id === edge.fromNodeId) && slots.some(node => node.id === edge.toNodeId))).toBe(true);
        expect(slots.every(node => node.parentId === a.frame.id)).toBe(true);
        expect(a.control.metadata?.reusableWorkflow?.definition).not.toBe(workflow.definition);
    });
    test("names imported prompt and filename slots by purpose", () => {
        expect(workflowSlotTitle(workflow.definition.nodes[0], workflow.definition)).toBe("人物三视图");
        expect(workflowSlotTitle(workflow.definition.nodes[1], workflow.definition)).toBe("动作参考");
        expect(workflowSlotTitle(workflow.definition.nodes[3], workflow.definition)).toBe("深度捕捉结果");
        expect(workflowSlotTitle({ ...workflow.definition.nodes[0], title: "人物参考（正面）" }, workflow.definition)).toBe("人物参考（正面）");
    });
    test("requires new input resources instead of silently reusing template defaults", () => {
        const graph = createWorkflowInstance(workflow, { x: 0, y: 0 });
        expect(() => workflowInstanceInputs(graph.control, graph.nodes)).toThrow("人物三视图");
        const populated = graph.nodes.map(node => node.metadata?.workflowSlot?.role === "input" ? { ...node, metadata: { ...node.metadata, storageKey: `resource:new-${node.metadata.workflowSlot.nodeId}` } } : node);
        expect(workflowInstanceInputs(graph.control, populated)).toEqual({ person: { resourceId: "new-person" }, motion: { resourceId: "new-motion" } });
        expect(() => workflowInstanceInputs(graph.control, populated.filter(node => node.metadata?.workflowSlot?.nodeId !== "motion"))).toThrow("已删除");
    });
    test("accepts matching canvas media at an unlocked input, without changing the source position", () => {
        const graph = createWorkflowInstance(workflow, { x: 100, y: 100 });
        const input = graph.nodes.find(node => node.metadata?.workflowSlot?.nodeId === "person")!;
        const source: CanvasNodeData = { id: "source", title: "新人物", type: CanvasNodeType.Image, width: 300, height: 300, position: { x: -400, y: 0 }, metadata: { storageKey: "resource:new-person" } };
        const point = { x: input.position.x + 100, y: input.position.y + 100 };
        expect(workflowDropSlot(graph.nodes, source, point)?.id).toBe(input.id);
        expect(source.position).toEqual({ x: -400, y: 0 });
        expect(workflowDropSlot(graph.nodes, { ...source, type: CanvasNodeType.Video }, point)).toBeUndefined();
        graph.control.metadata!.reusableWorkflow!.intent = { clientOperationId: "receipt", inputs: {} };
        expect(workflowInstanceLocked(graph.control)).toBe(true);
        expect(workflowDropSlot(graph.nodes, source, point)).toBeUndefined();
    });
    test("restores saved run identity and graph bindings through JSON serialization", () => {
        const graph = createWorkflowInstance(workflow, { x: 0, y: 0 });
        graph.control.metadata!.reusableWorkflow!.run = { id: "run", status: "running" } as WorkflowRun;
        const restored: CanvasNodeData[] = JSON.parse(JSON.stringify(graph.nodes));
        const control = restored.find(node => node.id === graph.control.id)!;
        expect(workflowInstanceLocked(control)).toBe(true);
        expect(control.metadata?.reusableWorkflow?.run?.id).toBe("run");
        expect(restored.filter(node => node.metadata?.workflowSlot?.instanceId === control.id)).toHaveLength(5);
    });
    test("allows a completed result from another instance as a reference without allowing self binding", () => {
        const graph = createWorkflowInstance(workflow, { x: 100, y: 100 });
        const other = createWorkflowInstance(workflow, { x: -1500, y: 0 });
        const source = other.nodes.find(node => node.metadata?.workflowSlot?.nodeId === "out")!;
        source.metadata!.storageKey = "resource:generated-video";
        const input = graph.nodes.find(node => node.metadata?.workflowSlot?.nodeId === "motion")!;
        const point = { x: input.position.x + 80, y: input.position.y + 80 };
        expect(workflowDropSlot([...graph.nodes, ...other.nodes], source, point)?.id).toBe(input.id);
        const ownResult = graph.nodes.find(node => node.metadata?.workflowSlot?.nodeId === "out")!;
        ownResult.metadata!.storageKey = "resource:own-result";
        expect(workflowDropSlot(graph.nodes, ownResult, point)).toBeUndefined();
    });
});


test("workflow slots survive reload sizing without changing layout or upload bindings", () => {
    const graph = createWorkflowInstance(workflow, { x: 20, y: 30 });
    const restored = graph.nodes.map(ensureMediaNodeMinimumSize);
    expect(restored).toEqual(graph.nodes);
    expect(normalizeWorkflowContainers(restored)).toBe(restored);
    const ordinary = { ...graph.nodes.find(n => n.type === CanvasNodeType.Image)!, metadata: {} };
    expect(ensureMediaNodeMinimumSize(ordinary).width).toBeGreaterThanOrEqual(420);
});

test("repairs previously enlarged slots once while preserving resources and receipts", () => {
    const graph = createWorkflowInstance(workflow, { x: 20, y: 30 });
    const broken = graph.nodes.map(node => node.metadata?.reusableWorkflow
        ? { ...node, metadata: { ...node.metadata, reusableWorkflow: { ...node.metadata.reusableWorkflow, layoutVersion: undefined } } }
        : node.metadata?.workflowSlot ? { ...node, width: 420, height: 364, position: { x: node.position.x - 60, y: node.position.y - 52 }, metadata: { ...node.metadata, storageKey: "resource:kept" } } : node);
    const repaired = normalizeWorkflowContainers(broken);
    for (const node of repaired.filter(n => n.metadata?.workflowSlot)) {
        const original = graph.nodes.find(n => n.id === node.id)!;
        expect(node.position).toEqual(original.position);
        expect([node.width, node.height]).toEqual([300,260]);
        expect(node.metadata?.storageKey).toBe("resource:kept");
    }
    expect(normalizeWorkflowContainers(repaired)).toBe(repaired);
});

test("deleting workflow frame or control removes its graph but keeps external sources", () => {
    const graph = createWorkflowInstance(workflow, { x: 0, y: 0 });
    const external = { ...graph.nodes[2], id: "external", parentId: undefined, metadata: {} };
    for (const id of [graph.frame.id,graph.control.id]) {
        const result = removeCanvasNodes([...graph.nodes,external],new Set([id]));
        expect(result.nodes).toEqual([external]);
        expect(result.removedIds.size).toBe(graph.nodes.length);
    }
    const plain = { ...graph.frame, type: CanvasNodeType.Frame };
    const child = { ...external, parentId: plain.id };
    const result = removeCanvasNodes([plain,child],new Set([plain.id]));
    expect(result.nodes).toEqual([{...child,parentId:undefined}]);
});


test("workflow result drag creates an independent ordinary media node without run bindings", () => {
    const graph = createWorkflowInstance(workflow, { x: 0, y: 0 });
    const source = graph.nodes.find(n => n.metadata?.workflowSlot?.role === "generation")!;
    source.metadata = { ...source.metadata, storageKey: "resource:result", content: "/resource/result", taskId: "private-task", naturalWidth: 1280, naturalHeight: 720 };
    expect(canExportWorkflowResult(source,graph.nodes)).toBe(true);
    const snapshot = structuredClone(source);
    const copy = createWorkflowResultNode(source,{x:-400,y:300});
    expect(source).toEqual(snapshot);
    expect(copy.id).not.toBe(source.id);
    expect(copy.parentId).toBeUndefined();
    expect(copy.metadata?.workflowSlot).toBeUndefined();
    expect(copy.metadata?.taskId).toBeUndefined();
    expect(copy.metadata?.storageKey).toBe("resource:result");
    expect(copy.width).toBeGreaterThanOrEqual(420);
    expect(copy.position.x+copy.width/2).toBe(-400);
    expect(workflowAtPoint(graph.nodes,{x:10,y:10})?.id).toBe(graph.frame.id);
    expect(workflowAtPoint(graph.nodes,{x:-400,y:300})).toBeUndefined();
    graph.control.metadata!.reusableWorkflow!.intent={clientOperationId:"op",inputs:{}};
    expect(canExportWorkflowResult(source,graph.nodes)).toBe(false);
});


test("compact drag preview restores the original transform after cancellation", () => {
    const properties = new Map<string,string>();
    const element = { dataset: { nodeId: "source" } as Record<string,string>, isConnected: true,
        style: { transform: "translate(10px, 20px)", transformOrigin: "", setProperty: (key:string,value:string) => properties.set(key,value), removeProperty: (key:string) => properties.delete(key) } };
    const container = { dataset: {}, querySelectorAll: () => [element], querySelector: () => null, dispatchEvent: () => true } as unknown as HTMLDivElement;
    applyCanvasNodeDragPreview(container,{x:40,y:60,nodeIds:new Set(["source"]),compact:{nodeId:"source",x:200,y:300,scale:.2}});
    expect(element.style.transform).toBe("translate(200px, 300px) scale(0.2)");
    expect(element.dataset.canvasCompactDrag).toBe("true");
    applyCanvasNodeDragPreview(container,null);
    expect(element.style.transform).toBe("translate(10px, 20px)");
    expect(element.dataset.canvasCompactDrag).toBeUndefined();
    expect(properties.has("translate")).toBe(false);
});
