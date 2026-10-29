import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { App } from "antd";
import { startOperation } from "@/stores/use-operation-progress";

import { generationTaskCanReloadResource, generationTaskNodeId } from "@/lib/canvas/canvas-generation-task-sync";
import { canvasNodeResourceId } from "@/lib/canvas/canvas-resource-id";
import { bindBackendCanvasGenerationResult, CanvasGenerationDurableAckError, CanvasGenerationMaterializationError, CanvasGenerationOutputMissingError } from "@/services/canvas-generation-consumer";
import { captureUserScope, isUserScopeAbandonedError, userScopeMatches } from "@/lib/user-scope-guard";
import { ensureCanvasNodeAsset, retryCanvasAssetSyncAfterRateLimit } from "@/services/project-asset-sync";
import { findGenerationTaskByOperation, listGenerationTasks, queryFailedVideoProviderTask, subscribeGenerationTasks, type GenerationTask } from "@/services/api/task-center";
import { useTaskDetails } from "@/hooks/use-task-details";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import { canvasNodeNeedsGenerationRecovery, consumeGenerationRecoveryRestore, isGenerationRecoveryRestored } from "@/lib/canvas/canvas-project-generation";
import { generationFailureMetadata } from "@/lib/generation-error";
import { canvasGenerationTaskNodes, canvasTaskFailureMetadata } from "./canvas-generation-failure";
import { runGenerationConsumer } from "@/services/generation-consumer-lifecycle";
import { consumeCanvasGenerationContinuation } from "./use-canvas-operation-history";

type CanvasGenerationRequest = {
    targetNodeId: string;
    originNodeId: string;
    runningNodeId: string;
    controller: AbortController;
};

type UseCanvasGenerationOptions = {
    projectId: string;
    domainProjectId?: string;
    projectLoaded: boolean;
    nodes: CanvasNodeData[];
    nodesRef: { current: CanvasNodeData[] };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
};

const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;
const NODE_STATUS_ERROR = "error" as const;
const INTERRUPTED_GENERATION_DETAILS = "页面刷新后本地生成已中断，请重新生成。";

function recoveryTaskIdentity(node: CanvasNodeData) {
    return node.metadata?.taskId || node.metadata?.agentGenerationContinuation?.taskId || "";
}

// 恢复器对一个节点的认领：只有认领还在、节点仍是认领时的任务身份，恢复结果才写回这个节点。
type GenerationRecoveryClaim = { node: CanvasNodeData; identity: string };

export function subscribeCanvasGenerationRecoveryTasks(ids: readonly string[], listener: (task: GenerationTask) => void, subscribe: (ids: readonly string[], listener: (task: GenerationTask) => void) => () => void = subscribeGenerationTasks) {
    return subscribe(Array.from(new Set(ids)), listener);
}

export type CanvasGenerationRecoveryContext = {
    projectId: string;
    controller: AbortController;
    signal: AbortSignal;
    isCurrentProject: () => boolean;
};

