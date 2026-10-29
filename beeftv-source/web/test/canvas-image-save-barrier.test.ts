import { beforeEach, expect, test } from "bun:test";
import { generationTaskMetadata, runCanvasGenerationTaskToConsumer } from "@/lib/canvas/canvas-project-generation";
import { removeCanvasNodes } from "@/lib/canvas/canvas-project-domain";
import { cancelIncompleteImageBatch } from "@/lib/canvas/canvas-image-batch-retry";
import { isolateCopiedNodeMetadata } from "@/lib/canvas/canvas-node-copy";
import { prepareInPlaceMediaVersion } from "@/lib/canvas/canvas-media-versions";
import { assistantProposalProgress } from "@/pages/canvas/canvas-assistant-copy";
import { captureUserScope, UserScopeAbandonedError } from "@/lib/user-scope-guard";
import { canvasGenerationFailureMetadata, canvasGenerationRetryBlocked, canvasGenerationTaskNodes, canvasTaskFailureMetadata } from "@/pages/canvas/canvas-generation-failure";
import { isCanvasNodeGenerating } from "@/lib/canvas/canvas-node-task-state";
import { ApiError } from "@/services/api/request";
import { CanvasGenerationDurableAckError, persistCanvasGenerationTarget } from "@/services/canvas-generation-consumer";
import { CanvasBackendSubmitPausedError } from "@/services/canvas-revision-conflict";
import type { GenerationTask } from "@/services/api/task-center";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { executeImageGeneration } from "@/pages/canvas/canvas-image-generation-executor";
import { executeAudioGeneration, executeVideoGeneration } from "@/pages/canvas/canvas-media-generation-executors";
import type { CanvasGenerationExecution } from "@/pages/canvas/canvas-generation-executor-types";

const project: CanvasProject = { id: "canvas-1", title: "画布", createdAt: "2026-01-01", updatedAt: "2026-01-01", revision: 3, nodes: [{ id: "new-image", type: CanvasNodeType.Image, title: "新结果", position: { x: 0, y: 0 }, width: 320, height: 320, metadata: { status: "loading" } }], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "grid", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 }, directorScenes: [] };
const input = { projectId: project.id, nodeId: "new-image", mode: "image" as const, prompt: "小猫", config: {} as never, clientOperationId: "test-image-save" };
const task: GenerationTask = { id: "task-original", type: "canvas_image", status: "succeeded", prompt: input.prompt, attempts: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01", failureDiagnostics: { source: "unknown", requests: [{ operation: "image_generate", method: "POST", dispatched: true, outcome: "response_received", httpStatus: 200, startedAt: "2026-01-01", durationMs: 10 }] } };

test("continuation manifest freezes split output identities before any image task or placeholder mutation", async () => {
    const target = { ...project.nodes[0]!, id: "source", metadata: { status: "idle" as const } };
    let mutations = 0;
    const rejected = new Error("confirmation receipt unavailable");
    let manifest: Parameters<NonNullable<CanvasGenerationExecution["onSubmissionPlan"]>>[0] | undefined;
    await expect(executeImageGeneration({
        sourceNode: target, nodeId: target.id, canvasNodes: [target], canvasConnections: [],
        prompt: "生成画面", effectivePrompt: "生成画面", projectId: project.id, clientOperationId: "proposal:gp-one:source",
        generationConfig: { model: "test-model", count: "2", channels: [] }, generationContext: { referenceImages: [] }, controller: new AbortController(),
        onSubmissionPlan: async value => { manifest = value; throw rejected; },
        setNodes: () => { mutations++; }, setConnections: () => { mutations++; }, registerPendingNodeIds: () => { mutations++; },
        startGenerationRequest: () => { mutations++; },
    } as unknown as CanvasGenerationExecution)).rejects.toBe(rejected);
    expect(mutations).toBe(0);
    expect(manifest?.sourceNodeId).toBe("source");
    expect(manifest?.submissions.map(item => item.operationId)).toEqual(["proposal:gp-one:source:0", "proposal:gp-one:source:1"]);
    expect(new Set(manifest?.submissions.flatMap(item => item.outputNodeIds)).size).toBe(2);
});

beforeEach(() => useCanvasStore.setState({ projects: [structuredClone(project)] }));

for (const [kind, execute] of [[CanvasNodeType.Image, executeImageGeneration], [CanvasNodeType.Video, executeVideoGeneration]] as const) {
    test(`${kind} manifest rejection or Stop during registration leaves no new output or task`, async () => {
        for (const stop of [false, true]) {
            const source = { ...project.nodes[0]!, type: kind, metadata: { status: "idle" as const } };
            const controller = new AbortController();
            let mutations = 0;
            let manifests = 0;
            const unexpected = () => { mutations++; };
            await expect(execute({
                sourceNode: source, nodeId: source.id, canvasNodes: [source], nodesRef: { current: [source] }, canvasConnections: [],
                prompt: "镜头", effectivePrompt: "镜头", projectId: project.id, clientOperationId: "proposal:gp-one:source",
                generationConfig: { model: "test-model", count: "1", channels: [] }, generationContext: { referenceImages: [], referenceVideos: [], referenceAudios: [] }, controller,
                onSubmissionPlan: async () => { manifests++; if (stop) controller.abort(); else throw new Error("receipt unavailable"); },
                setNodes: unexpected, setConnections: unexpected, registerPendingNodeIds: unexpected, startGenerationRequest: unexpected,
            } as unknown as CanvasGenerationExecution)).rejects.toThrow();
            expect(manifests).toBe(1); expect(mutations).toBe(0);
        }
    });
}

test("submission creates a stable operation ID without randomUUID in an HTTP WebView", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    let savedOperation = "";
    let submittedOperation = "";
    try {
        await runCanvasGenerationTaskToConsumer({ ...input, clientOperationId: undefined }, {
            prepareTarget: async (options) => { savedOperation = options.clientOperationId || ""; },
            bindTask: () => undefined,
            consumeTask: async () => undefined,
            runTask: async (options) => { submittedOperation = options.clientOperationId || ""; options.onTaskCreated?.(task); return { images: [] }; },
        });
        expect(savedOperation).toMatch(/^[A-Za-z0-9_-]{21}$/);
        expect(submittedOperation).toBe(savedOperation);
    } finally {
        if (descriptor) Object.defineProperty(crypto, "randomUUID", descriptor);
        else delete (crypto as Partial<Crypto>).randomUUID;
    }
});

