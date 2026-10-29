import { describe, expect, test } from "bun:test";
import { abstractWorkflowDefinition, connectWorkflowDraft, isWorkflowOperation, removeWorkflowDraftNode, switchWorkflowOperation, validateWorkflowDraft, workflowAppendPositions, workflowFitViewport, workflowDurationSources, workflowEditableFields, workflowEditorPositions, workflowOperationDefaults } from "../src/lib/canvas/workflow-editor";
import { createWorkflowInstance, upgradeWorkflowInstance } from "../src/lib/canvas/reusable-workflow-instance";
import type { CanvasWorkflow, WorkflowDefinition, WorkflowOperation } from "../src/services/api/canvas-workflows";

const operations: WorkflowOperation[] = [{ id: "video.trim", version: 1, name: "视频裁剪", outputType: "video", fields: [], inputs: [{ id: "video", label: "视频", mediaType: "video", required: true, multiple: false }] }];
const definition: WorkflowDefinition = { version: 1, nodes: [
    { id: "in", role: "input", title: "视频输入", mediaType: "video" },
    { id: "trim", role: "operation", operationId: "video.trim", operationVersion: 1, title: "视频裁剪", mediaType: "video", config: { startSeconds: 0, endSeconds: 1 } },
], edges: [{ fromNodeId: "in", toNodeId: "trim", fromPort: "output", toPort: "video", order: 0 }], outputNodeIds: ["trim"] };
const template: CanvasWorkflow = { id: "template", name: "裁剪流程", description: "", createdAt: "", updatedAt: "", revision: 1, definition };

test("duration can follow a specific connected video and rejects disconnected sources", () => {
    const operation: WorkflowOperation = { ...operations[0], id: "generate.video", inputs: [{ id: "referenceVideos", label: "参考视频", mediaType: "video", required: false, multiple: true }] };
    const draft: WorkflowDefinition = { ...definition, nodes: [{ ...definition.nodes[1], id: "generate", operationId: operation.id, videoDurationSourceNodeId: "b" }, ...["a", "b", "unused"].map(id => ({ ...definition.nodes[0], id }))], edges: ["a", "b"].map((id, order) => ({ fromNodeId: id, toNodeId: "generate", fromPort: "output", toPort: "referenceVideos", order })), outputNodeIds: ["generate"] };
    expect(workflowDurationSources(draft, "generate").map(node => node.id)).toEqual(["a", "b"]);
    expect(() => validateWorkflowDraft(draft, [operation])).not.toThrow();
    expect(() => validateWorkflowDraft({ ...draft, edges: draft.edges.slice(0, 1) }, [operation])).toThrow("时长参考视频已断开");
    expect(abstractWorkflowDefinition(draft, [operation]).nodes[0].videoDurationSourceNodeId).toBe("b");
});

