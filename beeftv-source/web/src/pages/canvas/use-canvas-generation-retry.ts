import { createClientId } from "@/lib/client-id";
import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import { App } from "antd";

import { compileNodeGenerationReferences, buildNodeGenerationContext, hydrateNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import type { CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import { buildEmotionImageArtifacts, emotionGenerationSize, emotionProviderMask, normalizeEmotionPromptForProvider, resolveEmotionEditPlan } from "@/lib/canvas/canvas-emotion";
import { captureUserScope, userScopeMatches } from "@/lib/user-scope-guard";
import {
    buildAudioGenerationMetadata,
    buildGenerationConfig,
    buildImageGenerationMetadata,
    buildVideoGenerationMetadata,
    createGenerationRetryContext,
    findRetrySourceNode,
    generationReferenceUrls,
    isGenerationCanceled,
    canvasImageReferenceLimitError,
    resolveMetadataReferences,
    resolveStoredReferenceImages,
    runBackendCanvasGenerationTask,
    runCanvasGenerationTaskToConsumer,
    sourceNodeReferenceImages,
    supportsVideoReferenceAudio,
} from "@/lib/canvas/canvas-project-generation";
import { isCanvasWorkflowProvider } from "@/lib/canvas/canvas-workflow";
import { isDepthCaptureResultNode } from "@/lib/canvas/canvas-depth-capture";
import { buildPortraitTexturePrompt } from "@/lib/canvas/canvas-portrait-texture";
import { resolveCanvasStyleExecution } from "@/lib/canvas/canvas-style-execution";
import { generationFailureMetadata, shouldBlockManualRetry } from "@/lib/generation-error";
import { modelCapabilityConfigFor } from "@/lib/model-capabilities";
import { navigateToSettings } from "@/lib/settings-navigation";
import type { Skill } from "@/services/api/skills";
import { skillRuntime, type SkillRuntimeMetadata } from "@/services/skill-runtime";
import type { GenerationTask } from "@/services/api/task-center";
import { retryStoredCanvasVideo } from "@/services/canvas-video-retry";
import { resolveImageUrl } from "@/services/image-storage";
import { resolveModelRequestConfig, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import type { Asset } from "@/stores/use-asset-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeTypeId } from "@/types/canvas";
import { canvasGenerationFailureMetadata, canvasGenerationRetryBlocked, type CanvasGenerationFailureInput } from "./canvas-generation-failure";

type UseCanvasGenerationRetryOptions = {
    projectId: string;
    domainProjectId?: string;
    addedSkills: Skill[];
    assets: Asset[];
    nodesRef: { current: CanvasNodeData[] };
    connectionsRef: { current: CanvasConnection[] };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setRunningNodeId: Dispatch<SetStateAction<string | null>>;
    startGenerationRequest: (targetNodeId: string, originNodeId: string, runningId?: string, controller?: AbortController) => AbortController;
    finishGenerationRequest: (targetNodeId: string, controller: AbortController) => void;
    bindGenerationTask: (targetNodeId: string, task: GenerationTask) => void;
    applyGenerationTaskResult: (targetNodeId: string, task: GenerationTask) => Promise<void>;
    regenerateImageBatch: (nodeId: string, prompt: string) => Promise<void>;
};

const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;
const NODE_STATUS_ERROR = "error" as const;

export function useCanvasGenerationRetry({
    projectId,
    domainProjectId,
    addedSkills,
    assets,
    nodesRef,
    connectionsRef,
    setNodes,
    setRunningNodeId,
    startGenerationRequest,
    finishGenerationRequest,
    bindGenerationTask,
    applyGenerationTaskResult,
    regenerateImageBatch,
}: UseCanvasGenerationRetryOptions) {
    const { message } = App.useApp();
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const projectIdRef = useRef(projectId);
    projectIdRef.current = projectId;
    const retryingVideos = useRef(new Set<string>());

    return useCallback(
        async (node: CanvasNodeData) => {
            if (isDepthCaptureResultNode(node)) {
                message.warning("深度动作捕捉节点必须使用本地深度任务重试");
                return;
            }
            const retryMode = retryModeForNode(node.type);
            if (!retryMode) {
                message.warning("当前节点不能使用通用生成重试");
                return;
            }
            if (retryMode === "video" && node.metadata?.taskId && node.metadata.status === "error") {
                const taskId = node.metadata.taskId;
                if (retryingVideos.current.has(taskId)) return;
                retryingVideos.current.add(taskId);
                const requestProjectId = projectId;
                const scope = captureUserScope();
                const controller = startGenerationRequest(node.id, node.id);
                setRunningNodeId(node.id);
                try {
                    const task = await retryStoredCanvasVideo(taskId, controller.signal, (update) => {
                        if (projectIdRef.current === requestProjectId && userScopeMatches(scope)) bindGenerationTask(node.id, update);
                    });
                    if (projectIdRef.current === requestProjectId && userScopeMatches(scope) && !controller.signal.aborted) await applyGenerationTaskResult(node.id, task);
                } catch (error) {
                    if (!isGenerationCanceled(error) && projectIdRef.current === requestProjectId && userScopeMatches(scope)) {
                        message.error(error instanceof Error ? error.message : "原视频任务重试失败");
                    }
                } finally {
                    retryingVideos.current.delete(taskId);
                    finishGenerationRequest(node.id, controller);
                    if (projectIdRef.current === requestProjectId && userScopeMatches(scope)) setRunningNodeId(null);
                }
                return;
            }
            const batchRoot = node.metadata?.batchRootId ? nodesRef.current.find((item) => item.id === node.metadata?.batchRootId) : null;
            const originalSourceId = node.metadata?.generatedFromNodeId || batchRoot?.metadata?.generatedFromNodeId;
            const originalSource = nodesRef.current.find((item) => item.id === originalSourceId);
            const sourceNode = originalSource || findRetrySourceNode(node.id, nodesRef.current, connectionsRef.current) || batchRoot || node;
            const savedImageMetadata = node.type === CanvasNodeType.Image ? { ...batchRoot?.metadata, ...node.metadata } : undefined;
            const hasSavedImageMetadata = Boolean(savedImageMetadata?.generationType);
            const useStoredSource = hasSavedImageMetadata && !connectionsRef.current.some((connection) => connection.toNodeId === sourceNode.id) && (!originalSourceId || !originalSource);
            const generationSourceNode = node.type === CanvasNodeType.Config && isCanvasWorkflowProvider(node.metadata) || node.metadata?.workflowProvider === "model" ? node : sourceNode;
            const sourceGenerationConfig = buildGenerationConfig(effectiveConfig, generationSourceNode, retryMode);
            let generationConfig =
                hasSavedImageMetadata && savedImageMetadata
                    ? {
                          ...sourceGenerationConfig,
                          model: savedImageMetadata.model || effectiveConfig.imageModel || effectiveConfig.model || sourceGenerationConfig.model,
                          quality: savedImageMetadata.quality || effectiveConfig.quality || sourceGenerationConfig.quality,
                          size: savedImageMetadata.size || effectiveConfig.size || sourceGenerationConfig.size,
                          transparentBackground: (savedImageMetadata.transparentBackground || effectiveConfig.transparentBackground || sourceGenerationConfig.transparentBackground) === "true" ? "true" : "false",
                          count: "1",
                      }
                    : { ...sourceGenerationConfig, count: "1" };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                navigateToSettings({ continueCreation: true });
                return;
            }

            const retryPromptSource = sourceNode.metadata?.composerContent || sourceNode.metadata?.prompt || node.metadata?.prompt || "";
            const nativeOutputs = retryMode === "image" ? modelCapabilityConfigFor(generationConfig, generationConfig.model).image?.fixedOutputs || 0 : 0;
            const groupRoot = batchRoot || node;
            const multipleNativeBatches = nativeOutputs > 0 && (groupRoot.metadata?.batchChildIds?.length || 0) > nativeOutputs;
            if (nativeOutputs && !multipleNativeBatches) {
                await regenerateImageBatch(groupRoot.id, retryPromptSource);
                return;
            }
            if (multipleNativeBatches && !batchRoot) {
                message.warning("请使用重试失败批次，或选择失败图片重试；已完成的批次将保留");
                return;
            }
            const nativeRetryTargets = multipleNativeBatches ? nodesRef.current.filter((item) => item.metadata?.batchRootId === batchRoot?.id && Boolean(node.metadata?.taskId) && item.metadata?.taskId === node.metadata?.taskId) : [];
            if (multipleNativeBatches && (nativeRetryTargets.length !== nativeOutputs || nativeRetryTargets.some((item) => item.metadata?.content || item.metadata?.storageKey))) {
                message.warning("该批次已有结果或任务状态不完整，请先取回原任务，避免重复生成");
                return;
            }
            const retryContextPrompt = retryMode === "image" && sourceNode.metadata?.portraitTexture ? buildPortraitTexturePrompt(retryPromptSource, sourceNode.metadata.portraitTexture) : retryPromptSource;
            let rawContext: Awaited<ReturnType<typeof hydrateNodeGenerationContext>> | null;
            try {
                const promptOnly = retryMode === "video";
                if (useStoredSource) rawContext = null;
                else {
                    const baseContext = buildNodeGenerationContext(sourceNode.id, nodesRef.current, connectionsRef.current, retryContextPrompt, assets, promptOnly, { preserveMediaBindings: retryMode === "video" });
                    rawContext = await hydrateNodeGenerationContext(baseContext, projectId, domainProjectId, retryMode, retryMode === "video" && supportsVideoReferenceAudio(generationConfig), !promptOnly);
                }
            } catch (error) {
                const failure = generationFailureMetadata(error, retryPromptSource, sourceNodeReferenceImages(generationSourceNode));
                message.error(failure.errorDetails);
                setNodes((current) => current.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, ...failure } } : item)));
                return;
            }
            let skillMetadata: SkillRuntimeMetadata = {
                skillIds: node.metadata?.skillIds || [],
                skillVersions: node.metadata?.skillVersions || [],
                skillFiles: node.metadata?.skillFiles || [],
            };
            let context = rawContext;
            if (rawContext) {
                try {
                    const skillExecution = await skillRuntime.prepare({ profile: "canvas", prompt: rawContext.prompt, skills: addedSkills });
                    context = { ...rawContext, prompt: skillExecution.prompt };
                    if (retryMode === "video") context = compileNodeGenerationReferences(context, generationConfig, buildVideoGenerationMetadata(node, context, generationConfig).videoEditOperation);
                    skillMetadata = skillExecution.metadata;
                } catch (error) {
                    message.error(error instanceof Error ? error.message : "技能上下文加载失败");
                    return;
                }
            }
            const prompt = (context?.prompt || savedImageMetadata?.prompt || "").trim();
            if (!prompt) {
                message.warning("找不到提示词，无法重试");
                return;
            }
            let mediaPrompt = prompt;
            let styleMetadata = {};
            if (node.type === CanvasNodeType.Image) {
                try {
                    const runtime = resolveCanvasStyleExecution(nodesRef.current, sourceNode, prompt, generationConfig, "image");
                    if (runtime) {
                        mediaPrompt = runtime.prompt;
                        styleMetadata = { styleProfileJson: runtime.profileJson, styleExecutionPlan: runtime.plan };
                    }
                } catch (error) {
                    message.error(error instanceof Error ? error.message : "项目画风与当前模型不兼容");
                    return;
                }
            }
            if (retryMode === "audio" && context?.characterReferences.length) {
                if (context.characterReferences.length !== 1) {
                    message.error("角色配音一次只能引用一个角色卡");
                    return;
                }
                const voice = context.resolvedCharacterVoices[0];
                if (!voice) {
                    message.error("角色尚未绑定可用声音，无法重试角色配音任务");
                    return;
                }
                generationConfig = { ...generationConfig, audioVoice: voice.voiceKey, audioInstructions: [voice.instructions, generationConfig.audioInstructions].filter(Boolean).join("；") };
            }
            const isEmotionRetry = Boolean(node.metadata?.emotionEdit);
            if (isEmotionRetry && resolveModelRequestConfig(generationConfig, generationConfig.model).interfaceType !== "openai-image") {
                message.error("表情编辑需要支持蒙版的 OpenAI Images 渠道，当前渠道已拒绝整图重绘");
                return;
            }
            const useReferenceImages = !isEmotionRetry && (Boolean(context?.referenceImages.length) || (useStoredSource && savedImageMetadata?.generationType === "edit"));
            const retryReferenceImages = isEmotionRetry
                ? []
                : useStoredSource && savedImageMetadata
                    ? await resolveMetadataReferences(savedImageMetadata)
                    : context?.referenceImages || [];
            if (useReferenceImages && !retryReferenceImages) {
                markMissingReferences(node.id, setNodes);
                message.error("参考图片已丢失，无法继续重试");
                return;
            }
            const retryImages = retryReferenceImages || [];
            if (retryMode === "image") {
                const referenceLimitError = canvasImageReferenceLimitError(generationConfig, retryImages);
                if (referenceLimitError) {
                    message.error(referenceLimitError);
                    return;
                }
            }
            const storedVideoImages = node.type === CanvasNodeType.Video && !context?.referenceImages.length ? await resolveStoredReferenceImages(node.metadata?.references) : [];
            if (storedVideoImages === null) {
                markMissingReferences(node.id, setNodes);
                message.error("参考图片已丢失，无法继续重试");
                return;
            }
            const videoReferenceImages = context?.referenceImages.length ? context.referenceImages : storedVideoImages;
            const videoContext =
                node.type === CanvasNodeType.Video
                    ? {
                          prompt,
                          referenceImages: videoReferenceImages,
                          referenceVideos: context?.referenceVideos || [],
                          referenceAudios: context?.referenceAudios || [],
                          textCount: context?.textCount || 0,
                          imageCount: videoReferenceImages.length,
                          videoCount: context?.referenceVideos.length || 0,
                          audioCount: context?.referenceAudios.length || 0,
                      }
                    : undefined;

            setRunningNodeId(node.id);
            const controller = startGenerationRequest(node.id, sourceNode.id, node.id);
            const expectedScope = captureUserScope();
            const capturedProjectId = projectId;
            const isCurrent = () => projectIdRef.current === capturedProjectId && !controller.signal.aborted && userScopeMatches(expectedScope);
            let submittedInput: CanvasGenerationFailureInput = { ...context, prompt: mediaPrompt };
            const runAndConsumeRetry = async (input: Parameters<typeof runBackendCanvasGenerationTask>[0]) => {
                submittedInput = input;
                if (canvasGenerationRetryBlocked(node.metadata, input)) {
                    message.warning(node.metadata?.errorDetails || "请先查看失败原因并调整输入，再重新生成");
                    return;
                }
                const originalError = { code: node.metadata?.generationErrorCode || node.metadata?.taskErrorCode, message: node.metadata?.errorDetails };
                // Edited input after a non-retryable failure is a new submission, not replay of the old retry operation.
                const retryContext = node.metadata?.taskId && !shouldBlockManualRetry(originalError, node.metadata?.taskStage)
                    ? await createGenerationRetryContext(node.metadata.taskId, node.metadata.attemptGroupId)
                    : { clientOperationId: createClientId() };
                setNodes((current) => current.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined, generationErrorCode: undefined, resourceReloadAvailable: undefined, failedPromptFingerprint: undefined, failedInputFingerprint: undefined } } : item)));
                const targetIds = nativeRetryTargets.length ? nativeRetryTargets.map((item) => item.id) : [node.id];
                await runCanvasGenerationTaskToConsumer(
                    { ...input, ...(nativeRetryTargets.length ? { config: { ...input.config, count: String(nativeOutputs) }, metadata: { ...input.metadata, outputNodeIds: targetIds } } : {}), ...retryContext, expectedScope },
                    {
                        bindTask: (task) => targetIds.forEach((id) => bindGenerationTask(id, task)),
                        consumeTask: async (task) => { for (const id of targetIds) await applyGenerationTaskResult(id, task); },
                        isCurrent,
                    },
                );
            };

            try {
                if (node.type === CanvasNodeType.Text) {
                    if (!context) return;
                    await runAndConsumeRetry({
                        projectId,
                        nodeId: node.id,
                        mode: "text",
                        prompt,
                        config: generationConfig,
                        referenceImages: context.referenceImages,
                        referenceVideos: context.referenceVideos,
                        signal: controller.signal,
                        metadata: { retry: true, sourceNodeId: sourceNode.id, resolvedCharacterVersions: context.resolvedCharacterVersions },
                    });
                    return;
                }
                if (node.type === CanvasNodeType.Video) {
                    const videoGenerationMetadata = buildVideoGenerationMetadata(node, videoContext, generationConfig);
                    setNodes((current) =>
                        current.map((item) =>
                            item.id === node.id
                                ? {
                                      ...item,
                                      metadata: {
                                          ...item.metadata,
                                          prompt: mediaPrompt,
                                          model: generationConfig.model,
                                          size: generationConfig.size,
                                          seconds: generationConfig.videoSeconds,
                                          vquality: generationConfig.vquality,
                                          generateAudio: generationConfig.videoGenerateAudio,
                                          watermark: generationConfig.videoWatermark,
                                          ...videoGenerationMetadata,
                                          ...styleMetadata,
                                          ...skillMetadata,
                                          references: videoContext ? generationReferenceUrls(videoContext) : item.metadata?.references,
                                      },
                                  }
                                : item,
                        ),
                    );
                    await runAndConsumeRetry({
                        projectId,
                        nodeId: node.id,
                        mode: "video",
                        prompt: mediaPrompt,
                        config: generationConfig,
                        referenceImages: videoContext?.referenceImages || [],
                        referenceVideos: videoContext?.referenceVideos || [],
                        referenceAudios: videoContext?.referenceAudios || [],
                        signal: controller.signal,
                        metadata: {
                            retry: true,
                            sourceNodeId: sourceNode.id,
                            resolvedCharacterVersions: context?.resolvedCharacterVersions || [],
                            resolvedCharacterVoices: context?.resolvedCharacterVoices || [],
                            promptTemplateOperation: node.metadata?.promptTemplateOperation,
                            promptTemplateVariables: node.metadata?.promptTemplateVariables,
                            ...videoGenerationMetadata,
                            ...styleMetadata,
                            ...skillMetadata,
                        },
                    });
                    return;
                }
                if (node.type === CanvasNodeType.Audio) {
                    setNodes((current) => current.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, prompt, ...buildAudioGenerationMetadata(generationConfig) } } : item)));
                    await runAndConsumeRetry({
                        projectId,
                        nodeId: node.id,
                        mode: "audio",
                        prompt,
                        config: generationConfig,
                        signal: controller.signal,
                        metadata: { retry: true, sourceNodeId: sourceNode.id, resolvedCharacterVersions: context?.resolvedCharacterVersions || [], resolvedCharacterVoiceKey: context?.resolvedCharacterVoices[0]?.voiceKey },
                    });
                    return;
                }

                const emotionEdit = node.metadata?.emotionEdit;
                if (emotionEdit) {
                    const emotionSource = nodesRef.current.find((item) => item.id === emotionEdit.sourceNodeId);
                    if (!emotionSource?.metadata?.content) throw new Error("情绪编辑源图片已删除，无法重试");
                    const sourceDataUrl = await resolveImageUrl(emotionSource.metadata.storageKey, emotionSource.metadata.content, { cacheMiss: true });
                    if (!sourceDataUrl) throw new Error("无法读取情绪编辑源图片");
                    const artifacts = await buildEmotionImageArtifacts(sourceDataUrl, emotionEdit.faceBox, emotionSource.metadata.naturalWidth || 0, emotionSource.metadata.naturalHeight || 0);
                    const emotionConfig = { ...generationConfig, size: emotionGenerationSize(artifacts.editRegion), quality: !generationConfig.quality || generationConfig.quality === "auto" ? "high" : generationConfig.quality };
                    const imageProfile = modelCapabilityConfigFor(emotionConfig, emotionConfig.model).image!;
                    const editPlan = resolveEmotionEditPlan(imageProfile.references.maskSupported);
                    const sourceReference = sourceNodeReferenceImages(emotionSource)[0];
                    if (!sourceReference) throw new Error("情绪编辑源图片不可用");
                    const editReference = { id: `${emotionSource.id}-${emotionEdit.presetId}-edit-region`, name: "emotion-edit-region.png", type: "image/png", dataUrl: artifacts.sourceDataUrl };
                    const characterReference = { id: `${emotionSource.id}-${emotionEdit.presetId}-character`, name: `${emotionEdit.characterName}-face.jpg`, type: "image/jpeg", dataUrl: artifacts.characterDataUrl };
                    const nextEmotionEdit = { ...emotionEdit, editRegion: artifacts.editRegion, sourceWidth: artifacts.imageWidth, sourceHeight: artifacts.imageHeight, providerSize: emotionConfig.size, editMode: editPlan.mode };
                    const providerPrompt = normalizeEmotionPromptForProvider(mediaPrompt);
                    const mask = emotionProviderMask(editPlan, { id: `${emotionSource.id}-emotion-mask`, name: "emotion-mask.png", type: "image/png", dataUrl: artifacts.maskDataUrl });
                    if (editPlan.notice) message.info(editPlan.notice);
                    const generationMetadata = { ...buildImageGenerationMetadata("edit", emotionConfig, 1, [sourceReference]), size: `${artifacts.imageWidth}x${artifacts.imageHeight}` };
                    setNodes((current) =>
                        current.map((item) =>
                            item.id === node.id
                                ? {
                                      ...item,
                                      metadata: { ...item.metadata, prompt: providerPrompt, ...generationMetadata, ...styleMetadata, ...skillMetadata, emotionEdit: nextEmotionEdit },
                                  }
                                : item,
                        ),
                    );
                    await runAndConsumeRetry({
                        projectId,
                        nodeId: node.id,
                        mode: "image",
                        prompt: providerPrompt,
                        config: emotionConfig,
                        referenceImages: [editReference, characterReference],
                        mask,
                        signal: controller.signal,
                        metadata: { retry: true, sourceNodeId: emotionSource.id, edit: "emotion", emotionEditMode: editPlan.mode, emotion: nextEmotionEdit, resolvedCharacterVersions: context?.resolvedCharacterVersions || [], ...styleMetadata, ...skillMetadata },
                    });
                    return;
                }

                const generationMetadata = buildImageGenerationMetadata(useReferenceImages ? "edit" : "generation", generationConfig, 1, retryImages);
                setNodes((current) =>
                    current.map((item) =>
                        item.id === node.id
                            ? {
                                  ...item,
                                  metadata: { ...item.metadata, prompt: mediaPrompt, ...generationMetadata, ...styleMetadata, ...skillMetadata },
                              }
                            : item,
                    ),
                );
                await runAndConsumeRetry({
                    projectId,
                    nodeId: node.id,
                    mode: "image",
                    prompt: mediaPrompt,
                    config: generationConfig,
                    referenceImages: useReferenceImages ? retryImages : [],
                    signal: controller.signal,
                    metadata: {
                        retry: true,
                        sourceNodeId: sourceNode.id,
                        resolvedCharacterVersions: context?.resolvedCharacterVersions || [],
                        promptTemplateOperation: node.metadata?.promptTemplateOperation,
                        promptTemplateVariables: node.metadata?.promptTemplateVariables,
                        ...styleMetadata,
                        ...skillMetadata,
                    },
                });
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const failure = canvasGenerationFailureMetadata(error, submittedInput);
                message.error(failure.errorDetails);
                setNodes((current) => current.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, ...failure } } : item)));
            } finally {
                finishGenerationRequest(node.id, controller);
                setRunningNodeId(null);
            }
        },
        [addedSkills, applyGenerationTaskResult, assets, bindGenerationTask, connectionsRef, domainProjectId, effectiveConfig, finishGenerationRequest, isAiConfigReady, message, nodesRef, projectId, regenerateImageBatch, setNodes, setRunningNodeId, startGenerationRequest],
    );
}

// 生成类型必须由明确的节点契约决定，未知节点不能降级成图片任务。
function retryModeForNode(type: CanvasNodeTypeId): CanvasNodeGenerationMode | null {
    if (type === CanvasNodeType.Text) return "text";
    if (type === CanvasNodeType.Image) return "image";
    if (type === CanvasNodeType.Video) return "video";
    if (type === CanvasNodeType.Audio) return "audio";
    return null;
}

function markMissingReferences(nodeId: string, setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>) {
    setNodes((current) => current.map((item) => (item.id === nodeId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails: "参考图片已丢失，无法继续重试" } } : item)));
}
