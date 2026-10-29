import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { seedanceOutputWarning } from "@/lib/seedance-output-warning";
import { fitNodeSize, nodeSizeFromRatio, VIDEO_NODE_MAX_SIZE } from "@/lib/canvas/canvas-node-size";
import { compositeEmotionImage } from "@/lib/canvas/canvas-emotion";
import { storeGeneratedAudio } from "@/services/api/audio";
import { storeGeneratedVideo } from "@/services/api/video";
import { parseBackendGenerationResult } from "@/services/api/generation-task";
import type { GenerationTask, GenerationTaskOutput } from "@/services/api/task-center";
import { resolveMediaUrl, type UploadedFile } from "@/services/file-storage";
import { resolveImageUrl, uploadImage, type UploadedImage } from "@/services/image-storage";
import { ownedResourceIdFromMediaRef, resourceStorageKey } from "@/services/api/resources";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { applyGenerationConsumerEffect, generationEffectApplied } from "@/services/generation-consumer-dedupe";
import { attachNodeEffectKey } from "@/services/generation-task-materializer";
import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";
import { mediaResultMetadata } from "@/lib/canvas/canvas-node-semantics";
import { generationTaskInput, generationTaskNodeId } from "@/lib/canvas/canvas-generation-task-identity";
export { generationTaskInput, generationTaskNodeId } from "@/lib/canvas/canvas-generation-task-identity";

export function generationTaskMode(task: GenerationTask, fallback?: CanvasGenerationMode): CanvasGenerationMode {
    const inputMode = generationTaskInput(task)?.mode;
    if (inputMode === "text" || inputMode === "image" || inputMode === "video" || inputMode === "audio") return inputMode;
    if (task.type === "canvas_text") return "text";
    if (task.type === "canvas_video") return "video";
    if (task.type === "canvas_audio") return "audio";
    if (task.type === "canvas_image") return "image";
    return fallback || "image";
}

export function generationTaskCanReloadResource(task: GenerationTask) {
    const mode = generationTaskMode(task);
    return task.status === "succeeded" && (mode === "image" || mode === "video" || mode === "audio") && (Boolean(task.resultJson) || Boolean(task.outputs?.length));
}

export function imageMetadata(image: UploadedImage): CanvasNodeMetadata {
    return {
        content: image.url,
        storageKey: image.storageKey,
        status: "success",
        naturalWidth: image.width,
        naturalHeight: image.height,
        bytes: image.bytes,
        mimeType: image.mimeType,
        errorDetails: undefined,
        generationErrorCode: undefined,
        resourceReloadAvailable: undefined,
        failedPromptFingerprint: undefined,
    };
}

export function videoMetadata(video: UploadedFile): CanvasNodeMetadata {
    return {
        outputParameterWarning: undefined,
        content: video.url,
        storageKey: video.storageKey,
        status: "success",
        naturalWidth: video.width,
        naturalHeight: video.height,
        bytes: video.bytes,
        mimeType: video.mimeType || "video/mp4",
        durationMs: video.durationMs,
        hasAudio: video.hasAudio,
        videoPreview: video.preview ? {
            content: video.preview.url,
            storageKey: video.preview.storageKey,
            width: video.preview.width,
            height: video.preview.height,
            bytes: video.preview.bytes,
            mimeType: video.preview.mimeType,
        } : undefined,
        errorDetails: undefined,
        generationErrorCode: undefined,
        resourceReloadAvailable: undefined,
        failedPromptFingerprint: undefined,
    };
}

export function reuseGeneratedMediaStorageKey(storageKey?: string, url?: string) {
    const existing = storageKey?.trim();
    if (existing) return existing;
    const resourceId = ownedResourceIdFromMediaRef(undefined, url);
    return resourceId ? resourceStorageKey(resourceId) : "";
}

