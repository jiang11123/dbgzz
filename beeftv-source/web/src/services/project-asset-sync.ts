import { assetResourceId, canvasNodeResourceId, canvasNodeToAsset, declaredCanvasNodeAssetCategory, findCanvasNodeAsset, type CanvasAssetSource } from "@/lib/canvas/canvas-node-asset";
import { canvasVideoAssetPreviewUrl } from "@/lib/canvas/canvas-media-preview";
import { readImageMeta } from "@/lib/image-utils";
import { parseAssetRecord } from "@/lib/asset-record";
import { parseBackendGenerationResult, type BackendGenerationResult } from "@/services/api/generation-task";
import { ApiError, http } from "@/services/api/request";
import { resourceIdFromStorageKey } from "@/services/api/resources";
import { getWorkspaceAsset } from "@/services/api/workspace-data";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import type { GenerationTask, GenerationTaskOutput } from "@/services/api/task-center";
import { getMediaBlob, resolveMediaUrl, setMediaBlob } from "@/services/file-storage";
import { createGenerationTaskMaterializer, createIdempotentMaterializeOutput, type MaterializeGenerationTaskOutput } from "@/services/generation-task-materializer";
import { withGenerationArtifactCommitLock } from "@/services/generation-asset-repository";
import { uploadGeneratedAssetToConfiguredSources } from "@/services/external-asset-sources";
import { getImageBlob, resolveImageUrl, setImageBlob } from "@/services/image-storage";
import { generationArtifactStorageKey, loadOrStoreGenerationArtifact } from "@/services/generation-artifact-sink";
import { createProviderNeutralGenerationTaskEffectStore } from "@/services/provider-neutral-generation-effects";
import { getActiveUserScope } from "@/lib/user-scope";
import { assertUserScope, captureUserScope, type CapturedUserScope } from "@/lib/user-scope-guard";
import { runGenerationConsumer } from "@/services/generation-consumer-lifecycle";
import { flushAssetStorePersistence, useAssetStore, type Asset, type AssetCategory, type NewAsset } from "@/stores/use-asset-store";
import type { CanvasNodeData } from "@/types/canvas";
import { persistWorkspaceAssetLink } from "@/services/workspace-asset-repository";
import { usesBrowserLocalResourceStore, workspaceAssetHasCanonicalMediaPersist } from "@/services/workspace-resource-storage";
import { bindBackendConversationMessageResult, type BindBackendConversationMessageRuntime } from "@/services/conversation-generation-consumer";
import type { StoredCreationConversation } from "@/services/creation-conversation-store";

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
}

export type EnsureCanvasNodeAssetOptions = {
    canvasId: string;
    domainProjectId?: string;
    node: CanvasNodeData;
    source: CanvasAssetSource;
    taskId?: string;
    category?: AssetCategory;
    folderId?: string;
    signal?: AbortSignal;
    expectedScope?: CapturedUserScope;
};

export type CanvasNodeAssetResult = {
    assetId: string;
    created: boolean;
    linkedToProject: boolean;
    confirmed: boolean;
};

type MaterializedLocalAssetDependencies = {
    localWorkspace: () => boolean;
    putAsset: (id: string, asset: Asset, expectedScope?: CapturedUserScope) => Promise<void>;
};

const defaultMaterializedLocalAssetDependencies: MaterializedLocalAssetDependencies = {
    localWorkspace: isLocalWorkspaceMode,
    putAsset: async (id, asset, expectedScope) => {
        const expected = expectedScope ?? captureUserScope();
        assertUserScope(expected);
        await http.put(`/assets/${encodeURIComponent(id)}`, { asset }, { expectedScope: expected });
    },
};

