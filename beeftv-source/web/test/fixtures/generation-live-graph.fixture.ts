import { mock } from "bun:test";
import { strict as assert } from "node:assert";

// Run in a separate process: deterministic model/network boundaries must not leak
// into the rest of the frontend suite. The real hook owns confirmation and dispatch.
const confirmations: { onOk: () => void }[] = [];
const dispatched: any[] = [];
const react = await import("react");
const clientDiagnostics = await import("@/services/diagnostics/client-diagnostics");
mock.module("@/lib/canvas/canvas-generation-config", () => ({ resolvedCanvasGenerationRequirements: (config: any, node: any, capability: string, input: any) => ({ capability, input, videoSeconds: config.videoSeconds, videoOperation: node?.metadata?.videoEditOperation }) }));
mock.module("react", () => ({ ...react, default: react.default, useCallback: (fn: any) => fn, useRef: (value: any) => ({ current: value }) }));
mock.module("antd", () => ({ App: { useApp: () => ({ modal: { confirm: (input: any) => { confirmations.push(input); return { destroy() {} }; } }, message: { loading: () => {}, destroy: () => {}, error: (x: string) => { throw Error(x); }, info: () => {}, warning: () => {} } }) } }));
// Only suppress event recording; task/operation dependencies retain real trace helpers.
mock.module("@/services/diagnostics/client-diagnostics", () => ({ ...clientDiagnostics, recordDiagnosticEvent: () => {} }));
mock.module("@/stores/use-config-store", () => ({ useEffectiveConfig: () => ({}), useConfigStore: (select: any) => select({ isAiConfigReady: () => true }), resolveModelRequestConfig: () => ({}) }));
mock.module("@/components/canvas/canvas-node-generation", () => ({ buildNodeGenerationContext: (_nodes: any, _edges: any, _id: any, prompt: string) => ({ prompt, referenceImages: [], referenceVideos: [], referenceAudios: [], characterReferences: [], resolvedCharacterVoices: [] }), hydrateNodeGenerationContext: async (context: any) => context, compileNodeGenerationReferences: (context: any) => context }));
mock.module("@/pages/canvas/canvas-assistant-proposal-execution", () => ({ buildConfirmedGenerationConfig: () => ({ model: "fixture", taskWorkflowProvider: "model", size: "1:1" }) }));
const submission = await import("@/lib/canvas/canvas-generation-submission");
mock.module("@/lib/canvas/canvas-generation-submission", () => ({ ...submission, canvasGenerationRequestFingerprint: () => "repeat" }));
mock.module("@/lib/canvas/canvas-project-generation", () => ({ isGenerationCanceled: () => false, buildVideoGenerationMetadata: () => ({ videoEditOperation: "text_to_video" }) }));
mock.module("@/lib/model-selection", () => ({ modelCompatibilityError: () => "", modelGroupReferenceLimits: () => undefined, modelPromptLengthError: () => "", modelRequestOptions: () => ({}) }));
mock.module("@/services/skill-runtime", () => ({ skillRuntime: { prepare: async ({ prompt }: any) => ({ prompt, metadata: {} }) } }));
mock.module("@/lib/canvas/canvas-style-execution", () => ({ resolveCanvasStyleExecution: () => undefined }));
mock.module("@/pages/canvas/canvas-generation-failure", () => ({ canvasGenerationRetryBlocked: () => false, canvasImageGenerationHasPendingResult: () => false, canvasImagePendingResultMessage: () => "", canvasGenerationFailureMetadata: () => ({}) }));
mock.module("@/components/generation-reference-links", () => ({ createReferenceLinkResolver: () => undefined }));
mock.module("@/pages/canvas/canvas-image-generation-executor", () => ({ executeImageGeneration: async (input: any) => { dispatched.push(input); input.nodesRef.current = input.canvasNodes.map((n: any) => n.id === input.nodeId ? { ...n, metadata: { ...n.metadata, storageKey: "new:" + n.id, taskId: "new-task:" + n.id } } : n); } }));
mock.module("@/pages/canvas/canvas-media-generation-executors", () => ({ executeVideoGeneration: async (input: any) => { dispatched.push(input); }, executeAudioGeneration: async () => {} }));
mock.module("@/pages/canvas/canvas-text-generation-executor", () => ({ executeTextGeneration: async () => {} }));

const { useCanvasGenerationExecutor } = await import(process.env.BEEFTV_EXECUTOR_MODULE || "@/pages/canvas/use-canvas-generation-executor");
const node = (id: string) => ({ id, type: "image", title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { status: "success", content: "old:" + id, storageKey: "old:" + id, taskId: "old-task:" + id, prompt: "coffee", lastGenerationRequestFingerprint: "repeat" } });
const frozenNodes = [node("image"), node("text")];
const nodesRef = { current: structuredClone(frozenNodes) };
const connectionsRef = { current: [] as any[] };
const no = () => {};
const generate = useCanvasGenerationExecutor({ projectId: "canvas", addedSkills: [], assets: [], nodesRef, connectionsRef, setNodes: no, setConnections: no, setSelectedNodeIds: no, setSelectedConnectionId: no, setDialogNodeId: no, setRunningNodeId: no, startGenerationRequest: () => new AbortController(), finishGenerationRequest: no, bindGenerationTask: no, applyGenerationTaskResult: async () => {} });
const options = { confirmedInputs: { nodes: frozenNodes, connections: [], config: {} as any, assets: [], skills: [] } };
const first = generate("image", "image", "coffee", options);
const second = generate("text", "image", "coffee", options);
const deadline = Date.now() + 2000;
while (confirmations.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
assert.equal(confirmations.length, 2, "both targets must reach duplicate confirmation");
confirmations[0]!.onOk();
await first;
connectionsRef.current = [{ id: "new-link", fromNodeId: "image", toNodeId: "text" }];
// A user may wait until the first paid task finishes before confirming the second.
confirmations[1]!.onOk();
await second;
assert.equal(dispatched.length, 2);
assert.equal(dispatched[1].canvasNodes.find((n: any) => n.id === "image").metadata.storageKey, "new:image");
assert.equal(nodesRef.current.find(n => n.id === "image")!.metadata.taskId, "new-task:image");
assert.equal(nodesRef.current.find(n => n.id === "text")!.metadata.taskId, "new-task:text");
assert.equal(dispatched[1].canvasConnections[0].id, "new-link");
assert.equal(dispatched[1].sourceNode.metadata.storageKey, "old:text");
assert.equal(frozenNodes[0]!.metadata.storageKey, "old:image");
console.log("PASS: shared frozen inputs, two concurrent targets, delayed repeat confirmation retain live results and connections");
