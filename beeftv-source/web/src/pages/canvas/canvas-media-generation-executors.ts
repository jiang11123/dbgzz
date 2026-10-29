import { nanoid } from "nanoid";
import { assertUserScope, captureUserScope } from "@/lib/user-scope-guard";

import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { canGenerateMediaInPlace } from "@/lib/canvas/canvas-generation-layout";
import { nodeSizeFromRatio } from "@/lib/canvas/canvas-node-size";
import { nextCanvasVersionLabel } from "@/lib/canvas/canvas-layout";
import { buildAudioGenerationMetadata, buildVideoGenerationMetadata, clearInPlaceMediaOutputMetadata, generationReferenceUrls, resetGenerationTaskMetadata, runCanvasGenerationTaskToConsumer } from "@/lib/canvas/canvas-project-generation";
import { canvasGenerationPromptMetadata } from "@/lib/canvas/canvas-generation-submission";
import { mediaResultMetadata } from "@/lib/canvas/canvas-node-semantics";
import { doubaoVideoProviderOptions } from "@/lib/doubao-video-model";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { projectCanvasGenerationSubmission, rebaseCanvasGenerationTarget } from "@/lib/canvas/canvas-generation-live-target";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

import type { CanvasGenerationExecution } from "./canvas-generation-executor-types";

const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;

export { clearInPlaceMediaOutputMetadata };

