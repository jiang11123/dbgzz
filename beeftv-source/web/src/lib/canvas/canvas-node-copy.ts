import { nanoid } from "nanoid";

import { resetGenerationTaskMetadata } from "@/lib/canvas/canvas-project-generation";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata, type StoryboardRow } from "@/types/canvas";
import type { DirectorScene } from "@/types/director";

const COPY_TITLE_SUFFIX = /^(.*)_copy(\d+)$/i;

export function nextCopiedNodeTitle(sourceTitle: string, existingTitles: Iterable<string>) {
    const sourceMatch = sourceTitle.match(COPY_TITLE_SUFFIX);
    const baseTitle = (sourceMatch?.[1] || sourceTitle.replace(/ Copy$/i, "")).trim() || sourceTitle.trim() || "未命名节点";
    let maxCopyIndex = 0;
    for (const title of existingTitles) {
        const match = title.match(COPY_TITLE_SUFFIX);
        if (!match || match[1] !== baseTitle) continue;
        const copyIndex = Number(match[2]);
        if (Number.isSafeInteger(copyIndex)) maxCopyIndex = Math.max(maxCopyIndex, copyIndex);
    }
    return `${baseTitle}_copy${maxCopyIndex + 1}`;
}

function remapReferenceId(nodeId: string | undefined, idMap: ReadonlyMap<string, string>) {
    return nodeId ? idMap.get(nodeId) || nodeId : undefined;
}

function remapOwnedNodeId(nodeId: string | undefined, idMap: ReadonlyMap<string, string>) {
    return nodeId ? idMap.get(nodeId) : undefined;
}

function remapReferenceIds(nodeIds: string[] | undefined, idMap: ReadonlyMap<string, string>) {
    return nodeIds ? Array.from(new Set(nodeIds.map((nodeId) => idMap.get(nodeId) || nodeId))) : undefined;
}

function copyStoryboardRow(row: StoryboardRow, idMap: ReadonlyMap<string, string>): StoryboardRow {
    const imageNodeId = remapOwnedNodeId(row.imageNodeId, idMap);
    const videoNodeId = remapOwnedNodeId(row.videoNodeId, idMap);
    const hasCopiedOutput = Boolean(imageNodeId || videoNodeId);
    return {
        ...row,
        characters: (row.characters || []).map((character) => ({
            ...character,
            characterImageNodeId: remapReferenceId(character.characterImageNodeId, idMap),
        })),
        assetBindings: (row.assetBindings || []).map((binding) => ({ ...binding, nodeId: remapReferenceId(binding.nodeId, idMap)! })),
        imageNodeId,
        videoNodeId,
        status: hasCopiedOutput ? row.status : "idle",
        errorDetails: undefined,
    };
}