export function audioMetadata(audio: UploadedFile): CanvasNodeMetadata {
    return {
        content: audio.url,
        storageKey: audio.storageKey,
        status: "success",
        bytes: audio.bytes,
        mimeType: audio.mimeType || "audio/mpeg",
        durationMs: audio.durationMs,
        errorDetails: undefined,
        generationErrorCode: undefined,
        resourceReloadAvailable: undefined,
        failedPromptFingerprint: undefined,
    };
}

function workflowMetadataForResultNode(): Partial<CanvasNodeMetadata> {
    return {
        workflowProvider: undefined,
        runningHubWorkflowId: undefined,
        runningHubWorkflowKind: undefined,
        workflowParameters: undefined,
    };
}

// 原地重生会换 storageKey 但继承旧 assetId，形成「旧素材 + 新资源」配对，云端校验会永久拒绝。
// 新媒体结果必须清掉旧绑定，交给入库/修复路径按新资源重绑。
export function applyGeneratedMediaResultMetadata(node: CanvasNodeData, media: CanvasNodeMetadata, extra: Partial<CanvasNodeMetadata> = {}): CanvasNodeMetadata {
    return mediaResultMetadata("generated", {
        ...node.metadata,
        ...workflowMetadataForResultNode(),
        ...media,
        ...extra,
        errorDetails: undefined,
        assetId: undefined,
        resultOrigin: "generated" as const,
    });
}

export type GenerationResultMediaIO = {
    resolveImageUrl: typeof resolveImageUrl;
    uploadImage: typeof uploadImage;
    resolveMediaUrl: typeof resolveMediaUrl;
    storeGeneratedVideo: typeof storeGeneratedVideo;
    storeGeneratedAudio: typeof storeGeneratedAudio;
    fetchBlob: (url: string) => Promise<Blob>;
};

const defaultGenerationResultMediaIO: GenerationResultMediaIO = {
    resolveImageUrl,
    uploadImage,
    resolveMediaUrl,
    storeGeneratedVideo,
    storeGeneratedAudio,
    fetchBlob: async (url) => (await fetch(url)).blob(),
};

