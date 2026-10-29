import { mock } from "bun:test";
import { strict as assert } from "node:assert";

// HTTP WebViews expose getRandomValues, but may not expose randomUUID.
Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });

const confirmations: any[] = [];
const diagnostics: any[] = [];
const errors: string[] = [];
const requests = new Map<string, AbortController>();
const loading = new Set<string>();
let dispatched = 0;
let running: string | null = null;
let hydrate: (context: any) => Promise<any> = async (context) => context;
let compatible = true;
let executeVideo = async (input: any) => { dispatched++; input.bindGenerationTask(input.nodeId, { id: "task" }); };
const react = await import("react");
const clientDiagnostics = await import("@/services/diagnostics/client-diagnostics");
mock.module("@/lib/canvas/canvas-generation-config", () => ({ resolvedCanvasGenerationRequirements: (config: any, node: any, capability: string, input: any) => ({ capability, input, videoSeconds: config.videoSeconds, videoOperation: node?.metadata?.videoEditOperation }) }));
mock.module("react", () => ({ ...react, default: react.default, useCallback: (fn: any) => fn, useRef: (value: any) => ({ current: value }) }));
mock.module("antd", () => ({ App: { useApp: () => ({ modal: { confirm: (input: any) => { confirmations.push(input); return { destroy: () => input.afterClose() }; } }, message: {
    error: (x: string) => errors.push(x), info() {}, warning() {},
    loading: ({ key }: any) => loading.add(key), destroy: (key: string) => loading.delete(key),
} }) } }));
// Keep the real trace helpers used by transitive task/operation imports.
mock.module("@/services/diagnostics/client-diagnostics", () => ({ ...clientDiagnostics, recordDiagnosticEvent: (event: any) => diagnostics.push(event) }));
mock.module("@/stores/use-config-store", () => ({ useEffectiveConfig: () => ({}), useConfigStore: (select: any) => select({ isAiConfigReady: () => true }), resolveModelRequestConfig: () => ({}) }));
mock.module("@/components/canvas/canvas-node-generation", () => ({ buildNodeGenerationContext: (_id: any, _nodes: any, _edges: any, prompt: string) => ({ prompt, referenceImages: [], referenceVideos: [], referenceAudios: [], characterReferences: [], resolvedCharacterVersions: [], resolvedCharacterVoices: [] }), hydrateNodeGenerationContext: (context: any) => hydrate(context), compileNodeGenerationReferences: (context: any) => context }));
mock.module("@/pages/canvas/canvas-assistant-proposal-execution", () => ({ buildConfirmedGenerationConfig: () => ({ model: "fixture", taskWorkflowProvider: "model", size: "1:1" }) }));
mock.module("@/lib/canvas/canvas-project-generation", () => ({ isGenerationCanceled: (error: any) => error?.name === "AbortError", buildVideoGenerationMetadata: () => ({ videoEditOperation: "text_to_video" }) }));
mock.module("@/lib/model-selection", () => ({ modelCompatibilityError: () => compatible ? "" : "参数不兼容", modelGroupReferenceLimits: () => undefined, modelPromptLengthError: () => "", modelRequestOptions: () => ({}) }));
mock.module("@/services/skill-runtime", () => ({ skillRuntime: { prepare: async ({ prompt }: any) => ({ prompt, metadata: {} }) } }));
mock.module("@/lib/canvas/canvas-style-execution", () => ({ resolveCanvasStyleExecution: () => undefined }));
mock.module("@/pages/canvas/canvas-generation-failure", () => ({ canvasGenerationRetryBlocked: () => false, canvasImageGenerationHasPendingResult: () => false, canvasImagePendingResultMessage: () => "", canvasGenerationFailureMetadata: () => ({}) }));
mock.module("@/components/generation-reference-links", () => ({ createReferenceLinkResolver: () => undefined }));
mock.module("@/pages/canvas/canvas-image-generation-executor", () => ({ executeImageGeneration: async () => {} }));
mock.module("@/pages/canvas/canvas-media-generation-executors", () => ({ executeVideoGeneration: (input: any) => executeVideo(input), executeAudioGeneration: async () => {} }));
mock.module("@/pages/canvas/canvas-text-generation-executor", () => ({ executeTextGeneration: async () => {} }));
const { useCanvasGenerationExecutor } = await import("@/pages/canvas/use-canvas-generation-executor");
const { useOperationProgress } = await import("@/stores/use-operation-progress");
const progressEntries = () => Object.values(useOperationProgress.getState().entries);
const nodesRef: any = { current: [{ id: "video", type: "video", metadata: { content: "old-result", status: "success" } }] };
const no = () => {};
const generate = useCanvasGenerationExecutor({ projectId: "canvas", addedSkills: [], assets: [], nodesRef, connectionsRef: { current: [] },
    setNodes: (update: any) => { nodesRef.current = update(nodesRef.current); }, setConnections: no, setSelectedNodeIds: no, setSelectedConnectionId: no, setDialogNodeId: no,
    setRunningNodeId: (update: any) => { running = typeof update === "function" ? update(running) : update; },
    startGenerationRequest: (id, _origin, _running, controller = new AbortController()) => { requests.set(id, controller); return controller; },
    finishGenerationRequest: (id, controller) => { if (requests.get(id) === controller) requests.delete(id); }, bindGenerationTask: no, applyGenerationTaskResult: async () => {},
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
let resolveRead!: (value: any) => void;
let pendingContext: any;
hydrate = (context) => { pendingContext = context; return new Promise((resolve) => { resolveRead = resolve; }); };
const first = generate("video", "video", "private prompt");
await tick();
assert.equal(running, "video");
assert.equal(loading.size, 0);
assert.deepEqual(progressEntries().map(({ target, detail, phase }) => ({ target, detail, phase })), [{ target: { projectId: "canvas", nodeId: "video" }, detail: "正在准备参考素材", phase: "preparing" }]);
assert.equal(dispatched, 0);
const duplicate = generate("video", "video", "private prompt");
assert(diagnostics.some((e) => e.code === "generation_duplicate_click"));
requests.get("video")!.abort();
await Promise.all([first, duplicate]);
assert.equal(requests.size, 0);
assert.equal(loading.size, 0);
assert.equal(progressEntries().length, 0, "cancelled preparation must clear node progress");
assert.equal(running, null);
resolveRead(pendingContext);
await tick();
assert.equal(dispatched, 0, "late hydration after cancellation must not dispatch");
assert.equal(errors.length, 0);

hydrate = async (context) => context;
compatible = false;
await generate("video", "video", "private prompt");
assert.equal(dispatched, 0);
assert.equal(requests.size, 0);
assert(errors[0]!.includes("参数不兼容"));
assert.equal(progressEntries().length, 0, "validation failure must clear node progress");
compatible = true;
await generate("video", "video", "private prompt");
assert.equal(dispatched, 1);
assert.equal(nodesRef.current[0].metadata.content, "old-result");
const repeat = generate("video", "video", "private prompt");
await tick();
assert.equal(confirmations.length, 1);
confirmations[0].afterClose();
await repeat;
assert.equal(dispatched, 1);
assert.equal(requests.size, 0);
const confirmed = generate("video", "video", "private prompt");
await tick();
confirmations[1].onOk();
await confirmed;
assert.equal(dispatched, 2);
assert.equal(loading.size, 0);
assert.equal(progressEntries().length, 0, "dispatch must hand node progress to the generation task");
// Accelerate only the preparation deadline; exercise the real hook and guard.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((fn: any, ms: number, ...args: any[]) => realSetTimeout(fn, ms === 60_000 ? 5 : ms, ...args)) as typeof setTimeout;
hydrate = (context) => { pendingContext = context; return new Promise((resolve) => { resolveRead = resolve; }); };
try {
    await generate("video", "video", "changed prompt");
} finally {
    globalThis.setTimeout = realSetTimeout;
}
assert(errors.some((text) => text.includes("尚未提交生成任务")));
assert.equal(requests.size, 0);
assert.equal(loading.size, 0);
assert.equal(progressEntries().length, 0, "timed-out preparation must clear node progress");
resolveRead(pendingContext);
await tick();
assert.equal(dispatched, 2);
hydrate = async (context) => context;
await generate("video", "video", "changed prompt");
assert.equal(dispatched, 3, "timeout must release the real submission lock for retry");
assert(!JSON.stringify(diagnostics).includes("private prompt"));
const failedDiag = diagnostics.find((e) => e.code === "generation_preflight_failed");
assert(failedDiag, "expected generation_preflight_failed event");
assert(failedDiag.message.includes("model=fixture"), "expected model in diagnostic message");
assert(failedDiag.message.includes("refs=i:0,v:0,a:0,c:0"), "expected ref counts in diagnostic message");
assert(failedDiag.message.includes("参数不兼容"), "expected failure reason in diagnostic message");
assert(diagnostics.some((e) => e.code === "generation_preflight_timeout"));
assert(diagnostics.some((e) => e.code === "generation_confirmation_cancelled"));

// Keep the first result waiting while the same source prepares a new request.
let firstExecution: any;
let rejectOld!: (error: Error) => void;
executeVideo = async (input) => {
    firstExecution = input;
    input.registerPendingNodeIds(["result-1"]);
    input.startGenerationRequest("result-1", "video", "video", input.controller);
    try {
        input.bindGenerationTask("result-1", { id: "old-task", type: "canvas_video", status: "running" });
        await new Promise<void>((_, reject) => { rejectOld = reject; });
    } finally { input.finishGenerationRequest("result-1", input.controller); }
};
const old = generate("video", "video", "first shot");
while (!firstExecution) await tick();
assert.equal(running, "video", "generation still owns source");
firstExecution.bindGenerationTask("result-1", { id: "old-task", type: "canvas_video", status: "running", stage: "正在取回生成结果" });
assert.equal(running, null, "result download must release source");
assert.equal(requests.has("video"), false);
assert.equal(requests.has("result-1"), true, "result still owns download controller");
assert.equal(firstExecution.controller.signal.aborted, false);
hydrate = (context) => { pendingContext = context; return new Promise((resolve) => { resolveRead = resolve; }); };
const next = generate("video", "video", "second shot");
while (progressEntries().length === 0) await tick();
assert.equal(running, "video", "source can prepare the next shot");
for (let n = 0; n < 510; n++) firstExecution.bindGenerationTask("result-1", { id: "old-task", type: "canvas_video", status: "running", stage: "正在取回生成结果" });
assert.equal(diagnostics.filter((event) => event.code === "generation_submission_bound" && event.taskId === "old-task").length, 1, "progress must not flood binding diagnostics");
rejectOld(new Error("old download interrupted"));
await old;
assert.equal(running, "video", "old completion must not clear the newer busy state");
assert.equal(progressEntries().length, 1, "old cleanup must not destroy the newer preparation progress");
assert.equal(requests.has("video"), true);
executeVideo = async (input) => { dispatched++; input.bindGenerationTask("result-2", { id: "new-task", type: "canvas_video", status: "succeeded" }); };
resolveRead(pendingContext);
await next;
assert.equal(running, null);
assert.equal(requests.size, 0);
assert.equal(loading.size, 0);
console.log("PASS: source release during delivery, isolated result controller, newer request survives old completion");
console.log("PASS: preflight lifecycle, duplicate lock, abort fencing, validation, closed dialog retry, private diagnostics");

