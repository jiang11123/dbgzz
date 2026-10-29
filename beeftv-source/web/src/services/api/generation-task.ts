import { createClientId } from "@/lib/client-id";
import { getMediaBlob } from "@/services/file-storage";
import { resolveReferenceMediaDuration } from "@/lib/reference-media-metadata";
import { getImageBlob } from "@/services/image-storage";
import { resourceIdFromStorageKey, resourceStorageKey, uploadResourceFile } from "@/services/api/resources";
import { createGenerationTask, findGenerationTaskByOperation, waitForGenerationTask, type GenerationTask, type CreateTaskInput } from "@/services/api/task-center";
import { submitGenerationCommand } from "./generation-submission";
import { modelCapabilityConfigFor } from "@/lib/model-capabilities";
import { grokImagePromptLimitError } from "@/lib/grok-image-prompt-limit";
import { resolveGenerationWorkflowExecution, type GenerationWorkflowExecution } from "@/lib/generation-workflow-execution";
import { isArkPlanBaseUrl } from "@/lib/seedance-video";
import { portraitGenerationError, resolveVideoOperation } from "@/lib/model-selection";
import { logicalModelIDForConfig, modelOptionName, resolveModelChannel, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import { buildBackendToolRequests, type ResponseFunctionTool, type ResponseInputMessage, type ToolChoice, type ToolResponseResult } from "@/services/api/image";
import { assertAgentExchangeBudget } from "@/lib/canvas/agent-context-budget";
import { assertVideoCapability } from "@/services/api/video-validation";
import { ApiError } from "@/services/api/request";
import { assertUserScope, captureUserScope } from "@/lib/user-scope-guard";
import { isReferenceHTTPSLink, uploadReferenceLinks, type ResolveReferenceLinks, type ReferenceLinkRequest } from "./reference-link-replacement";

export { logicalModelIDForConfig };

export type BackendGenerationMode = "text" | "image" | "video" | "audio";

export type BackendGenerationResult = {
    mode?: BackendGenerationMode;
    images?: Array<{ dataUrl: string; url?: string; storageKey?: string; width?: number; height?: number; bytes?: number; mimeType?: string }>;
    video?: { dataUrl: string; url?: string; storageKey?: string; previewUrl?: string; width?: number; height?: number; durationMs?: number; bytes?: number; mimeType?: string };
    audio?: { dataUrl: string; url?: string; storageKey?: string; durationMs?: number; bytes?: number; mimeType?: string; format?: string };
    text?: string;
    toolCalls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string }; thoughtSignature?: string }>;
    reasoning?: string;
};

type BackendGenerationTaskOptions = {
    projectId?: string;
    mode: BackendGenerationMode;
    prompt: string;
    config: AiConfig;
    referenceImages?: ReferenceImage[];
    referenceVideos?: ReferenceVideo[];
    referenceAudios?: ReferenceAudio[];
    textHistory?: Array<{ role: "user" | "assistant" | "system"; content: string }>;
    mask?: ReferenceImage;
    signal?: AbortSignal;
    metadata?: Record<string, unknown>;
    onTaskUpdate?: (task: GenerationTask) => void;
    onTextDelta?: (text: string) => void;
    resolveReferenceLinks?: ResolveReferenceLinks;
    streamText?: boolean;
    enableThinking?: boolean;
    clientOperationId?: string;
    retryOf?: string;
    retryContextsByBatchIndex?: Array<{ retryOf: string; attemptGroupId: string; clientOperationId: string }>;
    attemptGroupId?: string;
    expectedScope?: import("@/lib/user-scope-guard").CapturedUserScope;
};

export type GenerationTaskDependencies = {
    createTask: typeof createGenerationTask;
    waitTask: typeof waitForGenerationTask;
    createId: () => string;
    findTask?: typeof findGenerationTaskByOperation;
};

const defaultDependencies: GenerationTaskDependencies = {
    createTask: createGenerationTask,
    waitTask: waitForGenerationTask,
    createId: () => createClientId(),
    findTask: findGenerationTaskByOperation,
};

