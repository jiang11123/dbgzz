import "../helpers/localforage-bun-memory";
import { mock } from "bun:test";
import { strict as assert } from "node:assert";
import { defaultConfig } from "@/stores/use-config-store";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { CanvasGenerationDurableAckError } from "@/services/canvas-generation-errors";
import { GenerationSubmissionUnknownError } from "@/services/api/generation-submission";

const original = { ...await import("@/lib/canvas/canvas-project-generation") };
const { canvasGenerationTaskNodes } = await import("@/pages/canvas/canvas-generation-failure");
const total = Number(process.env.MJ_OUTPUTS || 4);
let scenario = "success";
let submissions = 0;
let operationIds: string[] = [];
let registeredOperations: { operationId: string; outputNodeIds: string[] }[] = [];
let outputIds: string[] = [];
let activeController: AbortController;
mock.module("@/lib/canvas/canvas-project-generation", () => ({
    ...original,
    runCanvasGenerationTaskToConsumer: async (input: any, dependencies: any) => {
        submissions++;
        operationIds.push(input.clientOperationId);
        outputIds.push(...input.metadata.outputNodeIds);
        const identity = `paid-task-${submissions}`;
        assert.equal(input.config.count, "4");
        assert.equal(input.metadata.outputNodeIds.length, 4);
        assert.equal(new Set(input.metadata.outputNodeIds).size, 4);
        dependencies.onSubmission?.({ taskClientOperationId: identity, generationSubmissionState: scenario === "unknown" ? "unknown" : scenario === "cancel-before-accept" ? "submitting" : "accepted" });
        if (scenario === "unknown") throw new GenerationSubmissionUnknownError(identity, new Error("connection lost"));
        if (scenario === "cancel-before-accept") {
            activeController.abort();
            throw new DOMException("Aborted", "AbortError");
        }
        const task = { id: identity, clientOperationId: identity, type: "canvas_image", status: "succeeded", prompt: input.prompt, createdAt: "2026-10-17", updatedAt: "2026-10-17", attempts: 1 };
        dependencies.bindTask(task);
        if (scenario.endsWith("after-accept")) {
            activeController.abort();
            throw new DOMException("Aborted", "AbortError");
        }
        await dependencies.consumeTask(task);
        return { images: [] };
    },
}));
const { executeImageGeneration } = await import("@/pages/canvas/canvas-image-generation-executor");