export async function buildGenerationTaskNodeResult(node: CanvasNodeData, task: GenerationTask, nodes: CanvasNodeData[] = [node], mediaIO: GenerationResultMediaIO = defaultGenerationResultMediaIO): Promise<CanvasNodeData> {
    const mode = generationTaskMode(task, node.type === CanvasNodeType.Text ? "text" : node.type === CanvasNodeType.Video ? "video" : node.type === CanvasNodeType.Audio ? "audio" : "image");
    const prompt = node.metadata?.prompt || task.prompt;
    const result = parseBackendGenerationResult(task);

    if (mode === "image") {
        const image = result.images?.[node.metadata?.taskOutputIndex ?? 0];
        const imageSource = image?.dataUrl || image?.url || "";
        const reuseImageKey = reuseGeneratedMediaStorageKey(image?.storageKey, imageSource);
        if (!imageSource && !reuseImageKey) throw new Error("后端任务没有返回图片");
        if (node.metadata?.emotionEdit && !image?.dataUrl) throw new Error("后端任务没有返回图片");
        let resultDataUrl = image?.dataUrl || imageSource;
        const emotionEdit = node.metadata?.emotionEdit;
        if (emotionEdit) {
            if (!emotionEdit.editRegion) throw new Error("情绪编辑任务缺少局部合成区域，已拒绝使用整图重绘结果");
            const sourceNode = nodes.find((item) => item.id === emotionEdit.sourceNodeId);
            if (!sourceNode?.metadata?.content) throw new Error("情绪编辑源图片已删除，无法恢复局部合成结果");
            const sourceDataUrl = await resolveImageUrl(sourceNode.metadata.storageKey, sourceNode.metadata.content);
            if (!sourceDataUrl) throw new Error("无法读取情绪编辑源图片，未使用整图重绘结果");
            resultDataUrl = await compositeEmotionImage(sourceDataUrl, resultDataUrl, emotionEdit.editRegion, emotionEdit.faceBox);
        }
        const uploaded =
            reuseImageKey && !emotionEdit
                ? { url: await mediaIO.resolveImageUrl(reuseImageKey, imageSource), storageKey: reuseImageKey, width: image?.width || 1024, height: image?.height || 1024, bytes: image?.bytes || 0, mimeType: image?.mimeType || "image/png" }
                : await mediaIO.uploadImage(resultDataUrl);
        const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
        const requestedImageSize = nodeSizeFromRatio(node.metadata?.size || "auto", imageConfig.width, imageConfig.height);
        const imageSizeBounds = requestedImageSize || { width: node.width || imageConfig.width, height: node.height || imageConfig.height };
        const hasReportedImageSize = Boolean(image?.width && image.width > 0 && image.height && image.height > 0);
        const resultWidth = reuseImageKey && !hasReportedImageSize && requestedImageSize ? requestedImageSize.width : uploaded.width;
        const resultHeight = reuseImageKey && !hasReportedImageSize && requestedImageSize ? requestedImageSize.height : uploaded.height;
        const normalizedImage = resultWidth === uploaded.width && resultHeight === uploaded.height ? uploaded : { ...uploaded, width: resultWidth, height: resultHeight };
        const imageSize =
            node.metadata?.generationType === "edit" && !requestedImageSize ? { width: node.width || imageConfig.width, height: node.height || imageConfig.height } : fitNodeSize(resultWidth, resultHeight, imageSizeBounds.width, imageSizeBounds.height);
        return {
            ...node,
            type: CanvasNodeType.Image,
            width: imageSize.width,
            height: imageSize.height,
            position: { x: node.position.x + node.width / 2 - imageSize.width / 2, y: node.position.y + node.height / 2 - imageSize.height / 2 },
            metadata: applyGeneratedMediaResultMetadata(node, imageMetadata(normalizedImage), { prompt, ...completedTaskMetadata(task) }),
        };
    }

    if (mode === "video") {
        const videoSource = result.video?.dataUrl || result.video?.url || "";
        const reuseVideoKey = reuseGeneratedMediaStorageKey(result.video?.storageKey, videoSource);
        if (!videoSource && !reuseVideoKey) throw new Error("后端任务没有返回视频");
        const video = reuseVideoKey
            ? {
                  url: await mediaIO.resolveMediaUrl(reuseVideoKey, videoSource),
                  storageKey: reuseVideoKey,
                  width: result.video?.width,
                  height: result.video?.height,
                  durationMs: result.video?.durationMs,
                  bytes: result.video?.bytes || 0,
                  mimeType: result.video?.mimeType || "video/mp4",
              }
            : await mediaIO.storeGeneratedVideo({ url: videoSource, mimeType: result.video?.mimeType || "video/mp4" });
        const videoSize = fitNodeSize(video.width || node.width || VIDEO_NODE_MAX_SIZE.width, video.height || node.height || VIDEO_NODE_MAX_SIZE.height, VIDEO_NODE_MAX_SIZE.width, VIDEO_NODE_MAX_SIZE.height);
        const geometry = node.metadata?.locked
            ? {}
            : {
                  width: videoSize.width,
                  height: videoSize.height,
                  position: { x: node.position.x + node.width / 2 - videoSize.width / 2, y: node.position.y + node.height / 2 - videoSize.height / 2 },
              };
        return {
            ...node,
            type: CanvasNodeType.Video,
            ...geometry,
            metadata: applyGeneratedMediaResultMetadata(node, { ...videoMetadata(video), outputParameterWarning: seedanceOutputWarning(task.inputJson, video.width, video.height, task.model) }, { prompt, ...completedTaskMetadata(task) }),
        };
    }

    if (mode === "audio") {
        const audioSource = result.audio?.dataUrl || result.audio?.url || "";
        const reuseAudioKey = reuseGeneratedMediaStorageKey(result.audio?.storageKey, audioSource);
        if (!audioSource && !reuseAudioKey) throw new Error("后端任务没有返回音频");
        const audio = reuseAudioKey
            ? { url: await mediaIO.resolveMediaUrl(reuseAudioKey, audioSource), storageKey: reuseAudioKey, durationMs: result.audio?.durationMs, bytes: result.audio?.bytes || 0, mimeType: result.audio?.mimeType || "audio/mpeg" }
            : await mediaIO.storeGeneratedAudio(await mediaIO.fetchBlob(audioSource), result.audio?.format || "mp3");
        return { ...node, type: CanvasNodeType.Audio, metadata: applyGeneratedMediaResultMetadata(node, audioMetadata(audio), { prompt, ...completedTaskMetadata(task) }) };
    }

    if (!result.text) throw new Error("后端任务没有返回文本");
    return {
        ...node,
        type: CanvasNodeType.Text,
        metadata: { ...node.metadata, content: result.text, richText: undefined, prompt, ...completedTaskMetadata(task), status: "success", errorDetails: undefined, generationErrorCode: undefined, resourceReloadAvailable: undefined, failedPromptFingerprint: undefined },
    };
}