type PreparedGenerationReferences = {
    referenceImages: Awaited<ReturnType<typeof prepareBackendImageReference>>[];
    referenceVideos: Awaited<ReturnType<typeof prepareBackendMediaReference>>[];
    referenceAudios: Awaited<ReturnType<typeof prepareBackendMediaReference>>[];
    mask?: Awaited<ReturnType<typeof prepareBackendImageReference>>;
};

// 生成、取消和任务记录必须共用后端任务生命周期，页面层不能再直连供应商。
export async function runBackendGenerationTask(
    {
        projectId,
        mode,
        prompt,
        config,
        referenceImages = [],
        referenceVideos = [],
        referenceAudios = [],
        textHistory = [],
        mask,
        signal,
        metadata,
        onTaskUpdate,
        onTextDelta,
        streamText,
        enableThinking,
        clientOperationId,
        retryOf,
        attemptGroupId,
        expectedScope = captureUserScope(),
        resolveReferenceLinks,
    }: BackendGenerationTaskOptions,
    dependencies: GenerationTaskDependencies = defaultDependencies,
) {
    throwIfAborted(signal);
    assertClientPromptLimit(mode, prompt, config, metadata);
    assertBackendRuntimeConfigured(config, mode);
    const prepared = await prepareGenerationReferences({ config, mode, referenceImages, referenceVideos, referenceAudios, mask });
    throwIfAborted(signal);
    assertPreparedVideoCapability(mode, config, prepared);
    return createAndWaitGenerationTask(
        { projectId, mode, prompt, config, referenceImages, referenceVideos, referenceAudios, textHistory, signal, metadata, onTaskUpdate, onTextDelta, streamText, enableThinking, clientOperationId, retryOf, attemptGroupId, expectedScope, resolveReferenceLinks },
        prepared,
        dependencies,
    );
}

// 分镜等后台生产流程只需要可靠提交任务；任务状态与产物由项目工作区轮询和
// 后端自动回填负责，不能让页面 mutation 一直等待供应商完成。
export async function submitBackendGenerationTask(options: BackendGenerationTaskOptions, dependencies: GenerationTaskDependencies = defaultDependencies): Promise<GenerationTask> {
    throwIfAborted(options.signal);
    assertClientPromptLimit(options.mode, options.prompt, options.config, options.metadata);
    assertBackendRuntimeConfigured(options.config, options.mode);
    const prepared = await prepareGenerationReferences(options);
    throwIfAborted(options.signal);
    assertPreparedVideoCapability(options.mode, options.config, prepared);
    return createBackendGenerationTask(options, prepared, dependencies);
}

type BackendToolGenerationOptions = {
    prompt: string;
    config: AiConfig;
    messages: ResponseInputMessage[];
    tools: ResponseFunctionTool[];
    toolChoice: ToolChoice;
    signal?: AbortSignal;
    onDelta?: (text: string) => void;
    onTaskCreated?: (task: GenerationTask) => void;
    metadata?: { source: string; nodeId?: string; runId?: string; stage?: string };
};

// 准备和执行复用完全相同的任务协议，准备阶段不提交模型任务。
export function prepareBackendToolGenerationTask(options: BackendToolGenerationOptions): CreateTaskInput {
    throwIfAborted(options.signal);
    assertAgentExchangeBudget(options.messages, options.tools, options.config.systemPrompt || "");
    const imageKeys = new Set<string>();
    for (const message of options.messages) {
        if ("type" in message || message.role === "tool" || !Array.isArray(message.content)) continue;
        for (const part of message.content) {
            if (part.type !== "image_url") continue;
            const key = part.image_url.url;
            if (!resourceIdFromStorageKey(key)) throw new Error("看图素材尚未保存为资源，请让助手重新读取图片后继续。");
            imageKeys.add(key);
        }
    }
    const logicalModelId = logicalModelIDForConfig(options.config);
    const requestConfig = resolveModelRequestConfig(options.config, options.config.model);
    if (!logicalModelId && !requestConfig.channelId && !requestConfig.interfaceType) throw new Error("当前模型未选择可用请求协议");
    const task: CreateTaskInput = {
        type: "canvas_text",
        operation: "text",
        prompt: options.prompt,
        model: options.config.model,
        ...(logicalModelId ? { logicalModelId } : {}),
        input: {
            mode: "text",
            prompt: options.prompt,
            config: backendProviderConfig(options.config, "text"),
            agentRequests: buildBackendToolRequests(options.messages, options.tools, options.toolChoice, options.config),
            textOptions: { stream: modelCapabilityConfigFor(options.config, requestConfig.model).text?.streaming !== false },
            referenceImages: [...imageKeys].map((storageKey) => ({ storageKey })),
            metadata: options.metadata || { source: "canvas-online-agent" },
        },
    };
    if (new Blob([JSON.stringify(task)]).size > 15 * 1024 * 1024) {
        throw new Error("本次图片或对话内容过多，请减少参考图片，或新建会话后继续。已有作品会保留。");
    }
    return task;
}

