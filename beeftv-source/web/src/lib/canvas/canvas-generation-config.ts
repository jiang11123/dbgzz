import { configuredModelMatchesCapability, defaultConfig, normalizeModelOptionValue, normalizeRunningHubCapability, type AiConfig, type WorkflowFieldMapping } from "@/stores/use-config-store";
import { resolveAudioSpeechSettings } from "@/lib/audio-generation";
import { normalizeVideoDuration, normalizeVideoResolution } from "@/lib/video-generation-options";
import { isH3Model, h3VideoOperation } from "@/lib/h3-video";
import { seedancePortraitModel } from "@/lib/seedance-portrait";
import { workflowFieldCurrentValue, workflowFieldHasStoredValue, workflowFieldKey, workflowFieldRandomKey, workflowFieldSubmissionValue, workflowOutputSizeValue, workflowVideoFieldsFromJson } from "@/lib/model-capabilities";
import { modelRequestOptions, resolveCompatibleModel, resolveModelGenerationDefaults, type ModelGenerationDefaults, type ModelInputSummary, type ModelRequirements } from "@/lib/model-selection";
import { resolveCanvasWorkflowProvider } from "@/lib/canvas/canvas-workflow";
import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeData } from "@/types/canvas";

// Preview counts may reserve character images; resolved counts contain the actual
// representations. Callers choose their input summary for each validation stage.
export function buildCanvasGenerationRequirements(config: AiConfig, node: CanvasNodeData | undefined, mode: CanvasGenerationMode, input: ModelInputSummary): ModelRequirements {
    const requestedConfig = {
        ...config,
        size: node?.metadata?.size ?? config.size,
        quality: node?.metadata?.quality ?? config.quality,
        count: String(node?.metadata?.count ?? (mode === "image" ? config.canvasImageCount || config.count : config.count)),
        transparentBackground: node?.metadata?.transparentBackground ?? config.transparentBackground,
        videoSeconds: node?.metadata?.seconds ?? config.videoSeconds,
        vquality: node?.metadata?.vquality ?? config.vquality,
        videoGenerateAudio: node?.metadata?.generateAudio ?? config.videoGenerateAudio,
        videoWatermark: node?.metadata?.watermark ?? config.videoWatermark,
        audioVoice: node?.metadata?.audioVoice ?? config.audioVoice,
        audioFormat: node?.metadata?.audioFormat ?? config.audioFormat,
        audioSpeed: node?.metadata?.audioSpeed ?? config.audioSpeed,
        audioPitch: node?.metadata?.audioPitch ?? config.audioPitch,
        audioVolume: node?.metadata?.audioVolume ?? config.audioVolume,
    };
    return resolvedCanvasGenerationRequirements(requestedConfig, node, mode, input);
}

export function resolvedCanvasGenerationRequirements(config: AiConfig, node: CanvasNodeData | undefined, mode: CanvasGenerationMode, input: ModelInputSummary): ModelRequirements {
    return {
        capability: mode,
        input,
        videoOperation: node?.metadata?.videoEditOperation,
        videoSeconds: mode === "video" ? config.videoSeconds : undefined,
        options: config.taskWorkflowProvider === "runninghub" ? undefined : modelRequestOptions(config, mode),
    };
}