for (scenario of ["success", "bind-failed", "unknown", "cancel-after-accept", "cancel-before-accept", "cancel-text-after-accept"]) {
    submissions = 0;
    operationIds = [];
    registeredOperations = [];
    outputIds = [];
    const source: CanvasNodeData = { id: "source", type: scenario === "cancel-text-after-accept" ? CanvasNodeType.Text : CanvasNodeType.Image, title: "MJ", position: { x: 0, y: 0 }, width: 320, height: 320, metadata: {} };
    const project = { id: "canvas", title: "MJ fixture", nodes: [source], connections: [], chatSessions: [], activeChatId: null, directorScenes: [], viewport: { x: 0, y: 0, k: 1 }, backgroundMode: "grid", showImageInfo: false, createdAt: "2026-10-17", updatedAt: "2026-10-17" } as CanvasProject;
    useCanvasStore.setState({ projects: [project] });
    const nodesRef = { current: project.nodes };
    const setNodes = (next: any) => {
        nodesRef.current = typeof next === "function" ? next(nodesRef.current) : next;
        useCanvasStore.getState().updateProject(project.id, { nodes: nodesRef.current });
    };
    const config = { ...defaultConfig, model: "beefapi::midjourney-v8.2", imageModel: "beefapi::midjourney-v8.2", count: String(total), channels: [{ id: "beefapi", name: "BeefTV", baseUrl: "https://beeftv.app/v1", models: ["midjourney-v8.2"], modelProfiles: [{ model: "midjourney-v8.2", capability: "image", protocol: "openai-image" }] }] } as typeof defaultConfig;
    const boundIndices: number[] = [];
    let binding = false;
    activeController = new AbortController();
    const input: any = {
        sourceNode: source, nodeId: source.id, canvasNodes: project.nodes, canvasConnections: [], prompt: "red cube", effectivePrompt: "red cube",
        clientOperationId: "confirmed-operation", projectId: project.id, generationConfig: config, generationContext: { referenceImages: [], referenceVideos: [], referenceAudios: [] }, controller: activeController, nodesRef, setNodes,
        onSubmissionPlan: async (manifest: any) => { registeredOperations = manifest.submissions; },
        setConnections() {}, setSelectedNodeIds() {}, setSelectedConnectionId() {}, setDialogNodeId() {}, registerPendingNodeIds() {},
        startGenerationRequest() {}, finishGenerationRequest() {}, styleMetadata: {}, skillMetadata: {}, showError() {},
        bindGenerationTask: (id: string, task: any) => setNodes(canvasGenerationTaskNodes(nodesRef.current, id, task)),
        applyGenerationTaskResult: async (id: string, task: any) => {
            assert.equal(binding, false, "four writes must be serialized");
            binding = true;
            const node = nodesRef.current.find((item) => item.id === id)!;
            const index = node.metadata!.taskOutputIndex!;
            assert.ok(task.id.startsWith("paid-task-"));
            boundIndices.push(index);
            await Promise.resolve();
            binding = false;
            if (scenario === "bind-failed" && index === 2) throw new CanvasGenerationDurableAckError(new Error("disk unavailable"));
            setNodes((nodes: CanvasNodeData[]) => nodes.map((item) => item.id === id ? { ...item, metadata: { ...item.metadata, content: `image:${index}`, assetId: `asset:${index}`, status: "success" } } : item));
        },
    };
    await executeImageGeneration(input);
    if (scenario === "success") {
        assert.deepEqual(registeredOperations.map(item => item.operationId), operationIds);
        assert.deepEqual(registeredOperations.flatMap(item => item.outputNodeIds), outputIds);
        assert.ok(registeredOperations.every(item => item.outputNodeIds.length === 4));
    }
    assert.equal(submissions, scenario.includes("cancel") ? 1 : total / 4);
    assert.equal(new Set(operationIds).size, submissions, "each native batch must own a distinct submission operation");
    assert.equal(new Set(outputIds).size, submissions * 4, "native batches must not share output targets");
    const children = nodesRef.current.filter((node) => node.metadata?.batchRootId);
    assert.equal(children.length, total);
    assert.deepEqual(children.map((node) => node.metadata!.taskOutputIndex), Array.from({ length: total }, (_, index) => index % 4));
    if (!scenario.includes("cancel")) assert.equal(new Set(children.map((node) => node.metadata!.taskClientOperationId)).size, total / 4);
    if (scenario === "unknown" || scenario === "cancel-before-accept") {
        assert.ok(children.every((node) => node.metadata!.generationSubmissionState === "unknown"));
        assert.deepEqual(boundIndices, []);
    } else if (scenario.endsWith("after-accept")) {
        assert.ok(children.slice(0,4).every((node) => node.metadata!.resourceReloadAvailable && String(node.metadata!.taskId).startsWith("paid-task-")));
        assert.deepEqual(boundIndices, []);
    } else {
        assert.deepEqual(boundIndices, Array.from({ length: total }, (_, index) => index % 4));
        assert.ok(children.every((node) => String(node.metadata!.taskId).startsWith("paid-task-")));
        assert.equal(children.filter((node) => node.metadata!.content).length, scenario === "success" ? total : total - total / 4);
        if (scenario === "bind-failed") assert.equal(children[2]!.metadata!.resourceReloadAvailable, true);
    }
    if (scenario !== "success") {
        await executeImageGeneration({ ...input, controller: new AbortController(), sourceNode: nodesRef.current.find((node) => node.id === source.id), canvasNodes: nodesRef.current });
        assert.equal(submissions, scenario.includes("cancel") ? 1 : total / 4, "retained/unknown results must block another paid task");
    }
}
console.log("PASS: one paid task, four indexed outputs, serialized writes, partial bind and unknown submission retain original identity");