export async function runBackendToolGenerationTask(options: BackendToolGenerationOptions): Promise<ToolResponseResult> {
    const task = await createGenerationTask(prepareBackendToolGenerationTask(options));
    options.onTaskCreated?.(task);
    const completed = await waitForGenerationTask(task.id, { signal: options.signal, initialTask: task, onTextDelta: options.onDelta });
    const result = parseBackendGenerationResult(completed);
    return {
        content: result.text || "",
        toolCalls: result.toolCalls || [],
        ...(result.reasoning ? { reasoning: result.reasoning } : {}),
    };
}

export async function runBackendGenerationTaskBatch(options: BackendGenerationTaskOptions & { count: number }, dependencies: GenerationTaskDependencies = defaultDependencies) {
    const count = Math.max(1, Math.min(15, Math.floor(Number(options.count)) || 1));
    throwIfAborted(options.signal);
    assertClientPromptLimit(options.mode, options.prompt, options.config, options.metadata);
    if (options.retryContextsByBatchIndex && options.retryContextsByBatchIndex.length !== count) throw new Error("生成重试批次任务数量不匹配");
    const prepared = await prepareGenerationReferences(options);
    throwIfAborted(options.signal);
    return Promise.allSettled(
        Array.from({ length: count }, (_, batchIndex) =>
            createAndWaitGenerationTask(
                {
                    ...options,
                    metadata: { ...options.metadata, batchIndex, batchCount: count },
                },
                prepared,
                dependencies,
            ),
        ),
    );
}

function generationOperation(options: BackendGenerationTaskOptions) {
    if (options.mode !== "video") return options.mode;
    return resolveVideoOperation(
        {
            textCount: 0,
            imageCount: options.referenceImages?.length ?? 0,
            videoCount: options.referenceVideos?.length ?? 0,
            audioCount: options.referenceAudios?.length ?? 0,
            characterCount: 0,
        },
        options.metadata?.videoEditOperation as string | undefined,
    );
}