describe("workflow editor", () => {
    test("extracted titles are generic and original media is not a default", () => {
        const source = { ...definition, nodes: [{ ...definition.nodes[0], title: "41972924987.mp4", resourceId: "original", useDefault: true }, { ...definition.nodes[1], title: "从这段素材生成具体内容" }] };
        const reusable = abstractWorkflowDefinition(source, operations);
        expect(reusable.nodes.map(n => n.title)).toEqual(["视频输入", "视频裁剪"]);
        expect(reusable.nodes[0].useDefault).toBe(false);
        expect(source.nodes[0].useDefault).toBe(true);
        expect(reusable.presentationVersion).toBe(1);
    });
    test("processing can be changed without retaining old recipe or unrelated parameters", () => {
        const next: WorkflowOperation = { ...operations[0], id: "video.crop", fields: [{ key: "width", label: "宽度", type: "number" }, { key: "height", label: "高度", type: "number" }] };
        const changed = switchWorkflowOperation(definition, "trim", next);
        expect(changed.nodes[1].operationId).toBe("video.crop");
        expect(changed.nodes[1].config).toEqual({ width: 1, height: 1 });
        expect(changed.edges).toEqual(definition.edges);
        expect(definition.nodes[1].operationId).toBe("video.trim");
        expect(workflowOperationDefaults({ ...next, fields: [{ key: "longEdge", label: "长边", type: "number" }] })).toEqual({ longEdge: 2048 });
    });
    test("reconnecting a multi-input graph uses an unoccupied port position", () => {
        const merge: WorkflowOperation = { ...operations[0], id: "video.merge", inputs: [{ id: "videos", label: "视频", mediaType: "video", required: true, multiple: true }] };
        const draft: WorkflowDefinition = { ...definition, nodes: [{ ...definition.nodes[1], id: "merge", operationId: "video.merge" }, ...["a", "b", "c"].map(id => ({ ...definition.nodes[0], id }))], edges: [{ fromNodeId: "a", toNodeId: "merge", toPort: "videos", order: 0 }, { fromNodeId: "b", toNodeId: "merge", toPort: "videos", order: 2 }] };
        expect(connectWorkflowDraft(draft, "c", "merge", "videos", [merge]).edges.at(-1)?.order).toBe(1);
    });
    test("model properties only advertise parameters declared by their source", () => {
        const operation: WorkflowOperation = { ...operations[0], id: "generate.image", fields: ["prompt", "size", "videoSeconds", "seed"].map(key => ({ key, label: key, type: "string" })) };
        expect(workflowEditableFields({ ...definition.nodes[1], config: { size: "1:1" } }, operation).map(field => field.key)).toEqual(["prompt", "size"]);
    });
    test("video model and delivery controls are editable even when absent in the source recipe", () => {
        const operation: WorkflowOperation = { ...operations[0], id: "generate.video", fields: ["modelOption", "prompt", "size", "vquality", "videoSeconds", "seed"].map(key => ({ key, label: key, type: "string" })) };
        expect(workflowEditableFields({ ...definition.nodes[1], config: {} }, operation).map(field => field.key)).toEqual(["modelOption", "prompt", "size", "vquality", "videoSeconds"]);
    });
    test("explicit media defaults are used without inheriting legacy reference anchors", () => {
        const base = { ...template, definition: { ...definition, nodes: [{ ...definition.nodes[0], resourceId: "saved-default", useDefault: true }, definition.nodes[1]] } };
        const graph = createWorkflowInstance(base, { x: 0, y: 0 });
        expect(graph.nodes.find(node => node.metadata?.workflowSlot?.nodeId === "in")?.metadata?.storageKey).toBe("resource:saved-default");
        base.definition.nodes[0].useDefault = false;
        expect(createWorkflowInstance(base, { x: 0, y: 0 }).nodes.find(node => node.metadata?.workflowSlot?.nodeId === "in")?.metadata?.storageKey).toBeUndefined();
    });
    test("pure processing graph validates without generation or model", () => {
        expect(() => validateWorkflowDraft(definition, operations)).not.toThrow();
        expect(definition.nodes.filter(isWorkflowOperation)).toHaveLength(1);
    });
    test("removal cleans edges, outputs and saved position without mutating draft", () => {
        const draft = { ...definition, positions: { trim: { x: 30, y: 40 } } };
        const next = removeWorkflowDraftNode(draft, "trim");
        expect(next.nodes.map(node => node.id)).toEqual(["in"]);
        expect(next.edges).toEqual([]); expect(next.outputNodeIds).toEqual([]);
        expect(next.positions).toEqual({}); expect(draft.nodes).toHaveLength(2);
    });
    test("removal clears node mentions and duration references while undo can restore the original", () => {
        const draft: WorkflowDefinition = { ...definition, nodes: [definition.nodes[0], { ...definition.nodes[1], videoDurationSourceNodeId: "in", config: { prompt: "参考 @[node:in] 和 @[node:other]，再次 @[node:in]", videoSeconds: 7 } }] };
        const next = removeWorkflowDraftNode(draft, "in");
        expect(next.nodes[0].config?.prompt).toBe("参考  和 @[node:other]，再次 ");
        expect(next.nodes[0].videoDurationSourceNodeId).toBeUndefined();
        expect(next.nodes[0].config?.videoSeconds).toBe(7);
        expect(draft.nodes[1].videoDurationSourceNodeId).toBe("in");
        expect(draft.nodes[1].config?.prompt).toContain("@[node:in]");
    });
    test("connections preserve duplicates, auto-match compatible inputs and reject cycles", () => {
        expect(connectWorkflowDraft(definition, "in", "trim", "video", operations)).toBe(definition);
        expect(connectWorkflowDraft({...definition,edges:[]}, "in", "trim", "wrong-port", operations).edges[0].toPort).toBe("video");
        const nodes = [...definition.nodes, { ...definition.nodes[0], id: "image", mediaType: "image" as const }];
        expect(() => connectWorkflowDraft({ ...definition, nodes, edges: [] }, "image", "trim", "video", operations)).toThrow("不支持接收");
        const chain = { ...definition, nodes: [...definition.nodes, { ...definition.nodes[1], id: "other" }], edges: [{ fromNodeId: "trim", toNodeId: "other", toPort: "video" }] };
        expect(() => connectWorkflowDraft(chain, "other", "trim", "video", operations)).toThrow("循环");
    });
    test("saved graph positions persist and missing inputs prevent save", () => {
        expect(workflowEditorPositions({ ...definition, positions: { in: { x: 2, y: 3 } } }).in).toEqual({ x: 2, y: 3 });
        expect(() => validateWorkflowDraft({ ...definition, edges: [] }, operations)).toThrow("缺少");
        expect(() => validateWorkflowDraft({ ...definition, nodes: [{ ...definition.nodes[0], role: "constant" }, definition.nodes[1]] }, operations)).toThrow("固定内容");
    });
    test("instance update keeps compatible inputs and pins the new revision", () => {
        const graph = createWorkflowInstance(template, { x: 100, y: 100 });
        const input = graph.nodes.find(node => node.metadata?.workflowSlot?.nodeId === "in")!;
        input.metadata!.storageKey = "resource:user-input";
        const output = graph.nodes.find(node => node.metadata?.workflowSlot?.nodeId === "trim")!;
        output.metadata!.storageKey = "resource:old-result";
        const baseline = structuredClone(graph.nodes);
        const result = upgradeWorkflowInstance(graph.control, graph.nodes, graph.connections, { ...template, revision: 2, name: "新版裁剪" });
        expect(result.nodes.find(node => node.id === input.id)?.metadata?.storageKey).toBe("resource:user-input");
        expect(result.nodes.find(node => node.id === output.id)?.metadata?.storageKey).toBeUndefined();
        expect(result.nodes.find(node => node.id === graph.control.id)?.metadata?.reusableWorkflow?.templateRevision).toBe(2);
        expect(graph.nodes).toEqual(baseline);
        expect(graph.control.metadata?.reusableWorkflow?.templateRevision).toBe(1);
    });
    test("incompatible inputs are not reused and running instances cannot update", () => {
        const graph = createWorkflowInstance(template, { x: 0, y: 0 });
        const oldInput = graph.nodes.find(node => node.metadata?.workflowSlot?.nodeId === "in")!;
        oldInput.metadata!.storageKey = "resource:video";
        const latest = { ...template, revision: 2, definition: { ...definition, nodes: [{ ...definition.nodes[0], mediaType: "image" as const }, definition.nodes[1]] } };
        const result = upgradeWorkflowInstance(graph.control, graph.nodes, graph.connections, latest);
        expect(result.nodes.find(node => node.metadata?.workflowSlot?.nodeId === "in")?.metadata?.storageKey).toBeUndefined();
        graph.control.metadata!.reusableWorkflow!.intent = { clientOperationId: "op", inputs: {} };
        expect(() => upgradeWorkflowInstance(graph.control, graph.nodes, graph.connections, template)).toThrow("结束");
    });
});


