import type { Dispatch, SetStateAction } from "react";
import { nanoid } from "nanoid";
import { beefAPIImageContract } from "@/lib/beefapi-image-contracts";

import { getNodeSpec } from "@/constant/canvas";
import { applyGenerationTaskResultToNodes, applyMaterializedGenerationTaskResultToNodes, generationTaskMode } from "@/lib/canvas/canvas-generation-task-sync";
import { failedImageBatchChildren, markImageBatchRetrying, reconcileImageBatchRoot, restoreUnsubmittedImageBatchChild } from "@/lib/canvas/canvas-image-batch-retry";
import { bindMissingCanvasResourceAssets, canvasNodesMissingResourceAssetBinding } from "@/lib/canvas/canvas-node-asset";
import { createCanvasNode } from "@/lib/canvas/canvas-project-domain";
import { getGenerationCount } from "@/lib/canvas/canvas-project-generation";
import { shouldBlockManualRetry } from "@/lib/generation-error";
import { canvasNodeFailureExplanation, isDepthCaptureResultNode } from "@/lib/canvas/canvas-depth-capture";
import type { GenerationTask } from "@/services/api/task-center";
import type { Asset } from "@/stores/use-asset-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type Position } from "@/types/canvas";

import { CanvasOwnerAbandonedError, canvasOwnerCanPersist, canvasOwnerEpochMatches, canvasOwnerUserMatches, type CanvasOwnerEpoch } from "./canvas-owner-epoch";

const NODE_STATUS_SUCCESS = "success" as const;

export type CanvasNodeRetryPlan =
    | { kind: "history" }
    | { kind: "depth" }
    | { kind: "script"; prompt: string }
    | { kind: "script-empty" }
    | { kind: "image-batch-root"; children: CanvasNodeData[] }
    | { kind: "image-batch-empty" }
    | { kind: "image-batch-child"; rootId: string }
    | { kind: "single" };

export function canvasNodeRetryPlan(node: CanvasNodeData, nodes: CanvasNodeData[]): CanvasNodeRetryPlan {
    if (canvasNodeFailureExplanation(node).category === "result_target_unavailable") return { kind: "history" };
    if (isDepthCaptureResultNode(node)) return { kind: "depth" };
    if (node.type === CanvasNodeType.Script) {
        const prompt = (node.metadata?.composerContent || node.metadata?.prompt || "").trim();
        return prompt ? { kind: "script", prompt } : { kind: "script-empty" };
    }
    if (node.type === CanvasNodeType.Image && node.metadata?.isBatchRoot) {
        const children = failedImageBatchChildren(node, nodes);
        return children.length ? { kind: "image-batch-root", children } : { kind: "image-batch-empty" };
    }
    if (node.type === CanvasNodeType.Image && node.metadata?.batchRootId) {
        return { kind: "image-batch-child", rootId: node.metadata.batchRootId };
    }
    return { kind: "single" };
}

export function selectRetryableImageBatchChildren(children: CanvasNodeData[]) {
    const retryable = children.filter((child) => !shouldBlockManualRetry({ code: child.metadata?.generationErrorCode || child.metadata?.taskErrorCode, message: child.metadata?.errorDetails }, child.metadata?.taskStage));
    return { retryable, blocked: retryable.length < children.length };
}

export function reconcileImageBatchRootNodes(rootId: string, nodes: CanvasNodeData[]) {
    const root = nodes.find((item) => item.id === rootId);
    if (!root) return nodes;
    const reconciled = reconcileImageBatchRoot(root, nodes);
    return nodes.map((item) => (item.id === root.id ? reconciled : item));
}

export async function runImageBatchChildRetry(input: {
    rootId: string;
    children: CanvasNodeData[];
    retry: (child: CanvasNodeData) => Promise<unknown>;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    reconcile: (rootId: string) => void;
}) {
    const childIds = input.children.map((child) => child.id);
    input.setNodes((current) => markImageBatchRetrying(input.rootId, childIds, current));
    await Promise.allSettled(
        input.children.map(async (child) => {
            await input.retry(child);
            input.setNodes((current) => current.map((item) => (item.id === child.id ? restoreUnsubmittedImageBatchChild(item, child) : item)));
        }),
    );
    input.reconcile(input.rootId);
}