export function isGenerationTaskCancelled(error: unknown, signal?: AbortSignal) {
    return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

function assertBackendRuntimeConfigured(config: AiConfig, mode: BackendGenerationMode) {
    if (resolveGenerationWorkflowExecution(config, mode)) return;
    if (logicalModelIDForConfig(config)) return;
    const requestConfig = resolveModelRequestConfig(config, config.model);
    if (!requestConfig.channelId && !requestConfig.interfaceType) throw new Error("当前模型未选择可用请求协议，请先在模型设置中选择协议插件");
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

function assertClientPromptLimit(mode: BackendGenerationMode, prompt: string, config: AiConfig, metadata?: Record<string, unknown>) {
    if (mode !== "image" || metadata?.promptTemplateOperation || (config.taskWorkflowProvider || "model") !== "model") return;
    const requestConfig = resolveModelRequestConfig(config, config.model);
    const promptLimitError = grokImagePromptLimitError(prompt, requestConfig.interfaceType, requestConfig.model);
    if (promptLimitError) throw new Error(promptLimitError);
}

async function prepareGenerationReferences({
    config,
    mode,
    referenceImages = [],
    referenceVideos = [],
    referenceAudios = [],
    mask,
}: Pick<BackendGenerationTaskOptions, "config" | "mode" | "referenceImages" | "referenceVideos" | "referenceAudios" | "mask">): Promise<PreparedGenerationReferences> {
    const portraitError = mode === "video" ? portraitGenerationError(config, config.model, config.vquality) : "";
    if (portraitError) throw new Error(portraitError);
    // asset:// 仅视频生成可用；Agent Plan Seedream 与 Seedance 共用 /api/plan/v3，不能按 BaseURL 误判。
    const preferArkAssetUrl = mode === "video" && usesArkVideoAssetReference(config);
    const preparedImages = await Promise.all(referenceImages.map((image) => prepareBackendImageReference(image, preferArkAssetUrl)));
    const preparedVideos = await Promise.all(referenceVideos.map(prepareBackendMediaReference));
    const preparedAudios = await Promise.all(referenceAudios.map(prepareBackendMediaReference));
    const preparedMask = mask ? await prepareBackendImageReference(mask, false) : undefined;
    return { referenceImages: preparedImages, referenceVideos: preparedVideos, referenceAudios: preparedAudios, mask: preparedMask };
}

// 与后端 isArkPrivateAssetVideoConfig 对齐：方舟视频渠道允许参考图直接 asset:// 引用，
// 跳过可信素材上传同步（适合已录入方舟素材 ID 的素材，例如被授权的真人像素材）。
function usesArkVideoAssetReference(config: AiConfig) {
    const interfaceType = resolveModelRequestConfig(config, config.model).interfaceType;
    if (interfaceType === "volcengine-ark-video" || interfaceType === "volcengine-ark-agent-plan-video") return true;
    if (interfaceType === "volcengine-ark-image" || interfaceType === "volcengine-ark-agent-plan-image") return false;
    return isArkPlanBaseUrl(config.baseUrl || "");
}

async function createAndWaitGenerationTask(options: BackendGenerationTaskOptions, prepared: PreparedGenerationReferences, dependencies: GenerationTaskDependencies) {
    const task = await createBackendGenerationTask(options, prepared, dependencies);
    const { signal, onTaskUpdate, onTextDelta } = options;
    const completed = await dependencies.waitTask(task.id, { signal, initialTask: task, onTaskUpdate, onTextDelta, expectedScope: options.expectedScope });
    return parseBackendGenerationResult(completed);
}

async function createBackendGenerationTask(options: BackendGenerationTaskOptions, prepared: PreparedGenerationReferences, dependencies: GenerationTaskDependencies) {
    const expectedScope = options.expectedScope ?? captureUserScope();
    const operationId = options.clientOperationId || dependencies.createId();
    options = { ...options, clientOperationId: operationId };
    const submit = () => {
        throwIfAborted(options.signal);
        assertUserScope(expectedScope);
        return submitGenerationCommand(backendGenerationTaskInput(options, prepared), operationId,
            (input) => { assertUserScope(expectedScope); return dependencies.createTask(input, { expectedScope }); },
            dependencies.findTask && options.projectId ? () => { assertUserScope(expectedScope); return dependencies.findTask!(operationId, options.projectId!); } : undefined,
            () => !options.signal?.aborted);
    };
    let task: GenerationTask;
    try {
        task = await submit();
    } catch (error) {
        // Only this admission error guarantees that no task/upstream submission exists.
        if (!(error instanceof ApiError) || error.reason !== "reference_media_requires_url") throw error;
        const groups = ["referenceImages", "referenceVideos", "referenceAudios"] as const;
        const labels = ["参考图片", "参考视频", "参考音频"];
        const references: ReferenceLinkRequest[] = [];
        const transport = resolveModelRequestConfig(options.config, options.config.model).referenceMediaTransport;
        const required = error.details?.requiredReferences;
        const needsURL = (kind: string, index: number, mask = false) => !Array.isArray(required) || required.some((item) => item && typeof item === "object" && item.kind === kind && item.index === index && Boolean(item.mask) === mask);
        groups.forEach((group, kind) => prepared[group].forEach((media, index) => {
            const mediaKind = (["image", "video", "audio"] as const)[kind];
            if (needsURL(mediaKind, index) && (media.storageKey || !isReferenceHTTPSLink(media.url || ""))) references.push({ key: `${group}:${index}`, label: `${labels[kind]} ${index + 1}`, name: media.name, resourceID: resourceIdFromStorageKey(media.storageKey) || undefined, upload: transport?.[mediaKind] !== "link" });
        }));
        if (prepared.mask && needsURL("image", 0, true) && (prepared.mask.storageKey || !isReferenceHTTPSLink(prepared.mask.url || ""))) references.push({ key: "mask:0", label: "遮罩", name: prepared.mask.name, resourceID: resourceIdFromStorageKey(prepared.mask.storageKey) || undefined, upload: transport?.image !== "link" });
        if (!references.length) throw error;
        const nodeId = options.metadata?.nodeId;
        const target = options.projectId && typeof nodeId === "string" && nodeId ? { projectId: options.projectId, nodeId } : undefined;
        const links = options.resolveReferenceLinks
            ? await options.resolveReferenceLinks(references, options.signal, target)
            : await uploadReferenceLinks(references, options.signal, target);
        throwIfAborted(options.signal);
        assertUserScope(expectedScope);
        if (!links || references.some((reference) => !links[reference.key])) throw error;
        for (const reference of references) {
            if (!isReferenceHTTPSLink(links[reference.key] || "")) throw new Error(`${reference.label}需要有效的 HTTPS 链接`);
        }
        const replace = <T extends { id?: string; name?: string; url?: string }>(items: T[], group: string): T[] =>
            items.map((media, index) => {
                const url = links[`${group}:${index}`];
                // The dialog requests an online address for the same reference asset.
                return url ? { ...media, storageKey: undefined, dataUrl: "", url: url.trim() } : media;
            });
        prepared.referenceImages = replace(prepared.referenceImages, "referenceImages");
        prepared.referenceVideos = replace(prepared.referenceVideos, "referenceVideos");
        prepared.referenceAudios = replace(prepared.referenceAudios, "referenceAudios");
        if (prepared.mask) prepared.mask = replace([prepared.mask], "mask")[0];
        assertPreparedVideoCapability(options.mode, options.config, prepared);
        task = await submit();
    }
    options.onTaskUpdate?.(task);
    return task;
}

export async function prepareBackendGenerationTask(options: BackendGenerationTaskOptions): Promise<CreateTaskInput> {
    throwIfAborted(options.signal);
    assertClientPromptLimit(options.mode, options.prompt, options.config, options.metadata);
    assertBackendRuntimeConfigured(options.config, options.mode);
    const prepared = await prepareGenerationReferences(options);
    throwIfAborted(options.signal);
    assertPreparedVideoCapability(options.mode, options.config, prepared);
    return backendGenerationTaskInput(options, prepared);
}

function assertPreparedVideoCapability(mode: BackendGenerationMode, config: AiConfig, prepared: PreparedGenerationReferences) {
    if (mode !== "video") return;
    const profile = modelCapabilityConfigFor(config, config.model).video;
    if (!profile) return;
    // Owned workflow resources can carry only a key; the backend reads their
    // authoritative metadata and validates it before contacting the provider.
    assertVideoCapability(profile, prepared.referenceImages, prepared.referenceVideos, prepared.referenceAudios, config.videoSeconds, { deferResourceMetadataToBackend: true });
}

function backendGenerationTaskInput(options: BackendGenerationTaskOptions, prepared: PreparedGenerationReferences): CreateTaskInput {
    const { projectId, mode, prompt, config, metadata } = options;
    const videoOperation = generationOperation(options);
    const workflow = resolveGenerationWorkflowExecution(config, mode);
    const logicalModelId = workflow ? "" : logicalModelIDForConfig(config);
    return {
        ...(projectId ? { projectId } : {}),
        type: `canvas_${mode}`,
        operation: mode === "video" ? videoOperation : mode,
        prompt,
        ...(workflow ? { provider: workflow.provider } : {}),
        model: workflow?.taskModel || config.model,
        ...(logicalModelId ? { logicalModelId } : {}),
        input: {
            mode,
            prompt,
            ...(workflow ? { execution: workflowPublicExecution(workflow) } : {}),
            config: backendProviderConfig(config, mode),
            capabilityOptions: logicalModelId ? logicalCapabilityOptions(config, mode) : undefined,
            textHistory: options.textHistory,
            ...(mode === "text" ? { textOptions: { stream: options.streamText !== false, thinking: options.enableThinking === true } } : {}),
            referenceImages: prepared.referenceImages,
            referenceVideos: prepared.referenceVideos,
            referenceAudios: prepared.referenceAudios,
            mask: prepared.mask,
            metadata: generationMetadata(config, {
                ...metadata,
                ...(options.clientOperationId ? { clientOperationId: options.clientOperationId } : {}),
                ...(options.retryOf ? { retryOf: options.retryOf } : {}),
                ...(options.attemptGroupId ? { attemptGroupId: options.attemptGroupId } : {}),
            }),
        },
    };
}

function generationMetadata(config: AiConfig, metadata?: Record<string, unknown>) {
    const channel = resolveModelChannel(config, config.model);
    const model = modelOptionName(config.model);
    const modelProfile = channel.modelProfiles?.find((item) => item.model === model);
    const protocol = modelProfile?.protocol || channel.interfaceType;
    const defaults = modelProfile?.defaultOptions;
    if (!protocol || !defaults || !Object.keys(defaults).length) return metadata;
    const existing = metadata?.providerOptions && typeof metadata.providerOptions === "object" && !Array.isArray(metadata.providerOptions) ? (metadata.providerOptions as Record<string, unknown>) : {};
    const namespace = existing[protocol] && typeof existing[protocol] === "object" && !Array.isArray(existing[protocol]) ? (existing[protocol] as Record<string, unknown>) : {};
    return { ...metadata, providerOptions: { ...existing, [protocol]: { ...defaults, ...namespace } } };
}

async function prepareBackendMediaReference(media: ReferenceVideo | ReferenceAudio) {
    media = await resolveReferenceMediaDuration(media);
    if (resourceIdFromStorageKey(media.storageKey)) return backendMediaReference(media, { storageKey: media.storageKey });
    const url = media.url || "";
    if (/^https?:\/\//i.test(url)) return backendMediaReference(media, { url });
    let blob: Blob | null = null;
    if (media.storageKey) blob = await getMediaBlob(media.storageKey);
    if (!blob && (url.startsWith("blob:") || url.startsWith("data:"))) blob = await (await fetch(url)).blob();
    if (!blob) throw new Error("参考媒体尚未保存，请重新上传后再生成");
    try {
        const kind: "video" | "audio" | "file" = blob.type.startsWith("video/") ? "video" : blob.type.startsWith("audio/") ? "audio" : "file";
        const resource = await uploadResourceFile(blob, kind, { fileName: media.name, width: "width" in media ? media.width : undefined, height: "height" in media ? media.height : undefined, durationMs: media.durationMs });
        return backendMediaReference(media, { storageKey: resourceStorageKey(resource.id), type: resource.mimeType || media.type || blob.type });
    } catch (error) {
        throw new Error(error instanceof Error ? `参考媒体上传失败：${error.message}` : "参考媒体上传失败");
    }
}

async function prepareBackendImageReference(image: ReferenceImage, preferArkAssetUrl = false) {
    if (preferArkAssetUrl && image.arkAssetId) return backendImageReference(image, { url: `asset://${image.arkAssetId}` });
    if (resourceIdFromStorageKey(image.storageKey)) return backendImageReference(image, { storageKey: image.storageKey });
    const sourceUrl = image.url || image.dataUrl;
    if (/^https?:\/\//i.test(sourceUrl)) return backendImageReference(image, { url: sourceUrl });
    const blob = image.storageKey ? await getImageBlob(image.storageKey) : sourceUrl ? await (await fetch(sourceUrl)).blob() : null;
    if (!blob) throw new Error("参考图片尚未保存，请重新上传后再生成");
    try {
        const resource = await uploadResourceFile(blob, "image", { fileName: image.name });
        return backendImageReference(image, { storageKey: resourceStorageKey(resource.id), type: resource.mimeType || image.type || blob.type });
    } catch (error) {
        throw new Error(error instanceof Error ? `参考图片上传失败：${error.message}` : "参考图片上传失败");
    }
}

// 任务输入只允许后端协议字段，避免把 previewUrl 等页面态 Data URL 带入强校验写路径。
function backendImageReference(image: ReferenceImage, override: Partial<ReferenceImage>): ReferenceImage {
    return {
        id: image.id,
        name: image.name,
        type: override.type || image.type,
        dataUrl: "",
        url: override.url,
        storageKey: override.storageKey,
        ...(image.bytes ? { bytes: image.bytes } : {}),
        ...(image.width ? { width: image.width } : {}),
        ...(image.height ? { height: image.height } : {}),
    };
}

function backendMediaReference<T extends ReferenceVideo | ReferenceAudio>(media: T, override: Partial<T>): T {
    return {
        id: media.id,
        name: media.name,
        type: override.type || media.type,
        url: override.url || "",
        storageKey: override.storageKey,
        ...("bytes" in media && media.bytes ? { bytes: media.bytes } : {}),
        ...("width" in media && media.width ? { width: media.width } : {}),
        ...("height" in media && media.height ? { height: media.height } : {}),
        ...(media.durationMs ? { durationMs: media.durationMs } : {}),
    } as T;
}

export function backendProviderConfig(config: AiConfig, mode: BackendGenerationMode = "image") {
    const requestConfig = resolveModelRequestConfig(config, config.model);
    const workflow = resolveGenerationWorkflowExecution(config, mode);
    if (workflow) return workflowProviderConfig(config, requestConfig, workflow);
    const generationOptions = {
        size: config.size,
        quality: omittedImageQuality(config.quality, requestConfig),
        transparentBackground: config.transparentBackground,
        seedreamMode: config.seedreamMode,
        seedreamMaxImages: config.seedreamMaxImages,
        seedreamOutputFormat: config.seedreamOutputFormat,
        seedreamOptimize: config.seedreamOptimize,
        seedreamWatermark: config.seedreamWatermark,
        count: config.count,
        videoSeconds: config.videoSeconds,
        vquality: config.vquality,
        videoGenerateAudio: config.videoGenerateAudio == null ? undefined : String(config.videoGenerateAudio),
        videoWatermark: config.videoWatermark == null ? undefined : String(config.videoWatermark),
        videoArkPrivateAssetUpload: config.videoArkPrivateAssetUpload == null ? undefined : String(config.videoArkPrivateAssetUpload),
        audioVoice: config.audioVoice,
        audioFormat: config.audioFormat,
        audioSpeed: config.audioSpeed,
        audioPitch: config.audioPitch,
        audioVolume: config.audioVolume,
        audioInstructions: config.audioInstructions,
        systemPrompt: config.systemPrompt,
    };
    if (logicalModelIDForConfig(config)) return generationOptions;
    return {
        channelId: requestConfig.channelId,
        apiFormat: requestConfig.apiFormat,
        interfaceType: requestConfig.interfaceType,
        baseUrl: requestConfig.baseUrl,
        referenceAssetOrigin: requestConfig.referenceAssetOrigin,
        referenceMediaTransport: requestConfig.referenceMediaTransport,
        apiKey: requestConfig.credentialRef ? "" : requestConfig.apiKey,
        secretKey: requestConfig.credentialRef ? "" : requestConfig.secretKey,
        headers: requestConfig.headers,
        credentialRef: requestConfig.credentialRef,
        model: requestConfig.model,
        ...generationOptions,
        capabilityConfig: modelCapabilityConfigFor(config, requestConfig.model),
        videoCapabilitiesVersion: resolveModelChannel(config, config.model).modelProfiles?.find((item) => item.model === requestConfig.model)?.videoCapabilitiesVersion,
        systemPrompt: config.systemPrompt,
    };
}

function workflowProviderConfig(config: AiConfig, requestConfig: ReturnType<typeof resolveModelRequestConfig>, workflow: GenerationWorkflowExecution) {
    const runningHubActive = workflow.provider === "runninghub";
    return {
        channelId: "",
        apiFormat: requestConfig.apiFormat,
        interfaceType: workflow.interfaceType,
        baseUrl: config.runningHub.baseUrl,
        apiKey: runningHubActive ? config.runningHub.apiKey : "",
        // 工作流是独立 Provider，不能继承普通模型渠道的密钥和自定义头。
        secretKey: "",
        headers: [],
        model: workflow.providerModel,
        size: config.size,
        quality: config.quality,
        transparentBackground: config.transparentBackground,
        count: config.count,
        videoSeconds: config.videoSeconds,
        vquality: config.vquality,
        videoGenerateAudio: config.videoGenerateAudio,
        videoWatermark: config.videoWatermark,
        videoArkPrivateAssetUpload: config.videoArkPrivateAssetUpload,
        audioVoice: config.audioVoice,
        audioFormat: config.audioFormat,
        audioSpeed: config.audioSpeed,
        audioPitch: config.audioPitch,
        audioVolume: config.audioVolume,
        audioInstructions: config.audioInstructions,
        workflowId: workflow.workflowId,
        webappId: workflow.webappId,
        workflowJson: workflow.workflowJson,
        workflowFields: workflow.workflowFields,
        runningHubUseWallet: false,
        runningHubWalletApiKey: "",
        runningHubUploadApiKey: runningHubActive ? config.runningHub.uploadApiKey || "" : "",
        capabilityConfig: modelCapabilityConfigFor(config, requestConfig.model),
        videoCapabilitiesVersion: resolveModelChannel(config, config.model).modelProfiles?.find((item) => item.model === requestConfig.model)?.videoCapabilitiesVersion,
        systemPrompt: config.systemPrompt,
    };
}

function workflowPublicExecution(workflow: GenerationWorkflowExecution) {
    return {
        provider: workflow.provider,
        kind: workflow.kind,
        interfaceType: workflow.interfaceType,
        name: workflow.name,
        ...(workflow.workflowId ? { workflowId: workflow.workflowId } : {}),
        ...(workflow.webappId ? { webappId: workflow.webappId } : {}),
    };
}

function logicalCapabilityOptions(config: AiConfig, mode: BackendGenerationMode) {
    const channel = resolveModelChannel(config, config.model);
    const spec = channel.modelProfiles?.find((item) => item.model === modelOptionName(config.model))?.logicalCapabilitySpec;
    const candidates: Record<string, unknown> =
        mode === "image"
            ? { size: config.size, quality: omittedImageQuality(config.quality, resolveModelRequestConfig(config, config.model)), transparentBackground: config.transparentBackground === "true", count: Number(config.count) }
            : mode === "video"
              ? { size: config.size, videoSeconds: Number(config.videoSeconds), vquality: config.vquality, videoGenerateAudio: config.videoGenerateAudio === "true", videoWatermark: config.videoWatermark === "true" }
              : mode === "audio"
                ? { audioVoice: config.audioVoice, audioFormat: config.audioFormat, audioSpeed: Number(config.audioSpeed), audioPitch: Number(config.audioPitch), audioVolume: Number(config.audioVolume) }
                : {};
    const filtered = Object.fromEntries(Object.entries(candidates).filter(([key]) => Boolean(spec?.options?.[key])));
    // 只把前台模型声明过的参数送进能力匹配。未声明的 quality 不能因为画布选了 4K 档位
    // 而被硬塞进去，否则会报“不支持参数 生成质量”；插件仍从 config.quality 读取档位。
    return filtered;
}

function omittedImageQuality(value: string | undefined, request: { model: string; interfaceType?: string }) {
    const normalized = String(value || "")
        .trim()
        .toLowerCase();
    if (request.interfaceType === "openai-image" && request.model.trim().toLowerCase() === "gpt-image-2" && ["", "auto", "any"].includes(normalized)) return "low";
    return normalized === "auto" || normalized === "any" ? undefined : value;
}

export function parseBackendGenerationResult(task: GenerationTask): BackendGenerationResult {
    if (!task.resultJson) throw new Error("后端任务没有返回结果");
    const result = JSON.parse(task.resultJson) as BackendGenerationResult;
    if (!result || typeof result !== "object") throw new Error("后端任务结果格式错误");
    return result;
}
