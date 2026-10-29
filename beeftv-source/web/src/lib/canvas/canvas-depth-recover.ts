import { depthCaptureTaskMetadata, depthCaptureWaitFailureMetadata, isDepthCaptureResultNode } from "@/lib/canvas/canvas-depth-capture";
import { assertLocalExecutorSession, beginLocalExecutorSession, isLocalExecutorSessionStop, observeLocalExecutorTask, type LocalExecutorSession } from "@/lib/plugins/builtin/editor/local-executor-session";
import type { CapturedUserScope } from "@/lib/user-scope-guard";
import type { GenerationTask } from "@/services/api/task-center";
import { bindBackendCanvasGenerationResult } from "@/services/canvas-generation-consumer";
import type { CanvasNodeData } from "@/types/canvas";

type DepthTarget = {
    node: CanvasNodeData;
    session: LocalExecutorSession;
    nodesRef: { current: CanvasNodeData[] };
    setNodes: (updater: (current: CanvasNodeData[]) => CanvasNodeData[]) => void;
};

function ownsTask(input: DepthTarget, node: CanvasNodeData) {
    return node.id === input.node.id && node.metadata?.taskId === input.node.metadata?.taskId;
}

function updateDepthTarget(input: DepthTarget, update: (node: CanvasNodeData) => CanvasNodeData) {
    assertLocalExecutorSession(input.session);
    input.nodesRef.current = input.nodesRef.current.map(node => ownsTask(input, node) ? update(node) : node);
    input.setNodes(current => current.map(node => ownsTask(input, node) ? update(node) : node));
}

// First completion, retry and reopen share the backend binding receipt. The
// backend patches the current node and refuses deleted or replaced targets.
export async function attachOwnedDepthCaptureResult(input: DepthTarget & { task: GenerationTask }, bind = bindBackendCanvasGenerationResult) {
    assertLocalExecutorSession(input.session);
    if (!input.nodesRef.current.some(node => ownsTask(input, node))) return;
    await bind({
        canvasId: input.session.projectId,
        nodeId: input.node.id,
        task: input.task,
        signal: input.session.controller.signal,
        nodesRef: input.nodesRef,
        setNodes: value => input.setNodes(current => typeof value === "function" ? value(current) : value),
        isCurrent: () => {
            assertLocalExecutorSession(input.session);
            return input.nodesRef.current.some(node => ownsTask(input, node));
        },
        runtime: { captureScope: () => input.session.expectedScope },
    });
}

export async function recoverOwnedDepthCaptureNode(input: DepthTarget, bind = bindBackendCanvasGenerationResult): Promise<void> {
    const taskId = input.node.metadata?.taskId;
    if (!taskId) {
        updateDepthTarget(input, node => ({ ...node, metadata: { ...node.metadata, status: "error", errorDetails: "深度任务未成功提交，请重新生成" } }));
        return;
    }
    let latestTask: GenerationTask | undefined;
    try {
        const task = await observeLocalExecutorTask(taskId, input.session, {
            intervalMs: 1000,
            onTaskUpdate: task => {
                latestTask = task;
                updateDepthTarget(input, node => ({ ...node, metadata: { ...node.metadata, ...depthCaptureTaskMetadata(task) } }));
            },
        });
        await attachOwnedDepthCaptureResult({ ...input, task }, bind);
    } catch (error) {
        if (isLocalExecutorSessionStop(error)) return;
        try { assertLocalExecutorSession(input.session); } catch (stop) {
            if (isLocalExecutorSessionStop(stop)) return;
            throw stop;
        }
        // Attachment failure must never turn a succeeded task into a failed one.
        updateDepthTarget(input, node => ({ ...node, metadata: { ...node.metadata, ...depthCaptureWaitFailureMetadata(error, latestTask || taskId) } }));
    }
}

export function recoverOwnedDepthCaptureNodes(input: {
    nodesRef: { current: CanvasNodeData[] };
    signal: AbortSignal;
    expectedScope: CapturedUserScope;
    projectId: string;
    getLiveProjectId: () => string;
    observers: Set<AbortController>;
    setNodes: DepthTarget["setNodes"];
}): void {
    if (input.signal.aborted) return;
    for (const node of input.nodesRef.current) {
        if (node.metadata?.generationErrorCode === "result_target_unavailable") continue;
        if (!isDepthCaptureResultNode(node) || (node.metadata?.status !== "loading" && !(node.metadata?.status === "error" && node.metadata.taskId))) continue;
        const observer = new AbortController();
        input.observers.add(observer);
        const onAbort = () => observer.abort();
        if (input.signal.aborted) onAbort();
        else input.signal.addEventListener("abort", onAbort, { once: true });
        const session = beginLocalExecutorSession(input.projectId, { controller: observer, getLiveProjectId: input.getLiveProjectId, expectedScope: input.expectedScope });
        void recoverOwnedDepthCaptureNode({ node, session, nodesRef: input.nodesRef, setNodes: input.setNodes }).finally(() => {
            input.signal.removeEventListener("abort", onAbort);
            input.observers.delete(observer);
        });
    }
}