export function createCanvasGenerationRecoveryCoordinator() {
    let active:
        | {
              token: symbol;
              controller: AbortController;
          }
        | undefined;
    let transitionTail = Promise.resolve();

    return {
        switchProject(projectId: string, operation: (context: CanvasGenerationRecoveryContext) => Promise<void>) {
            active?.controller.abort();
            const token = Symbol(projectId);
            const controller = new AbortController();
            const previousTail = transitionTail;
            const settled = previousTail.then(async () => {
                if (controller.signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
                await operation({
                    projectId,
                    controller,
                    signal: controller.signal,
                    isCurrentProject: () => active?.token === token && !controller.signal.aborted,
                });
            });
            active = { token, controller };
            transitionTail = settled.then(
                () => undefined,
                () => undefined,
            );
            return settled;
        },
        async abortAndDrain() {
            active?.controller.abort();
            active = undefined;
            await transitionTail;
        },
    };
}

export async function recoverCanvasGenerationTaskNode(input: {
    projectId: string;
    node: CanvasNodeData;
    completed: GenerationTask;
    continuationOnly: boolean;
    nodesRef: { current: CanvasNodeData[] };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    applyGenerationTaskResult: (nodeId: string, task: GenerationTask) => Promise<void>;
    signal: AbortSignal;
    isCurrentProject?: () => boolean;
    consumeContinuation?: typeof consumeCanvasGenerationContinuation;
}) {
    const isCurrentProject = () => !input.signal.aborted && (input.isCurrentProject?.() ?? true);
    if (!isCurrentProject()) return;
    const consumeContinuation = input.consumeContinuation ?? consumeCanvasGenerationContinuation;
    try {
        if (input.completed.projectId && input.completed.projectId !== input.projectId) throw new Error("生成任务不属于当前画布");
        if (!isCurrentProject()) return;
        if (input.completed.status === "failed" || input.completed.status === "cancelled") {
            throw new Error(input.completed.error || (input.completed.status === "cancelled" ? "任务已取消" : "任务失败"));
        }
        if (!input.continuationOnly) {
            if (!isCurrentProject()) return;
            await input.applyGenerationTaskResult(input.node.id, input.completed);
        }
        if (!isCurrentProject()) return;
        const continuation = input.nodesRef.current.find((item) => item.id === input.node.id)?.metadata?.agentGenerationContinuation ?? input.node.metadata?.agentGenerationContinuation;
        if (continuation?.status === "pending" && continuation.taskId === input.completed.id) {
            await consumeContinuation(
                input.completed,
                continuation,
                (nextContinuation) => {
                    if (!isCurrentProject()) return;
                    input.setNodes((current) =>
                        current.map((item) =>
                            item.id === input.node.id
                                ? {
                                      ...item,
                                      metadata: {
                                          ...item.metadata,
                                          agentGenerationContinuation: nextContinuation,
                                          ...(nextContinuation.effectKey
                                              ? {
                                                    generationEffectKeys: Array.from(new Set([...(item.metadata?.generationEffectKeys || []), nextContinuation.effectKey])),
                                                }
                                              : {}),
                                      },
                                  }
                                : item,
                        ),
                    );
                },
                { projectId: input.projectId, nodeId: input.node.id, nodesRef: input.nodesRef, setNodes: input.setNodes },
                input.signal,
            );
        }
    } catch (error) {
        if (!isCurrentProject() || (error instanceof Error && error.name === "AbortError")) return;
        const failure = canvasTaskFailureMetadata(input.completed, input.nodesRef.current.find((item) => item.id === input.node.id)?.metadata || input.node.metadata, error);
        input.setNodes((current) =>
            current.map((item) =>
                item.id === input.node.id
                    ? {
                          ...item,
                          metadata: {
                              ...item.metadata,
                              status: input.continuationOnly ? item.metadata?.status : NODE_STATUS_ERROR,
                              ...(input.continuationOnly ? {} : failure),
                              ...(item.metadata?.agentGenerationContinuation?.status === "pending"
                                  ? {
                                        agentGenerationContinuation: { ...item.metadata.agentGenerationContinuation, status: "failed" as const },
                                    }
                                  : {}),
                          },
                      }
                    : item,
            ),
        );
    }
}

export function useCanvasGeneration({ projectId, domainProjectId, projectLoaded, nodes, nodesRef, setNodes }: UseCanvasGenerationOptions) {
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const generationRequestsRef = useRef(new Map<string, CanvasGenerationRequest>());
    const recoveringTaskIdsRef = useRef(new Set<string>());
    // 正在恢复的节点及其认领：同一节点同一任务同时只交给恢复器一次；新认领或新请求会顶掉旧认领。
    const recoveringNodesRef = useRef(new Map<string, GenerationRecoveryClaim>());
    const lateRecoveryRef = useRef<(() => void) | null>(null);
    const autoSavedTaskIdsRef = useRef(new Set<string>());
    const consumerControllerRef = useRef(new AbortController());
    const projectIdRef = useRef(projectId);
    projectIdRef.current = projectId;
    const recoveryCoordinatorRef = useRef<ReturnType<typeof createCanvasGenerationRecoveryCoordinator> | null>(null);
    if (!recoveryCoordinatorRef.current) recoveryCoordinatorRef.current = createCanvasGenerationRecoveryCoordinator();
    const [runningNodeId, setRunningNodeId] = useState<string | null>(null);
    const [taskDetail, setTaskDetail] = useState<GenerationTask | null>(null);
    const [retrievingTaskId, setRetrievingTaskId] = useState<string | null>(null);
    const retrievalRef = useRef<object | null>(null);
    const taskDetailQuery = useTaskDetails(taskDetail?.id, projectId);
    const localMode = isLocalWorkspaceMode();

    useEffect(() => setTaskDetail(null), [projectId]);

    const startGenerationRequest = useCallback((targetNodeId: string, originNodeId: string, runningId = originNodeId, controller = new AbortController()) => {
        const previous = generationRequestsRef.current.get(targetNodeId);
        if (previous?.controller !== controller) previous?.controller.abort();
        // 用户在这些节点上开始了新请求：之前的恢复不再拥有它们，旧任务的结果不会写回。
        [targetNodeId, originNodeId, runningId].forEach((id) => recoveringNodesRef.current.delete(id));
        generationRequestsRef.current.set(targetNodeId, { targetNodeId, originNodeId, runningNodeId: runningId, controller });
        return controller;
    }, []);

    const finishGenerationRequest = useCallback((targetNodeId: string, controller: AbortController) => {
        const request = generationRequestsRef.current.get(targetNodeId);
        if (request?.controller === controller) generationRequestsRef.current.delete(targetNodeId);
    }, []);

    const openNodeTaskDetails = useCallback(
        async (node: CanvasNodeData) => {
            const taskId = node.metadata?.taskId;
            if (!taskId) return;
            setTaskDetail({
                id: taskId,
                type: "",
                status: (node.metadata?.taskStatus as GenerationTask["status"]) || "running",
                stage: node.metadata?.taskStage,
                progress: node.metadata?.taskProgress,
                prompt: node.metadata?.prompt || "",
                attempts: 1,
                createdAt: node.metadata?.taskCreatedAt || new Date().toISOString(),
                updatedAt: node.metadata?.taskUpdatedAt || new Date().toISOString(),
            });
        },
        [],
    );

    const bindGenerationTask = useCallback(
        (targetNodeId: string, task: GenerationTask) => {
            if (projectIdRef.current !== projectId) return;
            const current = task.type === "canvas_image" || nodesRef.current.some((node) => node.id === targetNodeId)
                ? nodesRef.current
                : useCanvasStore.getState().openProject(projectId)?.nodes ?? nodesRef.current;
            const next = canvasGenerationTaskNodes(current, targetNodeId, task);
            // 成功终态可能在同一轮到达；消费结果前就要让保存器看见 taskId。
            useCanvasStore.getState().updateProject(projectId, { nodes: next });
            nodesRef.current = next;
            // A receipt can share a React batch with another node's recovery.
            // Apply it to the queued state too, so that update is not replaced
            // by the earlier nodesRef snapshot.
            setNodes(current => projectIdRef.current === projectId ? canvasGenerationTaskNodes(current, targetNodeId, task) : current);
        },
        [nodesRef, projectId, setNodes],
    );

    const saveGeneratedAsset = useCallback(
        async (node: CanvasNodeData, taskId: string, signal?: AbortSignal) => {
            const result = await retryCanvasAssetSyncAfterRateLimit(() => ensureCanvasNodeAsset({ canvasId: projectId, domainProjectId, node, source: "canvas-generation", taskId, signal }), { signal });
            setNodes((current) => current.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, assetId: result.assetId } } : item)));
            if (domainProjectId) await queryClient.invalidateQueries({ queryKey: ["project", domainProjectId] });
        },
        [domainProjectId, projectId, queryClient, setNodes],
    );

    const applyGenerationTaskResult = useCallback(
        async (nodeId: string, task: GenerationTask, isNodeOwned: () => boolean = () => true) => {
            const capturedScope = captureUserScope();
            const capturedCanvasId = projectId;
            const controller = consumerControllerRef.current;
            const isCurrentCanvas = () => projectIdRef.current === capturedCanvasId && !controller.signal.aborted && userScopeMatches(capturedScope) && isNodeOwned();
            if (!isCurrentCanvas()) throw new DOMException("The canvas operation was abandoned", "AbortError");
            if (task.status !== "succeeded") {
                if (generationTaskCanReloadResource(task) && isCurrentCanvas()) {
                    setNodes((current) => current.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, resourceReloadAvailable: true } } : node)));
                }
                throw new Error(task.error || (task.status === "cancelled" ? "任务已取消" : "任务失败"));
            }
            let saving: ReturnType<typeof startOperation> | undefined;
            try {
                await bindBackendCanvasGenerationResult({
                    canvasId: capturedCanvasId,
                    nodeId,
                    task,
                    outputIndex: nodesRef.current.find((node) => node.id === nodeId)?.metadata?.taskOutputIndex ?? 0,
                    signal: controller.signal,
                    isCurrent: isCurrentCanvas,
                    isNodeOwned,
                    nodesRef,
                    setNodes,
                    onPhaseChange: task.type === "canvas_video" ? (phase) => {
                        saving?.dismiss();
                        saving = undefined;
                        if (phase !== "saving" || !isCurrentCanvas()) return;
                        saving = startOperation("保存生成结果", { owner: capturedScope, target: { projectId: capturedCanvasId, nodeId, taskId: task.id }, detail: "正在保存视频并更新画布" });
                        saving.update({ phase: "processing" });
                    } : undefined,
                });
                if (!isCurrentCanvas()) throw new DOMException("The canvas operation was abandoned", "AbortError");
            } catch (error) {
                if (error instanceof Error && error.name === "AbortError") throw error;
                if (isUserScopeAbandonedError(error)) throw error;
                throw error instanceof CanvasGenerationDurableAckError || error instanceof CanvasGenerationMaterializationError || error instanceof CanvasGenerationOutputMissingError ? error : new CanvasGenerationDurableAckError(error);
            } finally {
                saving?.dismiss();
            }
        },
        [nodesRef, projectId, setNodes],
    );

    const retrieveTaskResult = useCallback(async (task: GenerationTask) => {
        if (retrievalRef.current) return;
        const retrieval = {};
        retrievalRef.current = retrieval;
        const signal = consumerControllerRef.current.signal;
        setRetrievingTaskId(task.id);
        try {
            const result = await queryFailedVideoProviderTask(task.id);
            if (signal.aborted) return;
            await queryClient.cancelQueries({ queryKey: ["task-details", projectId, task.id] });
            if (signal.aborted) return;
            queryClient.setQueryData(["task-details", projectId, task.id], (current: { task: GenerationTask; logs: unknown[] } | undefined) => ({ task: result.task, logs: current?.logs ?? [] }));
            if (result.recovered) {
                const node = nodesRef.current.find((item) => item.metadata?.taskId === task.id);
                if (!node) throw new Error("视频已取回，请在生成历史中查看");
                await applyGenerationTaskResult(node.id, result.task);
                if (signal.aborted) return;
                message.success("视频已取回并放回画布，未重新生成");
            } else {
                message.info("原任务仍在处理中，请稍后再取回结果");
            }
            void queryClient.invalidateQueries({ queryKey: ["task-details", projectId, task.id] });
        } catch (error) {
            if (!signal.aborted) message.error(error instanceof Error ? error.message : "暂时无法取回结果，请稍后再试");
        } finally {
            if (retrievalRef.current === retrieval) {
                retrievalRef.current = null;
                setRetrievingTaskId(null);
            }
        }
    }, [applyGenerationTaskResult, message, nodesRef, projectId, queryClient]);

    const observeSubscribedGenerationTask = useCallback(
        (taskId: string, signal: AbortSignal, onUpdate?: (task: GenerationTask) => void) =>
            new Promise<GenerationTask>((resolve, reject) => {
                let unsubscribe: (() => void) | undefined;
                let settled = false;
                const cleanup = () => {
                    signal.removeEventListener("abort", onAbort);
                    unsubscribe?.();
                };
                const onAbort = () => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    reject(new DOMException("Aborted", "AbortError"));
                };
                const onTask = (task: GenerationTask) => {
                    if (settled) return;
                    onUpdate?.(task);
                    if (task.status !== "succeeded" && task.status !== "failed" && task.status !== "cancelled") return;
                    settled = true;
                    cleanup();
                    resolve(task);
                };
                if (signal.aborted) return onAbort();
                signal.addEventListener("abort", onAbort, { once: true });
                unsubscribe = subscribeCanvasGenerationRecoveryTasks([taskId], onTask);
                if (settled) unsubscribe();
            }),
        [],
    );

    // 本次会话里正在执行的生成请求（目标、配置、运行节点）由它自己的消费者负责，恢复器不碰，避免误停、误标错或重复订阅。
    const isLiveRequestNode = useCallback((nodeId: string) => Array.from(generationRequestsRef.current.values()).some((request) => request.targetNodeId === nodeId || request.originNodeId === nodeId || request.runningNodeId === nodeId), []);

    const selectRecoveryNodes = useCallback(
        (candidates: CanvasNodeData[]) =>
            candidates.filter((node) => {
                if (!canvasNodeNeedsGenerationRecovery(node) || isLiveRequestNode(node.id)) return false;
                const identity = recoveryTaskIdentity(node);
                return recoveringNodesRef.current.get(node.id)?.identity !== identity && !(identity && recoveringTaskIdsRef.current.has(identity));
            }),
        [isLiveRequestNode],
    );

    const claimRecoveryNodes = useCallback(
        (selected: CanvasNodeData[]) =>
            selected.map((node) => {
                const claim: GenerationRecoveryClaim = { node, identity: recoveryTaskIdentity(node) };
                recoveringNodesRef.current.set(node.id, claim);
                return claim;
            }),
        [],
    );

    const recoverInterruptedGenerationTasks = useCallback(
        async (startedProjectId: string, signal: AbortSignal, isCurrentProject: () => boolean, lateClaims?: GenerationRecoveryClaim[]) => {
            if (!isCurrentProject()) return;
            let claims = lateClaims;
            if (!claims) {
                claims = claimRecoveryNodes(selectRecoveryNodes(nodesRef.current));
                // 首次扫描已覆盖当前全部节点，这次恢复的记录不再交给后到补扫。
                consumeGenerationRecoveryRestore(nodesRef.current);
            }
            const recoveryNodes = claims.map((claim) => claim.node);
            const recoveredNodeIds = new Set(recoveryNodes.map((node) => node.id));
            const needsDiscovery = recoveryNodes.some((node) => !node.metadata?.taskId && !node.metadata?.agentGenerationContinuation?.taskId);
            const projectTasks = needsDiscovery && !localMode
                ? (
                      await listGenerationTasks(100, { projectId: startedProjectId }, undefined, signal).catch((error) => {
                          if (!isCurrentProject()) throw error;
                          return [];
                      })
                  ).filter((task) => task.projectId === startedProjectId && task.type.startsWith("canvas_"))
                : [];
            if (!isCurrentProject()) return;
            await Promise.all(
                claims.map(async (claim) => {
                    const { node } = claim;
                    // 节点只接受认领时的任务（或为它找到的任务）的结果；任务身份变了、用户又发起了请求或认领被顶掉，就不再写回。
                    const allowedIdentities = new Set([claim.identity]);
                    const ownsNode = (item: CanvasNodeData) => isCurrentProject() && !isLiveRequestNode(item.id) && allowedIdentities.has(recoveryTaskIdentity(item));
                    const owns = () => {
                        if (!isCurrentProject() || recoveringNodesRef.current.get(node.id) !== claim) return false;
                        const current = nodesRef.current.find((item) => item.id === node.id);
                        return Boolean(current && ownsNode(current));
                    };
                    try {
                        let discoveredTask = projectTasks.find((task) => generationTaskNodeId(task) === node.id);
                        if (!node.metadata?.taskId && node.metadata?.taskClientOperationId) {
                            try {
                                discoveredTask = await findGenerationTaskByOperation(node.metadata.taskClientOperationId, startedProjectId, signal);
                                if (discoveredTask && generationTaskNodeId(discoveredTask) !== node.id) discoveredTask = undefined;
                            } catch {
                                // A failed lookup cannot prove that the paid submission was rejected.
                            }
                        }
                        const taskId = node.metadata?.taskId || node.metadata?.agentGenerationContinuation?.taskId || discoveredTask?.id;
                        if (!taskId) {
                            if (!owns()) return;
                            setNodes((current) =>
                                current.map((item) =>
                                    item.id === node.id && ownsNode(item)
                                        ? {
                                              ...item,
                                              metadata: {
                                                  ...item.metadata,
                                                  status: NODE_STATUS_ERROR,
                                                  ...(item.metadata?.taskClientOperationId
                                                      ? {
                                                            generationSubmissionState: "unknown" as const,
                                                            taskStage: "提交结果待确认",
                                                            errorDetails: "尚未查到上次提交的任务，请稍后重新打开画布查询，暂勿重新生成",
                                                        }
                                                      : { errorDetails: INTERRUPTED_GENERATION_DETAILS }),
                                              },
                                          }
                                        : item,
                                ),
                            );
                            return;
                        }
                        allowedIdentities.add(taskId);
                        if (recoveringTaskIdsRef.current.has(taskId)) return;
                        recoveringTaskIdsRef.current.add(taskId);
                        const continuationOnly = !node.metadata?.taskId && node.metadata?.agentGenerationContinuation?.taskId === taskId && !discoveredTask;
                        try {
                            const completed = await observeSubscribedGenerationTask(taskId, signal, (task) => {
                                if (owns() && !continuationOnly) bindGenerationTask(node.id, task);
                            });
                            if (!owns()) return;
                            await recoverCanvasGenerationTaskNode({
                                projectId: startedProjectId,
                                node,
                                completed,
                                continuationOnly,
                                nodesRef,
                                setNodes,
                                applyGenerationTaskResult: (nodeId, task) => applyGenerationTaskResult(nodeId, task, owns),
                                signal,
                                isCurrentProject: owns,
                            });
                        } catch (error) {
                            if (!owns() || (error instanceof Error && error.name === "AbortError")) return;
                            const currentMetadata = nodesRef.current.find((item) => item.id === node.id)?.metadata || node.metadata;
                            const failure = generationFailureMetadata(error, currentMetadata?.prompt || "", currentMetadata?.references || []);
                            if (failure.failedInputFingerprint && currentMetadata?.failedInputFingerprint) {
                                failure.failedInputFingerprint = currentMetadata.failedInputFingerprint;
                                failure.failedPromptFingerprint = currentMetadata.failedPromptFingerprint;
                            }
                            setNodes((current) =>
                                current.map((item) =>
                                    item.id === node.id && ownsNode(item)
                                        ? {
                                              ...item,
                                              metadata: {
                                                  ...item.metadata,
                                                  status: continuationOnly ? item.metadata?.status : NODE_STATUS_ERROR,
                                                  ...(continuationOnly ? {} : failure),
                                                  ...(item.metadata?.agentGenerationContinuation?.status === "pending"
                                                      ? {
                                                            agentGenerationContinuation: { ...item.metadata.agentGenerationContinuation, status: "failed" as const },
                                                        }
                                                      : {}),
                                              },
                                          }
                                        : item,
                                ),
                            );
                        } finally {
                            recoveringTaskIdsRef.current.delete(taskId);
                        }
                    } finally {
                        if (recoveringNodesRef.current.get(node.id) === claim) recoveringNodesRef.current.delete(node.id);
                    }
                }),
            );
            if (!isCurrentProject()) return;
            setNodes((current) =>
                isCurrentProject()
                    ? current.map((node) => {
                          if (!node.metadata?.isBatchRoot || !node.metadata.batchChildIds?.length || node.metadata.taskId) return node;
                          // 本次会话正在生成的批次由它自己的请求维护；后到快照只重算含本轮恢复节点的批次。
                          if (isLiveRequestNode(node.id) || (lateClaims && !node.metadata.batchChildIds.some((id) => recoveredNodeIds.has(id)))) return node;
                          const children = node.metadata.batchChildIds.map((id) => current.find((item) => item.id === id)).filter(Boolean) as CanvasNodeData[];
                          const primary = children.find((item) => item.id === node.metadata?.primaryImageId && item.metadata?.content) || children.find((item) => item.metadata?.content);
                          const loading = children.some((item) => item.metadata?.status === NODE_STATUS_LOADING);
                          const failed = children.find((item) => item.metadata?.status === NODE_STATUS_ERROR);
                          const nextMetadata: NonNullable<CanvasNodeData["metadata"]> = {
                              ...node.metadata,
                              ...(primary
                                  ? {
                                        content: primary.metadata?.content,
                                        storageKey: primary.metadata?.storageKey,
                                        mimeType: primary.metadata?.mimeType,
                                        bytes: primary.metadata?.bytes,
                                        naturalWidth: primary.metadata?.naturalWidth,
                                        naturalHeight: primary.metadata?.naturalHeight,
                                        primaryImageId: primary.id,
                                    }
                                  : {
                                        content: undefined,
                                        storageKey: undefined,
                                        mimeType: undefined,
                                        bytes: undefined,
                                        naturalWidth: undefined,
                                        naturalHeight: undefined,
                                        primaryImageId: undefined,
                                    }),
                              status: primary ? NODE_STATUS_SUCCESS : loading ? NODE_STATUS_LOADING : NODE_STATUS_ERROR,
                              errorDetails: primary ? undefined : failed?.metadata?.errorDetails || "全部图片生成失败",
                          };
                          const nextNode: CanvasNodeData = { ...node, metadata: nextMetadata };
                          const primaryResourceId = primary ? canvasNodeResourceId(primary) : "";
                          const rootResourceId = canvasNodeResourceId(nextNode);
                          if (primary?.metadata?.assetId && primaryResourceId && rootResourceId && primaryResourceId === rootResourceId) {
                              nextMetadata.assetId = primary.metadata.assetId;
                          } else {
                              delete nextMetadata.assetId;
                          }
                          return nextNode;
                      })
                    : current,
            );
        },
        [applyGenerationTaskResult, bindGenerationTask, claimRecoveryNodes, isLiveRequestNode, localMode, nodesRef, observeSubscribedGenerationTask, selectRecoveryNodes, setNodes],
    );

    useEffect(() => {
        const coordinator = recoveryCoordinatorRef.current!;
        if (!projectLoaded) {
            void coordinator.abortAndDrain();
            return;
        }
        void coordinator
            .switchProject(projectId, async (context) => {
                recoveringTaskIdsRef.current.clear();
                recoveringNodesRef.current.clear();
                consumerControllerRef.current = context.controller;
                const scans = new Set<Promise<void>>();
                const scan = (lateClaims?: GenerationRecoveryClaim[]) => {
                    const run = runGenerationConsumer(context.signal, async (signal) => recoverInterruptedGenerationTasks(context.projectId, signal, () => !signal.aborted && context.isCurrentProject(), lateClaims));
                    scans.add(run);
                    void run.then(
                        () => scans.delete(run),
                        () => scans.delete(run),
                    );
                    return run;
                };
                // 画布先用缓存打开、云端版本随后才到时，后到快照里待恢复的节点沿用同一个恢复上下文补订阅；
                // 切换画布或卸载时随这个上下文一起中止，并在下一画布开始恢复前等它们收尾。
                // 只看这次快照恢复交来的节点：普通刷新合并的节点、本次会话里分镜等流程自己维护的节点都不在其中。
                const recoverLateNodes = () => {
                    if (!context.isCurrentProject()) return;
                    const restored = nodesRef.current.filter(isGenerationRecoveryRestored);
                    if (!restored.length) return;
                    const claims = claimRecoveryNodes(selectRecoveryNodes(restored));
                    // 只交出一次；跳过的节点（本次会话的请求、已在恢复的同一任务）也一并清掉。
                    consumeGenerationRecoveryRestore(restored);
                    if (!claims.length) return;
                    scan(claims).catch((error) => {
                        if (!(error instanceof Error && error.name === "AbortError")) throw error;
                    });
                };
                lateRecoveryRef.current = recoverLateNodes;
                try {
                    await scan();
                    await new Promise<void>((resolve) => {
                        if (context.signal.aborted) resolve();
                        else context.signal.addEventListener("abort", () => resolve(), { once: true });
                    });
                } finally {
                    if (lateRecoveryRef.current === recoverLateNodes) lateRecoveryRef.current = null;
                    await Promise.allSettled(scans);
                }
            })
            .catch((error) => {
                if (!(error instanceof Error && error.name === "AbortError")) throw error;
            });
        return () => {
            void coordinator.abortAndDrain();
        };
    }, [claimRecoveryNodes, nodesRef, projectId, projectLoaded, recoverInterruptedGenerationTasks, selectRecoveryNodes]);

    useEffect(() => {
        if (projectLoaded) lateRecoveryRef.current?.();
    }, [nodes, projectLoaded]);

    // 本地任务同样持久化在任务表中，优先由上面的任务恢复流程按 taskId 对账。
    // 这里只把没有持久任务身份的孤立 loading 快照标记为中断，避免覆盖已完成任务。
    useEffect(() => {
        if (!projectLoaded || !localMode) return;
        setNodes((current) => {
            let changed = false;
            const next = current.map((node) => {
                const metadata = node.metadata;
                if (!metadata || metadata.status !== NODE_STATUS_LOADING || metadata.content || metadata.taskId || metadata.taskClientOperationId || metadata.agentGenerationContinuation?.status === "pending" || generationRequestsRef.current.has(node.id)) return node;
                changed = true;
                return {
                    ...node,
                    metadata: {
                        ...metadata,
                        status: NODE_STATUS_ERROR,
                        taskStatus: "failed" as const,
                        taskStage: undefined,
                        taskUpdatedAt: new Date().toISOString(),
                        errorDetails: INTERRUPTED_GENERATION_DETAILS,
                    },
                };
            });
            return changed ? next : current;
        });
    }, [localMode, projectLoaded, setNodes]);

    useEffect(
        () => () => {
            void recoveryCoordinatorRef.current?.abortAndDrain();
            consumerControllerRef.current.abort();
            generationRequestsRef.current.forEach((request) => request.controller.abort());
            generationRequestsRef.current.clear();
        },
        [projectId],
    );

    useEffect(() => {
        if (!projectLoaded || localMode) return;
        nodes.forEach((node) => {
            const taskId = node.metadata?.taskId;
            if (!taskId || !node.metadata?.content || node.metadata.status !== NODE_STATUS_SUCCESS || (node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video && node.type !== CanvasNodeType.Audio)) return;
            const saveKey = `${taskId}:${node.id}:${domainProjectId || "personal"}`;
            if (autoSavedTaskIdsRef.current.has(saveKey)) return;
            autoSavedTaskIdsRef.current.add(saveKey);
            void runGenerationConsumer(consumerControllerRef.current.signal, async (signal) => {
                await saveGeneratedAsset(node, taskId, signal);
            }).catch((error) => {
                autoSavedTaskIdsRef.current.delete(saveKey);
                if (error instanceof Error && error.name === "AbortError") return;
                message.warning({
                    key: `canvas-asset-sync:${projectId}`,
                    content: error instanceof Error ? `生成结果已保留，但项目资产同步失败：${error.message}` : "生成结果已保留，但项目资产同步失败",
                    duration: 4,
                });
            });
        });
    }, [domainProjectId, localMode, message, nodes, projectId, projectLoaded, saveGeneratedAsset]);

    return {
        applyGenerationTaskResult,
        bindGenerationTask,
        finishGenerationRequest,
        openNodeTaskDetails,
        retrieveTaskResult,
        retrievingTaskId,
        runningNodeId,
        setRunningNodeId,
        setTaskDetail,
        startGenerationRequest,
        taskDetail: taskDetail ? taskDetailQuery.data?.task ?? taskDetail : null,
        taskDetailLoading: taskDetailQuery.isLoading,
        taskDetailError: taskDetailQuery.isError,
        taskDetailLogs: taskDetailQuery.data?.logs ?? [],
    };
}