export async function applyGenerationTaskResultToNodes(nodes: CanvasNodeData[], task: GenerationTask, targetNodeId?: string) {
    const node = findGenerationTaskNode(nodes, task, targetNodeId);
    if (!node) return { nodes, updated: false, nodeId: "", node: null };
    const updatedNode = await buildGenerationTaskNodeResult(node, task, nodes);
    return {
        nodes: applySuccessfulVersionSelection(nodes, updatedNode),
        updated: true,
        nodeId: node.id,
        node: updatedNode,
    };
}

/**
 * Repair a successful task result whose attach effect was acknowledged but whose
 * canvas snapshot is still loading. The returned stamp lets the caller commit
 * this repair through the same durable generation-effect transaction.
 */
export async function applyRecoveredGenerationTaskResultToNodes(nodes: CanvasNodeData[], task: GenerationTask, targetNodeId: string) {
    const applied = await applyGenerationTaskResultToNodes(nodes, task, targetNodeId);
    const outputIndex = nodes.find((node) => node.id === targetNodeId)?.metadata?.taskOutputIndex ?? 0;
    if (!applied.updated || !applied.node) return { ...applied, effectKey: attachNodeEffectKey(task.id, targetNodeId, outputIndex) };
    const effectKey = attachNodeEffectKey(task.id, applied.nodeId, outputIndex);
    const recoveredNodes = applied.nodes.map((node) => node.id === applied.nodeId
        ? { ...node, metadata: applyGenerationConsumerEffect(node.metadata || {}, effectKey, (metadata) => metadata).value }
        : node);
    return { ...applied, nodes: recoveredNodes, node: recoveredNodes.find((node) => node.id === applied.nodeId)!, effectKey };
}

export async function applyMaterializedGenerationTaskResultToNodes(nodes: CanvasNodeData[], task: GenerationTask, output: GenerationTaskOutput, effectKey: string, targetNodeId?: string) {
    const node = findGenerationTaskNode(nodes, task, targetNodeId);
    if (!node) return { nodes, updated: false, nodeId: "", node: null };
    if (generationEffectApplied(node.metadata || {}, effectKey)) {
        return { nodes, updated: true, nodeId: node.id, node };
    }
    const asset = useAssetStore.getState().assets.find((candidate) => candidate.id === output.materializedAssetId);
    if (!asset) throw new Error("生成任务输出素材不存在");
    const result = parseBackendGenerationResult(task);
    if (asset.kind === "image") {
        const images = [...(result.images || [])];
        images[output.outputIndex] = {
            dataUrl: asset.data.dataUrl || asset.coverUrl,
            storageKey: asset.data.storageKey,
            width: asset.data.width,
            height: asset.data.height,
            bytes: asset.data.bytes,
            mimeType: asset.data.mimeType,
        };
        result.images = images;
    } else if (asset.kind === "video") {
        result.video = { dataUrl: asset.data.url, ...asset.data };
    } else if (asset.kind === "audio") {
        result.audio = { dataUrl: asset.data.url, ...asset.data };
    } else {
        throw new Error("生成任务输出素材类型不支持画布节点");
    }
    const indexedNode = { ...node, metadata: { ...node.metadata, taskOutputIndex: output.outputIndex } };
    const updatedNode = await buildGenerationTaskNodeResult(indexedNode, { ...task, resultJson: JSON.stringify(result) }, nodes);
    const durableNode = {
        ...updatedNode,
        metadata: applyGenerationConsumerEffect({ ...updatedNode.metadata, assetId: asset.id }, effectKey, (metadata) => metadata).value,
    };
    return {
        nodes: applySuccessfulVersionSelection(nodes, durableNode),
        updated: true,
        nodeId: node.id,
        node: durableNode,
    };
}