export async function executeVideoGeneration({
    resolveReferenceLinks,
    nodeId,
    sourceNode,
    canvasNodes,
    nodesRef,
    prompt,
    effectivePrompt,
    generationConfig,
    generationContext,
    controller,
    projectId,
    canvasConnections,
    setNodes,
    setConnections,
    startGenerationRequest,
    finishGenerationRequest,
    bindGenerationTask,
    applyGenerationTaskResult,
    registerPendingNodeIds,
    styleMetadata,
    skillMetadata,
    taskContext,
    retryContext,
    clientOperationId,
    onSubmissionPlan,
}: CanvasGenerationExecution) {
    const spec = nodeSizeFromRatio(generationConfig.size, NODE_DEFAULT_SIZE[CanvasNodeType.Video].width, NODE_DEFAULT_SIZE[CanvasNodeType.Video].height) || NODE_DEFAULT_SIZE[CanvasNodeType.Video];
    const reuseSourceNode = canGenerateMediaInPlace(sourceNode, CanvasNodeType.Video);
    const isExistingVideoNode = sourceNode?.type === CanvasNodeType.Video && Boolean(sourceNode.metadata?.content) && !reuseSourceNode;
    const videoId = reuseSourceNode ? nodeId : nanoid();
    if (onSubmissionPlan) {
        const scope = captureUserScope();
        if (!clientOperationId) throw new Error("生成提交缺少确认标识");
        await onSubmissionPlan({ sourceNodeId: nodeId, submissions: [{ operationId: clientOperationId, outputNodeIds: [videoId] }] });
        assertUserScope(scope);
        controller.signal.throwIfAborted();
        if (!(nodesRef?.current || canvasNodes).some(node => node.id === nodeId)) throw new Error("原节点已删除，未开始生成");
    }
    const versionRootId = isExistingVideoNode && sourceNode ? sourceNode.metadata?.versionOfNodeId || sourceNode.id : undefined;
    const parent = sourceNode?.position || { x: 0, y: 0 };
    const videoGenerationMetadata = buildVideoGenerationMetadata(sourceNode, generationContext, generationConfig);
    const videoNode: CanvasNodeData = {
        id: videoId,
        type: CanvasNodeType.Video,
        title: effectivePrompt.slice(0, 32) || "Generated Video",
        position: reuseSourceNode ? sourceNode!.position : { x: parent.x + (sourceNode?.width || spec.width) + 96, y: parent.y },
        width: reuseSourceNode ? sourceNode!.width : spec.width,
        height: reuseSourceNode ? sourceNode!.height : spec.height,
        metadata: mediaResultMetadata("generated", {
            ...(reuseSourceNode ? resetGenerationTaskMetadata(sourceNode?.metadata, NODE_STATUS_LOADING) : {}),
            ...canvasGenerationPromptMetadata(prompt, effectivePrompt),
            status: NODE_STATUS_LOADING,
            errorDetails: undefined,
            generationErrorCode: undefined,
            outputParameterWarning: undefined,
            resourceReloadAvailable: undefined,
            failedPromptFingerprint: undefined,
            model: generationConfig.model,
            size: generationConfig.size,
            seconds: generationConfig.videoSeconds,
            vquality: generationConfig.vquality,
            generateAudio: generationConfig.videoGenerateAudio,
            watermark: generationConfig.videoWatermark,
            references: generationReferenceUrls(generationContext),
            ...videoGenerationMetadata,
            ...styleMetadata,
            ...skillMetadata,
            generatedFromNodeId: nodeId,
        }),
    };
    registerPendingNodeIds([videoId]);
    // 待生成版本先加入版本族，但只有成功结果才能替换当前主版本。
    const applyVideoNodes = (current: CanvasNodeData[]): CanvasNodeData[] => {
        if (reuseSourceNode) return current.map((node) => (node.id === nodeId ? rebaseCanvasGenerationTarget(node, videoNode, sourceNode) : node));
        if (!isExistingVideoNode || !sourceNode) return [...current.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } } : node)), videoNode];
        const rootId = versionRootId!;
        const nextLabel = nextCanvasVersionLabel(rootId, current);
        const hasPrimaryVersion = current.some((node) => (node.metadata?.versionOfNodeId || node.id) === rootId && node.metadata?.versionPrimary);
        return [
            ...current.map((node) => {
                if ((node.metadata?.versionOfNodeId || node.id) !== rootId) return node;
                return { ...node, metadata: { ...node.metadata, versionOfNodeId: rootId, versionLabel: node.metadata?.versionLabel || "A", versionPrimary: node.metadata?.versionPrimary || (!hasPrimaryVersion && node.id === sourceNode.id), status: node.id === nodeId ? NODE_STATUS_SUCCESS : node.metadata?.status } };
            }),
            { ...videoNode, metadata: { ...videoNode.metadata, versionOfNodeId: rootId, versionLabel: nextLabel, versionPrimary: false } },
        ];
    };
    const storedVideoProject = projectId ? useCanvasStore.getState().projects.find((project) => project.id === projectId) : undefined;
    const workingVideoConnections = storedVideoProject?.connections?.length ? storedVideoProject.connections : canvasConnections;
    const newVideoConnections: CanvasConnection[] = reuseSourceNode
        ? []
        : !isExistingVideoNode
          ? [{ id: nanoid(), fromNodeId: nodeId, toNodeId: videoId }]
          : workingVideoConnections.filter((connection) => connection.toNodeId === nodeId).map((connection) => ({ ...connection, id: nanoid(), toNodeId: videoId }));
    const workingNodes = nodesRef?.current?.length ? nodesRef.current : storedVideoProject?.nodes?.length ? storedVideoProject.nodes : canvasNodes;
    if (workingNodes?.length) {
        const nextNodes = applyVideoNodes(workingNodes);
        const nextConnections = [...(workingVideoConnections || []), ...newVideoConnections];
        if (projectId) {
            useCanvasStore.getState().updateProject(projectId, reuseSourceNode ? { nodes: nextNodes } : { nodes: nextNodes, connections: nextConnections });
        }
        if (nodesRef) nodesRef.current = nextNodes;
        setNodes(nextNodes);
        if (!reuseSourceNode) setConnections(nextConnections);
    } else {
        setNodes(applyVideoNodes);
        // 重新生成已有视频时，新节点继承源视频的上游连接，与源视频保持并行关系，而不是作为其下游子节点。
        if (!reuseSourceNode) {
            setConnections((current) => [...current, ...newVideoConnections]);
        }
    }

    startGenerationRequest(videoId, nodeId, nodeId, controller);
    try {
        await runCanvasGenerationTaskToConsumer(
            {
                projectId,
                nodeId: videoId,
                ...retryContext,
                ...(clientOperationId ? { clientOperationId } : {}),
                mode: "video",
                resolveReferenceLinks,
                prompt: effectivePrompt,
                config: generationConfig,
                referenceImages: generationContext.referenceImages,
                referenceVideos: generationContext.referenceVideos,
                referenceAudios: generationContext.referenceAudios,
                signal: controller.signal,
                metadata: {
                    sourceNodeId: nodeId,
                    ...taskContext,
                    resolvedCharacterVersions: generationContext.resolvedCharacterVersions,
                    resolvedCharacterVoices: generationContext.resolvedCharacterVoices,
                    promptTemplateOperation: sourceNode?.metadata?.promptTemplateOperation,
                    promptTemplateVariables: sourceNode?.metadata?.promptTemplateVariables,
                    ...videoGenerationMetadata,
                    ...styleMetadata,
                    ...skillMetadata,
                    ...doubaoVideoProviderOptions(generationConfig.model, sourceNode?.metadata?.doubaoVideoModel),
                },
            },
            {
                onSubmission: (metadata) => projectCanvasGenerationSubmission(nodesRef, setNodes, [videoId], metadata),
                bindTask: (task) => bindGenerationTask(videoId, task),
                consumeTask: (task) => applyGenerationTaskResult(videoId, task),
            },
        );
    } finally {
        finishGenerationRequest(videoId, controller);
    }
}