export type ImageNodeFromTextConfig = {
    imageModel?: string;
    model?: string;
    size?: string;
    quality?: string;
    transparentBackground?: string;
    canvasImageCount?: string;
    count?: string;
};

export type ImageNodeFromTextResult =
    | { ok: false; reason: "empty-prompt" | "missing-source" }
    | { ok: true; imageNode: CanvasNodeData; connection: CanvasConnection; nextNodes: CanvasNodeData[]; nextConnections: CanvasConnection[] };

export function createImageNodeFromTextSource(input: {
    sourceId: string;
    prompt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    config: ImageNodeFromTextConfig;
    connectionId?: string;
}): ImageNodeFromTextResult {
    const prompt = input.prompt.trim();
    if (!prompt) return { ok: false, reason: "empty-prompt" };
    const sourceNode = input.nodes.find((item) => item.id === input.sourceId);
    if (!sourceNode) return { ok: false, reason: "missing-source" };
    const nodeSize = getNodeSpec(CanvasNodeType.Image);
    const imageNode = createCanvasNode(
        CanvasNodeType.Image,
        {
            x: sourceNode.position.x + sourceNode.width + 96 + nodeSize.width / 2,
            y: sourceNode.position.y + sourceNode.height / 2,
        },
        {
            prompt: "@文本1",
            composerContent: "@文本1",
            model: input.config.imageModel || input.config.model,
            size: input.config.size,
            quality: input.config.quality,
            transparentBackground: input.config.transparentBackground,
            count: getGenerationCount(input.config.canvasImageCount || input.config.count || ""),
        },
    );
    imageNode.title = "图片生成";
    const connection = { id: input.connectionId || nanoid(), fromNodeId: sourceNode.id, toNodeId: imageNode.id };
    const nextNodes = input.nodes.map((item) => (item.id === sourceNode.id ? { ...item, metadata: { ...item.metadata, content: prompt, richText: undefined, prompt, status: NODE_STATUS_SUCCESS } } : item)).concat(imageNode);
    return { ok: true, imageNode, connection, nextNodes, nextConnections: [...input.connections, connection] };
}

export function createInsertingHistoryGate() {
    let busy = false;
    return {
        tryEnter() {
            if (busy) return false;
            busy = true;
            return true;
        },
        exit() {
            busy = false;
        },
    };
}

export function rebaseInsertedCanvasNode(live: CanvasNodeData[], inserted: CanvasNodeData) {
    const index = live.findIndex((node) => node.id === inserted.id);
    if (index < 0) return [...live, inserted];
    const next = live.slice();
    next[index] = inserted;
    return next;
}