/** Register a generated Resource-backed asset before a canvas snapshot can reference it. */
export async function registerMaterializedLocalAsset(
    asset: Asset,
    dependencies: MaterializedLocalAssetDependencies = defaultMaterializedLocalAssetDependencies,
    expectedScope?: CapturedUserScope,
) {
    const expected = expectedScope ?? captureUserScope();
    assertUserScope(expected);
    if (!dependencies.localWorkspace()) return;
    const storageKey = "storageKey" in asset.data ? asset.data.storageKey : undefined;
    if (!storageKey || !resourceIdFromStorageKey(storageKey)) return;
    await dependencies.putAsset(asset.id, asset, expected);
}

export async function registerMaterializedTaskAssets(
    task: Pick<GenerationTask, "outputs">,
    assets: Asset[],
    register: (asset: Asset) => Promise<void> = registerMaterializedLocalAsset,
) {
    const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
    for (const output of task.outputs || []) {
        if (!output.materializedAssetId) continue;
        const asset = assetsById.get(output.materializedAssetId);
        if (asset) await register(asset);
    }
}

const pendingAssetSyncs = new Map<string, Promise<CanvasNodeAssetResult>>();
const DEFAULT_RATE_LIMIT_RETRY_MS = 60_000;
const MAX_RATE_LIMIT_RETRY_MS = 5 * 60_000;

type CanvasAssetSyncRetryOptions = {
    signal?: AbortSignal;
    maxRetries?: number;
    wait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
    expectedScope?: CapturedUserScope;
};

