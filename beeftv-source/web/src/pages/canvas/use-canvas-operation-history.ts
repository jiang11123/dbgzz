import type { Dispatch, SetStateAction } from "react";

import { persistCanvasOperationContinuationEffect } from "@/services/canvas-generation-consumer";
import { consumeGenerationTaskAgent } from "@/services/project-asset-sync";
import type { GenerationTask } from "@/services/api/task-center";
import type { CanvasNodeData } from "@/types/canvas";

type CanvasGenerationContinuation = NonNullable<NonNullable<CanvasNodeData["metadata"]>["agentGenerationContinuation"]>;

type CanvasGenerationContinuationDependencies = {
    consumeAgent?: typeof consumeGenerationTaskAgent;
    persistContinuation?: typeof persistCanvasOperationContinuationEffect;
    projectId?: string;
    nodeId?: string;
    nodesRef?: { current: CanvasNodeData[] };
    setNodes?: Dispatch<SetStateAction<CanvasNodeData[]>>;
};

// 画布工具生成的续跑消费：任务成功后把生成结果写回节点并标记 continuation 完成。
// 旧内置 Agent 的私有撤销栈（useCanvasOperationHistory）与 agent 事件订阅已随该功能退场，
// 用户可见的撤销仍由 useCanvasHistory 提供。
export async function consumeCanvasGenerationContinuation(
    task: GenerationTask,
    continuation: CanvasGenerationContinuation,
    onCompleted: (continuation: CanvasGenerationContinuation, signal?: AbortSignal) => Promise<void> | void,
    dependencies: CanvasGenerationContinuationDependencies = {},
    signal?: AbortSignal,
) {
    if (continuation.status !== "pending" || continuation.taskId !== task.id || task.status !== "succeeded") return task;
    const consumeAgent = dependencies.consumeAgent ?? consumeGenerationTaskAgent;
    return consumeAgent(
        task,
        continuation.id,
        async ({ effectKey, signal: leaseSignal }) => {
            const completed = { ...continuation, status: "completed" as const, effectKey };
            if (dependencies.projectId && dependencies.nodeId && dependencies.nodesRef && dependencies.setNodes) {
                await (dependencies.persistContinuation ?? persistCanvasOperationContinuationEffect)({
                    projectId: dependencies.projectId,
                    nodeId: dependencies.nodeId,
                    continuation: completed,
                    effectKey,
                    signal: leaseSignal,
                    nodesRef: dependencies.nodesRef,
                    setNodes: dependencies.setNodes,
                });
            }
            await onCompleted(completed, leaseSignal);
        },
        { signal },
    );
}