function applySuccessfulVersionSelection(nodes: CanvasNodeData[], updatedNode: CanvasNodeData) {
    const versionRootId = updatedNode.metadata?.versionOfNodeId;
    return nodes.map((item) => {
        if (item.id === updatedNode.id) {
            return versionRootId ? { ...updatedNode, metadata: { ...updatedNode.metadata, versionPrimary: true } } : updatedNode;
        }
        if (!versionRootId || (item.metadata?.versionOfNodeId || item.id) !== versionRootId) return item;
        return { ...item, metadata: { ...item.metadata, versionPrimary: false } };
    });
}

export async function syncGenerationTaskToCanvasStore(task: GenerationTask) {
    if (task.status !== "succeeded" || !task.projectId) return false;
    // 短剧任务使用业务项目 ID，不能拿它请求同名的画布项目。
    const domainProjectId = task.clientContext?.domainProjectId || generationTaskInput(task)?.metadata?.domainProjectId;
    if (domainProjectId === task.projectId || !generationTaskNodeId(task)) return false;
    const { loadCanvasProjectForEditing } = await import("@/services/local-workspace-sync");
    const project = await loadCanvasProjectForEditing(task.projectId);
    if (!project) return false;
    const target = findGenerationTaskNode(project.nodes, task);
    const candidates = project.nodes.filter((node) => node.metadata?.taskId === task.id || node.id === target?.id);
    let changed = false;
    for (const node of candidates) {
        if (node.metadata?.taskId === task.id && node.metadata.status === "success" && node.metadata.content) continue;
        const updatedNode = await buildGenerationTaskNodeResult(node, task, project.nodes);
        const latest = useCanvasStore.getState().projects.find((item) => item.id === project.id);
        if (!latest?.nodes.some((item) => item.id === node.id)) continue;
        useCanvasStore.getState().updateProject(project.id, { nodes: latest.nodes.map((item) => (item.id === node.id ? updatedNode : item)) });
        changed = true;
    }
    return changed;
}

function findGenerationTaskNode(nodes: CanvasNodeData[], task: GenerationTask, targetNodeId?: string) {
    const nodeId = targetNodeId || generationTaskNodeId(task);
    return nodes.find((node) => node.id === nodeId) || (targetNodeId ? undefined : nodes.find((node) => node.metadata?.taskId === task.id));
}

function completedTaskMetadata(task: GenerationTask): CanvasNodeMetadata {
    return {
        taskFailureDiagnostics: task.failureDiagnostics,
        taskProviderRequestId: task.providerRequestId,
        taskId: task.id,
        taskStatus: task.status,
        taskProgress: typeof task.progress === "number" && Number.isFinite(task.progress) ? Math.max(0, Math.min(100, Math.round(task.progress))) : 100,
        taskStage: task.stage,
        taskStartedAt: task.startedAt,
        taskCompletedAt: task.completedAt,
        taskDurationMs: task.startedAt && task.completedAt ? Math.max(0, Date.parse(task.completedAt) - Date.parse(task.startedAt)) : undefined,
        taskCreatedAt: task.createdAt || task.created_at,
        taskUpdatedAt: task.updatedAt || task.updated_at,
        errorDetails: undefined,
        generationErrorCode: undefined,
        failedPromptFingerprint: undefined,
    };
}