test("restoring a completed image retains recovery flags and cannot open a second paid generation", () => {
    const target = { ...project.nodes[0], metadata: { taskId: task.id, taskStatus: "succeeded" as const, status: "error" as const, resourceReloadAvailable: true, generationErrorCode: "canvas_conflict" as const, errorDetails: "生成结果已保留，请点击「继续取回」" } };
    const restored = canvasGenerationTaskNodes([target], target.id, task)[0];
    expect(restored.metadata).toMatchObject({ status: "error", taskStatus: "succeeded", resourceReloadAvailable: true, generationErrorCode: "canvas_conflict" });
    expect(isCanvasNodeGenerating(restored)).toBe(true);
    expect(canvasGenerationRetryBlocked(restored.metadata, { prompt: "已经修改", mode: "image" })).toBe(true);
    const firstTerminal = canvasGenerationTaskNodes(project.nodes, input.nodeId, task)[0];
    expect(isCanvasNodeGenerating(firstTerminal)).toBe(true);
});

test("task polling preserves unsaved movement, prompt edits and a newly added sibling, and never recreates deleted targets", () => {
    const target = { ...project.nodes[0], position: { x: 500, y: 600 }, metadata: { prompt: "刚修改的提示词" } };
    const sibling = { ...target, id: "new-sibling" };
    const live = canvasGenerationTaskNodes([target, sibling], target.id, task);
    expect(live[0].position).toEqual(target.position);
    expect(live[0].metadata?.prompt).toBe("刚修改的提示词");
    expect(live[0].metadata?.taskId).toBe(task.id);
    expect(live[1]).toBe(sibling);
    expect(canvasGenerationTaskNodes([sibling], target.id, task)).toEqual([sibling]);
});

test("image submission waits for the target node save and shares one submission for a rapid double click", async () => {
    const events: string[] = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const dependencies = {
        prepareTarget: async (options: Parameters<typeof persistCanvasGenerationTarget>[0]) => persistCanvasGenerationTarget(options, async (_id, patch) => {
            expect(patch.nodes?.map((node) => node.id)).toEqual([input.nodeId]);
            events.push("save"); await pending; events.push("saved");
        }),
        bindTask: () => undefined,
        consumeTask: async () => { events.push("consume"); },
        runTask: async (options: Parameters<NonNullable<Parameters<typeof runCanvasGenerationTaskToConsumer>[1]["runTask"]>>[0]) => {
            events.push("submit"); options.onTaskCreated?.(task); return { images: [] };
        },
    };
    const first = runCanvasGenerationTaskToConsumer(input, dependencies);
    const second = runCanvasGenerationTaskToConsumer(input, dependencies);
    expect(events).toEqual(["save"]);
    release(); await Promise.all([first, second]);
    expect(events).toEqual(["save", "saved", "submit", "consume"]);
});

