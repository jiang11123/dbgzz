import { nanoid } from "nanoid";
import { projectCanvasGenerationSubmission, rebaseCanvasGenerationTarget } from "@/lib/canvas/canvas-generation-live-target";

import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { canGenerateImageInPlace, findAvailableGenerationGroupPosition, imageGenerationChildPosition, generationFailureNodeStatus, imageGenerationGroupSize } from "@/lib/canvas/canvas-generation-layout";
import { cancelIncompleteImageBatch, retireImageBatchChildren } from "@/lib/canvas/canvas-image-batch-retry";
import { buildImageGenerationNodeTitle } from "@/lib/canvas/canvas-generation-title";
import { nodeSizeFromRatio } from "@/lib/canvas/canvas-node-size";
import { canvasImageReferenceLimitError, buildImageGenerationMetadata, clearInPlaceMediaOutputMetadata, getGenerationCount, isGenerationCanceled, resetGenerationTaskMetadata, runCanvasGenerationTaskToConsumer } from "@/lib/canvas/canvas-project-generation";
import { imageGenerationReferenceConnections } from "@/lib/canvas/canvas-resource-references";
import { canvasGenerationPromptMetadata } from "@/lib/canvas/canvas-generation-submission";
import { mediaResultMetadata } from "@/lib/canvas/canvas-node-semantics";
import { doubaoImageProviderOptions } from "@/lib/doubao-image-model";
import { CONTENT_MODERATION_ERROR_CODE, type GenerationFailureMetadata } from "@/lib/generation-error";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { assertUserScope, captureUserScope, isUserScopeAbandonedError, userScopeMatches } from "@/lib/user-scope-guard";
import { CanvasGenerationTargetSaveError } from "@/services/canvas-generation-errors";
import { normalizeImageValue } from "@/lib/model-capabilities";
import { mergedImageCapabilityConfig } from "@/lib/model-selection";
import type { GenerationTask } from "@/services/api/task-center";

import type { CanvasGenerationExecution } from "./canvas-generation-executor-types";
import { canvasGenerationFailureMetadata, canvasImageGenerationHasPendingResult, canvasImagePendingResultMessage, isKeptGenerationResultCode } from "./canvas-generation-failure";

const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;
const NODE_STATUS_ERROR = "error" as const;
const NODE_STATUS_IDLE = "idle" as const;