export function buildGenerationConfig(config: AiConfig, node: CanvasNodeData | undefined, mode: CanvasGenerationMode, requirements?: ModelRequirements): AiConfig {
    // 只有独立 Config 节点读取工作流元数据；普通图片/视频/音频节点始终按基础模型生成。
    const workflowProvider = mode !== "text" && node?.type === CanvasNodeType.Config && resolveCanvasWorkflowProvider(node.metadata) === "runninghub" ? "runninghub" : "model";
    const defaultModel = mode === "image" ? config.imageModel : mode === "video" ? config.videoModel : mode === "audio" ? config.audioModel : config.textModel;
    const fallbackModel = mode === "image" ? defaultConfig.imageModel : mode === "video" ? defaultConfig.videoModel : mode === "audio" ? defaultConfig.audioModel : defaultConfig.textModel;
    const storedModel = resolveCanvasGenerationModel(config, node?.metadata?.model, mode);
    const preferredModel = storedModel || resolveCanvasGenerationModel(config, defaultModel, mode) || fallbackModel;
    // 先合并节点上的实时选择，再做兼容性匹配。否则路由只看到全局默认值，节点改过的时长、分辨率或布尔能力无法参与分流。
    const workflowParameters = node?.metadata?.workflowParameters || {};
    const runningHubWorkflowId = node?.metadata?.runningHubWorkflowId?.trim() || config.runningHub.workflowId.trim();
    const selectedRunningHubWorkflow =
        workflowProvider === "runninghub"
            ? config.runningHub.workflows.find((item) => item.workflowId.trim() === runningHubWorkflowId && (!node?.metadata?.runningHubWorkflowKind || (item.kind === "app" ? "app" : "workflow") === node.metadata.runningHubWorkflowKind))
            : undefined;
    const selectedWorkflowFields = workflowProvider === "runninghub" ? (selectedRunningHubWorkflow?.fields?.length ? selectedRunningHubWorkflow.fields : workflowVideoFieldsFromJson(selectedRunningHubWorkflow?.workflowJson)) : [];
    const workflowOutputSize = workflowProvider === "model" ? "" : workflowOutputSizeValue(selectedWorkflowFields, workflowParameters);
    const workflowParameterValue = (source: string) => {
        const value = workflowParameters[`source:${source}`];
        return value === undefined || value === null ? undefined : String(value);
    };
    const requestedConfig: AiConfig = {
        ...config,
        quality: node?.metadata?.quality ?? workflowParameterValue("quality") ?? config.quality ?? defaultConfig.quality,
        size: workflowProvider === "model" ? (node?.metadata?.size ?? config.size ?? defaultConfig.size) : workflowOutputSize || node?.metadata?.size || config.size || defaultConfig.size,
        transparentBackground: node?.metadata?.transparentBackground ?? config.transparentBackground ?? defaultConfig.transparentBackground,
        seedreamMode: node?.metadata?.seedreamMode ?? config.seedreamMode,
        seedreamMaxImages: node?.metadata?.seedreamMaxImages ?? config.seedreamMaxImages,
        seedreamOutputFormat: node?.metadata?.seedreamOutputFormat ?? config.seedreamOutputFormat,
        seedreamOptimize: node?.metadata?.seedreamOptimize ?? config.seedreamOptimize,
        seedreamWatermark: node?.metadata?.seedreamWatermark ?? config.seedreamWatermark,
        videoSeconds:
            workflowProvider === "model" && !isH3Model(preferredModel)
                ? normalizeVideoDuration(node?.metadata?.seconds ?? workflowParameterValue("videoSeconds") ?? config.videoSeconds ?? defaultConfig.videoSeconds)
                : String(node?.metadata?.seconds ?? workflowParameterValue("videoSeconds") ?? config.videoSeconds ?? defaultConfig.videoSeconds),
        vquality:
            workflowProvider === "model"
                ? normalizeVideoResolution(node?.metadata?.vquality ?? workflowParameterValue("vquality") ?? config.vquality ?? defaultConfig.vquality)
                : String(node?.metadata?.vquality ?? workflowParameterValue("vquality") ?? config.vquality ?? defaultConfig.vquality),
        videoGenerateAudio: node?.metadata?.generateAudio ?? config.videoGenerateAudio ?? defaultConfig.videoGenerateAudio,
        videoWatermark: node?.metadata?.watermark ?? config.videoWatermark ?? defaultConfig.videoWatermark,
        videoArkPrivateAssetUpload: node?.metadata?.arkPrivateAssetUpload ?? config.videoArkPrivateAssetUpload ?? defaultConfig.videoArkPrivateAssetUpload,
        ...resolveAudioSpeechSettings(preferredModel, {
            audioVoice: node?.metadata?.audioVoice ?? config.audioVoice,
            audioFormat: node?.metadata?.audioFormat ?? config.audioFormat,
            audioSpeed: node?.metadata?.audioSpeed ?? config.audioSpeed,
            audioPitch: node?.metadata?.audioPitch ?? config.audioPitch,
            audioVolume: node?.metadata?.audioVolume ?? config.audioVolume,
            audioInstructions: node?.metadata?.audioInstructions ?? config.audioInstructions,
        }),
        count: String(node?.metadata?.count ?? (mode === "image" ? config.canvasImageCount || config.count || defaultConfig.count : config.count || defaultConfig.count)),
    };
    const imageSize = mode === "image" ? requestedConfig.size : undefined;
    // 无 requirements 的调用（重试、媒体工具等）也按当前能力与尺寸路由到组内最低价兼容模型，
    // 避免旧 metadata.model 不支持当前尺寸导致生成时被 normalize 回退。
    const liveOptions = modelRequestOptions(requestedConfig, mode);
    const baseRequirements = requirements?.capability ? { ...requirements, options: { ...liveOptions, ...(requirements.options || {}) } } : { capability: mode, options: liveOptions };
    if (mode === "video" && isH3Model(preferredModel) && requirements?.input) baseRequirements.videoOperation = h3VideoOperation(preferredModel, requirements.input, node?.metadata?.videoEditOperation);
    const model = workflowProvider === "model" ? resolveCompatibleModel(config, preferredModel, imageSize ? { ...baseRequirements, imageSize } : baseRequirements) || preferredModel : preferredModel;
    const generationDefaults: Partial<ModelGenerationDefaults> =
        workflowProvider === "model"
            ? resolveModelGenerationDefaults(
                  config,
                  model,
                  mode === "image" ? "image" : mode === "video" ? "video" : undefined,
                  mode === "image"
                      ? {
                            size: node?.metadata?.size,
                            quality: node?.metadata?.quality,
                            transparentBackground: node?.metadata?.transparentBackground,
                            count: requestedConfig.count,
                        }
                      : {
                            size: node?.metadata?.size,
                            videoSeconds: node?.metadata?.seconds,
                            vquality: node?.metadata?.vquality,
                            videoGenerateAudio: node?.metadata?.generateAudio,
                            videoWatermark: node?.metadata?.watermark,
                        },
                  {
                      size: requestedConfig.size,
                      quality: requestedConfig.quality,
                      transparentBackground: requestedConfig.transparentBackground,
                      count: requestedConfig.count,
                      videoSeconds: requestedConfig.videoSeconds,
                      vquality: requestedConfig.vquality,
                      videoGenerateAudio: requestedConfig.videoGenerateAudio,
                      videoWatermark: requestedConfig.videoWatermark,
                  },
              )
            : {};
    const modeCapability = mode === "video" || mode === "audio" ? mode : "image";
    const runningHubCapability = normalizeRunningHubCapability(selectedRunningHubWorkflow?.capability, normalizeRunningHubCapability(config.runningHub.capability));
    const runningHub = {
        ...config.runningHub,
        enabled: workflowProvider === "runninghub" && config.runningHub.enabled,
        selectedKind: selectedRunningHubWorkflow?.kind === "app" ? ("app" as const) : ("workflow" as const),
        workflowId: runningHubWorkflowId,
        capability: runningHubCapability,
        workflows:
            workflowProvider === "runninghub"
                ? config.runningHub.workflows.map((item) =>
                      item.workflowId.trim() === runningHubWorkflowId && (!node?.metadata?.runningHubWorkflowKind || (item.kind === "app" ? "app" : "workflow") === node.metadata.runningHubWorkflowKind)
                          ? { ...item, fields: applyWorkflowParameterValues(item.fields?.length ? item.fields : (workflowVideoFieldsFromJson(item.workflowJson) as WorkflowFieldMapping[]), workflowParameters) }
                          : item,
                  )
                : config.runningHub.workflows,
    };
    return {
        ...requestedConfig,
        taskWorkflowProvider: workflowProvider,
        runningHub,
        model,
        quality: generationDefaults.quality || requestedConfig.quality,
        size: generationDefaults.size ?? requestedConfig.size,
        transparentBackground: generationDefaults.transparentBackground || (requestedConfig.transparentBackground === "true" ? "true" : "false"),
        videoSeconds: generationDefaults.videoSeconds || requestedConfig.videoSeconds,
        vquality: generationDefaults.vquality ?? requestedConfig.vquality,
        videoGenerateAudio: generationDefaults.videoGenerateAudio || requestedConfig.videoGenerateAudio,
        videoWatermark: generationDefaults.videoWatermark || requestedConfig.videoWatermark,
        videoArkPrivateAssetUpload: requestedConfig.videoArkPrivateAssetUpload,
        count: generationDefaults.count || requestedConfig.count,
    };
}