for (const error of [new ApiError("保存冲突", { status: 409, reason: "conflict" }), new CanvasBackendSubmitPausedError(), new Error("disk failure")]) {
    test(`a rejected target save creates no paid task: ${error.name}`, async () => {
        let submissions = 0;
        await expect(runCanvasGenerationTaskToConsumer(input, {
            prepareTarget: (options) => persistCanvasGenerationTarget(options, async () => { throw error; }),
            bindTask: () => undefined, consumeTask: async () => undefined,
            runTask: async () => { submissions++; return { images: [] }; },
        })).rejects.toThrow("未开始生成");
        expect(submissions).toBe(0);
        expect(useCanvasStore.getState().projects[0]?.nodes.map((node) => node.id)).toEqual([input.nodeId]);
    });
}

test("a target deleted while saving stops before submission and is not recreated", async () => {
    await expect(persistCanvasGenerationTarget({ ...input, expectedScope: captureUserScope() }, async () => {
        useCanvasStore.setState({ projects: [{ ...project, nodes: [] }] });
    })).rejects.toThrow("生成节点已不存在");
    expect(useCanvasStore.getState().projects[0]?.nodes).toEqual([]);
});

test("abort and abandoned account saves cannot proceed to a paid task", async () => {
    const controller = new AbortController();
    await expect(persistCanvasGenerationTarget({ ...input, signal: controller.signal, expectedScope: captureUserScope() }, async () => { controller.abort(); })).rejects.toMatchObject({ name: "AbortError" });
    await expect(persistCanvasGenerationTarget({ ...input, expectedScope: captureUserScope() }, async () => { throw new UserScopeAbandonedError(); })).rejects.toBeInstanceOf(UserScopeAbandonedError);
    const refNode = { id: "ref-image", type: CanvasNodeType.Image, title: "参考图", position: { x: 0, y: 0 }, width: 320, height: 320, metadata: { status: "success" as const, storageKey: "resource:res-ref", content: "/api/resources/res-ref/file" } };
    useCanvasStore.setState({ projects: [{ ...structuredClone(project), nodes: [...project.nodes, refNode] }] });
    let current = true;
    let persistAttempts = 0;
    await expect(
        persistCanvasGenerationTarget(
            {
                ...input,
                expectedScope: captureUserScope(),
                isCurrent: () => current,
                ensureNodeAsset: async () => {
                    current = false;
                    return { assetId: "asset-ref", created: false, linkedToProject: false, confirmed: true };
                },
            },
            async () => {
                persistAttempts += 1;
                throw new ApiError("画布媒体尚未进入素材库，请等待同步完成后重试", { status: 400 });
            },
        ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(persistAttempts).toBe(1);
    expect(useCanvasStore.getState().projects[0]?.nodes.find((item) => item.id === "ref-image")?.metadata?.assetId).toBeUndefined();

    let hookCurrent = true;
    let hookPersistAttempts = 0;
    let hookSubmissions = 0;
    await expect(
        runCanvasGenerationTaskToConsumer(
            {
                ...input,
                clientOperationId: "test-image-save-owner-change",
                expectedScope: captureUserScope(),
                ensureNodeAsset: async () => {
                    hookCurrent = false;
                    return { assetId: "asset-ref", created: false, linkedToProject: false, confirmed: true };
                },
            } as Parameters<typeof runCanvasGenerationTaskToConsumer>[0],
            {
                isCurrent: () => hookCurrent,
                prepareTarget: (options) =>
                    persistCanvasGenerationTarget(options, async () => {
                        hookPersistAttempts += 1;
                        throw new ApiError("画布媒体尚未进入素材库，请等待同步完成后重试", { status: 400 });
                    }),
                bindTask: () => undefined,
                consumeTask: async () => undefined,
                runTask: async () => {
                    hookSubmissions += 1;
                    return { images: [] };
                },
            },
        ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(hookPersistAttempts).toBe(1);
    expect(hookSubmissions).toBe(0);
});

test("account abandonment or cancellation during result consumption cannot report success", async () => {
    for (const error of [new UserScopeAbandonedError(), new DOMException("Aborted", "AbortError")]) {
        let binds = 0;
        await expect(runCanvasGenerationTaskToConsumer(input, {
            prepareTarget: async () => undefined,
            bindTask: () => { binds++; },
            runTask: async (options) => { options.onTaskCreated?.(task); return { images: [] }; },
            consumeTask: async () => { throw error; },
        })).rejects.toBe(error);
        expect(binds).toBe(1);
    }
});

test("main generation and batch generation stop before changing nodes when a paid result awaits recovery", async () => {
    for (const batch of [false, true]) {
        const target = { ...project.nodes[0], metadata: { taskId: task.id, taskStatus: "succeeded" as const, status: "error" as const, resourceReloadAvailable: true, generationErrorCode: "canvas_conflict" as const } };
        const root = batch ? { ...target, id: "batch-root", metadata: { batchChildIds: [target.id], status: "success" as const } } : target;
        let mutations = 0;
        const notices: string[] = [];
        const unexpected = () => { mutations++; };
        await executeImageGeneration({
            sourceNode: root, nodeId: root.id, canvasNodes: batch ? [root, target] : [target], canvasConnections: [],
            prompt: "修改后再点生成", effectivePrompt: "修改后再点生成", projectId: project.id,
            generationConfig: { count: batch ? "2" : "1" }, generationContext: { referenceImages: [] }, controller: new AbortController(),
            setNodes: unexpected, setConnections: unexpected, registerPendingNodeIds: unexpected,
            showError: (value: string) => notices.push(value),
        } as unknown as CanvasGenerationExecution);
        expect(mutations).toBe(0);
        expect(notices).toEqual(["生成结果已保留，请点击「继续取回」"]);
    }
});

test("in-place media generation preserves the existing shot name before submission", async () => {
    for (const [type, execute] of [[CanvasNodeType.Image, executeImageGeneration], [CanvasNodeType.Video, executeVideoGeneration], [CanvasNodeType.Audio, executeAudioGeneration]] as const) {
        const target = { ...project.nodes[0], type, title: `镜1-${type}`, metadata: { status: "idle" as const } };
        useCanvasStore.setState({ projects: [{ ...structuredClone(project), nodes: [target] }] });
        const nodesRef = { current: [target] };
        const stopBeforeSubmission = new Error("test stops before paid submission");
        await expect(execute({
            sourceNode: target, nodeId: target.id, canvasNodes: [target], canvasConnections: [], nodesRef,
            prompt: "新的完整动作提示词", effectivePrompt: "新的完整动作提示词", projectId: project.id,
            generationConfig: { model: "test-model", count: "1", size: "9:16", channels: [] },
            generationContext: { referenceImages: [], referenceVideos: [], referenceAudios: [], resolvedCharacterVersions: [], resolvedCharacterVoices: [] },
            controller: new AbortController(),
            setNodes: () => undefined, setConnections: () => undefined, registerPendingNodeIds: () => undefined,
            setSelectedNodeIds: () => undefined, setSelectedConnectionId: () => undefined, setDialogNodeId: () => undefined,
            startGenerationRequest: () => { throw stopBeforeSubmission; },
        } as unknown as CanvasGenerationExecution)).rejects.toBe(stopBeforeSubmission);
        const saved = useCanvasStore.getState().projects[0]!.nodes;
        expect(saved).toHaveLength(1);
        expect(saved[0]?.title).toBe(target.title);
        expect(saved[0]?.metadata?.prompt).toBe("新的完整动作提示词");
        expect(nodesRef.current[0]?.title).toBe(target.title);
    }
});

test("executor retains original batch outputs after layout deletion, cancellation, copying and regeneration", async () => {
    const proposal = { proposalId: "p1", kind: "image" as const, nodeIds: ["source"], model: "test-model", modelKey: "test::image" };
    const createTargets = async (source: CanvasNodeData, nodes: CanvasNodeData[], count: string) => {
        useCanvasStore.setState({ projects: [{ ...structuredClone(project), nodes }] });
        const stopBeforeSubmission = new Error("test stops before paid submission");
        await expect(executeImageGeneration({
            sourceNode: source, nodeId: source.id, canvasNodes: nodes, canvasConnections: [], nodesRef: { current: nodes },
            prompt: "两个镜头", effectivePrompt: "两个镜头", projectId: project.id, clientOperationId: "proposal:p1:source",
            generationConfig: { model: "test-model", count, channels: [] }, generationContext: { referenceImages: [] }, controller: new AbortController(),
            setNodes: () => undefined, setConnections: () => undefined, registerPendingNodeIds: () => undefined,
            setSelectedNodeIds: () => undefined, setSelectedConnectionId: () => undefined, setDialogNodeId: () => undefined,
            startGenerationRequest: () => { throw stopBeforeSubmission; },
        } as unknown as CanvasGenerationExecution)).rejects.toBe(stopBeforeSubmission);
        return useCanvasStore.getState().projects[0]!.nodes;
    };
    const source = { ...project.nodes[0]!, id: "source", metadata: { status: "idle" as const, generationOutputNodeIds: ["old-output"] } };
    const created = await createTargets(source, [source], "2");
    const root = created.find(node => node.id === source.id)!;
    const outputs = root.metadata!.generationOutputNodeIds!;
    expect(outputs).toHaveLength(2);
    expect(outputs).toEqual(root.metadata?.batchChildIds);
    expect(outputs).not.toBe(root.metadata?.batchChildIds);
    expect(outputs).not.toContain("old-output");
    const tasks = outputs.map((id, index) => ({ ...task, id: `task-${id}`, clientOperationId: `proposal:p1:source:${index}`, status: index ? "running" : "succeeded" } as GenerationTask));
    const receipts = created.map(node => {
        const index = outputs.indexOf(node.id);
        return index < 0 ? node : { ...node, metadata: { ...node.metadata, ...generationTaskMetadata(tasks[index]!), status: index ? "loading" as const : "success" as const, content: index ? undefined : "resource:ready" } };
    });
    expect(assistantProposalProgress(proposal, receipts).ready).toBe(false);
    const removed = removeCanvasNodes(receipts, new Set([outputs[1]!])).nodes;
    expect(removed.find(node => node.id === root.id)?.metadata?.batchChildIds).toEqual([outputs[0]!]);
    expect(removed.find(node => node.id === root.id)?.metadata?.generationOutputNodeIds).toEqual(outputs);
    expect(tasks[1]!.status).toBe("running");
    expect(assistantProposalProgress(proposal, removed).ready).toBe(false);
    expect(assistantProposalProgress(proposal, removed).text).toContain("无法确认这批结果是否完整");
    const cancelled = cancelIncompleteImageBatch(root.id, outputs, receipts, []).nodes;
    expect(assistantProposalProgress(proposal, cancelled).ready).toBe(false);
    const finished = receipts.map(node => outputs.includes(node.id) ? { ...node, metadata: { ...node.metadata, taskStatus: "succeeded", status: "success" as const, content: "resource:ready" } } : node);
    expect(assistantProposalProgress(proposal, finished).ready).toBe(true);
    expect(isolateCopiedNodeMetadata(root, new Map()).generationOutputNodeIds).toBeUndefined();
    const snapshot = prepareInPlaceMediaVersion([{ ...root, metadata: { ...root.metadata, content: "resource:ready" } }], root.id).find(node => node.id !== root.id)!;
    expect(snapshot.metadata?.generationOutputNodeIds).toBeUndefined();
    const regenerated = await createTargets(root, finished, "2");
    expect(regenerated.find(node => node.id === root.id)?.metadata?.generationOutputNodeIds?.some(id => outputs.includes(id))).toBe(false);
    const single = await createTargets(root, finished, "1");
    expect(single.find(node => node.id === root.id)?.metadata?.generationOutputNodeIds).toBeUndefined();
});

test("a succeeded image with a bind failure keeps its original task and HTTP evidence and blocks another paid generation", async () => {
    let submissions = 0;
    const updates: GenerationTask[] = [];
    let caught: unknown;
    try {
        await runCanvasGenerationTaskToConsumer(input, {
            prepareTarget: async () => undefined,
            bindTask: (value) => updates.push(value),
            runTask: async (options) => { submissions++; options.onTaskCreated?.(task); return { images: [] }; },
            consumeTask: async () => { throw new ApiError("原任务节点已删除，未重新创建节点", { status: 404, reason: "node_deleted" }); },
        });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(CanvasGenerationDurableAckError);
    const terminal = updates.at(-1)!;
    expect(terminal.id).toBe(task.id);
    expect(terminal.status).toBe("succeeded");
    expect(terminal.failureDiagnostics?.source).toBe("client_result");
    expect(terminal.failureDiagnostics?.requests?.[0]?.httpStatus).toBe(200);
    expect(terminal.failureDiagnostics?.summary).toContain("原任务节点已删除");
    const recovered = canvasTaskFailureMetadata(terminal, undefined, caught);
    expect(recovered.taskFailureDiagnostics?.summary).toContain("原任务节点已删除");
    expect(recovered.taskFailureDiagnostics?.executionResult).toBe("completed");
    expect(recovered.taskFailureDiagnostics?.requests?.[0]?.httpStatus).toBe(200);
    const metadata = canvasGenerationFailureMetadata(caught, { prompt: input.prompt, mode: "image" });
    expect(metadata.resourceReloadAvailable).toBe(false);
    expect(metadata.generationErrorCode).toBe("result_target_unavailable");
    expect(metadata.errorDetails).toContain("生成历史");
    expect(canvasGenerationRetryBlocked(metadata, { prompt: "已修改提示词", mode: "image" })).toBe(true);
    expect(submissions).toBe(1);
});