export async function executeImageGeneration({
    resolveReferenceLinks,
    nodeId,
    sourceNode,
    canvasNodes,
    canvasConnections,
    prompt,
    effectivePrompt,
    generationConfig,
    generationContext,
    controller,
    projectId,
    nodesRef,
    setNodes,
    setConnections,
    setSelectedNodeIds,
    setSelectedConnectionId,
    setDialogNodeId,
    startGenerationRequest,
    finishGenerationRequest,
    bindGenerationTask,
    applyGenerationTaskResult,
    styleMetadata,
    skillMetadata,
    taskContext,
    retryContext,
    clientOperationId,
    onSubmissionPlan,
    showError,
    registerPendingNodeIds,
}: CanvasGenerationExecution) {
    if (canvasImageGenerationHasPendingResult(sourceNode, canvasNodes)) {
        showError(canvasImagePendingResultMessage(sourceNode, canvasNodes));
        return;
    }
    const expectedScope = captureUserScope();
    const isCurrent = () => userScopeMatches(expectedScope) && !controller.signal.aborted;
    const referenceLimitError = canvasImageReferenceLimitError(generationConfig, generationContext.referenceImages);
    if (referenceLimitError) {
        showError(referenceLimitError);
        return;
    }
    const profile = mergedImageCapabilityConfig(generationConfig, generationConfig.model || generationConfig.imageModel);
    const nativeOutputCount = profile.fixedOutputs || 0;
    const count = nativeOutputCount ? Number(normalizeImageValue(profile, generationConfig).count) : getGenerationCount(generationConfig.count);
    const isConfigNode = sourceNode?.type === CanvasNodeType.Config;
    const isImageNode = sourceNode?.type === CanvasNodeType.Image;
    const isExistingImageNode = isImageNode && Boolean(sourceNode?.metadata?.content || sourceNode?.metadata?.storageKey);
    const reuseSourceNode = canGenerateImageInPlace(sourceNode);
    // 已有图片生成新结果并保留旧版本；参考图只来自入边，避免把旧结果误当成自身输入。
    const referenceImages = generationContext.referenceImages;
    const generationType = referenceImages.length ? ("edit" as const) : ("generation" as const);
    const generationMetadata = buildImageGenerationMetadata(generationType, generationConfig, count, referenceImages);
    const parentConfig = NODE_DEFAULT_SIZE[isConfigNode ? CanvasNodeType.Config : isImageNode ? CanvasNodeType.Image : CanvasNodeType.Text];
    const imageDefaults = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
    // 生成中占位框按设置比例显示，避免 16:9 任务显示成默认 340x240。
    const requestedImageSize = nodeSizeFromRatio(generationConfig.size || "auto", imageDefaults.width, imageDefaults.height);
    const imageConfig = requestedImageSize || imageDefaults;
    // auto 图生图沿用来源节点尺寸；用户明确选择比例时必须以目标比例创建节点。
    const referenceNode = referenceImages.length === 1 ? canvasNodes.find((node) => node.id === referenceImages[0].id && node.type === CanvasNodeType.Image) : undefined;
    const imageSizeSource = requestedImageSize ? undefined : isImageNode && sourceNode?.metadata?.content ? sourceNode : referenceNode;
    const outputNodeSize = imageSizeSource ? { width: imageSizeSource.width, height: imageSizeSource.height } : imageConfig;
    const parentPosition = sourceNode?.position || { x: 0, y: 0 };
    const parentWidth = sourceNode?.width || parentConfig.width;
    const parentHeight = sourceNode?.height || parentConfig.height;
    const rootId = reuseSourceNode ? nodeId : nanoid();
    const childIds = count > 1 ? Array.from({ length: count }, () => nanoid()) : [];
    const targetIds = count > 1 ? childIds : [rootId];
    const baseOperationId = clientOperationId || retryContext?.clientOperationId;
    const submissionSize = nativeOutputCount || 1;
    const submissions = Array.from({ length: Math.ceil(targetIds.length / submissionSize) }, (_, index) => ({
        operationId: baseOperationId ? (targetIds.length > submissionSize ? `${baseOperationId}:${index}` : baseOperationId) : undefined,
        outputNodeIds: targetIds.slice(index * submissionSize, (index + 1) * submissionSize),
    }));
    if (onSubmissionPlan) {
        if (!clientOperationId) throw new Error("生成提交缺少确认标识");
        await onSubmissionPlan({ sourceNodeId: nodeId, submissions: submissions.map(submission => ({ ...submission, operationId: submission.operationId! })) });
        assertUserScope(expectedScope);
        controller.signal.throwIfAborted();
        canvasNodes = nodesRef?.current || canvasNodes;
        canvasConnections = useCanvasStore.getState().projects.find(project => project.id === projectId)?.connections || canvasConnections;
        if (!canvasNodes.some(node => node.id === nodeId)) throw new Error("原节点已删除，未开始生成");
    }
    const retired = reuseSourceNode && sourceNode ? retireImageBatchChildren(sourceNode, canvasNodes, canvasConnections) : { nodes: canvasNodes, connections: canvasConnections, removedIds: [] as string[] };
    const workingNodes = retired.nodes;
    const workingConnections = retired.connections;
    registerPendingNodeIds(reuseSourceNode && count > 1 ? childIds : [rootId, ...childIds]);
    const rootWidth = outputNodeSize.width;
    const rootHeight = outputNodeSize.height;
    const preferredPosition = {
        x: parentPosition.x + parentWidth + 96,
        y: parentPosition.y + parentHeight / 2 - rootHeight / 2,
    };
    const rootPosition = findAvailableGenerationGroupPosition(workingNodes.filter(node => node.id !== rootId), reuseSourceNode ? parentPosition : preferredPosition, imageGenerationGroupSize({ width: rootWidth, height: rootHeight }, outputNodeSize, childIds.length));

    const reusableRootMetadata = reuseSourceNode
        ? count > 1
            ? resetGenerationTaskMetadata(sourceNode?.metadata, NODE_STATUS_LOADING)
            : clearInPlaceMediaOutputMetadata(sourceNode?.metadata)
        : {};
    const rootNode: CanvasNodeData = {
        id: rootId,
        type: CanvasNodeType.Image,
        title: buildImageGenerationNodeTitle(effectivePrompt, sourceNode),
        position: rootPosition,
        width: rootWidth,
        height: rootHeight,
        metadata: mediaResultMetadata("generated", {
            ...reusableRootMetadata,
            ...canvasGenerationPromptMetadata(prompt, effectivePrompt),
            status: NODE_STATUS_LOADING,
            size: generationConfig.size,
            isBatchRoot: count > 1,
            batchChildIds: count > 1 ? childIds : undefined,
            generationOutputNodeIds: count > 1 ? [...targetIds] : undefined,
            batchFailedCount: count > 1 ? 0 : undefined,
            batchUsesReferenceImages: referenceImages.length > 0,
            primaryImageId: undefined,
            ...(reuseSourceNode && count > 1 && sourceNode?.metadata?.content ? { content: sourceNode.metadata.content } : {}),
            ...generationMetadata,
            taskOutputIndex: undefined,
            ...styleMetadata,
            ...skillMetadata,
            imageBatchExpanded: count > 1 ? true : undefined,
            generationErrorCode: undefined,
            resourceReloadAvailable: undefined,
            failedPromptFingerprint: undefined,
            failedInputFingerprint: undefined,
            generatedFromNodeId: nodeId,
        }),
    };
    const childNodes: CanvasNodeData[] = childIds.map((id, index) => ({
        id,
        type: CanvasNodeType.Image,
        title: buildImageGenerationNodeTitle(effectivePrompt, sourceNode, index, count),
        position: imageGenerationChildPosition(rootNode.position, rootNode.width, outputNodeSize, index),
        width: outputNodeSize.width,
        height: outputNodeSize.height,
        metadata: mediaResultMetadata("generated", {
            ...canvasGenerationPromptMetadata(prompt, effectivePrompt),
            status: NODE_STATUS_LOADING,
            size: generationConfig.size,
            batchRootId: rootId,
            ...generationMetadata,
            taskOutputIndex: nativeOutputCount ? index % nativeOutputCount : undefined,
            ...styleMetadata,
            ...skillMetadata,
            generationErrorCode: undefined,
            resourceReloadAvailable: undefined,
            failedPromptFingerprint: undefined,
            failedInputFingerprint: undefined,
            generatedFromNodeId: nodeId,
        }),
    }));
    const connectsSelf = !isExistingImageNode || referenceImages.some((img) => img.id === nodeId);
    const batchConnections = [
        ...(reuseSourceNode ? [] : imageGenerationReferenceConnections(nodeId, rootId, workingNodes, workingConnections, nanoid)),
        ...(reuseSourceNode || !connectsSelf ? [] : [{ id: nanoid(), fromNodeId: nodeId, toNodeId: rootId }]),
        ...childIds.map((childId) => ({ id: nanoid(), fromNodeId: rootId, toNodeId: childId })),
    ];

    const nextNodes: CanvasNodeData[] = [
        ...workingNodes.map((node) => {
            if (node.id !== nodeId) return node;
            if (isConfigNode) return { ...node, metadata: { ...node.metadata, ...canvasGenerationPromptMetadata(prompt, effectivePrompt), status: NODE_STATUS_LOADING, errorDetails: undefined } };
            if (reuseSourceNode) return rebaseCanvasGenerationTarget(node, rootNode, sourceNode);
            if (isImageNode) return node.metadata?.content ? node : { ...node, metadata: { ...node.metadata, status: NODE_STATUS_IDLE, errorDetails: undefined } };
            return {
                ...node,
                type: CanvasNodeType.Text,
                title: prompt.slice(0, 32) || "Prompt",
                width: parentConfig.width,
                height: parentConfig.height,
                metadata: { ...node.metadata, content: prompt, richText: undefined, prompt, composerContent: prompt, status: NODE_STATUS_SUCCESS, fontSize: 14, errorDetails: undefined },
            };
        }),
        ...(reuseSourceNode ? [] : [rootNode]),
        ...childNodes,
    ];

    // 任务提交前的保存屏障读取 store；不能等 React updater 执行后才发布新节点。
    const removed = new Set(retired.removedIds);
    const nextConnections = [...canvasConnections.filter((connection) => !removed.has(connection.fromNodeId) && !removed.has(connection.toNodeId)), ...batchConnections];
    if (projectId) useCanvasStore.getState().updateProject(projectId, { nodes: nextNodes, connections: nextConnections });
    nodesRef.current = nextNodes;
    setNodes(nextNodes);
    setConnections(nextConnections);
    setSelectedNodeIds(new Set([nodeId]));
    setSelectedConnectionId(null);
    setDialogNodeId(nodeId);

    targetIds.forEach((targetId) => startGenerationRequest(targetId, nodeId, nodeId, controller));
    if (count > 1) startGenerationRequest(rootId, nodeId, nodeId, controller);
    let hasSuccess = false;
    let hasFailure = false;
    let failureCount = 0;
    let representativeFailure: GenerationFailureMetadata | undefined;
    let abandoned = false;
    let saveFailureMessage: string | undefined;
    const nativeTasks = new Map<number, Promise<GenerationTask>>();
    let nativeBindTail = Promise.resolve();
    await Promise.all(
        targetIds.map(async (targetId, index) => {
            try {
                if (!isCurrent()) return false;
                const batchIndex = nativeOutputCount ? Math.floor(index / nativeOutputCount) : index;
                const { outputNodeIds: batchTargets, operationId } = submissions[batchIndex];
                if (nativeOutputCount) {
                    // One paid task owns all candidates. Keep its identity on every
                    // placeholder so a reload retrieves that task instead of creating it again.
                    if (!nativeTasks.has(batchIndex)) nativeTasks.set(batchIndex, (async () => {
                        let completed: GenerationTask | undefined;
                        await runCanvasGenerationTaskToConsumer(
                            {
                                projectId, nodeId: batchTargets[0], expectedScope, ...retryContext,
                                ...(operationId ? { clientOperationId: operationId } : {}),
                                mode: "image", resolveReferenceLinks, prompt: effectivePrompt,
                                config: { ...generationConfig, count: String(nativeOutputCount) }, referenceImages,
                                signal: controller.signal,
                                metadata: { sourceNodeId: nodeId, ...taskContext, outputNodeIds: batchTargets, resolvedCharacterVersions: generationContext.resolvedCharacterVersions, promptTemplateOperation: sourceNode?.metadata?.promptTemplateOperation, promptTemplateVariables: sourceNode?.metadata?.promptTemplateVariables, ...styleMetadata, ...skillMetadata },
                            },
                            {
                                bindTask: (task) => [...(batchIndex === 0 ? [rootId] : []), ...batchTargets].forEach((id) => bindGenerationTask(id, task)),
                                consumeTask: async (task) => { completed = task; },
                                isCurrent,
                                onSubmission: (metadata) => {
                                    if (!isCurrent()) return;
                                    const submissionIds = [...(batchIndex === 0 ? [rootId] : []), ...batchTargets];
                                    projectCanvasGenerationSubmission(nodesRef, setNodes, submissionIds, metadata);
                                    if (projectId) useCanvasStore.getState().updateProject(projectId, { nodes: nodesRef.current });
                                },
                            },
                        );
                        if (!completed) throw new Error("生成任务缺少成功终态");
                        return completed;
                    })());
                    const completed = await nativeTasks.get(batchIndex)!;
                    const binding = nativeBindTail.then(() => applyGenerationTaskResult(targetId, completed));
                    nativeBindTail = binding.catch(() => {});
                    await binding;
                } else {
                    await runCanvasGenerationTaskToConsumer(
                        {
                            projectId,
                            nodeId: targetId,
                            expectedScope,
                            ...retryContext,
                            ...(operationId ? { clientOperationId: operationId } : {}),
                            mode: "image",
                            resolveReferenceLinks,
                            prompt: effectivePrompt,
                            config: { ...generationConfig, count: "1" },
                            referenceImages,
                            signal: controller.signal,
                            metadata: {
                                sourceNodeId: nodeId,
                                ...taskContext,
                                resolvedCharacterVersions: generationContext.resolvedCharacterVersions,
                                promptTemplateOperation: sourceNode?.metadata?.promptTemplateOperation,
                                promptTemplateVariables: sourceNode?.metadata?.promptTemplateVariables,
                                ...styleMetadata,
                                ...skillMetadata,
                                ...doubaoImageProviderOptions(generationConfig.model, sourceNode?.metadata?.doubaoImageModel),
                            },
                        },
                        {
                            onSubmission: (metadata) => projectCanvasGenerationSubmission(nodesRef, setNodes, [targetId], metadata),
                            bindTask: (task) => bindGenerationTask(targetId, task),
                            consumeTask: (task) => applyGenerationTaskResult(targetId, task),
                            isCurrent,
                        },
                    );
                }
                if (!isCurrent()) return false;
                if (targetId !== rootId) {
                    setNodes((current) => {
                        const child = current.find((node) => node.id === targetId);
                        const root = current.find((node) => node.id === rootId);
                        if (!child?.metadata?.content || !root || root.metadata?.primaryImageId) return current;
                        const center = { x: root.position.x + root.width / 2, y: root.position.y + root.height / 2 };
                        const geometry = root.metadata?.locked
                            ? {}
                            : {
                                  width: child.width,
                                  height: child.height,
                                  position: { x: center.x - child.width / 2, y: center.y - child.height / 2 },
                              };
                        const updated = current.map((node) =>
                            node.id === rootId
                                ? {
                                      ...node,
                                      ...geometry,
                                      metadata: {
                                          ...node.metadata,
                                          content: child.metadata?.content,
                                          storageKey: child.metadata?.storageKey,
                                          mimeType: child.metadata?.mimeType,
                                          bytes: child.metadata?.bytes,
                                          naturalWidth: child.metadata?.naturalWidth,
                                          naturalHeight: child.metadata?.naturalHeight,
                                          assetId: child.metadata?.assetId,
                                          primaryImageId: targetId,
                                          status: NODE_STATUS_SUCCESS,
                                      },
                                  }
                                : node,
                        );
                        if (projectId) useCanvasStore.getState().updateProject(projectId, { nodes: updated });
                        return updated;
                    });
                }
                hasSuccess = true;
                if (isConfigNode) setNodes((current) => current.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined } } : node)));
                return true;
            } catch (error) {
                if (isUserScopeAbandonedError(error) || (!controller.signal.aborted && isGenerationCanceled(error))) {
                    abandoned = true;
                    return false;
                }
                if (!isCurrent() || isGenerationCanceled(error)) return false;
                if (error instanceof CanvasGenerationTargetSaveError) saveFailureMessage = error.message;
                const failure = canvasGenerationFailureMetadata(error, { prompt: effectivePrompt, referenceImages });
                if (!representativeFailure || failure.generationErrorCode === CONTENT_MODERATION_ERROR_CODE) representativeFailure = failure;
                hasFailure = true;
                failureCount += 1;
                setNodes((current) => {
                    const next = current.map((node) => (node.id === targetId ? { ...node, metadata: { ...node.metadata, status: targetId === nodeId ? generationFailureNodeStatus(isExistingImageNode) : NODE_STATUS_ERROR, ...failure } } : node));
                    if (projectId) useCanvasStore.getState().updateProject(projectId, { nodes: next });
                    return next;
                });
                return false;
            } finally {
                finishGenerationRequest(targetId, controller);
            }
        }),
    );
    if (count > 1) finishGenerationRequest(rootId, controller);
    if (abandoned || !userScopeMatches(expectedScope)) return;
    if (controller.signal.aborted) {
        setNodes((current) => {
            const ids = new Set([rootId, ...childIds]);
            if (nativeOutputCount && current.some((node) => ids.has(node.id) && (node.metadata?.taskId || node.metadata?.taskClientOperationId) && node.metadata?.generationSubmissionState !== "rejected")) {
                const next = current.map((node) => ids.has(node.id) && (node.id === rootId || !node.metadata?.content) ? {
                    ...node,
                    metadata: {
                        ...node.metadata,
                        status: node.metadata?.content ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR,
                        resourceReloadAvailable: true,
                        generationSubmissionState: node.metadata?.taskId ? "accepted" as const : "unknown" as const,
                        errorDetails: "已停止等待，任务已保留，请继续查询原任务",
                    },
                } : node);
                if (projectId) useCanvasStore.getState().updateProject(projectId, { nodes: next });
                return next;
            }
            const cancelled = cancelIncompleteImageBatch(rootId, childIds, current, []);
            if (cancelled.removedIds.length) {
                const removed = new Set(cancelled.removedIds);
                setConnections((connections) => connections.filter((connection) => !removed.has(connection.fromNodeId) && !removed.has(connection.toNodeId)));
            }
            return cancelled.nodes.map((node) => (node.id === nodeId && isConfigNode && node.metadata?.status === NODE_STATUS_LOADING ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_IDLE, errorDetails: undefined } } : node));
        });
        return;
    }
    if (hasFailure) showError(isKeptGenerationResultCode(representativeFailure?.generationErrorCode) ? representativeFailure?.errorDetails || "生成结果已保留，请点击「继续取回」" : saveFailureMessage || (hasSuccess ? "部分图片生成失败" : "全部图片生成失败"));
    setNodes((current) => {
        const next = current.map((node) => {
            if (node.id === nodeId && isConfigNode) {
                return {
                    ...node,
                    metadata: {
                        ...node.metadata,
                        status: hasSuccess ? NODE_STATUS_SUCCESS : generationFailureNodeStatus(isExistingImageNode),
                        ...(hasSuccess ? { errorDetails: undefined, generationErrorCode: undefined, failedPromptFingerprint: undefined, failedInputFingerprint: undefined } : representativeFailure || { errorDetails: "全部图片生成失败" }),
                    },
                };
            }
            if (node.id === rootId) {
                return {
                    ...node,
                    metadata: {
                        ...node.metadata,
                        status: hasSuccess ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR,
                        batchFailedCount: count > 1 ? failureCount : undefined,
                        ...(hasSuccess ? { errorDetails: undefined, generationErrorCode: undefined, failedPromptFingerprint: undefined, failedInputFingerprint: undefined } : representativeFailure || { errorDetails: "全部图片生成失败" }),
                    },
                };
            }
            return node;
        });
        if (projectId) useCanvasStore.getState().updateProject(projectId, { nodes: next });
        return next;
    });
}