// 副本只能继承内容和用户引用，运行中任务、批次及指向源生成结果的关系必须隔离。
export function isolateCopiedNodeMetadata(node: CanvasNodeData, idMap: ReadonlyMap<string, string>): CanvasNodeMetadata {
    const metadata = resetGenerationTaskMetadata(node.metadata, node.metadata?.content ? "success" : "idle");
    // 提交标记绑定原任务和节点；副本携带它会被普通保存当作未确认生成结果过滤。
    delete metadata.generationEffectKeys;
    delete metadata.generationBatches;
    delete metadata.batchRootId;
    delete metadata.batchChildIds;
    delete metadata.batchFailedCount;
    delete metadata.isBatchRoot;
    delete metadata.primaryImageId;
    delete metadata.imageBatchExpanded;
    delete metadata.batchUsesReferenceImages;
    delete metadata.versionOfNodeId;
    delete metadata.versionLabel;
    delete metadata.versionPrimary;
    delete metadata.upscaleBatch;
    if (metadata.upscale) metadata.upscale = structuredClone(metadata.upscale);
    metadata.generatedFromProcessingNodeId = remapOwnedNodeId(node.metadata?.generatedFromProcessingNodeId, idMap);

    metadata.copiedFromNodeId = node.id;
    if (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio) {
        metadata.generationResultPlacement = "replace-node";
    }
    metadata.frame = node.metadata?.frame ? { ...node.metadata.frame } : undefined;
    metadata.referenceSetId = remapOwnedNodeId(node.metadata?.referenceSetId, idMap);
    metadata.referenceAssetNodeIds = node.metadata?.referenceAssetNodeIds
        ?.map((nodeId) => remapOwnedNodeId(nodeId, idMap))
        .filter((nodeId): nodeId is string => Boolean(nodeId));
    metadata.videoStartFrameNodeId = remapReferenceId(node.metadata?.videoStartFrameNodeId, idMap);
    metadata.videoEndFrameNodeId = remapReferenceId(node.metadata?.videoEndFrameNodeId, idMap);
    metadata.videoMiddleFrameNodeId = remapReferenceId(node.metadata?.videoMiddleFrameNodeId, idMap);
    metadata.videoReferenceOrder = remapReferenceIds(node.metadata?.videoReferenceOrder,idMap);
    metadata.directorPreviewNodeId = remapOwnedNodeId(node.metadata?.directorPreviewNodeId, idMap);
    metadata.directorDepthNodeId = remapOwnedNodeId(node.metadata?.directorDepthNodeId, idMap);
    metadata.directorNormalNodeId = remapOwnedNodeId(node.metadata?.directorNormalNodeId, idMap);
    metadata.directorClayVideoNodeId = remapOwnedNodeId(node.metadata?.directorClayVideoNodeId, idMap);

    const characterViewNodeIds = node.metadata?.characterViewNodeIds;
    const copiedCharacterViewNodeIds = characterViewNodeIds ? {
        front: remapOwnedNodeId(characterViewNodeIds.front, idMap),
        side: remapOwnedNodeId(characterViewNodeIds.side, idMap),
        back: remapOwnedNodeId(characterViewNodeIds.back, idMap),
    } : undefined;
    metadata.characterViewNodeIds = copiedCharacterViewNodeIds && Object.values(copiedCharacterViewNodeIds).some(Boolean)
        ? copiedCharacterViewNodeIds
        : undefined;
    metadata.emotionEdit = node.metadata?.emotionEdit ? {
        ...node.metadata.emotionEdit,
        sourceNodeId: remapReferenceId(node.metadata.emotionEdit.sourceNodeId, idMap)!,
        faceBox: { ...node.metadata.emotionEdit.faceBox },
        editRegion: node.metadata.emotionEdit.editRegion ? { ...node.metadata.emotionEdit.editRegion } : undefined,
    } : undefined;
    metadata.storyboard = node.metadata?.storyboard ? {
        rows: node.metadata.storyboard.rows.map((row) => copyStoryboardRow(row, idMap)),
        visibleColumns: [...node.metadata.storyboard.visibleColumns],
        referenceNodeIds: remapReferenceIds(node.metadata.storyboard.referenceNodeIds, idMap) || [],
    } : undefined;
    return metadata;
}

// Scene-local objects may retain their ids, but each copied card owns a deep
// scene snapshot and fresh shot identities. Output nodes belong to the copy only.
export function isolateCopiedDirectorScenes(nodes: CanvasNodeData[], sourceScenes: DirectorScene[], idMap: ReadonlyMap<string, string>) {
    const scenes: DirectorScene[] = [];
    const copiedNodes = nodes.map((node) => {
        if (!node.metadata?.directorSceneId) return node;
        const source = sourceScenes.find((scene) => scene.id === node.metadata?.directorSceneId);
        if (!source) return { ...node, metadata: { ...node.metadata, directorSceneId: undefined, directorShotId: undefined, directorCoverStorageKey: undefined, directorCoverUrl: undefined, directorCoverSceneUpdatedAt: undefined } };
        const copy = structuredClone(source);
        const shotIds = new Map(copy.shots.map((shot) => [shot.id, nanoid()]));
        copy.id = nanoid();
        copy.createdAt = copy.updatedAt = new Date().toISOString();
        copy.shots = copy.shots.map((shot) => ({
            ...shot,
            id: shotIds.get(shot.id)!,
            previewNodeId: remapOwnedNodeId(shot.previewNodeId, idMap),
            depthNodeId: remapOwnedNodeId(shot.depthNodeId, idMap),
            normalNodeId: remapOwnedNodeId(shot.normalNodeId, idMap),
        }));
        copy.activeShotId = shotIds.get(source.activeShotId) || copy.shots[0]?.id || "";
        scenes.push(copy);
        return { ...node, metadata: { ...node.metadata, directorSceneId: copy.id, directorShotId: shotIds.get(node.metadata.directorShotId || "") || copy.activeShotId } };
    });
    return { nodes: copiedNodes, scenes };
}
