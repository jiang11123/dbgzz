import { describe, expect, test } from "bun:test";
import { compileCanvasWorkflow, prepareWorkflowDefinition, workflowRunInputs } from "../src/lib/canvas/reusable-workflow";
import type { WorkflowRun } from "../src/services/api/canvas-workflows";
import { CanvasNodeType, type CanvasNodeData, type CanvasConnection } from "../src/types/canvas";

const node = (id: string, type: CanvasNodeType, metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData => ({ id, title: id, type, metadata, position: { x: 0, y: 0 }, width: 200, height: 160 });
const edge = (a: string, b: string): CanvasConnection => ({ id: `${a}-${b}`, fromNodeId: a, toNodeId: b });
const image = node("person", CanvasNodeType.Image, { nodeRole: "result", storageKey: "resource:person-resource", resultOrigin: "upload" });
const generator = node("generate", CanvasNodeType.Video, { nodeRole: "generator", model: "model-a" });
const result = node("result", CanvasNodeType.Video, { nodeRole: "result", generatedFromNodeId: "generate", storageKey: "resource:video-result", taskId: "task-1", taskStatus: "succeeded" });

describe("canvas reusable workflow extraction", () => {
    test("local canvas processing preserves its explicit operation and reference ports", () => {
        const cropped = node("crop", CanvasNodeType.Image, { storageKey: "resource:crop", workflowOperation: { id: "image.crop", version: 1, config: { x: 0, y: 0, width: .5, height: 1 }, inputs: [{ nodeId: image.id, port: "image" }] } });
        const compiled = compileCanvasWorkflow([image, cropped], [], new Set([image.id, cropped.id])).definition;
        expect(compiled.nodes.find(n => n.id === "crop")).toMatchObject({ role: "operation", operationId: "image.crop", config: { width: .5 } });
        expect(compiled.edges).toEqual([{ fromNodeId: image.id, toNodeId: "crop", fromPort: "output", toPort: "image", order: 0 }]);
        expect(compiled.outputNodeIds).toEqual(["crop"]);
    });
    test("existing frame and trim metadata become deterministic steps", () => {
        const video = node("video", CanvasNodeType.Video, { storageKey: "resource:video" });
        const frame = node("frame", CanvasNodeType.Image, { storageKey: "resource:frame", videoFrameSourceNodeId: video.id, videoFrameTimeMs: 1500 });
        const compiled = compileCanvasWorkflow([video, frame], [], new Set([video.id, frame.id])).definition;
        expect(compiled.nodes.find(n => n.id === "frame")).toMatchObject({ role: "operation", operationId: "video.frame", config: { seconds: 1.5 } });
    });
    test("historical input form uses that run's replacements rather than template defaults", () => {
        const definition = compileCanvasWorkflow([image, generator, result], [edge("person", "generate")], new Set(["person", "generate", "result"])).definition;
        const run = { id: "run", templateId: "template", templateName: "workflow", status: "failed", steps: [{ nodeId: "person", title: "person", status: "succeeded", resourceId: "replacement" }], outputs: [], createdAt: "", updatedAt: "" } satisfies WorkflowRun;
        expect(workflowRunInputs(definition, run)).toEqual({ person: { resourceId: "replacement", text: undefined } });
    });
    test("collapses generator and its selected result, preserves recipe and variable reference", () => {
        const { definition } = compileCanvasWorkflow([image, generator, result], [edge("person", "generate"), edge("generate", "result")], new Set(["person", "generate", "result"]));
        expect(definition.nodes.map(n => [n.id, n.role])).toEqual([["person", "input"], ["generate", "generation"]]);
        expect(definition.nodes[1]).toMatchObject({ sourceTaskId: "task-1", resourceId: "video-result" });
        expect(definition.edges).toEqual([{ fromNodeId: "person", toNodeId: "generate" }]);
        expect(definition.outputNodeIds).toEqual(["generate"]);
    });
    test("captures unselected media references as empty reusable inputs", () => {
        const compiled = compileCanvasWorkflow([image, generator, result], [edge("person", "generate"), edge("generate", "result")], new Set(["generate", "result"]));
        expect(compiled.externalCount).toBe(1);
        expect(compiled.definition.nodes.find(n => n.id === "person")?.role).toBe("input");
    });
    test("a standalone generated result recovers the original generator inputs", () => {
        const { definition } = compileCanvasWorkflow([image, generator, result], [edge("person", "generate"), edge("generate", "result")], new Set(["result"]));
        expect(definition.edges).toEqual([{ fromNodeId: "person", toNodeId: "result" }]);
        expect(definition.nodes.find(n => n.id === "result")?.sourceTaskId).toBe("task-1");
    });
    test("depth result becomes a processing step with the source resource", () => {
        const source = node("motion", CanvasNodeType.Video, { storageKey: "resource:motion-resource" });
        const depth = node("depth", CanvasNodeType.Video, { storageKey: "resource:depth-resource", taskType: "depth_capture", taskId: "depth-task", taskStatus: "succeeded", depthSourceNodeId: "motion" });
        const compiled = compileCanvasWorkflow([source, depth], [edge("motion", "depth")], new Set(["motion", "depth"]));
        expect(compiled.definition.nodes.find(n => n.id === "depth")?.role).toBe("depth");
    });
    test("text generator/result pairs collapse without requiring a media resource", () => {
        const prompt = node("write", CanvasNodeType.Text, { nodeRole: "generator", prompt: "写一句话" });
        const answer = node("answer", CanvasNodeType.Text, { generatedFromNodeId: "write", taskId: "text-task", taskStatus: "succeeded", content: "你好" });
        const compiled = compileCanvasWorkflow([prompt, answer], [edge("write", "answer")], new Set(["write", "answer"]));
        expect(compiled.definition.nodes).toHaveLength(1);
        expect(compiled.definition.nodes[0]).toMatchObject({ id: "write", role: "generation", sourceTaskId: "text-task", text: "你好" });
    });
    test("a source image used for regeneration remains a replaceable input", () => {
        const source = { ...image, metadata: { ...image.metadata, generatedFromNodeId: image.id } };
        const child = node("edited", CanvasNodeType.Image, { nodeRole: "result", generatedFromNodeId: image.id, storageKey: "resource:edited-result", taskId: "edit-task", taskStatus: "succeeded" });
        const compiled = compileCanvasWorkflow([source, child], [edge(source.id, child.id)], new Set([source.id, child.id]));
        expect(compiled.definition.edges).toEqual([{ fromNodeId: "person", toNodeId: "edited" }]);
        expect(prepareWorkflowDefinition(compiled.definition).nodes.find(n => n.id === "person")?.role).toBe("input");
        const standalone = compileCanvasWorkflow([source, child], [edge(source.id, child.id)], new Set([child.id]));
        expect(standalone.definition.nodes.find(n => n.id === "person")?.role).toBe("input");
    });
    test("an in-place completed generator does not alias itself away", () => {
        const inPlace = node("in-place", CanvasNodeType.Image, { nodeRole: "generator", generatedFromNodeId: "in-place", storageKey: "resource:in-place-result", taskId: "in-place-task", taskStatus: "succeeded" });
        expect(compileCanvasWorkflow([inPlace], [], new Set([inPlace.id])).definition.nodes).toHaveLength(1);
    });
    test("rejects unfinished, ambiguous and unsupported recipes", () => {
        expect(() => compileCanvasWorkflow([generator], [], new Set(["generate"]))).toThrow("手动");
        expect(() => compileCanvasWorkflow([node("director", CanvasNodeType.Director)], [], new Set(["director"]))).toThrow("暂不支持");
        expect(() => compileCanvasWorkflow([generator, result, { ...result, id: "result2" }], [], new Set(["generate"]))).toThrow("多个");
    });
    test("rejects cyclic execution dependencies", () => {
        const other = node("other", CanvasNodeType.Video, { storageKey: "resource:other", taskId: "task-other", taskStatus: "succeeded" });
        expect(() => compileCanvasWorkflow([generator, result, other], [edge("generate", "other"), edge("other", "generate")], new Set(["generate", "result", "other"]))).toThrow("循环");
    });
    test("freezing an intermediate step removes its upstream branch", () => {
        const compiled = compileCanvasWorkflow([image, generator, result], [edge("person", "generate")], new Set(["person", "generate", "result"])).definition;
        const final = { id: "final", title: "final", mediaType: "video" as const, role: "generation" as const, sourceTaskId: "final-task", resourceId: "final-resource" };
        const def = prepareWorkflowDefinition({ ...compiled, nodes: [...compiled.nodes.map(n => n.id === "generate" ? { ...n, role: "constant" as const } : n), final], edges: [...compiled.edges, { fromNodeId: "generate", toNodeId: "final" }], outputNodeIds: ["final"] });
        expect(def.nodes.map(n => n.id)).toEqual(["generate", "final"]);
        expect(def.edges).toEqual([{ fromNodeId: "generate", toNodeId: "final" }]);
    });
});