test("appended nodes stay adjacent while existing dragged coordinates are preserved", () => {
    const source = { ...definition, positions: { in: { x: 3000, y: -900 }, trim: { x: 3400, y: -900 } } };
    const added = [{ ...definition.nodes[1], id: "new" }, { ...definition.nodes[0], id: "new-input" }];
    const positions = workflowAppendPositions(source, added);
    expect(positions.in).toEqual(source.positions.in);
    expect(positions.trim).toEqual(source.positions.trim);
    expect(positions.new).toEqual({ x: 3800, y: -900 });
    expect(positions["new-input"]).toEqual({ x: 4200, y: -900 });
    expect(source.positions).not.toHaveProperty("new");
});

test("fitting includes the entire graph and reserves room for the open library", () => {
    const bounds = { left: -5000, top: -900, right: 4200, bottom: 1500 };
    for (const width of [668, 949, 1400]) {
        for (const libraryOpen of [false, true]) {
            const view = workflowFitViewport(bounds, width, 650, libraryOpen);
            expect(view.x + bounds.left * view.k).toBeGreaterThanOrEqual(libraryOpen ? 284 : 0);
            expect(view.x + bounds.right * view.k).toBeLessThanOrEqual(width - 24);
            expect(view.y + bounds.top * view.k).toBeGreaterThanOrEqual(24);
            expect(view.y + bounds.bottom * view.k).toBeLessThanOrEqual(650 - 24);
        }
    }
});