export async function executeAudioGeneration({
    nodeId,
    sourceNode,
    canvasNodes,
    canvasConnections,
    nodesRef,
    prompt,
    effectivePrompt,
    generationConfig,
    generationContext,
    controller,
    projectId,
    setNodes,
    setConnections,
    startGenerationRequest,
    finishGenerationRequest,
    bindGenerationTask,
    applyGenerationTaskResult,
    registerPendingNodeIds,
    taskContext,
    skillMetadata,
    retryContext,
    clientOperationId,
}: CanvasGenerationExecution) {
    const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
    const reuseSourceNode = canGenerateMediaInPlace(sourceNode, CanvasNodeType.Audio);
    const isExistingAudioNode = sourceNode?.type === CanvasNodeType.Audio && Boolean(sourceNode.metadata?.content);
    const audioId = reuseSourceNode ? nodeId : nanoid();
    const parent = sourceNode?.position || { x: 0, y: 0 };
    const audioNode: CanvasNodeData = {
        id: audioId,
        type: CanvasNodeType.Audio,
        title: effectivePrompt.slice(0, 32) || "Generated Audio",
        position: reuseSourceNode ? sourceNode!.position : { x: parent.x + (sourceNode?.width || spec.width) + 96, y: parent.y + ((sourceNode?.height || spec.height) - spec.height) / 2 },
        width: reuseSourceNode ? sourceNode!.width : spec.width,
        height: reuseSourceNode ? sourceNode!.height : spec.height,
        metadata: mediaResultMetadata("generated", {
            ...(reuseSourceNode ? clearInPlaceMediaOutputMetadata(sourceNode?.metadata) : {}),
            ...canvasGenerationPromptMetadata(prompt, effectivePrompt),
            status: NODE_STATUS_LOADING,
            ...buildAudioGenerationMetadata(generationConfig),
            ...skillMetadata,
            generatedFromNodeId: nodeId,
        }),
    };
    registerPendingNodeIds([audioId]);
    const applyAudioNodes = (current: CanvasNodeData[]): CanvasNodeData[] =>
        reuseSourceNode ? current.map((node) => (node.id === nodeId ? rebaseCanvasGenerationTarget(node, audioNode, sourceNode) : node)) : [...current.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } } : node)), audioNode];
    const newAudioConnection: CanvasConnection | null = !reuseSourceNode && !isExistingAudioNode ? { id: nanoid(), fromNodeId: nodeId, toNodeId: audioId } : null;
    const storedAudioProject = projectId ? useCanvasStore.getState().projects.find((project) => project.id === projectId) : undefined;
    const workingAudioConnections = storedAudioProject?.connections?.length ? storedAudioProject.connections : canvasConnections;
    const workingNodes = nodesRef?.current?.length ? nodesRef.current : storedAudioProject?.nodes?.length ? storedAudioProject.nodes : canvasNodes;
    if (workingNodes?.length) {
        const nextNodes = applyAudioNodes(workingNodes);
        const nextConnections = newAudioConnection ? [...(workingAudioConnections || []), newAudioConnection] : workingAudioConnections;
        if (projectId) {
            useCanvasStore.getState().updateProject(projectId, newAudioConnection ? { nodes: nextNodes, connections: nextConnections } : { nodes: nextNodes });
        }
        if (nodesRef) nodesRef.current = nextNodes;
        setNodes(nextNodes);
        if (newAudioConnection) setConnections(nextConnections);
    } else {
        setNodes(applyAudioNodes);
        if (newAudioConnection) setConnections((current) => [...current, newAudioConnection]);
    }

    startGenerationRequest(audioId, nodeId, nodeId, controller);
    try {
        await runCanvasGenerationTaskToConsumer(
            {
                projectId,
                nodeId: audioId,
                ...retryContext,
                ...(clientOperationId ? { clientOperationId } : {}),
                mode: "audio",
                prompt: effectivePrompt,
                config: generationConfig,
                signal: controller.signal,
                metadata: { sourceNodeId: nodeId, ...taskContext, resolvedCharacterVersions: generationContext.resolvedCharacterVersions, resolvedCharacterVoiceKey: generationContext.resolvedCharacterVoices[0]?.voiceKey, ...skillMetadata },
            },
            {
                onSubmission: (metadata) => projectCanvasGenerationSubmission(nodesRef, setNodes, [audioId], metadata),
                bindTask: (task) => bindGenerationTask(audioId, task),
                consumeTask: (task) => applyGenerationTaskResult(audioId, task),
            },
        );
    } finally {
        finishGenerationRequest(audioId, controller);
    }
}