export async function insertCanvasGenerationHistoryTask(input: {
    task: GenerationTask;
    projectId: string;
    domainProjectId?: string;
    center: Position;
    nodes: CanvasNodeData[];
    assets: Asset[];
    persist: (nodes: CanvasNodeData[]) => Promise<void>;
    ensureAsset: (node: CanvasNodeData) => Promise<{ assetId: string }>;
    applyResult?: typeof applyGenerationTaskResultToNodes;
    readLiveNodes: () => CanvasNodeData[];
    canContinueWrite?: () => boolean;
}): Promise<{ node: CanvasNodeData; nextNodes: CanvasNodeData[]; insertedNodes?: CanvasNodeData[]; abandoned?: boolean }> {
    const mode = generationTaskMode(input.task);
    const nodeType = mode === "video" ? CanvasNodeType.Video : mode === "audio" ? CanvasNodeType.Audio : CanvasNodeType.Image;
    const count = mode === "image" ? beefAPIImageContract(input.task.model || "")?.fixedOutputs || 1 : 1;
    const insertedNodes: CanvasNodeData[] = [];
    for (let index = 0; index < count; index++) {
        const node = createCanvasNode(nodeType, { x: input.center.x + (index % 2) * 400, y: input.center.y + Math.floor(index / 2) * 400 }, {
            prompt: input.task.prompt,
            composerContent: input.task.prompt,
            status: "loading",
            taskId: input.task.id,
            taskStatus: input.task.status,
            taskStage: input.task.stage,
            taskProvider: input.task.provider,
            taskCreatedAt: input.task.createdAt,
            taskCompletedAt: input.task.completedAt,
            model: input.task.model,
            ...(count > 1 ? { taskOutputIndex: index } : {}),
        });
        node.title = mode === "video" ? "历史视频" : mode === "audio" ? "历史音频" : "历史图片";
        const output = input.task.outputs?.find((output) => output.outputIndex === index && output.materializedAssetId);
        const applied = output && !input.applyResult
            ? await applyMaterializedGenerationTaskResultToNodes([node], input.task, output, `history:${input.task.id}:${node.id}:${index}`, node.id)
            : await (input.applyResult || applyGenerationTaskResultToNodes)([node], input.task, node.id);
        if (!applied.node) throw new Error("生成结果无法定位到画布节点");
        if (input.canContinueWrite && !input.canContinueWrite()) return { node: applied.node, nextNodes: [], abandoned: true };
        const bound = await bindMissingCanvasResourceAssets([applied.node], input.assets, async (item) => {
            if (input.canContinueWrite && !input.canContinueWrite()) throw new CanvasOwnerAbandonedError();
            return input.ensureAsset(item);
        });
        const inserted = bound[0];
        if (!inserted || canvasNodesMissingResourceAssetBinding(bound).length) {
            throw new Error("生成结果尚未进入素材库，无法插入画布");
        }
        if (input.canContinueWrite && !input.canContinueWrite()) return { node: inserted, nextNodes: [], abandoned: true };
        insertedNodes.push(inserted);
    }
    const nextNodes = insertedNodes.reduce((nodes, inserted) => rebaseInsertedCanvasNode(nodes, inserted), input.readLiveNodes());
    await input.persist(nextNodes);
    return { node: insertedNodes[0], nextNodes, insertedNodes };
}

export async function runOwnedCanvasHistoryInsert(input: {
    owner: CanvasOwnerEpoch;
    getLiveCanvasId: () => string;
    getLiveUserScope?: () => string;
    getLiveLifetime?: () => number;
    task: GenerationTask;
    projectId: string;
    domainProjectId?: string;
    center: Position;
    nodes: CanvasNodeData[];
    assets: Asset[];
    persist: (nodes: CanvasNodeData[]) => Promise<void>;
    ensureAsset: (node: CanvasNodeData) => Promise<{ assetId: string }>;
    applyResult?: typeof applyGenerationTaskResultToNodes;
    readLiveNodes: () => CanvasNodeData[];
    onCommit: (node: CanvasNodeData, insertedNodes: CanvasNodeData[]) => void;
}): Promise<"committed" | "abandoned"> {
    const liveUser = () => input.getLiveUserScope?.();
    const liveLifetime = () => input.getLiveLifetime?.();
    const canContinueWrite = () => canvasOwnerCanPersist(input.owner, input.getLiveCanvasId(), liveUser(), liveLifetime());
    try {
        const result = await insertCanvasGenerationHistoryTask({
            ...input,
            canContinueWrite,
            ensureAsset: async (node) => {
                if (!canvasOwnerUserMatches(input.owner, liveUser())) throw new CanvasOwnerAbandonedError();
                return input.ensureAsset(node);
            },
        });
        if (result.abandoned) return "abandoned";
        if (!canvasOwnerEpochMatches(input.owner, input.getLiveCanvasId(), liveUser(), liveLifetime())) return "abandoned";
        input.onCommit(result.node, result.insertedNodes || [result.node]);
        return "committed";
    } catch (error) {
        if (error instanceof CanvasOwnerAbandonedError) return "abandoned";
        throw error;
    }
}
