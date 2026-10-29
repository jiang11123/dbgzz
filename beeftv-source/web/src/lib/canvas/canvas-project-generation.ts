import { type GenerationTask } from "@/services/api/task-center";
import { createClientId } from "@/lib/client-id";
import { backendProviderConfig, logicalModelIDForConfig, runBackendGenerationTask, type GenerationTaskDependencies } from "@/services/api/generation-task";
import { resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { resolveMediaUrl } from "@/services/file-storage";
import { resourceIdFromStorageKey } from "@/services/api/resources";
import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { isH3Model, h3VideoOperation, h3ResolvedReferenceOrder } from "@/lib/h3-video";
import { isSeedanceVideoConfig } from "@/lib/seedance-video";
import { modelCapabilityConfigFor } from "@/lib/model-capabilities";
import { resolveVideoOperation } from "@/lib/model-selection";
import { imageMetadata } from "@/lib/canvas/canvas-generation-task-sync";
import { ensureMediaNodeMinimumSize } from "@/lib/canvas/canvas-node-size";
import { repairOverlappingImageBatches } from "@/lib/canvas/canvas-generation-layout";
import { interruptFileUpload } from "@/lib/canvas/canvas-file-upload";
import { isDepthCaptureResultNode } from "@/lib/canvas/canvas-depth-capture";
import { isCanvasWorkflowProvider } from "@/lib/canvas/canvas-workflow";
import type { CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import { CanvasNodeType, type CanvasAssistantSession, type CanvasConnection, type CanvasImageGenerationType, type CanvasNodeData, type CanvasNodeMetadata, type CanvasVideoEditOperation } from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import { assertUserScope, captureUserScope, isUserScopeAbandonedError, userScopeMatches } from "@/lib/user-scope-guard";
import { CanvasGenerationDurableAckError, CanvasGenerationMaterializationError } from "@/services/canvas-generation-errors";
import type { persistCanvasGenerationTarget } from "@/services/canvas-generation-target";
import { GenerationSubmissionUnknownError } from "@/services/api/generation-submission";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

export async function runBackendCanvasGenerationTask(
    {
        projectId,
        nodeId,
        mode,
        prompt,
        config,
        referenceImages = [],
        referenceVideos = [],
        referenceAudios = [],
        mask,
        signal,
        metadata,
        onTaskCreated,
        clientOperationId,
        retryOf,
        attemptGroupId,
        expectedScope,
        resolveReferenceLinks,
    }: {
        projectId: string;
        nodeId: string;
        mode: CanvasNodeGenerationMode;
        prompt: string;
        config: AiConfig;
        referenceImages?: ReferenceImage[];
        referenceVideos?: ReferenceVideo[];
        referenceAudios?: ReferenceAudio[];
        mask?: ReferenceImage;
        signal?: AbortSignal;
        metadata?: Record<string, unknown>;
        onTaskCreated?: (task: GenerationTask) => void;
        clientOperationId?: string;
        retryOf?: string;
        attemptGroupId?: string;
        expectedScope?: import("@/lib/user-scope-guard").CapturedUserScope;
        resolveReferenceLinks?: import("@/services/api/reference-link-replacement").ResolveReferenceLinks;
    },
    dependencies?: GenerationTaskDependencies,
) {
    if (mode === "image") assertCanvasImageReferenceLimit(config, referenceImages);
    return runBackendGenerationTask(
        {
            projectId,
            mode,
            prompt,
            config,
            referenceImages,
            referenceVideos,
            referenceAudios,
            mask,
            signal,
            metadata: { nodeId, ...(mode === "video" && !metadata?.videoEditOperation ? { videoEditOperation: "image_to_video" } : {}), ...metadata },
            onTaskUpdate: onTaskCreated,
            clientOperationId,
            retryOf,
            attemptGroupId,
            expectedScope,
            resolveReferenceLinks,
        },
        dependencies,
    );
}

export function canvasImageReferenceLimitError(config: AiConfig, referenceImages: ReferenceImage[]) {
    // 工作流的参考素材上限由字段映射槽位决定，不能再套用当前普通图片模型的能力表。
    if ((config.taskWorkflowProvider || "model") !== "model") return "";
    const maxImages = modelCapabilityConfigFor(config, config.model).image?.references.maxImages;
    if (maxImages === undefined || referenceImages.length <= maxImages) return "";
    return `当前图片模型最多支持 ${maxImages} 张参考图，当前已连接 ${referenceImages.length} 张。请移除多余连线后重试`;
}

export function assertCanvasImageReferenceLimit(config: AiConfig, referenceImages: ReferenceImage[]) {
    const error = canvasImageReferenceLimitError(config, referenceImages);
    if (error) throw new Error(error);
}

export { backendProviderConfig };
// 兼容故事板执行器的旧导入路径。
export { logicalModelIDForConfig };

const generationOperationLocks = new Map<string, Promise<unknown>>();

function hydrateCompletedTextTask(task: GenerationTask, text: string): GenerationTask {
    let existingResult: Record<string, unknown> = {};
    try {
        const parsed = JSON.parse(task.resultJson || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existingResult = parsed;
    } catch {
        // The parsed generation result below is the canonical fallback for a stale or malformed task snapshot.
    }
    return { ...task, resultJson: JSON.stringify({ ...existingResult, mode: "text", text }) };
}

export function runGenerationOperationOnce<T>(clientOperationId: string | undefined, operation: () => Promise<T>): Promise<T> {
    if (!clientOperationId) return operation();
    const existing = generationOperationLocks.get(clientOperationId) as Promise<T> | undefined;
    if (existing) return existing;
    const running = operation().finally(() => {
        if (generationOperationLocks.get(clientOperationId) === running) generationOperationLocks.delete(clientOperationId);
    });
    generationOperationLocks.set(clientOperationId, running);
    return running;
}

export async function runCanvasGenerationTaskToConsumer(
    input: Parameters<typeof runBackendCanvasGenerationTask>[0],
    dependencies: {
        bindTask(task: GenerationTask): void;
        consumeTask(task: GenerationTask): Promise<void>;
        runTask?: (options: Parameters<typeof runBackendCanvasGenerationTask>[0]) => ReturnType<typeof runBackendCanvasGenerationTask>;
        prepareTarget?: typeof persistCanvasGenerationTarget;
        isCurrent?: () => boolean;
        onSubmission?: (metadata: Pick<CanvasNodeMetadata, "taskClientOperationId" | "generationSubmissionState" | "taskStage">) => void;
    },
) {
    input = { ...input, clientOperationId: input.clientOperationId || createClientId() };
    return runGenerationOperationOnce(input.clientOperationId, async () => {
        const expectedScope = input.expectedScope ?? captureUserScope();
        const isCurrent = () => !input.signal?.aborted && userScopeMatches(expectedScope) && (dependencies.isCurrent ? dependencies.isCurrent() : true);
        const submission = (state: NonNullable<CanvasNodeMetadata["generationSubmissionState"]>) => {
            if (!isCurrent()) return;
            const metadata = { taskClientOperationId: input.clientOperationId, generationSubmissionState: state, taskStage: state === "submitting" ? "正在提交生成任务" : state === "unknown" ? "提交结果待确认，请查询原任务" : undefined };
            // Editor and store are one writer here. Advance the editor's live
            // refs before publishing the store change can trigger persistence.
            dependencies.onSubmission?.(metadata);
            const project = useCanvasStore.getState().openProject(input.projectId);
            if (project) useCanvasStore.getState().updateProject(project.id, { nodes: project.nodes.map((node) => node.id === input.nodeId ? { ...node, metadata: { ...node.metadata, ...metadata } } : node) });
        };
        submission("submitting");
        try {
            const prepare = dependencies.prepareTarget ?? (await import("@/services/canvas-generation-target")).persistCanvasGenerationTarget;
            await prepare({ ...input, expectedScope, isCurrent });
        } catch (error) {
            submission("rejected");
            throw error;
        }
        if (input.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
        assertUserScope(expectedScope);
        let completedTask: GenerationTask | undefined;
        let result: Awaited<ReturnType<typeof runBackendCanvasGenerationTask>>;
        let accepted = false;
        try { result = await (dependencies.runTask ?? runBackendCanvasGenerationTask)({
            ...input,
            expectedScope,
            onTaskCreated: (task) => {
                accepted = true;
                submission("accepted");
                if (input.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
                assertUserScope(expectedScope);
                input.onTaskCreated?.(task);
                dependencies.bindTask(task);
                if (task.status === "succeeded") completedTask = task;
            },
        }); } catch (error) {
            if (!accepted) submission(error instanceof GenerationSubmissionUnknownError ? "unknown" : "rejected");
            throw error;
        }
        if (input.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
        assertUserScope(expectedScope);
        if (!completedTask) throw new Error("生成任务缺少成功终态");
        const taskForConsumer = input.mode === "text" && completedTask.type === "canvas_text" && result.text ? hydrateCompletedTextTask(completedTask, result.text) : completedTask;
        try {
            await dependencies.consumeTask(taskForConsumer);
            if (input.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
            assertUserScope(expectedScope);
        } catch (error) {
            if (isUserScopeAbandonedError(error) || (error instanceof Error && error.name === "AbortError")) throw error;
            const cause = error instanceof CanvasGenerationDurableAckError || error instanceof CanvasGenerationMaterializationError ? error.cause : error;
            dependencies.bindTask({
                ...taskForConsumer,
                failureDiagnostics: {
                    ...taskForConsumer.failureDiagnostics,
                    source: "client_result",
                    executionResult: "completed",
                    stage: "画布应用结果",
                    summary: cause instanceof Error ? cause.message : "画布应用结果失败",
                    capturedAt: new Date().toISOString(),
                },
            });
            throw error instanceof CanvasGenerationDurableAckError || error instanceof CanvasGenerationMaterializationError ? error : new CanvasGenerationDurableAckError(error);
        }
        return result;
    });
}

export type GenerationRetryContext = {
    retryOf: string;
    attemptGroupId: string;
    clientOperationId: string;
};

export async function createGenerationRetryContext(retryOf: string, attemptGroupId = retryOf): Promise<GenerationRetryContext> {
    const bytes = new TextEncoder().encode(`generation-retry\0${attemptGroupId}\0${retryOf}`);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return { retryOf, attemptGroupId, clientOperationId: `retry:${hex}` };
}

export function createGenerationBatchRetryContexts(taskIds: readonly string[], attemptGroupId: string) {
    return Promise.all(taskIds.map((taskId) => createGenerationRetryContext(taskId, attemptGroupId)));
}

export function generationTaskMetadata(task: GenerationTask): CanvasNodeMetadata {
    const progress = normalizeTaskProgress(task.progress, task.status);
    return {
        taskId: task.id,
        taskType: task.type,
        taskClientOperationId: task.clientOperationId,
        generationSubmissionState: "accepted",
        retryOf: task.retryOf,
        attemptGroupId: task.attemptGroupId,
        taskStatus: task.status,
        taskProgress: progress,
        taskStage: task.stage,
        taskProvider: task.provider,
        taskStartedAt: task.startedAt,
        taskCompletedAt: task.completedAt,
        taskDurationMs: task.startedAt && task.completedAt ? Math.max(0, Date.parse(task.completedAt) - Date.parse(task.startedAt)) : undefined,
        taskErrorCode: task.errorCode,
        taskFailureDiagnostics: task.failureDiagnostics,
        taskProviderRequestId: task.providerRequestId,
        taskOfficialStatus: task.officialStatus,
        taskReceiptRecorded: task.receiptRecorded,
        taskCreatedAt: task.createdAt || task.created_at,
        taskUpdatedAt: task.updatedAt || task.updated_at,
    };
}

// 失败节点再次提交前必须移除旧任务绑定，否则批次调度会把它误判为仍在处理。
export function resetGenerationTaskMetadata(metadata: CanvasNodeMetadata | undefined, status: CanvasNodeMetadata["status"] = "idle"): CanvasNodeMetadata {
    const next = {
        ...(metadata || {}),
        status,
        errorDetails: undefined,
        generationErrorCode: undefined,
        generationErrorSummary: undefined,
        resourceReloadAvailable: undefined,
        failedPromptFingerprint: undefined,
        failedInputFingerprint: undefined,
    };
    delete next.taskId;
    delete next.taskType;
    delete next.taskOutputIndex;
    delete next.generationOutputNodeIds;
    delete next.taskClientOperationId;
    delete next.retryOf;
    delete next.attemptGroupId;
    delete next.taskStatus;
    delete next.taskProgress;
    delete next.taskStage;
    delete next.taskProvider;
    delete next.taskStartedAt;
    delete next.taskCompletedAt;
    delete next.taskDurationMs;
    delete next.taskErrorCode;
    delete next.taskFailureDiagnostics;
    delete next.taskProviderRequestId;
    delete next.taskOfficialStatus;
    delete next.taskReceiptRecorded;
    delete next.taskCreatedAt;
    delete next.taskUpdatedAt;
    return next;
}

export function clearInPlaceMediaOutputMetadata(metadata: CanvasNodeMetadata | undefined, status: CanvasNodeMetadata["status"] = "loading"): CanvasNodeMetadata {
    const next = resetGenerationTaskMetadata(metadata, status);
    delete next.depthSourceNodeId;
    delete next.content;
    delete next.storageKey;
    delete next.assetId;
    delete next.previewContent;
    delete next.videoPreview;
    delete next.naturalWidth;
    delete next.naturalHeight;
    delete next.durationMs;
    delete next.hasAudio;
    delete next.bytes;
    delete next.mimeType;
    delete next.generationEffectKeys;
    delete next.outputParameterWarning;
    return next;
}

function normalizeTaskProgress(progress: number | undefined, status: GenerationTask["status"]) {
    if (typeof progress === "number" && Number.isFinite(progress)) return Math.max(0, Math.min(100, Math.round(progress)));
    if (status === "queued") return 0;
    if (status === "succeeded") return 100;
    return undefined;
}

export function imageExtension(dataUrl: string) {
    return dataUrl.match(/^data:image[/]([^;]+)/)?.[1] || dataUrl.match(/image[/]([^;]+)/)?.[1] || "png";
}

export function audioExtension(mimeType?: string) {
    if (mimeType?.includes("wav")) return "wav";
    if (mimeType?.includes("opus")) return "opus";
    if (mimeType?.includes("aac")) return "aac";
    if (mimeType?.includes("flac")) return "flac";
    if (mimeType?.includes("pcm")) return "pcm";
    return "mp3";
}

export function buildImageGenerationMetadata(type: CanvasImageGenerationType, config: AiConfig, count: number, references: ReferenceImage[]): CanvasNodeMetadata {
    return {
        ...generationWorkflowMetadata(config),
        generationType: type,
        model: config.model,
        size: config.size,
        quality: config.quality,
        transparentBackground: config.transparentBackground,
        seedreamMode: config.seedreamMode,
        seedreamMaxImages: config.seedreamMaxImages,
        seedreamOutputFormat: config.seedreamOutputFormat,
        seedreamOptimize: config.seedreamOptimize,
        seedreamWatermark: config.seedreamWatermark,
        count,
        references: references.map(referenceUrl).filter((url): url is string => Boolean(url)),
    };
}

export function nodeReferenceImage(node: CanvasNodeData): ReferenceImage | null {
    if (node.type === CanvasNodeType.MediaConversion) {
        // 转换结果只在成功物化后作为生成参考；运行中、跳过和失败状态都不能透传旧结果。
        const conversion = node.metadata?.mediaConversion;
        const storageKey = conversion?.resultStorageKey || node.metadata?.storageKey;
        if (conversion?.status !== "completed" || !storageKey) return null;
        return {
            id: node.id,
            name: node.title || `conversion-${node.id}.png`,
            type: node.metadata?.mimeType || "image/png",
            dataUrl: node.metadata?.content || "",
            storageKey,
        };
    }
    if (node.type !== CanvasNodeType.Image || (!node.metadata?.content && !node.metadata?.storageKey)) return null;
    return {
        id: node.id,
        name: `reference-${node.id}.png`,
        type: node.metadata.mimeType || "image/png",
        dataUrl: node.metadata.content || "",
        storageKey: node.metadata.storageKey,
    };
}

export function buildAudioGenerationMetadata(config: AiConfig): CanvasNodeMetadata {
    return {
        ...generationWorkflowMetadata(config),
        model: config.model,
        audioVoice: config.audioVoice,
        audioFormat: config.audioFormat,
        audioSpeed: config.audioSpeed,
        audioPitch: config.audioPitch,
        audioVolume: config.audioVolume,
        audioInstructions: config.audioInstructions,
    };
}

function referenceUrl(image: ReferenceImage) {
    return image.storageKey || image.url || (!image.dataUrl.startsWith("data:") ? image.dataUrl : undefined);
}

export async function resolveStoredReferenceImages(references?: string[]) {
    if (!references?.length) return [];
    const imageReferences = references.filter(isStoredImageReference);
    const images = await Promise.all(
        imageReferences.map(async (url, index) => {
            const storageKey = url.startsWith("image:") || resourceIdFromStorageKey(url) ? url : undefined;
            const dataUrl = storageKey ? await resolveImageUrl(storageKey, "") : url;
            if (!dataUrl) return null;
            return {
                id: `${index}`,
                name: `reference-${index + 1}.png`,
                type: imageMimeType(dataUrl),
                dataUrl,
                url: /^https?:\/\//i.test(dataUrl) ? dataUrl : undefined,
                storageKey,
            };
        }),
    );
    return images.every(Boolean) ? (images as ReferenceImage[]) : null;
}

function isStoredImageReference(url: string) {
    return resourceIdFromStorageKey(url) || url.startsWith("image:") || url.startsWith("data:image/") || /\.(png|jpe?g|webp|gif|avif)(?:[?#]|$)/i.test(url);
}

function imageMimeType(url: string) {
    return url.match(/^data:(image\/[^;,]+)/)?.[1] || "image/png";
}

export function generationReferenceUrls(context: { referenceImages: ReferenceImage[]; referenceVideos: Array<{ storageKey?: string; url?: string }>; referenceAudios?: Array<{ storageKey?: string; url?: string }> }) {
    return [
        ...context.referenceImages.map(referenceUrl).filter((url): url is string => Boolean(url)),
        ...context.referenceVideos.map((video) => video.storageKey || video.url).filter((url): url is string => Boolean(url)),
        ...(context.referenceAudios || []).map((audio) => audio.storageKey || audio.url).filter((url): url is string => Boolean(url)),
    ];
}

function resolveVideoEditOperation(
    node: CanvasNodeData | undefined,
    context?: {
        referenceImages: ReferenceImage[];
        referenceVideos: ReferenceVideo[];
        referenceAudios: ReferenceAudio[];
    },
): CanvasVideoEditOperation {
    const storedOperation = node?.metadata?.videoEditOperation;
    const input = {
        textCount: 0,
        imageCount: context?.referenceImages.length || 0,
        videoCount: context?.referenceVideos.length || 0,
        audioCount: context?.referenceAudios.length || 0,
        characterCount: 0,
    };
    return resolveVideoOperation(input, storedOperation) as CanvasVideoEditOperation;
}

export function buildVideoGenerationMetadata(
    node: CanvasNodeData | undefined,
    context?: {
        referenceImages: ReferenceImage[];
        referenceVideos: ReferenceVideo[];
        referenceAudios: ReferenceAudio[];
    },
    config?: AiConfig,
): CanvasNodeMetadata {
    const metadata = node?.metadata;
    const referenceImageIds = new Set((context?.referenceImages || []).map((image) => image.id));
    // 工作流视频把已连接媒体交给字段映射处理，不再把历史首尾帧选择当成硬约束。
    // 工作流视频把已连接媒体交给字段映射处理，不再把历史首尾帧选择当成硬约束。
    const workflowVideo = node?.type === CanvasNodeType.Config && (config?.taskWorkflowProvider === "runninghub" || isCanvasWorkflowProvider(metadata));
    const startFrame = workflowVideo ? undefined : requireConnectedVideoFrame(metadata?.videoStartFrameNodeId, "首帧", referenceImageIds);
    const endFrame = workflowVideo ? undefined : requireConnectedVideoFrame(metadata?.videoEndFrameNodeId, "尾帧", referenceImageIds);
    return {
        ...(config ? generationWorkflowMetadata(config) : {}),
        videoEditOperation:
            config && isH3Model(config.model)
                ? h3VideoOperation(config.model, { imageCount: context?.referenceImages.length || 0, videoCount: context?.referenceVideos.length || 0, audioCount: context?.referenceAudios.length || 0 }, metadata?.videoEditOperation)
                : resolveVideoEditOperation(node, context),
        videoCameraMoveId: metadata?.videoCameraMoveId,
        videoCameraMovePrompt: metadata?.videoCameraMovePrompt,
        videoStartFrameNodeId: startFrame,
        videoEndFrameNodeId: endFrame,
        videoMiddleFrameNodeId: metadata?.videoMiddleFrameNodeId ? requireConnectedVideoFrame(metadata.videoMiddleFrameNodeId, "中间帧", referenceImageIds) : undefined,
        videoMiddleFrameTime: metadata?.videoMiddleFrameTime,
        videoH3Options: metadata?.videoH3Options,
        doubaoVideoModel: metadata?.doubaoVideoModel,
        videoReferenceOrder: config && isH3Model(config.model) ? h3ResolvedReferenceOrder(metadata?.videoReferenceOrder, [...(context?.referenceImages || []), ...(context?.referenceVideos || []), ...(context?.referenceAudios || [])]) : metadata?.videoReferenceOrder,
    };
}

function requireConnectedVideoFrame(frameNodeId: string | undefined, label: string, referenceImageIds: Set<string>) {
    if (!frameNodeId) return undefined;
    if (referenceImageIds.has(frameNodeId)) return frameNodeId;
    throw new Error(`已配置的${label}参考图未连接或不可用，请重新选择后再生成`);
}

export async function resolveMetadataReferences(metadata: CanvasNodeMetadata) {
    if (metadata.generationType !== "edit") return [];
    if (!metadata.references?.length) return null;
    return resolveStoredReferenceImages(metadata.references);
}

export async function hydrateCanvasImages(nodes: CanvasNodeData[]) {
    return Promise.all(
        nodes.map(async (node) => {
            const content = node.metadata?.content;
            const videoPreview =
                node.type === CanvasNodeType.Video && node.metadata?.videoPreview?.storageKey
                    ? { ...node.metadata.videoPreview, content: await resolveImageUrl(node.metadata.videoPreview.storageKey, node.metadata.videoPreview.content, { cacheMiss: true }) }
                    : node.metadata?.videoPreview;
            if ((node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio) && node.metadata?.storageKey) return { ...node, metadata: { ...node.metadata, content: await resolveMediaUrl(node.metadata.storageKey, content), videoPreview } };
            if (videoPreview !== node.metadata?.videoPreview) return { ...node, metadata: { ...node.metadata, videoPreview } };
            if (node.type === CanvasNodeType.Image && node.metadata?.storageKey) return { ...node, metadata: { ...node.metadata, content: await resolveImageUrl(node.metadata.storageKey, content, { cacheMiss: true }) } };
            if (node.type !== CanvasNodeType.Image || !content) return node;
            if (!content.startsWith("data:image/")) return node;
            return { ...node, metadata: { ...node.metadata, ...imageMetadata(await uploadImage(content)) } };
        }),
    );
}

export async function hydrateAssistantImages(sessions: CanvasAssistantSession[]) {
    const hydrateItem = async <T extends { dataUrl?: string; storageKey?: string }>(item: T) => {
        if (item.storageKey) return { ...item, dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl) };
        if (item.dataUrl?.startsWith("data:image/")) {
            const image = await uploadImage(item.dataUrl);
            return { ...item, dataUrl: image.url, storageKey: image.storageKey };
        }
        return item;
    };
    return Promise.all(
        sessions.map(async (session) => ({
            ...session,
            messages: await Promise.all(
                session.messages.map(async (message) => ({
                    ...message,
                    references: await Promise.all((message.references || []).map(hydrateItem)),
                })),
            ),
        })),
    );
}

export function getGenerationCount(count: string) {
    return Math.max(1, Math.min(15, Math.floor(Math.abs(Number(count)) || 1)));
}

export function generationWorkflowMetadata(config: AiConfig): Pick<CanvasNodeMetadata, "workflowProvider" | "runningHubWorkflowId" | "runningHubWorkflowKind"> {
    const provider = config.taskWorkflowProvider || "model";
    return {
        workflowProvider: provider,
        runningHubWorkflowId: provider === "runninghub" ? config.runningHub.workflowId : undefined,
        runningHubWorkflowKind: provider === "runninghub" ? config.runningHub.selectedKind : undefined,
    };
}

export { buildGenerationConfig, resolveCanvasGenerationModel } from "./canvas-generation-config";

export function supportsVideoReferenceAudio(config: AiConfig) {
    const interfaceType = resolveModelRequestConfig(config, config.model).interfaceType;
    return interfaceType === "newapi-channel-1" || interfaceType === "newapi-channel-2" || isSeedanceVideoConfig(config);
}

const LEGACY_INTERRUPTED_GENERATION_DETAILS = "页面刷新后生成已中断，请重新生成。";

/** 节点是否还要和任务中心对账。首次打开画布和之后才载入的快照共用这一条判定。 */
export function canvasNodeNeedsGenerationRecovery(node: CanvasNodeData) {
    const metadata = node.metadata;
    if (!metadata || metadata.generationErrorCode === "result_target_unavailable" || metadata.fileUpload === "uploading" || isDepthCaptureResultNode(node)) return false;
    const pendingAgentContinuation = metadata.agentGenerationContinuation?.status === "pending";
    const aggregateBatchRoot = metadata.isBatchRoot && metadata.batchChildIds?.length && !metadata.taskId;
    if (aggregateBatchRoot && !pendingAgentContinuation) return false;
    return pendingAgentContinuation || ["submitting", "unknown"].includes(metadata.generationSubmissionState || "") || metadata.status === "loading" || metadata.errorDetails === LEGACY_INTERRUPTED_GENERATION_DETAILS || Boolean(metadata.taskId && (metadata.status !== "success" || (metadata.taskStatus === "succeeded" && !metadata.content && !metadata.storageKey)));
}

// 快照恢复交给任务对账的节点，在 metadata 上挂一个只存在于本页面内存里的记号（symbol 键）。
// JSON 序列化、保存和内容对比都看不到它；节点被复制时随之带走，恢复器读过后作废，普通刷新合并进来的节点没有它。
const GENERATION_RECOVERY_RESTORE = Symbol("generationRecoveryRestore");
type RestoreTaggedMetadata = CanvasNodeMetadata & { [GENERATION_RECOVERY_RESTORE]?: object };
const consumedRestoreTokens = new WeakSet<object>();

function generationRecoveryRestoreToken(node: CanvasNodeData) {
    return (node.metadata as RestoreTaggedMetadata | undefined)?.[GENERATION_RECOVERY_RESTORE];
}

export function isGenerationRecoveryRestored(node: CanvasNodeData) {
    const token = generationRecoveryRestoreToken(node);
    return Boolean(token && !consumedRestoreTokens.has(token));
}

/** 恢复器读过这些节点后调用：同一次恢复只交出一次。 */
export function consumeGenerationRecoveryRestore(nodes: readonly CanvasNodeData[]) {
    nodes.forEach((node) => {
        const token = generationRecoveryRestoreToken(node);
        if (token) consumedRestoreTokens.add(token);
    });
}

/** 三路合并只处理持久化字段；把打开快照的恢复资格交给合并后仍绑定同一任务的节点。 */
export function carryGenerationRecoveryRestore(nodes: CanvasNodeData[], restored: readonly CanvasNodeData[]) {
    const sources = new Map(restored.map((node) => [node.id, node]));
    let changed = false;
    const next = nodes.map((node) => {
        const source = sources.get(node.id);
        if (!source || !isGenerationRecoveryRestored(source) || !canvasNodeNeedsGenerationRecovery(node)) return node;
        if (source.metadata?.taskId !== node.metadata?.taskId
            || source.metadata?.taskClientOperationId !== node.metadata?.taskClientOperationId
            || source.metadata?.agentGenerationContinuation?.id !== node.metadata?.agentGenerationContinuation?.id
            || source.metadata?.agentGenerationContinuation?.taskId !== node.metadata?.agentGenerationContinuation?.taskId) return node;
        const token = generationRecoveryRestoreToken(source);
        if (generationRecoveryRestoreToken(node) === token) return node;
        changed = true;
        return { ...node, metadata: { ...node.metadata, [GENERATION_RECOVERY_RESTORE]: token } };
    });
    return changed ? next : nodes;
}

function markGenerationRecoveryRestore(node: CanvasNodeData): CanvasNodeData {
    if (!canvasNodeNeedsGenerationRecovery(node)) return node;
    const metadata: RestoreTaggedMetadata = { ...node.metadata, [GENERATION_RECOVERY_RESTORE]: {} };
    return { ...node, metadata };
}

export function resetInterruptedGeneration(nodes: CanvasNodeData[]) {
    const configWidth = NODE_DEFAULT_SIZE[CanvasNodeType.Config].width;
    const configHeight = NODE_DEFAULT_SIZE[CanvasNodeType.Config].height;
    let changed = false;
    const reset = nodes.map((node) => {
        const mediaNode = ensureMediaNodeMinimumSize(interruptFileUpload(node));
        const resizedNode =
            mediaNode.type === CanvasNodeType.Config && (mediaNode.width < configWidth || mediaNode.height < configHeight)
                ? { ...mediaNode, width: Math.max(mediaNode.width, configWidth), height: Math.max(mediaNode.height, configHeight) }
                : mediaNode.type === CanvasNodeType.Script && mediaNode.height < NODE_DEFAULT_SIZE[CanvasNodeType.Script].height
                  ? { ...mediaNode, height: NODE_DEFAULT_SIZE[CanvasNodeType.Script].height }
                  : mediaNode;
        const restoredNode = markGenerationRecoveryRestore(resizedNode.metadata?.status === "loading" ? { ...resizedNode, metadata: { ...resizedNode.metadata, errorDetails: "正在从任务中心恢复生成状态..." } } : resizedNode);
        if (restoredNode !== node) changed = true;
        return restoredNode;
    });
    return repairOverlappingImageBatches(changed ? reset : nodes);
}

export function isGenerationCanceled(error: unknown) {
    return error instanceof Error && (error.message === "请求已取消" || error.name === "AbortError");
}

export function findRetrySourceNode(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const queue = connections.filter((connection) => connection.toNodeId === nodeId).map((connection) => connection.fromNodeId);
    const visited = new Set<string>();
    while (queue.length) {
        const id = queue.shift()!;
        if (visited.has(id)) continue;
        visited.add(id);
        const node = nodes.find((item) => item.id === id);
        if (node?.type === CanvasNodeType.Config) return node;
        connections.filter((connection) => connection.toNodeId === id).forEach((connection) => queue.push(connection.fromNodeId));
    }
    return null;
}

export function sourceNodeReferenceImages(node: CanvasNodeData | null) {
    const reference = node ? nodeReferenceImage(node) : null;
    return reference ? [reference] : [];
}

export function isAudioFile(file: File) {
    return file.type.startsWith("audio/") || /\.(mp3|wav)$/i.test(file.name);
}