function waitForCanvasAssetSyncRetry(delayMs: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("The operation was aborted", "AbortError"));
            return;
        }
        const timer = globalThis.setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, delayMs);
        const onAbort = () => {
            globalThis.clearTimeout(timer);
            reject(new DOMException("The operation was aborted", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

export async function retryCanvasAssetSyncAfterRateLimit<T>(operation: () => Promise<T>, options: CanvasAssetSyncRetryOptions = {}): Promise<T> {
    const expected = options.expectedScope ?? captureUserScope();
    const maxRetries = Math.max(0, options.maxRetries ?? 2);
    const wait = options.wait ?? waitForCanvasAssetSyncRetry;
    for (let attempt = 0; ; attempt += 1) {
        throwIfAborted(options.signal);
        assertUserScope(expected);
        try {
            return await operation();
        } catch (error) {
            if (!(error instanceof ApiError) || error.status !== 429 || attempt >= maxRetries) throw error;
            const delayMs = Math.min(MAX_RATE_LIMIT_RETRY_MS, Math.max(0, error.retryAfterMs ?? DEFAULT_RATE_LIMIT_RETRY_MS));
            await wait(delayMs, options.signal);
            assertUserScope(expected);
        }
    }
}

export function ensureCanvasNodeAsset(options: EnsureCanvasNodeAssetOptions) {
    const expected = options.expectedScope ?? captureUserScope();
    const identity = options.taskId || options.node.metadata?.taskId || options.node.metadata?.storageKey || options.node.id;
    const key = [expected.userScope, String(expected.epoch), options.domainProjectId || "personal", options.canvasId, options.node.id, identity].join(":");
    const pending = pendingAssetSyncs.get(key);
    if (pending) return pending;
    const request = runGenerationConsumer(options.signal, (signal) => persistCanvasNodeAsset({ ...options, signal, expectedScope: expected })).finally(() => pendingAssetSyncs.delete(key));
    pendingAssetSyncs.set(key, request);
    return request;
}

async function persistCanvasNodeAsset(options: EnsureCanvasNodeAssetOptions): Promise<CanvasNodeAssetResult> {
    const expected = options.expectedScope ?? captureUserScope();
    throwIfAborted(options.signal);
    assertUserScope(expected);
    const store = useAssetStore.getState();
    let asset = findCanvasNodeAsset(store.assets, options.node, options.canvasId, options.taskId);
    const declaredCategory = options.category || declaredCanvasNodeAssetCategory(options.node);
    let created = false;
    if (!asset) {
        const input = canvasNodeToAsset(options.node, { canvasId: options.canvasId, source: options.source, taskId: options.taskId });
        if (!input) throw new Error("当前节点没有可保存的素材内容");
        const assetId = store.addAsset(options.category ? { ...input, category: options.category } : input);
        asset = useAssetStore.getState().assets.find((item) => item.id === assetId);
        created = true;
    }
    if (!asset) throw new Error("素材写入本地失败");
    const inferredResourceId = canvasNodeResourceId(options.node) || assetResourceId(asset);
    const canonicalStorageKey = inferredResourceId ? `resource:${inferredResourceId}` : undefined;
    const currentStorageKey = "storageKey" in asset.data ? asset.data.storageKey : undefined;
    if (canonicalStorageKey && asset.kind !== "text" && asset.kind !== "entity" && (!resourceIdFromStorageKey(currentStorageKey) || asset.pendingRemoteUpload)) {
        store.updateAsset(asset.id, {
            ...(declaredCategory && asset.category !== declaredCategory ? { category: declaredCategory } : {}),
            pendingRemoteUpload: false,
            remoteUploadError: undefined,
            data: { ...asset.data, storageKey: canonicalStorageKey } as Asset["data"],
            metadata: { ...asset.metadata, resourceKey: canonicalStorageKey },
        });
        asset = useAssetStore.getState().assets.find((item) => item.id === asset?.id) || asset;
    } else if (declaredCategory && asset.category !== declaredCategory) {
        store.updateAsset(asset.id, { category: declaredCategory });
        asset = useAssetStore.getState().assets.find((item) => item.id === asset?.id) || asset;
    }
    const storageKey = "storageKey" in asset.data ? asset.data.storageKey : undefined;
    const confirmed = workspaceAssetHasCanonicalMediaPersist(asset);
    if (!confirmed) {
        await flushAssetStorePersistence(expected);
        assertUserScope(expected);
        return { assetId: asset.id, created, linkedToProject: false, confirmed: false };
    }
    // Browser-local IndexedDB is the durable store, but a proxied Go canvas
    // repository still requires an owned Asset for resource: keys. Desktop and
    // hosted commits go through persistWorkspaceAssetLink's typed APIs instead.
    if (usesBrowserLocalResourceStore() && isLocalWorkspaceMode() && storageKey && resourceIdFromStorageKey(storageKey)) {
        assertUserScope(expected);
        await http.put(`/assets/${encodeURIComponent(asset.id)}`, { asset }, { signal: options.signal, expectedScope: expected });
        throwIfAborted(options.signal);
        assertUserScope(expected);
    }
    await persistWorkspaceAssetLink({
        asset,
        domainProjectId: options.domainProjectId,
        category: declaredCategory,
        folderId: options.folderId,
        source: "canvas",
        signal: options.signal,
        expectedScope: expected,
    });
    assertUserScope(expected);
    return { assetId: asset.id, created, linkedToProject: Boolean(options.domainProjectId), confirmed: true };
}

function generationTaskResult(task: GenerationTask): BackendGenerationResult {
    if (task.resultJson) return parseBackendGenerationResult(task);
    if (!task.previewUrl) return {};
    return task.previewKind === "video" ? { mode: "video", video: { dataUrl: task.previewUrl } } : { mode: "image", images: [{ dataUrl: task.previewUrl }] };
}

export function projectGenerationTaskResult(task: GenerationTask, result?: BackendGenerationResult): GenerationTask {
    const projectedResult = result ?? generationTaskResult(task);
    const projectedOutputs: GenerationTaskOutput[] = projectedResult.images?.length
        ? projectedResult.images.map((image, outputIndex) => ({
              outputIndex,
              mediaType: "image" as const,
              ...(image.storageKey ? { providerArtifactRef: image.storageKey } : {}),
          }))
        : projectedResult.video
          ? [
                {
                    outputIndex: 0,
                    mediaType: "video" as const,
                    ...(projectedResult.video.storageKey ? { providerArtifactRef: projectedResult.video.storageKey } : {}),
                },
            ]
          : projectedResult.audio
            ? [
                  {
                      outputIndex: 0,
                      mediaType: "audio" as const,
                      ...(projectedResult.audio.storageKey ? { providerArtifactRef: projectedResult.audio.storageKey } : {}),
                  },
              ]
            : (task.outputs?.map((output) => ({ ...output })) ?? []);
    const delivered = new Map((task.outputs || []).map((output) => [output.outputIndex, output]));
    const outputs = projectedOutputs.map((output) => {
        const existing = delivered.get(output.outputIndex);
        if (!existing?.materializedAssetId) return output;
        return {
            ...output,
            materializedAssetId: existing.materializedAssetId,
            materializationErrorCode: existing.materializationErrorCode,
        };
    });

    return {
        ...task,
        ...(result ? { resultJson: JSON.stringify(result) } : {}),
        outputs,
        ...(task.status === "succeeded" && outputs.length && !outputs.every((output) => output.materializedAssetId) ? { resultState: "PENDING_MATERIALIZATION" as const } : {}),
    };
}

export function hasBackendDeliveredGenerationOutputs(task: Pick<GenerationTask, "outputs">) {
    return (task.outputs || []).some((output) => Boolean(output.materializedAssetId));
}

export type HydrateBackendGeneratedAssetDependencies = {
    expectedScope?: CapturedUserScope;
    getAsset?: (id: string, signal?: AbortSignal) => Promise<{ asset: Asset }>;
    readAssets?: () => Asset[];
    writeAsset?: (asset: Asset) => void;
};

const defaultHydrateBackendGeneratedAssetDependencies: HydrateBackendGeneratedAssetDependencies = {
    getAsset: (id, signal) => getWorkspaceAsset(id, signal).then((payload) => ({ asset: payload.asset })),
    readAssets: () => useAssetStore.getState().assets,
    writeAsset: (asset) => {
        useAssetStore.setState((state) => (state.assets.some((item) => item.id === asset.id) ? state : { assets: [asset, ...state.assets] }));
    },
};

export async function hydrateBackendGeneratedAsset(
    assetId: string,
    signal?: AbortSignal,
    dependencies: HydrateBackendGeneratedAssetDependencies = defaultHydrateBackendGeneratedAssetDependencies,
) {
    throwIfAborted(signal);
    const id = assetId.trim();
    if (!id) throw new Error("任务产物尚未由后端交付");
    const expectedScope = dependencies.expectedScope;
    if (expectedScope) assertUserScope(expectedScope);
    const getAsset = dependencies.getAsset ?? ((id, signal) => getWorkspaceAsset(id, signal, { expectedScope }).then((payload) => ({ asset: payload.asset })));
    const readAssets = dependencies.readAssets ?? defaultHydrateBackendGeneratedAssetDependencies.readAssets!;
    const writeAsset = dependencies.writeAsset ?? defaultHydrateBackendGeneratedAssetDependencies.writeAsset!;
    const existing = readAssets().find((asset) => asset.id === id);
    if (existing) return existing;
    const payload = await getAsset(id, signal);
    throwIfAborted(signal);
    if (expectedScope) assertUserScope(expectedScope);
    const asset = parseAssetRecord(payload.asset);
    writeAsset(asset);
    return asset;
}

export async function hydrateBackendGeneratedOutputs(
    task: Pick<GenerationTask, "outputs">,
    signal?: AbortSignal,
    dependencies: HydrateBackendGeneratedAssetDependencies = defaultHydrateBackendGeneratedAssetDependencies,
) {
    for (const output of task.outputs || []) {
        if (!output.materializedAssetId) continue;
        await hydrateBackendGeneratedAsset(output.materializedAssetId, signal, dependencies);
    }
}

async function storedGenerationImage(result: NonNullable<BackendGenerationResult["images"]>[number], effectKey: string, scope: string, signal?: AbortSignal) {
    throwIfAborted(signal);
    if (result.storageKey) {
        const url = await resolveImageUrl(result.storageKey, result.dataUrl);
        if (!url) throw new Error("图片结果资源不可用");
        const meta = result.width && result.height ? undefined : await readImageMeta(url, signal);
        throwIfAborted(signal);
        return {
            url,
            storageKey: result.storageKey,
            width: result.width || meta?.width || 1024,
            height: result.height || meta?.height || 1024,
            bytes: result.bytes || 0,
            mimeType: result.mimeType || "image/png",
        };
    }
    const storageKey = generationArtifactStorageKey(effectKey, "image", scope);
    const blob = await loadOrStoreGenerationArtifact({
        effectKey: storageKey,
        read: (key) => getImageBlob(key),
        materialize: async () => (await fetch(result.dataUrl, { signal })).blob(),
        write: async (key, artifact) => {
            await setImageBlob(key, artifact);
        },
    });
    throwIfAborted(signal);
    const url = await resolveImageUrl(storageKey);
    throwIfAborted(signal);
    if (!url) throw new Error("图片结果资源不可用");
    const meta = result.width && result.height ? undefined : await readImageMeta(url, signal);
    throwIfAborted(signal);
    return {
        url,
        storageKey,
        width: result.width || meta?.width || 1024,
        height: result.height || meta?.height || 1024,
        bytes: result.bytes || blob.size,
        mimeType: result.mimeType || blob.type || "image/png",
    };
}

async function storedGenerationMedia(dataUrl: string, effectKey: string, mediaType: "video" | "audio", metadata: { width?: number; height?: number; durationMs?: number; bytes?: number; mimeType: string }, scope: string, signal?: AbortSignal) {
    throwIfAborted(signal);
    const storageKey = generationArtifactStorageKey(effectKey, mediaType, scope);
    const blob = await loadOrStoreGenerationArtifact({
        effectKey: storageKey,
        read: (key) => getMediaBlob(key),
        materialize: async () => (await fetch(dataUrl, { signal })).blob(),
        write: async (key, artifact) => {
            await setMediaBlob(key, artifact);
        },
    });
    throwIfAborted(signal);
    const url = await resolveMediaUrl(storageKey);
    throwIfAborted(signal);
    if (!url) throw new Error(`${mediaType === "video" ? "视频" : "音频"}结果资源不可用`);
    return {
        url,
        storageKey,
        width: metadata.width,
        height: metadata.height,
        durationMs: metadata.durationMs,
        bytes: metadata.bytes || blob.size,
        mimeType: metadata.mimeType || blob.type,
    };
}

async function generationOutputAsset(input: Parameters<MaterializeGenerationTaskOutput>[0], scope: string): Promise<NewAsset> {
    throwIfAborted(input.signal);
    const result = generationTaskResult(input.task);
    const metadata = {
        source: "generation-task",
        generationEffectKey: input.effectKey,
        taskId: input.task.id,
        outputIndex: input.output.outputIndex,
        conversationId: input.task.clientContext?.conversationId,
        messageId: input.task.clientContext?.messageId,
        batchIndex: input.task.clientContext?.batchIndex,
    };

    if (input.output.mediaType === "image") {
        const image = result.images?.[input.output.outputIndex];
        if (!image) throw new Error("生成任务缺少图片输出");
        const stored = await storedGenerationImage(image, input.effectKey, scope, input.signal);
        return {
            kind: "image",
            title: "生成图片",
            coverUrl: stored.url,
            tags: ["生成"],
            status: "confirmed",
            source: "生成任务",
            metadata,
            data: {
                dataUrl: stored.url,
                storageKey: stored.storageKey,
                width: stored.width,
                height: stored.height,
                bytes: stored.bytes,
                mimeType: stored.mimeType,
            },
        };
    }

    if (input.output.mediaType === "video") {
        const video = result.video;
        if (!video) throw new Error("生成任务缺少视频输出");
        const stored = video.storageKey
            ? {
                  url: await resolveMediaUrl(video.storageKey, video.dataUrl),
                  storageKey: video.storageKey,
                  width: video.width || 0,
                  height: video.height || 0,
                  durationMs: video.durationMs,
                  bytes: video.bytes || 0,
                  mimeType: video.mimeType || "video/mp4",
              }
            : await storedGenerationMedia(
                  video.dataUrl,
                  input.effectKey,
                  "video",
                  {
                      width: video.width,
                      height: video.height,
                      durationMs: video.durationMs,
                      bytes: video.bytes,
                      mimeType: video.mimeType || "video/mp4",
                  },
                  scope,
                  input.signal,
              );
        if (!stored.url) throw new Error("视频结果资源不可用");
        return {
            kind: "video",
            title: "生成视频",
            coverUrl: canvasVideoAssetPreviewUrl(stored.url),
            tags: ["生成"],
            status: "confirmed",
            source: "生成任务",
            metadata,
            data: {
                url: stored.url,
                storageKey: stored.storageKey,
                width: stored.width || 0,
                height: stored.height || 0,
                durationMs: stored.durationMs,
                bytes: stored.bytes,
                mimeType: stored.mimeType || "video/mp4",
            },
        };
    }

    const audio = result.audio;
    if (!audio) throw new Error("生成任务缺少音频输出");
    const stored = audio.storageKey
        ? {
              url: await resolveMediaUrl(audio.storageKey, audio.dataUrl),
              storageKey: audio.storageKey,
              durationMs: audio.durationMs,
              bytes: audio.bytes || 0,
              mimeType: audio.mimeType || "audio/mpeg",
          }
        : await storedGenerationMedia(
              audio.dataUrl,
              input.effectKey,
              "audio",
              {
                  durationMs: audio.durationMs,
                  bytes: audio.bytes,
                  mimeType: audio.mimeType || "audio/mpeg",
              },
              scope,
              input.signal,
          );
    if (!stored.url) throw new Error("音频结果资源不可用");
    return {
        kind: "audio",
        title: "生成音频",
        coverUrl: "",
        tags: ["生成"],
        status: "confirmed",
        source: "生成任务",
        metadata,
        data: {
            url: stored.url,
            storageKey: stored.storageKey,
            durationMs: stored.durationMs,
            bytes: stored.bytes,
            mimeType: stored.mimeType || "audio/mpeg",
        },
    };
}

const materializeGenerationOutput: MaterializeGenerationTaskOutput = createIdempotentMaterializeOutput({
    async insertOrReturnAsset(input) {
        const scope = getActiveUserScope();
        const assetId = await withGenerationArtifactCommitLock(
            scope,
            async () => {
                throwIfAborted(input.signal);
                const asset = await generationOutputAsset(input, scope);
                throwIfAborted(input.signal);
                const createdAssetId = await useAssetStore.getState().addGenerationAsset(input.effectKey, asset, input.signal);
                throwIfAborted(input.signal);
                return createdAssetId;
            },
            { requireCrossRealmLock: true },
        );
        const storedAsset = useAssetStore.getState().assets.find((candidate) => candidate.id === assetId);
        if (storedAsset) {
            const syncResult = await uploadGeneratedAssetToConfiguredSources(storedAsset, input.signal);
            throwIfAborted(input.signal);
            if (syncResult.records.length) {
                const currentAsset = useAssetStore.getState().assets.find((candidate) => candidate.id === assetId) || storedAsset;
                useAssetStore.getState().updateAsset(assetId, {
                    metadata: { ...currentAsset.metadata, externalSync: syncResult.records },
                });
            }
        }
        return assetId;
    },
});

function remoteGenerationTaskMaterializer() {
    return createGenerationTaskMaterializer({
        // 每个页面实例持有自己的租约；共享浏览器 storage + Web Lock 提供跨标签原子权威。
        effects: createProviderNeutralGenerationTaskEffectStore(),
        materializeOutput: materializeGenerationOutput,
    });
}

function generationTaskMaterializer(task: GenerationTask) {
    return remoteGenerationTaskMaterializer();
}

export async function materializeGenerationTaskAssets(task: GenerationTask, signal?: AbortSignal): Promise<GenerationTask> {
    if (hasBackendDeliveredGenerationOutputs(task)) {
        await hydrateBackendGeneratedOutputs(task, signal);
        throwIfAborted(signal);
        return task;
    }
    const materialized = await generationTaskMaterializer(task).materialize(projectGenerationTaskResult(task), signal);
    await registerMaterializedTaskAssets(materialized, useAssetStore.getState().assets);
    throwIfAborted(signal);
    return materialized;
}

export function attachGenerationTaskNode(task: GenerationTask, nodeId: string, outputIndex: number, consumer: Parameters<ReturnType<typeof generationTaskMaterializer>["attachNode"]>[3], signal?: AbortSignal) {
    return generationTaskMaterializer(task).attachNode(task, nodeId, outputIndex, consumer, signal);
}

export function attachGenerationTaskMessage(task: GenerationTask, messageId: string, outputIndex: number, consumer: Parameters<ReturnType<typeof generationTaskMaterializer>["attachMessage"]>[3], signal?: AbortSignal) {
    return generationTaskMaterializer(task).attachMessage(task, messageId, outputIndex, consumer, signal);
}

export function resumeGenerationTaskAgent(task: GenerationTask, continuationId: string, consumer: Parameters<ReturnType<typeof generationTaskMaterializer>["resumeAgent"]>[2], signal?: AbortSignal) {
    return generationTaskMaterializer(task).resumeAgent(task, continuationId, consumer, signal);
}

export async function consumeGenerationTaskNode(
    task: GenerationTask,
    nodeId: string,
    outputIndex: number,
    consumer: (input: { task: GenerationTask; output: GenerationTaskOutput; effectKey: string; signal?: AbortSignal }) => Promise<void> | void,
    dependencies: {
        signal?: AbortSignal;
        managed?: true;
        materialize?: typeof materializeGenerationTaskAssets;
        attachNode?: typeof attachGenerationTaskNode;
    } = {},
): Promise<GenerationTask> {
    if (!dependencies.managed) {
        return runGenerationConsumer(dependencies.signal, (signal) => consumeGenerationTaskNode(task, nodeId, outputIndex, consumer, { ...dependencies, signal, managed: true }));
    }
    const materialized = await (dependencies.materialize ?? materializeGenerationTaskAssets)(task, dependencies.signal);
    const output = materialized.outputs?.find((candidate) => candidate.outputIndex === outputIndex);
    if (!output?.materializedAssetId) throw new Error("生成任务输出尚未物化");
    await (dependencies.attachNode ?? attachGenerationTaskNode)(
        materialized,
        nodeId,
        outputIndex,
        async ({ effectKey, signal }) => {
            await consumer({ task: materialized, output, effectKey, signal });
        },
        dependencies.signal,
    );
    return materialized;
}

export async function consumeGenerationTaskAgent(
    task: GenerationTask,
    continuationId: string,
    consumer: (input: { task: GenerationTask; effectKey: string; signal?: AbortSignal }) => Promise<void> | void,
    dependencies: {
        signal?: AbortSignal;
        managed?: true;
        materialize?: typeof materializeGenerationTaskAssets;
        resumeAgent?: typeof resumeGenerationTaskAgent;
    } = {},
): Promise<GenerationTask> {
    if (!dependencies.managed) {
        return runGenerationConsumer(dependencies.signal, (signal) => consumeGenerationTaskAgent(task, continuationId, consumer, { ...dependencies, signal, managed: true }));
    }
    const materialized = task.outputs?.length ? await (dependencies.materialize ?? materializeGenerationTaskAssets)(task, dependencies.signal) : task;
    await (dependencies.resumeAgent ?? resumeGenerationTaskAgent)(
        materialized,
        continuationId,
        async ({ effectKey, signal }) => {
            await consumer({ task: materialized, effectKey, signal });
        },
        dependencies.signal,
    );
    return materialized;
}

export async function consumeGenerationTaskMessage(
    task: GenerationTask,
    messageId: string,
    consumer: (input: {
        task: GenerationTask;
        resultUrls: string[];
        effectKey: string;
        signal?: AbortSignal;
        content?: string;
        conversation?: StoredCreationConversation;
        revision?: number;
        bindingStatus?: string;
    }) => Promise<void> | void,
    dependencies: {
        signal?: AbortSignal;
        managed?: true;
        materialize?: typeof materializeGenerationTaskAssets;
        materializedUrls?: typeof generationTaskMaterializedUrls;
        attachMessage?: typeof attachGenerationTaskMessage;
        bindMessage?: BindBackendConversationMessageRuntime;
    } = {},
): Promise<GenerationTask> {
    if (!dependencies.managed) {
        return runGenerationConsumer(dependencies.signal, (signal) => consumeGenerationTaskMessage(task, messageId, consumer, { ...dependencies, signal, managed: true }));
    }
    const materialized = hasBackendDeliveredGenerationOutputs(task)
        ? await (async () => {
              await hydrateBackendGeneratedOutputs(task, dependencies.signal);
              return task;
          })()
        : await (dependencies.materialize ?? materializeGenerationTaskAssets)(task, dependencies.signal);
    const conversationId = materialized.clientContext?.conversationId?.trim() || "";
    if (conversationId && materialized.status === "succeeded") {
        for (const outputIndex of conversationMessageAttachIndexes(materialized)) {
            const bound = await bindBackendConversationMessageResult({
                conversationId,
                messageId,
                task: materialized,
                outputIndex,
                signal: dependencies.signal,
                runtime: dependencies.bindMessage,
            });
            await consumer({
                task: materialized,
                resultUrls: bound.resultUrls,
                effectKey: bound.effectKey,
                signal: dependencies.signal,
                content: bound.content,
                conversation: bound.conversation,
                revision: bound.receipt.revision,
                bindingStatus: bound.receipt.bindingStatus,
            });
        }
        return materialized;
    }
    const resultUrls = (dependencies.materializedUrls ?? generationTaskMaterializedUrls)(materialized);
    const attach = dependencies.attachMessage ?? attachGenerationTaskMessage;
    const outputs = materialized.outputs?.filter((output) => output.materializedAssetId) ?? [];
    for (const output of outputs) {
        await attach(
            materialized,
            messageId,
            output.outputIndex,
            async ({ effectKey, signal }) => {
                await consumer({ task: materialized, resultUrls, effectKey, signal });
            },
            dependencies.signal,
        );
    }
    return materialized;
}

function conversationMessageAttachIndexes(task: GenerationTask): number[] {
    switch (task.type) {
        case "text":
        case "canvas_text":
        case "text_replay":
            return [0];
        default:
            break;
    }
    const indexes = (task.outputs || []).map((output) => output.outputIndex);
    return indexes.length ? indexes : [0];
}

export function generationTaskMaterializedUrls(task: GenerationTask): string[] {
    const assets = useAssetStore.getState().assets;
    return (task.outputs || []).flatMap((output) => {
        const asset = output.materializedAssetId ? assets.find((candidate) => candidate.id === output.materializedAssetId) : undefined;
        if (!asset) return [];
        if (asset.kind === "image") return [asset.data.dataUrl || asset.coverUrl];
        if (asset.kind === "video" || asset.kind === "audio") return [asset.data.url];
        return [];
    });
}