export function resolveCanvasGenerationModel(config: AiConfig, model: string | undefined, mode: CanvasGenerationMode): string {
    if (!model) return "";
    const normalized = normalizeModelOptionValue(model, config.channels);
    // Keep an explicit paid-tier choice when its catalog entry disappears.
    // Validation will report unavailable instead of choosing a standard default.
    if (mode === "video" && seedancePortraitModel(model)) return normalized || model;
    if (!normalized) return "";
    return configuredModelMatchesCapability(config, normalized, mode) ? normalized : "";
}

function applyWorkflowParameterValues(fields: WorkflowFieldMapping[] | undefined, values: Record<string, unknown>) {
    if (!fields?.length || !Object.keys(values).length) return fields;
    return fields.map((field) => {
        const key = workflowFieldKey(field);
        const randomKey = workflowFieldRandomKey(field);
        const hasValue = workflowFieldHasStoredValue(field, values);
        const hasRandom = Object.prototype.hasOwnProperty.call(values, randomKey);
        if (!hasValue && !hasRandom) return field;
        const value = workflowFieldSubmissionValue(field, workflowFieldCurrentValue(field, values));
        // 画布动态参数按具体字段覆盖，不能继续走 aspectRatio/quality 等全局来源，
        // 否则同一工作流中的两个同类参数会被折叠成同一个值。
        return {
            ...field,
            ...(hasValue ? { fieldValue: value, value } : {}),
            source: "",
            sourceAutomatic: false,
            sourceFromUpstream: false,
            randomEnabled: hasRandom ? values[randomKey] === true : hasValue ? false : field.randomEnabled,
        };
    });
}

