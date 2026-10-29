import { nanoid } from "nanoid";

import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { getGenerationCount, runCanvasGenerationTaskToConsumer } from "@/lib/canvas/canvas-project-generation";
import { canvasGenerationPromptMetadata } from "@/lib/canvas/canvas-generation-submission";
import { projectCanvasGenerationSubmission } from "@/lib/canvas/canvas-generation-live-target";
import { planTextGenerationTargets } from "@/lib/canvas/canvas-generation-layout";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

import type { CanvasGenerationExecution } from "./canvas-generation-executor-types";

const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;

export async function executeTextGeneration({
    nodeId,
    sourceNode,
    prompt,
    effectivePrompt,
    generationConfig,
    generationContext,
    controller,
    editingTextNode,
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
    nodesRef,
    canvasNodes,
    canvasConnections,
}: CanvasGenerationExecution) {
    const isConfigNode = sourceNode?.type === CanvasNodeType.Config;
    const isDirectTextTarget = sourceNode?.type === CanvasNodeType.Text && !sourceNode.metadata?.content?.trim() && !editingTextNode;
    // 独立文本份数（textCount），默认 1，不再复用餐图片数量 count（对齐上游 v0.16 语义）
    const textCount = getGenerationCount(String(sourceNode?.metadata?.textCount ?? 1));
    const parentConfig = NODE_DEFAULT_SIZE[isConfigNode ? CanvasNodeType.Config : CanvasNodeType.Text];
    const textConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
    const parentPosition = sourceNode?.position || { x: 0, y: 0 };
    const { generateInPlace, childIds, targetIds: textTargetIds } = planTextGenerationTargets({ nodeId, sourceNode, isConfigNode, count: textCount, createId: nanoid });
    registerPendingNodeIds(childIds);
    if (childIds.length || generateInPlace) {
        const childNodes: CanvasNodeData[] = childIds.map((id, index) => ({
            id,
            type: CanvasNodeType.Text,
            title: effectivePrompt.slice(0, 32) || "Generated Text",
            position: {
                x: parentPosition.x + parentConfig.width + 96,
                y: parentPosition.y + parentConfig.height / 2 - textConfig.height / 2 + (index - (childIds.length - 1) / 2) * (textConfig.height + 36),
            },
            width: textConfig.width,
            height: textConfig.height,
            metadata: { ...canvasGenerationPromptMetadata(prompt, effectivePrompt), status: NODE_STATUS_LOADING, generatedFromNodeId: nodeId, fontSize: 14, ...skillMetadata },
        }));
        const project = useCanvasStore.getState().openProject(projectId);
        const currentNodes = nodesRef.current.length ? nodesRef.current : project?.nodes || canvasNodes;
        const nextNodes = [...currentNodes.map((node) => (node.id === nodeId && (isConfigNode || generateInPlace) ? { ...node, metadata: { ...node.metadata, ...canvasGenerationPromptMetadata(prompt, effectivePrompt), status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)), ...childNodes];
        const nextConnections = [...(project?.connections || canvasConnections), ...childIds.map((childId) => ({ id: nanoid(), fromNodeId: nodeId, toNodeId: childId }))];
        if (project) useCanvasStore.getState().updateProject(projectId, { nodes: nextNodes, connections: nextConnections });
        nodesRef.current = nextNodes;
        setNodes(nextNodes);
        setConnections(nextConnections);
    }

    textTargetIds.forEach((targetNodeId) => startGenerationRequest(targetNodeId, nodeId, nodeId, controller));
    const answers = await Promise.all(
        textTargetIds.map((targetNodeId) =>
            runCanvasGenerationTaskToConsumer(
                {
                    projectId,
                    nodeId: targetNodeId,
                    ...retryContext,
                    clientOperationId: retryContext?.clientOperationId || (clientOperationId ? `${clientOperationId}:${targetNodeId}` : undefined),
                    mode: "text",
                    prompt: effectivePrompt,
                    config: generationConfig,
                    referenceImages: generationContext.referenceImages,
                    referenceVideos: generationContext.referenceVideos,
                    signal: controller.signal,
                    metadata: { sourceNodeId: nodeId, ...taskContext, resolvedCharacterVersions: generationContext.resolvedCharacterVersions, ...skillMetadata },
                },
                {
                    onSubmission: (metadata) => projectCanvasGenerationSubmission(nodesRef, setNodes, [targetNodeId], metadata),
                    bindTask: (task) => bindGenerationTask(targetNodeId, task),
                    consumeTask: (task) => applyGenerationTaskResult(targetNodeId, task),
                },
            )
                .then(() => ({ nodeId: targetNodeId }))
                .finally(() => finishGenerationRequest(targetNodeId, controller)),
        ),
    );
    if (controller.signal.aborted) return;
    void answers;
    if (isConfigNode) {
        setNodes((current) => current.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined, generationErrorCode: undefined, resourceReloadAvailable: undefined, failedPromptFingerprint: undefined } } : node)));
    }
}
