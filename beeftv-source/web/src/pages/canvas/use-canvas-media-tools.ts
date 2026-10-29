import { isAIUpscaleTask, upscaleObservationFailureMetadata, UPSCALE_OBSERVATION_TIMEOUT_MS } from "@/lib/canvas/canvas-ai-upscale-task";
import { recoverUpscaleTask } from "@/services/api/media-upscale";
import { bindBackendCanvasGenerationResult } from "@/services/canvas-generation-consumer";
import { waitForGenerationTask } from "@/services/api/task-center";
import { getImageBlob } from "@/services/image-storage";
import { uploadResourceFile } from "@/services/api/resources";
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { App } from "antd";
import { confirmDepthComponents } from "@/components/depth-components-panel";
import { nanoid } from "nanoid";

import type { CanvasImageCropRect } from "@/components/canvas/canvas-node-crop-dialog";
import type { CanvasImageMaskEditPayload } from "@/components/canvas/canvas-node-mask-edit-dialog";
import type { CanvasImageSplitParams } from "@/components/canvas/canvas-node-split-dialog";
import type { CanvasImageUpscaleParams } from "@/components/canvas/canvas-node-upscale-dialog";
import type { CanvasImageAngleParams } from "@/components/canvas/canvas-node-angle-dialog";
import type { CanvasVideoCropRect } from "@/components/canvas/canvas-video-crop-dialog";
import { buildLightingLabel, type CanvasImageLightingOptions } from "@/components/canvas/canvas-node-lighting-dialog";
import type { CanvasImageEmotionPayload } from "@/components/canvas/canvas-node-emotion-panel";
import type { PanoramaGenerateConfig } from "@/components/canvas/canvas-panorama-config-modal";
import type { CanvasVideoFrameParams } from "@/components/canvas/canvas-video-frame-dialog";
import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { cropDataUrl, splitDataUrl, upscaleDataUrl } from "@/lib/canvas/canvas-image-data";
import { normalizeVideoCropForEncoding } from "@/lib/canvas/video-crop-geometry";
import { isValidGridSplit, layoutGridSplitCells } from "@/lib/canvas/canvas-grid-split";
import { audioMetadata, imageMetadata, videoMetadata } from "@/lib/canvas/canvas-generation-task-sync";
import { findAvailableGenerationGroupPosition, imageGenerationChildPosition, imageGenerationGroupSize } from "@/lib/canvas/canvas-generation-layout";
import { canvasGenerationPromptMetadata } from "@/lib/canvas/canvas-generation-submission";
import { cancelIncompleteImageBatch } from "@/lib/canvas/canvas-image-batch-retry";
import { buildAngleLabel, buildAnglePrompt, createCanvasNode } from "@/lib/canvas/canvas-project-domain";
import { validateVideoSegmentBatch } from "@/lib/canvas/canvas-video-regeneration";
import { resolveCanvasStyleExecution } from "@/lib/canvas/canvas-style-execution";
import {
    buildGenerationConfig,
    buildImageGenerationMetadata,
    nodeReferenceImage,
    isGenerationCanceled,
    runBackendCanvasGenerationTask,
} from "@/lib/canvas/canvas-project-generation";
import { fitNodeSize, VIDEO_NODE_MAX_SIZE } from "@/lib/canvas/canvas-node-size";
import { compositeEmotionImage, emotionGenerationSize, emotionProviderMask, normalizeEmotionPromptForProvider, resolveEmotionEditPlan } from "@/lib/canvas/canvas-emotion";
import { DEFAULT_PORTRAIT_TEXTURE_SETTINGS } from "@/lib/canvas/canvas-portrait-texture";
import { IMAGE_PROMPT_REVERSE } from "@/lib/prompts";
import { createPortraitTextureNode } from "@/lib/canvas/canvas-image-source";
import { mediaResultMetadata } from "@/lib/canvas/canvas-node-semantics";
import { attachOwnedDepthCaptureResult, recoverOwnedDepthCaptureNode, recoverOwnedDepthCaptureNodes } from "@/lib/canvas/canvas-depth-recover";
import { depthCaptureTaskMetadata, depthCaptureWaitFailureMetadata } from "@/lib/canvas/canvas-depth-capture";
import { persistOwnedCanvasMediaNodes } from "@/lib/canvas/canvas-media-persist";
import { captureVideoFrames, resolveVideoFramePresetTimeMs } from "@/lib/canvas/canvas-video-frame";
import { resolveCanvasVideoDurationMs } from "@/lib/canvas/canvas-video-duration";
import { buildVideoFrameNodes } from "@/lib/canvas/canvas-video-frame-nodes";
import { mergeVideos, warmFFmpeg, type MergeVideoProgress } from "@/lib/canvas/canvas-video-merge";
import { cropVideo, extractVideoAudio, removeAudioFromVideo, trimVideoSegment } from "@/lib/canvas/canvas-video-segment";
import { applyInlineVideoTrimMetadata, normalizeInlineVideoTrimRange, type InlineVideoTrimRange } from "@/lib/canvas/canvas-video-inline-trim";
import { generationErrorMessage } from "@/lib/generation-error";
import { modelCapabilityConfigFor } from "@/lib/model-capabilities";
import { defaultImageParamsForModel } from "@/lib/model-selection";
import { navigateToSettings } from "@/lib/settings-navigation";
import { storeGeneratedVideo } from "@/services/api/video";
import { getMediaBlob, resolveMediaUrl, uploadMediaFile } from "@/services/file-storage";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { ensureCanvasNodeAsset } from "@/services/project-asset-sync";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import { syncLocalCanvasSnapshot } from "@/services/local-workspace-sync";
import { openLocalCanvasProjectFromBackend, persistCanvasDocument } from "@/services/local-workspace-repository";
import { http } from "@/services/api/request";
import { flushCanvasStorePersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { queryGenerationTask, type GenerationTask } from "@/services/api/task-center";
import { getResourcePlaybackBlob, ownedResourceIdFromMediaRef, resourceStorageKey } from "@/services/api/resources";
import {
    assertLocalExecutorSession,
    beginLocalExecutorSession,
    isLocalExecutorSessionStop,
    isUncertainLocalExecutorSubmit,
    localExecutorFrozenInputKey,
    localExecutorIntentAfterError,
    nextLocalExecutorClientOperationId,
    runOwnedDepthCapture,
} from "@/lib/plugins/builtin/editor/local-executor-session";
import { assertUserScope, captureUserScope, type CapturedUserScope } from "@/lib/user-scope-guard";

function normalizeMaskEditQuality(quality: string | undefined, size: string | undefined) {
    const value = String(quality || "").trim().toLowerCase();
    if (value && value !== "auto" && value !== "any") return value;
    const match = String(size || "").trim().toLowerCase().match(/^(\d+)x(\d+)$/);
    if (!match) return quality || "auto";
    const pixels = Number(match[1]) * Number(match[2]);
    return pixels <= 2_000_000 ? "1k" : pixels <= 4_300_000 ? "2k" : pixels <= 8_294_400 ? "4k" : quality || "auto";
}
import { defaultConfig, resolveModelRequestConfig, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type ContextMenuState } from "@/types/canvas";
import type { StartCanvasUploadStatus } from "./use-canvas-upload";

type UseCanvasMediaToolsOptions = {
    projectId: string;
    domainProjectId?: string;
    nodesRef: { current: CanvasNodeData[] };
    connectionsRef: { current: CanvasConnection[] };
    selectedNodeIdsRef: { current: Set<string> };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setSelectedNodeIds: Dispatch<SetStateAction<Set<string>>>;
    setSelectedConnectionId: Dispatch<SetStateAction<string | null>>;
    setDialogNodeId: Dispatch<SetStateAction<string | null>>;
    setContextMenu: Dispatch<SetStateAction<ContextMenuState | null>>;
    setHoveredNodeId: Dispatch<SetStateAction<string | null>>;
    setToolbarNodeId: Dispatch<SetStateAction<string | null>>;
    setRunningNodeId: Dispatch<SetStateAction<string | null>>;
    startUploadStatus: StartCanvasUploadStatus;
    startGenerationRequest: (targetNodeId: string, originNodeId: string, runningId?: string, controller?: AbortController) => AbortController;
    finishGenerationRequest: (targetNodeId: string, controller: AbortController) => void;
    bindGenerationTask: (targetNodeId: string, task: GenerationTask) => void;
};

const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;
const NODE_STATUS_ERROR = "error" as const;
const NODE_STATUS_IDLE = "idle" as const;

export function useCanvasMediaTools({
    projectId,
    domainProjectId,
    nodesRef,
    connectionsRef,
    selectedNodeIdsRef,
    setNodes,
    setConnections,
    setSelectedNodeIds,
    setSelectedConnectionId,
    setDialogNodeId,
    setContextMenu,
    setHoveredNodeId,
    setToolbarNodeId,
    setRunningNodeId,
    startUploadStatus,
    startGenerationRequest,
    finishGenerationRequest,
    bindGenerationTask,
}: UseCanvasMediaToolsOptions) {
    const { message, modal } = App.useApp();
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const extractingVideoFramesNodeIdRef = useRef<string | null>(null);
    const mergeVideoRunningRef = useRef(false);
    const [cropNodeId, setCropNodeId] = useState<string | null>(null);
    const [videoCropNodeId, setVideoCropNodeId] = useState<string | null>(null);
    const [annotationNodeId, setAnnotationNodeId] = useState<string | null>(null);
    const [maskEditNodeId, setMaskEditNodeId] = useState<string | null>(null);
    const [upscaleNodeId, setUpscaleNodeId] = useState<string | null>(null);
    const [angleNodeId, setAngleNodeId] = useState<string | null>(null);
    const [lightingNodeId, setLightingNodeId] = useState<string | null>(null);
    const [emotionNodeId, setEmotionNodeId] = useState<string | null>(null);
    const [frameDialogNodeId, setFrameDialogNodeId] = useState<string | null>(null);
    const [extractingVideoFramesNodeId, setExtractingVideoFramesNodeId] = useState<string | null>(null);
    const [mergeVideoProgress, setMergeVideoProgress] = useState<MergeVideoProgress | null>(null);
    const [segmentRunningMode, setSegmentRunningMode] = useState<"audio" | null>(null);
    const segmentRunningRef = useRef(false);
    const [inlineTrimNodeId, setInlineTrimNodeId] = useState<string | null>(null);
    const [inlineTrimRunning, setInlineTrimRunning] = useState(false);
    const inlineTrimRunningRef = useRef(false);
    const [panoramaConfigNodeId, setPanoramaConfigNodeId] = useState<string | null>(null);
    const projectIdRef = useRef(projectId);
    const depthObserversRef = useRef(new Set<AbortController>());
    projectIdRef.current = projectId;
    useEffect(() => () => {
        for (const observer of depthObserversRef.current) observer.abort();
        depthObserversRef.current.clear();
    }, [projectId]);

    const resolveImageEditStyle = useCallback((node: CanvasNodeData, prompt: string, config: AiConfig) => {
        try {
            const runtime = resolveCanvasStyleExecution(nodesRef.current, node, prompt, config, "image");
            return {
                prompt: runtime?.prompt || prompt,
                metadata: runtime ? { styleProfileJson: runtime.profileJson, styleExecutionPlan: runtime.plan } : {},
            };
        } catch (error) {
            message.error(generationErrorMessage(error));
            return null;
        }
    }, [message, nodesRef]);

    const persistMediaNodes = useCallback(async (
        mediaNodes: CanvasNodeData[],
        mediaConnections: CanvasConnection[] = [],
        options?: { expectedScope?: CapturedUserScope; signal?: AbortSignal },
    ) => {
        try {
            return await persistOwnedCanvasMediaNodes({
                canvasId: projectId,
                domainProjectId,
                mediaNodes,
                mediaConnections,
                expectedScope: options?.expectedScope ?? captureUserScope(),
                signal: options?.signal,
            }, {
                ensureCanvasNodeAsset,
                getStoredProject: (canvasId) => {
                    const project = useCanvasStore.getState().projects.find((item) => item.id === canvasId);
                    return project ? { nodes: project.nodes, connections: project.connections } : undefined;
                },
                hasProject: (canvasId) => useCanvasStore.getState().projects.some((item) => item.id === canvasId),
                openProject: (id, expectedScope) => openLocalCanvasProjectFromBackend(id, expectedScope),
                updateProject: (canvasId, patch) => useCanvasStore.getState().updateProject(canvasId, patch),
                flushPersistence: async (expectedScope) => {
                    assertUserScope(expectedScope);
                    await flushCanvasStorePersistence();
                },
                syncSnapshot: (id, patch, expectedScope) => syncLocalCanvasSnapshot(id, patch, expectedScope),
                readSavedProject: async (canvasId, expectedScope) => {
                    const { project } = await http.get<{ project: { nodes: CanvasNodeData[] } }>(
                        `/canvas-projects/${encodeURIComponent(canvasId)}`,
                        { expectedScope, signal: options?.signal },
                    );
                    return project;
                },
                setNodes,
                getLiveProjectId: () => projectIdRef.current,
                getLiveNodes: () => nodesRef.current,
                getLiveConnections: () => connectionsRef.current,
                isLocalWorkspace: isLocalWorkspaceMode,
                warn: (text) => { message.warning(text); },
                error: (text) => { message.error(text); },
            });
        } catch (error) {
            if (isLocalExecutorSessionStop(error)) return new Map<string, string>();
            throw error;
        }
    }, [connectionsRef, domainProjectId, message, nodesRef, projectId, setNodes]);

    const prepareUpscaleResource = useCallback(async (node: CanvasNodeData) => {
        const existing = ownedResourceIdFromMediaRef(node.metadata?.storageKey, node.metadata?.content);
        if (existing) return existing;
        const key = node.metadata?.storageKey || "";
        const video = node.type === CanvasNodeType.Video;
        let blob = key ? await (video ? getMediaBlob(key) : getImageBlob(key)) : null;
        if (!blob) {
            const url = video ? await resolveMediaUrl(key, node.metadata?.content) : await resolveImageUrl(key, node.metadata?.content);
            if (!url) throw new Error("无法读取原素材");
            const response = await fetch(url);
            if (!response.ok) throw new Error("读取原素材失败");
            blob = await response.blob();
        }
        const resource = await uploadResourceFile(blob, video ? "video" : "image", { width: node.metadata?.naturalWidth, height: node.metadata?.naturalHeight });
        return resource.id;
    }, []);

    const observeAIUpscale = useCallback((task: GenerationTask, targetNodeId: string, expectedScope: CapturedUserScope) => {
        const observer = new AbortController();
        depthObserversRef.current.add(observer);
        let observedTask = task;
        void waitForGenerationTask(task.id, { initialTask: task, expectedScope, signal: observer.signal, timeoutMs: UPSCALE_OBSERVATION_TIMEOUT_MS, onTaskUpdate: update => { observedTask = update; if (projectIdRef.current === projectId) bindGenerationTask(targetNodeId, update); } }).then(async completed => {
            assertUserScope(expectedScope);
            if (projectIdRef.current !== projectId) return;
            const currentNode = nodesRef.current.find(item => item.id === targetNodeId);
            if (!currentNode) return;
            // Backend delivery may have already bound the output. Adopt its idempotent
            // receipt instead of racing it with a full canvas snapshot write.
            await bindBackendCanvasGenerationResult({
                canvasId: projectId,
                nodeId: targetNodeId,
                task: completed,
                outputIndex: currentNode.metadata?.taskOutputIndex ?? 0,
                signal: observer.signal,
                isCurrent: () => !observer.signal.aborted && projectIdRef.current === projectId,
                nodesRef,
                setNodes,
            });
        }).catch(cause => {
            if (observer.signal.aborted || projectIdRef.current !== projectId) return;
            setNodes(current => current.map(item => item.id === targetNodeId ? { ...item, metadata: { ...item.metadata, ...upscaleObservationFailureMetadata(observedTask, generationErrorMessage(cause)) } } : item));
        }).finally(() => depthObserversRef.current.delete(observer));
    }, [bindGenerationTask, nodesRef, projectId, setNodes]);

    const recoverAIUpscale = useCallback(async (node: CanvasNodeData) => {
        const taskId = node.metadata?.taskId;
        if (!taskId) throw new Error("找不到原超分任务");
        const expectedScope = captureUserScope();
        const original = await queryGenerationTask(taskId, { expectedScope });
        if (!isAIUpscaleTask(original)) throw new Error("该任务不是超分任务");
        const task = original.status === "failed" ? await recoverUpscaleTask(taskId, expectedScope) : original;
        assertUserScope(expectedScope);
        if (projectIdRef.current !== projectId) return;
        bindGenerationTask(node.id, task);
        setNodes(current => current.map(item => item.id === node.id ? { ...item, metadata: { ...item.metadata, status: "loading", errorDetails: undefined, processingLabel: "取回原超分任务结果" } } : item));
        observeAIUpscale(task, node.id, expectedScope);
    }, [bindGenerationTask, observeAIUpscale, projectId, setNodes]);


    const createImageReversePromptNodes = useCallback((node: CanvasNodeData) => {
        if (node.type !== CanvasNodeType.Image || !node.metadata?.content) {
            message.warning("图片节点为空，无法反推提示词");
            return;
        }
        const gap = 96;
        const textSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
        const resultSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
        const centerY = node.position.y + node.height / 2;
        const textNode = {
            ...createCanvasNode(CanvasNodeType.Text, { x: node.position.x + node.width + gap + textSpec.width / 2, y: centerY }, { content: IMAGE_PROMPT_REVERSE, prompt: IMAGE_PROMPT_REVERSE, status: NODE_STATUS_SUCCESS, fontSize: 14 }),
            title: "反推提示词",
        };
        const resultNode = {
            ...createCanvasNode(CanvasNodeType.Text, { x: textNode.position.x + textNode.width + gap + resultSpec.width / 2, y: centerY }, {
                content: "",
                generationMode: "text",
                model: effectiveConfig.textModel || effectiveConfig.model || defaultConfig.textModel,
                count: 1,
                composerContent: "参考图片：@图片1\n任务说明：@文本1",
            }),
            title: "反推提示词结果",
        };
        setNodes((current) => [...current, textNode, resultNode]);
        setConnections((current) => [...current, { id: nanoid(), fromNodeId: node.id, toNodeId: resultNode.id }, { id: nanoid(), fromNodeId: textNode.id, toNodeId: resultNode.id }]);
        setSelectedNodeIds(new Set([resultNode.id]));
        setSelectedConnectionId(null);
        setDialogNodeId(resultNode.id);
        setContextMenu(null);
    }, [effectiveConfig.model, effectiveConfig.textModel, message, setConnections, setContextMenu, setDialogNodeId, setNodes, setSelectedConnectionId, setSelectedNodeIds]);

    const openPortraitTextureEditor = useCallback((node: CanvasNodeData) => {
        if (node.type !== CanvasNodeType.Image || !node.metadata?.content) {
            message.warning("图片节点为空，无法调节人物质感");
            return;
        }
        const portraitTextureSettings = { ...DEFAULT_PORTRAIT_TEXTURE_SETTINGS, ...node.metadata?.portraitTexture };
        const child = createPortraitTextureNode(node, nanoid());
        child.metadata = { ...child.metadata, portraitTexture: portraitTextureSettings };
        setHoveredNodeId(null);
        setToolbarNodeId(null);
        setNodes((current) => [...current, child]);
        setConnections((current) => [...current, { id: nanoid(), fromNodeId: node.id, toNodeId: child.id }]);
        setSelectedNodeIds(new Set([child.id]));
        setSelectedConnectionId(null);
        setDialogNodeId(child.id);
    }, [message, setConnections, setDialogNodeId, setHoveredNodeId, setNodes, setSelectedConnectionId, setSelectedNodeIds, setToolbarNodeId]);

    const cropImageNode = useCallback(async (node: CanvasNodeData, crop: CanvasImageCropRect) => {
        if (!node.metadata?.content) return;
        try {
            const source = await resolveImageUrl(node.metadata.storageKey, node.metadata.content, { cacheMiss: true });
            const cropped = await cropDataUrl(source, crop);
            const image = await uploadImage(cropped);
            const size = fitNodeSize(image.width, image.height, node.width, node.height);
            const childId = nanoid();
            const child: CanvasNodeData = { id: childId, type: CanvasNodeType.Image, title: `${node.title || "图片"} · 裁剪`, position: { x: node.position.x + node.width + 96, y: node.position.y }, width: size.width, height: size.height, metadata: mediaResultMetadata("derived", { ...imageMetadata(image), prompt: node.metadata?.prompt, generatedFromNodeId: node.id,
                workflowOperation: { id: "image.crop", version: 1, config: { x: crop.x, y: crop.y, width: crop.width, height: crop.height }, inputs: [{ nodeId: node.id, port: "image" }] },
            }) };
            const connection = { id: nanoid(), fromNodeId: node.id, toNodeId: childId };
            setNodes((current) => [...current, child]);
            setConnections((current) => [...current, connection]);
            setSelectedNodeIds(new Set([childId]));
            setDialogNodeId(childId);
            setCropNodeId(null);
            await persistMediaNodes([child], [connection]);
        } catch (error) {
            message.error(error instanceof Error ? `裁切失败：${error.message}` : "裁切失败，请重试");
        }
    }, [message, persistMediaNodes, setConnections, setDialogNodeId, setNodes, setSelectedNodeIds]);

    const cropVideoNode = useCallback(async (node: CanvasNodeData, crop: CanvasVideoCropRect, sourceDimensions: { width: number; height: number }) => {
        const source = { url: node.metadata?.content, storageKey: node.metadata?.storageKey };
        if (!source.url && !source.storageKey) return;
        const normalizedCrop = normalizeVideoCropForEncoding(crop, sourceDimensions);
        const childId = nanoid();
        const connection = { id: nanoid(), fromNodeId: node.id, toNodeId: childId };
        const size = fitNodeSize(normalizedCrop.width, normalizedCrop.height, VIDEO_NODE_MAX_SIZE.width, VIDEO_NODE_MAX_SIZE.height);
        const pendingChild: CanvasNodeData = {
            id: childId,
            type: CanvasNodeType.Video,
            title: `${node.title || "视频"} · 裁切`,
            position: { x: node.position.x + node.width + 96, y: node.position.y },
            width: size.width,
            height: size.height,
            metadata: mediaResultMetadata("derived", {
                status: NODE_STATUS_LOADING,
                processingLabel: "正在裁切视频",
                prompt: `从「${node.title || "视频"}」裁切画面`,
                videoCrop: normalizedCrop,
                videoCropSourceNodeId: node.id,
                workflowOperation: { id: "video.crop", version: 1, config: { x: normalizedCrop.x / sourceDimensions.width, y: normalizedCrop.y / sourceDimensions.height, width: normalizedCrop.width / sourceDimensions.width, height: normalizedCrop.height / sourceDimensions.height }, inputs: [{ nodeId: node.id, port: "video" }] },
            }),
        };
        // The source remains available as soon as the crop is confirmed. The
        // downstream node owns the asynchronous FFmpeg work and its outcome.
        setNodes((current) => [...current, pendingChild]);
        setConnections((current) => [...current, connection]);
        setSelectedNodeIds(new Set([childId]));
        setSelectedConnectionId(null);
        setVideoCropNodeId(null);
        try {
            const output = await cropVideo(source, normalizedCrop);
            const uploaded = await uploadMediaFile(output, "video");
            const completedChild: CanvasNodeData = {
                ...pendingChild,
                width: fitNodeSize(uploaded.width || normalizedCrop.width, uploaded.height || normalizedCrop.height, VIDEO_NODE_MAX_SIZE.width, VIDEO_NODE_MAX_SIZE.height).width,
                height: fitNodeSize(uploaded.width || normalizedCrop.width, uploaded.height || normalizedCrop.height, VIDEO_NODE_MAX_SIZE.width, VIDEO_NODE_MAX_SIZE.height).height,
                metadata: mediaResultMetadata("derived", {
                    ...videoMetadata(uploaded),
                    prompt: pendingChild.metadata?.prompt,
                    status: NODE_STATUS_SUCCESS,
                    videoCrop: normalizedCrop,
                    videoCropSourceNodeId: node.id,
                    workflowOperation: pendingChild.metadata?.workflowOperation,
                }),
            };
            setNodes((current) => current.map((item) => item.id === childId ? completedChild : item));
            await persistMediaNodes([completedChild], [connection]);
        } catch (error) {
            const details = error instanceof Error ? error.message : "视频画面裁切失败";
            setNodes((current) => current.map((item) => item.id === childId ? {
                ...item,
                metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails: details },
            } : item));
        }
    }, [persistMediaNodes, setConnections, setNodes, setSelectedConnectionId, setSelectedNodeIds]);

    const depthCaptureNode = useCallback(async (node: CanvasNodeData) => {
        const resourceId = ownedResourceIdFromMediaRef(node.metadata?.storageKey, node.metadata?.content);
        if (!resourceId) {
            message.error("请先等待视频保存到本地资源库，再进行深度动作捕捉");
            return;
        }
        const requestedScope = captureUserScope();
        try {
            if (!await confirmDepthComponents(modal)) return;
            assertUserScope(requestedScope);
            if (projectIdRef.current !== projectId || !nodesRef.current.some(item => item.id === node.id)) return;
        } catch (error) { message.error(generationErrorMessage(error)); return; }
        const expectedScope = captureUserScope();
        const originalProjectId = projectId;
        const observer = new AbortController();
        depthObserversRef.current.add(observer);
        const frozenInputKey = localExecutorFrozenInputKey(["depth_capture", originalProjectId, resourceId]);
        const clientOperationId = nextLocalExecutorClientOperationId(null, frozenInputKey);
        const childId = nanoid();
        const connection = { id: nanoid(), fromNodeId: node.id, toNodeId: childId };
        const pendingChild: CanvasNodeData = {
            id: childId,
            type: CanvasNodeType.Video,
            title: `${node.title || "视频"} · 深度动作捕捉`,
            position: { x: node.position.x + node.width + 96, y: node.position.y },
            width: node.width,
            height: node.height,
            metadata: mediaResultMetadata("derived", {
                status: NODE_STATUS_LOADING,
                processingLabel: "检查深度处理组件",
                taskStage: "检查深度处理组件",
                taskProgress: 0,
                prompt: `从「${node.title || "视频"}」生成深度动作参考`,
                depthSourceNodeId: node.id,
                taskClientOperationId: clientOperationId,
                taskClientOperationInput: frozenInputKey,
            }),
        };
        nodesRef.current = [...nodesRef.current, pendingChild];
        connectionsRef.current = [...connectionsRef.current, connection];
        setNodes(nodesRef.current);
        setConnections((current) => [...current, connection]);
        setSelectedNodeIds(new Set([childId]));
        setSelectedConnectionId(null);
        let submittedTaskId: string | undefined;
        let latestDepthTask: GenerationTask | undefined;
        try {
            const session = beginLocalExecutorSession(originalProjectId, {
                controller: observer,
                getLiveProjectId: () => projectIdRef.current,
                expectedScope,
            });
            await persistCanvasDocument(originalProjectId, { nodes: nodesRef.current, connections: connectionsRef.current }, expectedScope);
            assertLocalExecutorSession(session);
            if (!nodesRef.current.some(item => item.id === childId)) return;
            const { task } = await runOwnedDepthCapture({
                session,
                projectId: originalProjectId,
                resourceId,
                nodeId: childId,
                clientOperationId,
                onCreated: async (created) => {
                    latestDepthTask = created;
                    submittedTaskId = created.id;
                    nodesRef.current = nodesRef.current.map(item => item.id === childId && item.metadata?.taskClientOperationId === clientOperationId ? { ...item, metadata: { ...item.metadata, taskId: created.id, taskStatus: created.status, taskClientOperationId: created.clientOperationId || clientOperationId } } : item);
                    setNodes(nodesRef.current);
                    await persistCanvasDocument(originalProjectId, { nodes: nodesRef.current, connections: connectionsRef.current }, expectedScope);
                },
                onTaskUpdate: (next) => {
                    latestDepthTask = next;
                    setNodes((current) => current.map((item) => item.id === childId && item.metadata?.taskId === next.id ? { ...item, metadata: { ...item.metadata, ...depthCaptureTaskMetadata(next) } } : item));
                },
            });
            const target = nodesRef.current.find(item => item.id === childId);
            if (target?.metadata?.taskId === task.id) await attachOwnedDepthCaptureResult({ node: target, task, session, nodesRef, setNodes });
        } catch (error) {
            if (isLocalExecutorSessionStop(error)) return;
            const details = error instanceof Error ? error.message : "深度动作捕捉失败";
            const intent = localExecutorIntentAfterError({
                clientOperationId,
                submittedTaskId,
                frozenInputKey,
            }, error);
            const uncertain = isUncertainLocalExecutorSubmit(error, submittedTaskId);
            setNodes((current) => current.map((item) => item.id === childId && item.metadata?.taskClientOperationId === clientOperationId ? {
                ...item,
                metadata: {
                    ...item.metadata,
                    status: NODE_STATUS_ERROR,
                    taskId: submittedTaskId,
                    taskClientOperationId: intent.clientOperationId,
                    taskClientOperationInput: frozenInputKey,
                    taskClientOperationTerminal: intent.terminal,
                    taskStage: uncertain ? "submission_unknown" : item.metadata?.taskStage,
                    errorDetails: details,
                    ...(!uncertain ? depthCaptureWaitFailureMetadata(error, latestDepthTask || submittedTaskId) : {}),
                },
            } : item));
            message.error(details);
        } finally {
            depthObserversRef.current.delete(observer);
        }
    }, [message, modal, nodesRef, connectionsRef, projectId, setConnections, setNodes, setSelectedConnectionId, setSelectedNodeIds]);

    const retryDepthCaptureNode = useCallback(async (node: CanvasNodeData) => {
        // A known task is recovered before considering a new execution.
        if (node.metadata?.taskId) {
            const observer = new AbortController();
            depthObserversRef.current.add(observer);
            try {
                const session = beginLocalExecutorSession(projectId, {
                    controller: observer, getLiveProjectId: () => projectIdRef.current,
                });
                const existing = await queryGenerationTask(node.metadata.taskId, { signal: observer.signal, expectedScope: session.expectedScope });
                assertLocalExecutorSession(session);
                if (!nodesRef.current.some(item => item.id === node.id && item.metadata?.taskId === existing.id)) return;
                if (existing.status !== "failed" && existing.status !== "cancelled") {
                    await recoverOwnedDepthCaptureNode({ node, nodesRef, setNodes, session });
                    return;
                }
            } catch (error) {
                if (!isLocalExecutorSessionStop(error)) message.error(generationErrorMessage(error));
                return;
            } finally { depthObserversRef.current.delete(observer); }
        }
        const sourceNodeId = node.metadata?.depthSourceNodeId;
        const sourceNode = sourceNodeId ? nodesRef.current.find((item) => item.id === sourceNodeId) : undefined;
        const resourceId = sourceNode ? ownedResourceIdFromMediaRef(sourceNode.metadata?.storageKey, sourceNode.metadata?.content) : undefined;
        if (!sourceNode || !resourceId) {
            const details = "原始视频已丢失，无法重新生成深度动作参考";
            setNodes((current) => current.map((item) => item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails: details } } : item));
            message.error(details);
            return;
        }
        const requestedScope = captureUserScope();
        try {
            if (!await confirmDepthComponents(modal)) return;
            assertUserScope(requestedScope);
            if (projectIdRef.current !== projectId || !nodesRef.current.some(item => item.id === node.id)) return;
        } catch (error) { message.error(generationErrorMessage(error)); return; }
        const expectedScope = captureUserScope();
        const originalProjectId = projectId;
        const observer = new AbortController();
        depthObserversRef.current.add(observer);
        const frozenInputKey = localExecutorFrozenInputKey(["depth_capture", originalProjectId, resourceId]);
        const clientOperationId = nextLocalExecutorClientOperationId({
            clientOperationId: node.metadata?.taskClientOperationId,
            submittedTaskId: node.metadata?.taskId,
            frozenInputKey: node.metadata?.taskClientOperationInput,
            terminal: node.metadata?.taskClientOperationTerminal,
        }, frozenInputKey);
        nodesRef.current = nodesRef.current.map((item) => item.id === node.id ? {
            ...item,
            metadata: {
                ...item.metadata,
                status: NODE_STATUS_LOADING,
                processingLabel: "检查深度处理组件",
                taskStage: "检查深度处理组件",
                taskProgress: 0,
                taskStatus: "queued",
                taskId: undefined,
                taskClientOperationId: clientOperationId,
                taskClientOperationInput: frozenInputKey,
                taskClientOperationTerminal: undefined,
                errorDetails: undefined,
            },
        } : item);
        setNodes(nodesRef.current);
        let submittedTaskId: string | undefined;
        let latestDepthTask: GenerationTask | undefined;
        try {
            const session = beginLocalExecutorSession(originalProjectId, {
                controller: observer,
                getLiveProjectId: () => projectIdRef.current,
                expectedScope,
            });
            await persistCanvasDocument(originalProjectId, { nodes: nodesRef.current, connections: connectionsRef.current }, expectedScope);
            assertLocalExecutorSession(session);
            if (!nodesRef.current.some(item => item.id === node.id && item.metadata?.taskClientOperationId === clientOperationId)) return;
            const { task } = await runOwnedDepthCapture({
                session,
                projectId: originalProjectId,
                resourceId,
                nodeId: node.id,
                clientOperationId,
                onCreated: async (created) => {
                    latestDepthTask = created;
                    submittedTaskId = created.id;
                    nodesRef.current = nodesRef.current.map(item => item.id === node.id && item.metadata?.taskClientOperationId === clientOperationId ? { ...item, metadata: { ...item.metadata, taskId: created.id, taskStatus: created.status, taskClientOperationId: created.clientOperationId || clientOperationId } } : item);
                    setNodes(nodesRef.current);
                    await persistCanvasDocument(originalProjectId, { nodes: nodesRef.current, connections: connectionsRef.current }, expectedScope);
                },
                onTaskUpdate: (next) => {
                    latestDepthTask = next;
                    setNodes((current) => current.map((item) => item.id === node.id && item.metadata?.taskId === next.id ? { ...item, metadata: { ...item.metadata, ...depthCaptureTaskMetadata(next) } } : item));
                },
            });
            const target = nodesRef.current.find(item => item.id === node.id);
            if (target?.metadata?.taskId === task.id) await attachOwnedDepthCaptureResult({ node: target, task, session, nodesRef, setNodes });
        } catch (error) {
            if (isLocalExecutorSessionStop(error)) return;
            const details = error instanceof Error ? error.message : "深度动作捕捉失败";
            const intent = localExecutorIntentAfterError({
                clientOperationId,
                submittedTaskId,
                frozenInputKey,
            }, error);
            const uncertain = isUncertainLocalExecutorSubmit(error, submittedTaskId);
            setNodes((current) => current.map((item) => item.id === node.id && item.metadata?.taskClientOperationId === clientOperationId ? {
                ...item,
                metadata: {
                    ...item.metadata,
                    status: NODE_STATUS_ERROR,
                    taskId: submittedTaskId,
                    taskClientOperationId: intent.clientOperationId,
                    taskClientOperationInput: frozenInputKey,
                    taskClientOperationTerminal: intent.terminal,
                    taskStage: uncertain ? "submission_unknown" : item.metadata?.taskStage,
                    errorDetails: details,
                    ...(!uncertain ? depthCaptureWaitFailureMetadata(error, latestDepthTask || submittedTaskId) : {}),
                },
            } : item));
            message.error(details);
        } finally {
            depthObserversRef.current.delete(observer);
        }
    }, [message, modal, nodesRef, connectionsRef, projectId, setNodes]);

    const recoverDepthCaptureNodes = useCallback((signal: AbortSignal) => {
        recoverOwnedDepthCaptureNodes({
            nodesRef,
            signal,
            expectedScope: captureUserScope(),
            projectId,
            getLiveProjectId: () => projectIdRef.current,
            observers: depthObserversRef.current,
            setNodes,
        });
    }, [nodesRef, projectId, setNodes]);

    const saveAnnotatedImageNode = useCallback(async (node: CanvasNodeData, dataUrl: string) => {
        const image = await uploadImage(dataUrl);
        const size = fitNodeSize(image.width, image.height, node.width, node.height);
        const childId = nanoid();
        const child: CanvasNodeData = { id: childId, type: CanvasNodeType.Image, title: `${node.title || "图片"} · 标注`, position: { x: node.position.x + node.width + 96, y: node.position.y }, width: size.width, height: size.height, metadata: mediaResultMetadata("derived", { ...imageMetadata(image), prompt: node.metadata?.prompt, generatedFromNodeId: node.id }) };
        const connection = { id: nanoid(), fromNodeId: node.id, toNodeId: childId };
        setNodes((current) => [...current, child]);
        setConnections((current) => [...current, connection]);
        setSelectedNodeIds(new Set([childId]));
        setSelectedConnectionId(null);
        setDialogNodeId(null);
        setAnnotationNodeId(null);
        await persistMediaNodes([child], [connection]);
        message.success("标注图片已保存为新节点");
    }, [message, persistMediaNodes, setConnections, setDialogNodeId, setNodes, setSelectedConnectionId, setSelectedNodeIds]);

    const closeFrameDialog = useCallback(() => {
        if (extractingVideoFramesNodeIdRef.current) return;
        setFrameDialogNodeId(null);
    }, []);

    const extractVideoFrames = useCallback(async (node: CanvasNodeData, params: CanvasVideoFrameParams) => {
        const content = node.metadata?.content;
        const resourceId = ownedResourceIdFromMediaRef(node.metadata?.storageKey, content);
        const effectiveStorageKey = node.metadata?.storageKey || (resourceId ? resourceStorageKey(resourceId) : "");
        if ((!content && !effectiveStorageKey) || extractingVideoFramesNodeIdRef.current || !params.timesMs.length) return;
        const progress = startUploadStatus("关键帧截取", "读取视频资源", params.timesMs.length + 2);
        extractingVideoFramesNodeIdRef.current = node.id;
        setExtractingVideoFramesNodeId(node.id);
        setFrameDialogNodeId(null);
        try {
            const storedBlob = effectiveStorageKey ? await getMediaBlob(effectiveStorageKey).catch(() => null) : null;
            const resolvedUrl = storedBlob ? "" : await resolveMediaUrl(effectiveStorageKey, content || "").catch(() => content || "");
            progress.update("定位并绘制所选画面", 2);
            let captured: Awaited<ReturnType<typeof captureVideoFrames>>;
            try {
                captured = await captureVideoFrames(storedBlob || resolvedUrl, params.timesMs);
            } catch (captureError) {
                const playbackBlob = resourceId ? await getResourcePlaybackBlob(resourceStorageKey(resourceId)).catch(() => null) : null;
                if (!playbackBlob) throw captureError;
                captured = await captureVideoFrames(playbackBlob, params.timesMs);
            }
            const uploadedFrames = [];
            const uploadFailures: string[] = [];
            for (let index = 0; index < captured.frames.length; index += 1) {
                const frame = captured.frames[index];
                try {
                    progress.update(`保存画面（${index + 1}/${captured.frames.length}）`, index + 3);
                    uploadedFrames.push({ timeMs: frame.timeMs, image: await uploadImage(frame.blob) });
                } catch (error) {
                    uploadFailures.push(error instanceof Error ? error.message : "画面图片上传失败");
                }
            }
            const frameNodes = buildVideoFrameNodes(node, uploadedFrames, nodesRef.current);
            if (!frameNodes.length) throw new Error(uploadFailures[0] || "画面图片保存失败");
            const links = frameNodes.map((frameNode) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: frameNode.id }));
            const nextNodes = [...nodesRef.current, ...frameNodes];
            const nextConnections = [...connectionsRef.current, ...links];
            const selection = new Set(frameNodes.map((frameNode) => frameNode.id));
            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;
            selectedNodeIdsRef.current = selection;
            setNodes(nextNodes);
            setConnections(nextConnections);
            setSelectedNodeIds(selection);
            setSelectedConnectionId(null);
            await persistMediaNodes(frameNodes, links);
            const failedCount = captured.failures.length + uploadFailures.length;
            progress.done(failedCount ? `已截取 ${frameNodes.length} 个关键帧，${failedCount} 个失败` : `已截取 ${frameNodes.length} 个关键帧并创建独立图片节点`);
            if (failedCount) message.warning(`${failedCount} 个时间点提取失败，其余画面已创建`);
            else message.success(`已截取 ${frameNodes.length} 个关键帧，新图片节点已生成在视频右侧`);
        } catch (error) {
            const details = error instanceof Error ? error.message : "视频画面提取失败";
            progress.fail(details);
            message.error(details);
        } finally {
            extractingVideoFramesNodeIdRef.current = null;
            setExtractingVideoFramesNodeId(null);
        }
    }, [connectionsRef, message, nodesRef, persistMediaNodes, selectedNodeIdsRef, setConnections, setNodes, setSelectedConnectionId, setSelectedNodeIds, startUploadStatus]);

    // 视频节点工具栏的三个快捷取帧动作直接执行，不再打开批量选帧弹窗。
    const extractVideoFrameAt = useCallback((node: CanvasNodeData, preset: "current" | "first" | "last" = "current") => {
        if (!node.metadata?.content && !node.metadata?.storageKey) {
            message.warning("视频节点为空，无法进行关键帧截取");
            return;
        }
        const video = document.querySelector<HTMLVideoElement>(`[data-node-id="${CSS.escape(node.id)}"] video`);
        const durationMs = resolveCanvasVideoDurationMs(node.metadata?.durationMs, video?.duration);
        const currentMs = video && Number.isFinite(video.currentTime) ? Math.round(video.currentTime * 1000) : 0;
        const timeMs = resolveVideoFramePresetTimeMs(preset, durationMs, currentMs);
        setHoveredNodeId(null);
        setToolbarNodeId(null);
        void extractVideoFrames(node, { timesMs: [timeMs] });
    }, [extractVideoFrames, message, setHoveredNodeId, setToolbarNodeId]);

    const openInlineVideoTrim = useCallback((node: CanvasNodeData) => {
        if (!node.metadata?.content) {
            message.warning("视频节点为空，无法剪辑");
            return;
        }
        if (inlineTrimRunningRef.current) return;
        setHoveredNodeId(null);
        setToolbarNodeId(null);
        setDialogNodeId(null);
        // Preload the same shared worker while the user sets the trim range.
        // A failure remains non-blocking here and is reported by submission.
        void warmFFmpeg().catch(() => undefined);
        setInlineTrimNodeId(node.id);
    }, [message, setDialogNodeId, setHoveredNodeId, setToolbarNodeId]);

    const openVideoCrop = useCallback((node: CanvasNodeData) => {
        if (!node.metadata?.content) {
            message.warning("视频节点为空，无法裁切");
            return;
        }
        setHoveredNodeId(null);
        setToolbarNodeId(null);
        // The editor remains responsive while FFmpeg initializes in the
        // background; confirmation then reuses this exact worker instance.
        void warmFFmpeg().catch(() => undefined);
        setVideoCropNodeId(node.id);
    }, [message, setHoveredNodeId, setToolbarNodeId]);

    const closeInlineVideoTrim = useCallback(() => {
        if (!inlineTrimRunningRef.current) setInlineTrimNodeId(null);
    }, []);

    const confirmInlineVideoTrim = useCallback(async (node: CanvasNodeData, requestedRange: InlineVideoTrimRange) => {
        if (inlineTrimRunningRef.current || !node.metadata?.content) return;
        const sourceDurationMs = Math.max(100, node.metadata.durationMs || requestedRange.endMs);
        const range = normalizeInlineVideoTrimRange(requestedRange, sourceDurationMs);
        inlineTrimRunningRef.current = true;
        setInlineTrimRunning(true);
        const progress = startUploadStatus("剪辑视频", "加载 FFmpeg", 4);
        try {
            const output = await trimVideoSegment(
                { url: node.metadata.content, storageKey: node.metadata.storageKey },
                range,
                sourceDurationMs,
                (status) => progress.update(status.phase === "loading" ? "加载 FFmpeg" : status.phase === "reading" ? "读取视频资源" : "正在裁切片段 · " + Math.round(status.progress) + "%", status.phase === "encoding" ? 3 : 2),
            );
            progress.update("保存剪辑结果", 4);
            const uploaded = await uploadMediaFile(output, "video");
            const existingTrimCount = nodesRef.current.filter((item) => item.metadata?.videoTrimSourceNodeId === node.id).length;
            const child: CanvasNodeData = {
                id: nanoid(),
                type: CanvasNodeType.Video,
                title: `${node.title || "视频"} · 剪辑片段`,
                position: {
                    x: node.position.x + node.width + 96,
                    y: node.position.y + existingTrimCount * 48,
                },
                width: node.width,
                height: node.height,
                metadata: mediaResultMetadata("derived", {
                    ...applyInlineVideoTrimMetadata(node.metadata || {}, videoMetadata(uploaded), range),
                    status: NODE_STATUS_SUCCESS,
                    prompt: `从「${node.title || "视频"}」剪辑 ${((range.endMs - range.startMs) / 1000).toFixed(2)} 秒片段`,
                    videoTrimSourceNodeId: node.id,
                    workflowOperation: { id: "video.trim", version: 1, config: { startSeconds: range.startMs / 1000, endSeconds: range.endMs / 1000 }, inputs: [{ nodeId: node.id, port: "video" }] },
                }),
            };
            const connection: CanvasConnection = { id: nanoid(), fromNodeId: node.id, toNodeId: child.id };
            const nextNodes = [...nodesRef.current, child];
            const nextConnections = [...connectionsRef.current, connection];
            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;
            selectedNodeIdsRef.current = new Set([child.id]);
            setNodes(nextNodes);
            setConnections(nextConnections);
            setSelectedNodeIds(new Set([child.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(null);
            await persistMediaNodes([child]);
            setInlineTrimNodeId(null);
            progress.done(`已生成 ${((range.endMs - range.startMs) / 1000).toFixed(2)} 秒剪辑视频`);
            message.success("已生成新的剪辑视频，原视频已保留");
        } catch (error) {
            const details = error instanceof Error ? error.message : "视频剪辑失败";
            progress.fail(details);
            message.error(details);
        } finally {
            inlineTrimRunningRef.current = false;
            setInlineTrimRunning(false);
        }
    }, [connectionsRef, message, nodesRef, persistMediaNodes, selectedNodeIdsRef, setConnections, setDialogNodeId, setNodes, setSelectedConnectionId, setSelectedNodeIds, startUploadStatus]);

    // 音视频分离同时产出独立音轨和无声视频，原视频始终保留。
    const runExtractVideoAudio = useCallback(async (node: CanvasNodeData, params: { startMs: number; endMs: number }) => {
        const progress = startUploadStatus("音视频分离", "生成无声视频与音轨", 6);
        try {
            const source = { url: node.metadata?.content, storageKey: node.metadata?.storageKey };
            const range = { startMs: params.startMs, endMs: params.endMs };
            const audio = await extractVideoAudio(source, range, node.metadata?.durationMs, (status) => {
                progress.update(status.phase === "loading" ? "加载 FFmpeg" : status.phase === "reading" ? "检查视频音轨" : "正在提取音轨 · " + Math.round(status.progress) + "%", status.phase === "encoding" ? 2 : 1);
            });
            progress.update("正在生成无声视频", 3);
            const mutedVideo = await removeAudioFromVideo(source, range, node.metadata?.durationMs, (status) => {
                progress.update(status.phase === "reading" ? "读取视频资源" : "正在生成无声视频 · " + Math.round(status.progress) + "%", status.phase === "encoding" ? 4 : 3);
            });
            progress.update("保存两个独立结果", 5);
            const [uploadedVideo, uploadedAudio] = await Promise.all([uploadMediaFile(mutedVideo, "video"), uploadMediaFile(audio, "audio")]);
            const videoSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Video];
            const audioSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
            const outputX = node.position.x + node.width + 96;
            const silentVideo = createCanvasNode(CanvasNodeType.Video, { x: outputX + videoSpec.width / 2, y: node.position.y + videoSpec.height / 2 }, mediaResultMetadata("derived", {
                ...videoMetadata(uploadedVideo), prompt: `从「${node.title || "视频"}」移除声音`, status: NODE_STATUS_SUCCESS,
                videoAudioSourceNodeId: node.id, videoHasAudio: false,
            }));
            silentVideo.title = `${node.title || "视频"} · 无声视频`;
            const audioNode = createCanvasNode(CanvasNodeType.Audio, { x: outputX + audioSpec.width / 2, y: node.position.y + videoSpec.height + 96 + audioSpec.height / 2 }, mediaResultMetadata("derived", {
                ...audioMetadata(uploadedAudio), prompt: `从「${node.title || "视频"}」提取的声音`, status: NODE_STATUS_SUCCESS,
                audioExtractSourceNodeId: node.id, audioExtractStartMs: params.startMs, audioExtractEndMs: params.endMs,
            }));
            audioNode.title = `${node.title || "视频"} · 音轨`;
            const outputs = [silentVideo, audioNode];
            const outputIds = new Set(outputs.map((item) => item.id));
            const links = outputs.map((item) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: item.id }));
            nodesRef.current = [...nodesRef.current, ...outputs];
            connectionsRef.current = [...connectionsRef.current, ...links];
            setNodes(nodesRef.current);
            setConnections(connectionsRef.current);
            setSelectedNodeIds(outputIds);
            setSelectedConnectionId(null);
            const savedAssets = await persistMediaNodes(outputs, links);
            if (outputs.some((output) => !savedAssets.get(output.id))) throw new Error("分离结果尚未确认保存，请重试；不要将当前节点视为已保存的成品");
            progress.done("已生成并保存无声视频和独立音轨");
            message.success("已生成并保存无声视频和独立音轨，原视频已保留");
        } catch (error) {
            const details = error instanceof Error ? error.message : "音频提取失败";
            setNodes((current) => current.map((item) => item.id === node.id ? { ...item, metadata: { ...item.metadata, mediaOperationError: details } } : item));
            progress.fail(details);
            modal.error({ title: "音视频分离未完成", content: details, okText: "知道了" });
        }
    }, [connectionsRef, message, modal, nodesRef, persistMediaNodes, setConnections, setSelectedConnectionId, setSelectedNodeIds, setNodes, startUploadStatus]);

    // 音视频分离始终处理整段视频，直接生成独立音轨节点，不再打开范围选择弹窗。
    const extractAudioFromVideo = useCallback((node: CanvasNodeData) => {
        if (!node.metadata?.content) {
            message.warning("视频节点为空，无法进行音视频分离");
            return;
        }
        if (segmentRunningRef.current) return;
        segmentRunningRef.current = true;
        setSegmentRunningMode("audio");
        setHoveredNodeId(null);
        setToolbarNodeId(null);
        const video = document.querySelector<HTMLVideoElement>(`[data-node-id="${CSS.escape(node.id)}"] video`);
        const durationMs = resolveCanvasVideoDurationMs(node.metadata.durationMs, video?.duration);
        if (!durationMs || durationMs <= 0) {
            segmentRunningRef.current = false;
            setSegmentRunningMode(null);
            message.warning("视频时长尚未就绪，无法分离整段音频，请稍后重试");
            return;
        }
        void runExtractVideoAudio(node, { startMs: 0, endMs: durationMs }).finally(() => {
            segmentRunningRef.current = false;
            setSegmentRunningMode(null);
        });
    }, [message, runExtractVideoAudio, setHoveredNodeId, setSegmentRunningMode, setToolbarNodeId]);

    const mergeVideosByIds = useCallback(async (videoNodeIds: string[]) => {
        if (mergeVideoRunningRef.current) return;
        const requestedIds = new Set(videoNodeIds);
        const videos = nodesRef.current
            .filter((node) => requestedIds.has(node.id) && node.type === CanvasNodeType.Video && Boolean(node.metadata?.content))
            .sort((left, right) => {
                const leftShot = left.metadata?.shotIndex ?? Number.MAX_SAFE_INTEGER;
                const rightShot = right.metadata?.shotIndex ?? Number.MAX_SAFE_INTEGER;
                return leftShot - rightShot || left.position.y - right.position.y || left.position.x - right.position.x;
            });
        if (videos.length < 2) {
            message.warning("请至少选择两个已有视频");
            return;
        }
        mergeVideoRunningRef.current = true;
        setMergeVideoProgress({ phase: "reading", progress: 0 });
        try {
            const blob = await mergeVideos(videos.map((node) => ({ id: node.id, url: node.metadata?.content, storageKey: node.metadata?.storageKey })), setMergeVideoProgress);
            setMergeVideoProgress({ phase: "saving", progress: 98 });
            const uploaded = await storeGeneratedVideo({ blob });
            const size = fitNodeSize(uploaded.width || 1280, uploaded.height || 720, VIDEO_NODE_MAX_SIZE.width, VIDEO_NODE_MAX_SIZE.height);
            const left = Math.max(...videos.map((node) => node.position.x + node.width)) + 120;
            const top = Math.min(...videos.map((node) => node.position.y));
            const mergedNode = createCanvasNode(CanvasNodeType.Video, { x: left + size.width / 2, y: top + size.height / 2 }, mediaResultMetadata("derived", {
                ...videoMetadata(uploaded),
                prompt: `按选中顺序合并 ${videos.length} 段视频`,
                workflowKind: "final",
                workflowTitle: "合并成片",
                videoEditOperation: "concat",
                videoMergeSourceNodeIds: videos.map((node) => node.id),
                status: NODE_STATUS_SUCCESS,
            }));
            mergedNode.title = `合并成片 · ${videos.length} 段`;
            mergedNode.width = size.width;
            mergedNode.height = size.height;
            mergedNode.position = { x: left, y: top };
            const links = videos.map((node) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: mergedNode.id }));
            const nextNodes = [...nodesRef.current, mergedNode];
            const nextConnections = [...connectionsRef.current, ...links];
            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;
            setNodes(nextNodes);
            setConnections(nextConnections);
            const selection = new Set([mergedNode.id]);
            selectedNodeIdsRef.current = selection;
            setSelectedNodeIds(selection);
            setSelectedConnectionId(null);
            setDialogNodeId(null);
            setMergeVideoProgress({ phase: "binding", progress: 98 });
            await persistMediaNodes([mergedNode]);
            setMergeVideoProgress({ phase: "done", progress: 100 });
            message.success(`已合并 ${videos.length} 段视频，成片节点已添加`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "视频合并失败");
        } finally {
            mergeVideoRunningRef.current = false;
            window.setTimeout(() => setMergeVideoProgress(null), 700);
        }
    }, [connectionsRef, message, nodesRef, persistMediaNodes, selectedNodeIdsRef, setConnections, setDialogNodeId, setNodes, setSelectedConnectionId, setSelectedNodeIds]);

    const mergeSelectedVideos = useCallback(() => mergeVideosByIds(Array.from(selectedNodeIdsRef.current)), [mergeVideosByIds, selectedNodeIdsRef]);

    const openPanoramaConfig = useCallback((node: CanvasNodeData) => {
        setPanoramaConfigNodeId(node.id);
    }, []);

    const createPanoramaViewerWithConfig = useCallback((node: CanvasNodeData, composedPrompt: string, config: PanoramaGenerateConfig) => {
        const panoramaSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Panorama];
        const childId = nanoid();
        const childNode: CanvasNodeData = {
            id: childId,
            type: CanvasNodeType.Panorama,
            title: `${node.title || "图片"} · 全景`,
            position: { x: node.position.x + node.width + 96, y: node.position.y },
            width: panoramaSpec.width,
            height: panoramaSpec.height,
            metadata: {
                prompt: composedPrompt || node.metadata?.prompt,
                panoramaConfig: {
                    projection: config.projection,
                    sourceMode: config.sourceMode,
                    smartBase: config.smartBase,
                    directImageUrl: config.directImageUrl ?? null,
                },
            },
        };
        setNodes((current) => [...current, childNode]);
        setConnections((current) => {
            const linkTargets = new Set<string>([node.id]);
            config.referenceImages.forEach((reference) => linkTargets.add(reference.id));
            const extraConnections = config.referenceImages
                .filter((reference) => reference.id !== node.id)
                .map((reference) => ({ id: nanoid(), fromNodeId: reference.id, toNodeId: childId }));
            return [...current, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }, ...extraConnections];
        });
        setSelectedNodeIds(new Set([childId]));
        setSelectedConnectionId(null);
        // 全景节点是纯查看器，创建后不弹提示词面板。
        setDialogNodeId(null);
        setPanoramaConfigNodeId(null);
        message.success(config.sourceMode === "image" ? "已创建全景查看节点" : "已创建全景生成节点");
    }, [message, setConnections, setDialogNodeId, setNodes, setSelectedConnectionId, setSelectedNodeIds]);

    const addPanoramaCaptureNode = useCallback(async (node: CanvasNodeData, dataUrl: string, title: string) => {
        const image = await uploadImage(dataUrl);
        const size = fitNodeSize(image.width || 720, image.height || 405);
        // 已有导出时按列错开，避免多张截图叠在同一位置。
        const outputCount = connectionsRef.current.filter((connection) => connection.fromNodeId === node.id).length;
        const childNode: CanvasNodeData = {
            id: nanoid(),
            type: CanvasNodeType.Image,
            title,
            position: { x: node.position.x + node.width + 96, y: node.position.y + (outputCount % 5) * (size.height + 32) },
            width: size.width,
            height: size.height,
            metadata: mediaResultMetadata("derived", { ...imageMetadata(image), prompt: node.metadata?.prompt, generatedFromNodeId: node.id }),
        };
        setNodes((current) => [...current, childNode]);
        setConnections((current) => [...current, { id: nanoid(), fromNodeId: node.id, toNodeId: childNode.id }]);
        await persistMediaNodes([childNode]);
        message.success(`已导出「${title}」`);
    }, [connectionsRef, message, persistMediaNodes, setConnections, setNodes]);

    // 豆包账号节点结果物化：与全景截图同一模式——上传媒体、在源节点右侧创建原生结果节点并连线。
    // 结果落原生 Image/Video 节点（而非豆包节点自身），下游分镜/图片/视频/导演台按原生数据流消费。
    const addDoubaoResultNode = useCallback(async (source: CanvasNodeData, kind: "image" | "video", blob: Blob, title: string, options?: { prompt?: string }) => {
        const outputCount = connectionsRef.current.filter((connection) => connection.fromNodeId === source.id).length;
        if (kind === "image") {
            const image = await uploadImage(blob);
            const size = fitNodeSize(image.width || 720, image.height || 405);
            const childNode: CanvasNodeData = {
                id: nanoid(),
                type: CanvasNodeType.Image,
                title,
                position: { x: source.position.x + source.width + 96, y: source.position.y + (outputCount % 5) * (size.height + 32) },
                width: size.width,
                height: size.height,
                metadata: mediaResultMetadata("generated", { ...imageMetadata(image), prompt: options?.prompt, generatedFromNodeId: source.id }),
            };
            setNodes((current) => [...current, childNode]);
            setConnections((current) => [...current, { id: nanoid(), fromNodeId: source.id, toNodeId: childNode.id }]);
            await persistMediaNodes([childNode]);
            return;
        }
        const uploaded = await uploadMediaFile(blob, "video");
        const size = NODE_DEFAULT_SIZE[CanvasNodeType.Video];
        const childNode: CanvasNodeData = {
            id: nanoid(),
            type: CanvasNodeType.Video,
            title,
            position: { x: source.position.x + source.width + 96, y: source.position.y + (outputCount % 5) * (size.height + 32) },
            width: size.width,
            height: size.height,
            metadata: mediaResultMetadata("generated", { ...videoMetadata(uploaded), prompt: options?.prompt, generatedFromNodeId: source.id }),
        };
        setNodes((current) => [...current, childNode]);
        setConnections((current) => [...current, { id: nanoid(), fromNodeId: source.id, toNodeId: childNode.id }]);
        await persistMediaNodes([childNode]);
    }, [connectionsRef, persistMediaNodes, setConnections, setNodes]);

    const splitImageNode = useCallback(async (node: CanvasNodeData, params: CanvasImageSplitParams) => {
        if (!node.metadata?.content || !isValidGridSplit(params)) return;
        const source = await resolveImageUrl(node.metadata.storageKey, node.metadata.content, { cacheMiss: true });
        const pieces = await splitDataUrl(source, params);
        const sizedPieces = await Promise.all(pieces.map(async (piece) => {
            const image = await uploadImage(piece.dataUrl);
            return { piece, image, size: fitNodeSize(image.width, image.height) };
        }));
        const positions = layoutGridSplitCells(
            { x: node.position.x + node.width + 96, y: node.position.y },
            sizedPieces.map(({ piece, size }) => ({ row: piece.row, column: piece.column, width: size.width, height: size.height })),
        );
        const childNodes = sizedPieces.map(({ piece, image, size }, index) => ({
            id: nanoid(),
            type: CanvasNodeType.Image,
            title: `${node.title || "图片"} · 宫格 ${piece.row + 1}-${piece.column + 1}`,
            position: positions[index] || { x: node.position.x + node.width + 96, y: node.position.y },
            width: size.width,
            height: size.height,
            metadata: mediaResultMetadata("derived", { ...imageMetadata(image), prompt: node.metadata?.prompt, manualSize: true, generatedFromNodeId: node.id }),
        } satisfies CanvasNodeData));
        setNodes((current) => [...current, ...childNodes]);
        setConnections((current) => [...current, ...childNodes.map((child) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: child.id }))]);
        setSelectedNodeIds(new Set(childNodes.map((child) => child.id)));
        setSelectedConnectionId(null);
        setDialogNodeId(null);
        await persistMediaNodes(childNodes);
        message.success(`已切分为 ${childNodes.length} 个子节点`);
    }, [message, persistMediaNodes, setConnections, setDialogNodeId, setNodes, setSelectedConnectionId, setSelectedNodeIds]);

    const maskEditImageNode = useCallback(async (node: CanvasNodeData, payload: CanvasImageMaskEditPayload) => {
        if (!node.metadata?.content) return;
        const baseGenerationConfig = buildGenerationConfig(effectiveConfig, node, "image");
        const selectedModel = payload.generationConfig?.model || payload.generationConfig?.imageModel || baseGenerationConfig.model;
        const modelDefaults = defaultImageParamsForModel(baseGenerationConfig, selectedModel);
        const selectedImageProfile = modelCapabilityConfigFor(baseGenerationConfig, selectedModel).image;
        if (!selectedImageProfile?.references.maskSupported) {
            message.error("当前图片模型不支持局部重绘蒙版，请选择支持蒙版编辑的模型");
            return;
        }
        const generationConfig = {
            ...baseGenerationConfig,
            ...payload.generationConfig,
            model: selectedModel,
            imageModel: payload.generationConfig?.imageModel || payload.generationConfig?.model || effectiveConfig.imageModel,
            quality: normalizeMaskEditQuality(payload.generationConfig?.quality || node.metadata?.quality || baseGenerationConfig.quality || modelDefaults.quality, payload.generationConfig?.size || node.metadata?.size || baseGenerationConfig.size || modelDefaults.size),
            count: String(payload.generationConfig?.count || 1),
            // 原图像素尺寸不是模型的输出尺寸合同；非高级设置时使用模型默认尺寸，避免把节点尺寸误发给上游。
            size: payload.generationConfig?.size || node.metadata?.size || modelDefaults.size,
        };
        if (!isAiConfigReady(generationConfig, generationConfig.model)) {
            navigateToSettings({ continueCreation: true });
            return;
        }
        const userPrompt = payload.prompt.trim();
        const prompt = `只修改蒙版透明区域，其他区域保持不变。${userPrompt}`;
        const source = nodeReferenceImage(node);
        if (!source) return;
        const styleExecution = resolveImageEditStyle(node, prompt, generationConfig);
        if (!styleExecution) return;
        const { prompt: effectivePrompt, metadata: styleMetadata } = styleExecution;
        const requestedCount = Math.max(1, Number(generationConfig.count) || 1);
        const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, requestedCount, [source]);
        setMaskEditNodeId(null);
        const rootId = nanoid();
        const childIds = requestedCount > 1 ? Array.from({ length: requestedCount }, () => nanoid()) : [];
        const targetIds = requestedCount > 1 ? childIds : [rootId];
        const imageSize = { width: node.width, height: node.height };
        const preferredPosition = { x: node.position.x + node.width + 96, y: node.position.y };
        const rootPosition = findAvailableGenerationGroupPosition(nodesRef.current, preferredPosition, imageGenerationGroupSize(imageSize, imageSize, childIds.length));
        const rootNode: CanvasNodeData = {
            id: rootId,
            type: CanvasNodeType.Image,
            title: userPrompt.slice(0, 32) || "局部编辑结果",
            position: rootPosition,
            width: node.width,
            height: node.height,
            metadata: {
                ...canvasGenerationPromptMetadata(userPrompt, effectivePrompt),
                status: NODE_STATUS_LOADING,
                isBatchRoot: requestedCount > 1,
                batchChildIds: requestedCount > 1 ? childIds : undefined,
                batchFailedCount: requestedCount > 1 ? 0 : undefined,
                imageBatchExpanded: requestedCount > 1 ? true : undefined,
                ...generationMetadata,
                ...styleMetadata,
            },
        };
        const childNodes: CanvasNodeData[] = childIds.map((id, index) => ({
            id,
            type: CanvasNodeType.Image,
            title: `${userPrompt.slice(0, 28) || "局部编辑结果"} · ${index + 1}`,
            position: imageGenerationChildPosition(rootNode.position, rootNode.width, imageSize, index),
            width: node.width,
            height: node.height,
            metadata: {
                ...canvasGenerationPromptMetadata(userPrompt, effectivePrompt),
                status: NODE_STATUS_LOADING,
                batchRootId: rootId,
                ...generationMetadata,
                ...styleMetadata,
            },
        }));
        setRunningNodeId(rootId);
        setNodes((current) => [...current, rootNode, ...childNodes]);
        setConnections((current) => [...current, { id: nanoid(), fromNodeId: node.id, toNodeId: rootId }, ...childIds.map((childId) => ({ id: nanoid(), fromNodeId: rootId, toNodeId: childId }))]);
        setSelectedNodeIds(new Set([rootId, ...childIds]));
        setSelectedConnectionId(null);
        setDialogNodeId(rootId);
        const controller = startGenerationRequest(rootId, node.id, rootId);
        targetIds.forEach((targetId) => startGenerationRequest(targetId, node.id, rootId, controller));
        let hasSuccess = false;
        let failureCount = 0;
        let representativeError: string | undefined;
        try {
            await Promise.all(targetIds.map(async (targetId) => {
                try {
                    const result = await runBackendCanvasGenerationTask({
                        projectId,
                        nodeId: targetId,
                        mode: "image",
                        prompt: effectivePrompt,
                        config: { ...generationConfig, count: "1" },
                        referenceImages: [source],
                        mask: { id: `${node.id}-mask`, name: "mask.png", type: "image/png", dataUrl: payload.maskDataUrl },
                        signal: controller.signal,
                        metadata: { sourceNodeId: node.id, edit: "mask", ...styleMetadata },
                        onTaskCreated: (task) => bindGenerationTask(targetId, task),
                    });
                    const image = result.images?.find((item) => item?.dataUrl);
                    if (!image?.dataUrl) throw new Error("后端任务没有返回图片");
                    const uploaded = await uploadImage(image.dataUrl);
                    const size = fitNodeSize(uploaded.width, uploaded.height, node.width, node.height);
                    const currentNode = nodesRef.current.find((item) => item.id === targetId);
                    if (!currentNode) throw new Error("局部编辑节点已被删除");
                    const finalizedNode = { ...currentNode, width: size.width, height: size.height, metadata: { ...currentNode.metadata, ...imageMetadata(uploaded), prompt: effectivePrompt, ...generationMetadata } };
                    setNodes((current) => current.map((item) => {
                        if (item.id === targetId) return finalizedNode;
                        if (item.id !== rootId || requestedCount <= 1 || item.metadata?.primaryImageId) return item;
                        return { ...item, width: size.width, height: size.height, metadata: { ...item.metadata, ...imageMetadata(uploaded), primaryImageId: targetId, status: NODE_STATUS_SUCCESS } };
                    }));
                    await persistMediaNodes([finalizedNode]);
                    hasSuccess = true;
                } catch (error) {
                    if (isGenerationCanceled(error)) return;
                    failureCount += 1;
                    const details = generationErrorMessage(error);
                    representativeError = details;
                    setNodes((current) => current.map((item) => (item.id === targetId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails: details } } : item)));
                } finally {
                    finishGenerationRequest(targetId, controller);
                }
            }));
            if (controller.signal.aborted) {
                setNodes((current) => {
                    const cancelled = cancelIncompleteImageBatch(rootId, childIds, current, []);
                    if (cancelled.removedIds.length) {
                        const removed = new Set(cancelled.removedIds);
                        setConnections((connections) => connections.filter((connection) => !removed.has(connection.fromNodeId) && !removed.has(connection.toNodeId)));
                    }
                    return cancelled.nodes.map((item) => {
                        if (item.id !== rootId) return item;
                        if (item.metadata?.content) return item;
                        return { ...item, metadata: { ...item.metadata, status: NODE_STATUS_IDLE, errorDetails: undefined } };
                    });
                });
                return;
            }
            if (failureCount > 0) {
                message.error(hasSuccess ? "部分局部编辑失败" : representativeError || "局部编辑失败");
            }
            setNodes((current) => current.map((item) => {
                if (item.id !== rootId) return item;
                return {
                    ...item,
                    metadata: {
                        ...item.metadata,
                        status: hasSuccess ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR,
                        batchFailedCount: requestedCount > 1 ? failureCount : undefined,
                        ...(hasSuccess
                            ? { errorDetails: undefined }
                            : { errorDetails: representativeError || "局部编辑失败" }),
                    },
                };
            }));
        } finally {
            if (requestedCount > 1) finishGenerationRequest(rootId, controller);
            setRunningNodeId(null);
        }
    }, [bindGenerationTask, effectiveConfig, finishGenerationRequest, isAiConfigReady, message, nodesRef, persistMediaNodes, projectId, resolveImageEditStyle, setConnections, setDialogNodeId, setNodes, setRunningNodeId, setSelectedConnectionId, setSelectedNodeIds, startGenerationRequest]);

    const upscaleImageNode = useCallback(async (node: CanvasNodeData, params: CanvasImageUpscaleParams) => {
        if (!node.metadata?.content) return;
        setUpscaleNodeId(null);
        const source = await resolveImageUrl(node.metadata.storageKey, node.metadata.content, { cacheMiss: true });
        const upscaled = await upscaleDataUrl(source, params);
        const image = await uploadImage(upscaled);
        const size = fitNodeSize(image.width, image.height);
        const childId = nanoid();
        const child: CanvasNodeData = { id: childId, type: CanvasNodeType.Image, title: `${node.title || "图片"} · 放大`, position: { x: node.position.x + node.width + 96, y: node.position.y }, width: size.width, height: size.height, metadata: mediaResultMetadata("derived", { ...imageMetadata(image), prompt: node.metadata?.prompt, generatedFromNodeId: node.id,
            workflowOperation: { id: "image.resize", version: 1, config: { longEdge: params.targetLongEdge, algorithm: params.algorithm }, inputs: [{ nodeId: node.id, port: "image" }] },
        }) };
        setNodes((current) => [...current, child]);
        setConnections((current) => [...current, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
        setSelectedNodeIds(new Set([childId]));
        setDialogNodeId(childId);
        await persistMediaNodes([child]);
    }, [persistMediaNodes, setConnections, setDialogNodeId, setNodes, setSelectedNodeIds]);

    const generateAngleNode = useCallback(async (node: CanvasNodeData, params: CanvasImageAngleParams) => {
        if (!node.metadata?.content) return;
        const generationConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), count: "1" };
        if (!isAiConfigReady(generationConfig, generationConfig.model)) {
            navigateToSettings({ continueCreation: true });
            return;
        }
        const childId = nanoid();
        const imageSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
        const title = buildAngleLabel(params);
        const prompt = buildAnglePrompt(params);
        const source = nodeReferenceImage(node);
        if (!source) return;
        const styleExecution = resolveImageEditStyle(node, prompt, generationConfig);
        if (!styleExecution) return;
        const { prompt: effectivePrompt, metadata: styleMetadata } = styleExecution;
        const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, [source]);
        setAngleNodeId(null);
        setRunningNodeId(childId);
        setNodes((current) => [...current, { id: childId, type: CanvasNodeType.Image, title, position: { x: node.position.x + node.width + 96, y: node.position.y }, width: imageSpec.width, height: imageSpec.height, metadata: { prompt: effectivePrompt, status: NODE_STATUS_LOADING, ...generationMetadata, ...styleMetadata } }]);
        setConnections((current) => [...current, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
        setSelectedNodeIds(new Set([childId]));
        setDialogNodeId(childId);
        const controller = startGenerationRequest(childId, node.id, childId);
        try {
            const result = await runBackendCanvasGenerationTask({ projectId, nodeId: childId, mode: "image", prompt: effectivePrompt, config: generationConfig, referenceImages: [source], signal: controller.signal, metadata: { sourceNodeId: node.id, edit: "angle", ...styleMetadata }, onTaskCreated: (task) => bindGenerationTask(childId, task) });
            const image = result.images?.[0];
            if (!image?.dataUrl) throw new Error("后端任务没有返回图片");
            const uploaded = await uploadImage(image.dataUrl);
            const size = fitNodeSize(uploaded.width, uploaded.height, imageSpec.width, imageSpec.height);
            const currentNode = nodesRef.current.find((item) => item.id === childId);
            if (!currentNode) throw new Error("视角生成节点已被删除");
            const finalizedNode = { ...currentNode, width: size.width, height: size.height, metadata: { ...currentNode.metadata, ...imageMetadata(uploaded), prompt: effectivePrompt, ...generationMetadata } };
            setNodes((current) => current.map((item) => item.id === childId ? finalizedNode : item));
            await persistMediaNodes([finalizedNode]);
        } catch (error) {
            if (isGenerationCanceled(error)) return;
            const details = generationErrorMessage(error);
            setNodes((current) => current.map((item) => item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails: details } } : item));
        } finally {
            finishGenerationRequest(childId, controller);
            setRunningNodeId(null);
        }
    }, [bindGenerationTask, effectiveConfig, finishGenerationRequest, isAiConfigReady, nodesRef, persistMediaNodes, projectId, resolveImageEditStyle, setConnections, setDialogNodeId, setNodes, setRunningNodeId, setSelectedNodeIds, startGenerationRequest]);

    const generateLightingNode = useCallback((node: CanvasNodeData, options: CanvasImageLightingOptions, prompt: string) => {
        if (!node.metadata?.content) return;
        const generationConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), count: "1" };
        const childId = nanoid();
        const imageSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
        const title = buildLightingLabel(options);
        const source = nodeReferenceImage(node);
        if (!source) return;
        const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, [source]);
        setLightingNodeId(null);
        setNodes((current) => [...current, {
            id: childId,
            type: CanvasNodeType.Image,
            title,
            position: { x: node.position.x + node.width + 96, y: node.position.y },
            width: imageSpec.width,
            height: imageSpec.height,
            metadata: {
                prompt,
                status: NODE_STATUS_IDLE,
                generationMode: "image",
                ...generationMetadata,
            },
        }]);
        setConnections((current) => [...current, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
        setSelectedNodeIds(new Set([childId]));
        setSelectedConnectionId(null);
        setDialogNodeId(childId);
    }, [effectiveConfig, setConnections, setDialogNodeId, setLightingNodeId, setNodes, setSelectedConnectionId, setSelectedNodeIds]);

    const generateEmotionNode = useCallback(async (node: CanvasNodeData, payload: CanvasImageEmotionPayload) => {
        if (!node.metadata?.content) return;
        const baseConfig = buildGenerationConfig(effectiveConfig, node, "image");
        const providerSize = emotionGenerationSize(payload.editRegion);
        const generationConfig = { ...baseConfig, count: "1", size: providerSize, quality: !baseConfig.quality || baseConfig.quality === "auto" ? "high" : baseConfig.quality };
        if (!isAiConfigReady(generationConfig, generationConfig.model)) { navigateToSettings({ continueCreation: true }); return; }
        if (resolveModelRequestConfig(generationConfig, generationConfig.model).interfaceType !== "openai-image") {
            message.error("表情编辑需要支持多参考图编辑的 OpenAI Images 渠道");
            return;
        }
        const imageProfile = modelCapabilityConfigFor(generationConfig, generationConfig.model).image!;
        const editPlan = resolveEmotionEditPlan(imageProfile.references.maskSupported);
        const source = nodeReferenceImage(node);
        if (!source) return;
        const editReference = {
            id: `${node.id}-${payload.presetId}-edit-region`,
            name: "emotion-edit-region.png",
            type: "image/png",
            dataUrl: payload.sourceDataUrl,
        };
        const characterReference = {
            id: `${node.id}-${payload.presetId}-character`,
            name: `${payload.characterName}-face.jpg`,
            type: "image/jpeg",
            dataUrl: payload.characterDataUrl,
        };
        const childId = nanoid();
        const styleExecution = resolveImageEditStyle(node, payload.prompt, generationConfig);
        if (!styleExecution) return;
        const { prompt: effectivePrompt, metadata: styleMetadata } = styleExecution;
        const providerPrompt = normalizeEmotionPromptForProvider(effectivePrompt);
        const generationMetadata = { ...buildImageGenerationMetadata("edit", generationConfig, 1, [source]), size: `${payload.imageWidth}x${payload.imageHeight}` };
        const emotionEdit = { sourceNodeId: node.id, characterName: payload.characterName, presetId: payload.presetId, intimacy: payload.intimacy, arousal: payload.arousal, label: payload.label, faceBox: payload.faceBox, editRegion: payload.editRegion, sourceWidth: payload.imageWidth, sourceHeight: payload.imageHeight, providerSize, editMode: editPlan.mode };
        if (editPlan.notice) message.info(editPlan.notice);
        setEmotionNodeId(null);
        setRunningNodeId(childId);
        setNodes((current) => [...current, { id: childId, type: CanvasNodeType.Image, title: `${payload.characterName} · ${payload.label}`, position: { x: node.position.x + node.width + 96, y: node.position.y }, width: node.width, height: node.height, metadata: { prompt: providerPrompt, status: NODE_STATUS_LOADING, ...generationMetadata, ...styleMetadata, emotionEdit } }]);
        setConnections((current) => [...current, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
        setSelectedNodeIds(new Set([childId]));
        setSelectedConnectionId(null);
        setDialogNodeId(childId);
        const controller = startGenerationRequest(childId, node.id, childId);
        try {
            const mask = emotionProviderMask(editPlan, { id: `${node.id}-emotion-mask`, name: "emotion-mask.png", type: "image/png", dataUrl: payload.maskDataUrl });
            const result = await runBackendCanvasGenerationTask({ projectId, nodeId: childId, mode: "image", prompt: providerPrompt, config: generationConfig, referenceImages: [editReference, characterReference], mask, signal: controller.signal, metadata: { sourceNodeId: node.id, edit: "emotion", emotionEditMode: editPlan.mode, emotion: emotionEdit, ...styleMetadata }, onTaskCreated: (task) => bindGenerationTask(childId, task) });
            const image = result.images?.[0];
            if (!image?.dataUrl) throw new Error("后端任务没有返回图片");
            const sourceDataUrl = await resolveImageUrl(node.metadata.storageKey, node.metadata.content, { cacheMiss: true });
            const composited = await compositeEmotionImage(sourceDataUrl, image.dataUrl, payload.editRegion, payload.faceBox);
            const uploaded = await uploadImage(composited);
            const size = fitNodeSize(uploaded.width, uploaded.height, node.width, node.height);
            const currentNode = nodesRef.current.find((item) => item.id === childId);
            if (!currentNode) throw new Error("表情编辑节点已被删除");
            const finalizedNode = { ...currentNode, width: size.width, height: size.height, metadata: { ...currentNode.metadata, ...imageMetadata(uploaded), prompt: providerPrompt, ...generationMetadata, emotionEdit } };
            setNodes((current) => current.map((item) => item.id === childId ? finalizedNode : item));
            await persistMediaNodes([finalizedNode]);
        } catch (error) {
            if (isGenerationCanceled(error)) return;
            const details = generationErrorMessage(error);
            message.error(details);
            setNodes((current) => current.map((item) => item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails: details } } : item));
        } finally { finishGenerationRequest(childId, controller); setRunningNodeId(null); }
    }, [bindGenerationTask, effectiveConfig, finishGenerationRequest, isAiConfigReady, message, nodesRef, persistMediaNodes, projectId, resolveImageEditStyle, setConnections, setDialogNodeId, setNodes, setRunningNodeId, setSelectedConnectionId, setSelectedNodeIds, startGenerationRequest]);

    return {
        prepareUpscaleResource,
        recoverAIUpscale,
        observeAIUpscale,
        angleNodeId,
        lightingNodeId,
        emotionNodeId,
        annotationNodeId,
        createImageReversePromptNodes,
        openPortraitTextureEditor,
        cropImageNode,
        cropNodeId,
        videoCropNodeId,
        cropVideoNode,
        depthCaptureNode,
        retryDepthCaptureNode,
        recoverDepthCaptureNodes,
        closeFrameDialog,
        extractAudioFromVideo,
        extractVideoFrameAt,
        extractVideoFrames,
        extractingVideoFramesNodeId,
        frameDialogNodeId,
        generateAngleNode,
        generateLightingNode,
        openPanoramaConfig,
        createPanoramaViewerWithConfig,
        addPanoramaCaptureNode,
        addDoubaoResultNode,
        panoramaConfigNodeId,
        setPanoramaConfigNodeId,
        maskEditImageNode,
        maskEditNodeId,
        mergeSelectedVideos,
        mergeVideosByIds,
        mergeVideoProgress,
        saveAnnotatedImageNode,
        segmentRunningMode,
        inlineTrimNodeId,
        inlineTrimRunning,
        setInlineTrimNodeId,
        openInlineVideoTrim,
        openVideoCrop,
        closeInlineVideoTrim,
        confirmInlineVideoTrim,
        setFrameDialogNodeId,
        setAngleNodeId,
        setLightingNodeId,
        generateEmotionNode,
        setEmotionNodeId,
        setAnnotationNodeId,
        setCropNodeId,
        setVideoCropNodeId,
        setMaskEditNodeId,
        setUpscaleNodeId,
        splitImageNode,
        upscaleImageNode,
        upscaleNodeId,
    };
}
