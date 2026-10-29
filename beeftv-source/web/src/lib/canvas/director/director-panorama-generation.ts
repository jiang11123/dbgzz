import { nanoid } from "nanoid";
import { assertUserScope, captureUserScope, isUserScopeAbandonedError } from "@/lib/user-scope-guard";
import { beginGenerationConsumer } from "@/services/generation-consumer-lifecycle";
import { resolveCanvasGenerationModel } from "@/lib/canvas/canvas-project-generation";
import { modelCapabilityConfigFor } from "@/lib/model-capabilities";
import { submitBackendGenerationTask } from "@/services/api/generation-task";
import { listGenerationTasks, queryGenerationTask, waitForGenerationTask, type GenerationTask } from "@/services/api/task-center";
import { uploadImage, type UploadedImage } from "@/services/image-storage";
import { materializeGenerationTaskAssets } from "@/services/project-asset-sync";
import { useAssetStore, type ImageAsset } from "@/stores/use-asset-store";
import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

export const DIRECTOR_PANORAMA_PROMPT = "以参考图中的主体、材质和光影为基础，将环境扩展成完整的 360 度等距柱状全景图。输出 2:1 比例的连续单幅画面，左右边缘自然无缝衔接，保持真实空间尺度；不要拼贴、边框、文字、水印或拍摄设备。";

type DirectorPanoramaGenerationInput = { file: File; config: AiConfig; sceneId: string; projectId?: string; signal?: AbortSignal; onTaskUpdate?: (task: GenerationTask) => void };
type DirectorPanoramaGenerationDependencies = {
    upload: (input: string | Blob) => Promise<UploadedImage>;
    submit: typeof submitBackendGenerationTask;
    wait: typeof waitForGenerationTask;
    materialize: typeof materializeGenerationTaskAssets;
    findAsset: (id: string) => ImageAsset | undefined;
    updateAsset: (id: string, patch: { title: string; tags: string[]; source: string; metadata: Record<string, unknown> }) => void;
    selectModel: (config: AiConfig) => string;
};
type DirectorPanoramaRecoveryDependencies = Pick<DirectorPanoramaGenerationDependencies, "wait" | "materialize" | "findAsset" | "updateAsset"> & { list: typeof listGenerationTasks; query: typeof queryGenerationTask };

export function selectDirectorPanoramaModel(config: AiConfig): string {
    return resolveCanvasGenerationModel(config, config.imageModel, "image") || resolveCanvasGenerationModel(config, config.model, "image");
}

function directorPanoramaSize(config: AiConfig, model: string): string {
    const image = modelCapabilityConfigFor(config, model).image;
    if (image?.size.allowCustom || image?.size.values.includes("2:1")) return "2:1";
    return image?.size.default && image.size.default !== "*" ? image.size.default : config.size;
}

const defaultDependencies: DirectorPanoramaGenerationDependencies = {
    upload: uploadImage, submit: submitBackendGenerationTask, wait: waitForGenerationTask, materialize: materializeGenerationTaskAssets,
    findAsset: (id) => useAssetStore.getState().assets.find((asset): asset is ImageAsset => asset.id === id && asset.kind === "image"),
    updateAsset: (id, patch) => useAssetStore.getState().updateAsset(id, patch),
    selectModel: selectDirectorPanoramaModel,
};
const defaultRecoveryDependencies: DirectorPanoramaRecoveryDependencies = { ...defaultDependencies, list: listGenerationTasks, query: queryGenerationTask };

function panoramaSessionGuard(signal?: AbortSignal) {
    const expected = captureUserScope();
    return () => {
        if (signal?.aborted) throw new DOMException("生成会话已结束", "AbortError");
        assertUserScope(expected);
    };
}

async function panoramaFromTask(task: GenerationTask, sceneId: string, dependencies: Pick<DirectorPanoramaGenerationDependencies, "materialize" | "findAsset" | "updateAsset">, assertCurrent: () => void, name?: string, signal?: AbortSignal) {
    assertCurrent();
    const materialized = await dependencies.materialize(task, signal);
    assertCurrent();
    const assetId = materialized.outputs?.find((output) => output.mediaType === "image")?.materializedAssetId;
    if (!assetId) throw new Error("图片任务完成，但没有返回全景图");
    const asset = dependencies.findAsset(assetId);
    if (!asset) throw new Error("全景图结果无法读取，请到任务中心检查输出资源");
    if (asset.metadata?.source !== "director-panorama-ai") {
        dependencies.updateAsset(assetId, { title: name || "AI 全景图", tags: ["全景图", "AI生成"], source: "导演台", metadata: { ...asset.metadata, source: "director-panorama-ai", sceneId, taskId: task.id } });
    }
    return { id: assetId, name: name || asset.title, url: asset.data.dataUrl, storageKey: asset.data.storageKey || "", width: asset.data.width, height: asset.data.height };
}

/** The task outlives its modal; only the observer is stopped by a reload. */
export async function generateDirectorPanorama(input: DirectorPanoramaGenerationInput, dependencies: DirectorPanoramaGenerationDependencies = defaultDependencies): Promise<{ id: string; name: string; url: string; storageKey: string; width: number; height: number }> {
    const consumer = beginGenerationConsumer(input.signal);
    try {
        const { file, config, sceneId, projectId, onTaskUpdate } = input;
        const signal = consumer.signal;
        const assertCurrent = panoramaSessionGuard(signal);
        assertCurrent();
        if (!file.type.startsWith("image/")) throw new Error("请选择图片文件");
        const model = dependencies.selectModel(config);
        if (!model) throw new Error("请先在模型设置中选择可用的图片模型");
        if (modelCapabilityConfigFor(config, model).image?.references.maxImages === 0) throw new Error("当前图片模型不支持参考图，请选择支持图生图的模型");
        const source = await dependencies.upload(file);
        assertCurrent();
        const reference: ReferenceImage = { id: nanoid(), name: file.name, type: source.mimeType, dataUrl: source.url, storageKey: source.storageKey, width: source.width, height: source.height, bytes: source.bytes };
        const task = await dependencies.submit({ projectId, mode: "image", prompt: DIRECTOR_PANORAMA_PROMPT, config: { ...config, model, size: directorPanoramaSize(config, model), count: "1" }, referenceImages: [reference], metadata: { source: "director-panorama", sceneId }, signal, onTaskUpdate });
        assertCurrent();
        const completed = await dependencies.wait(task.id, { initialTask: task, signal, onTaskUpdate });
        return await panoramaFromTask(completed, sceneId, dependencies, assertCurrent, `AI 全景图 · ${file.name}`, signal);
    } finally {
        consumer.release();
    }
}

/** Rejoin tasks after a reload. Abort stops only this observer, never the server task. */
export async function recoverDirectorPanoramaTasks(projectId: string, sceneId: string, signal?: AbortSignal, dependencies: DirectorPanoramaRecoveryDependencies = defaultRecoveryDependencies): Promise<number> {
    const consumer = beginGenerationConsumer(signal);
    signal = consumer.signal;
    try {
        const assertCurrent = panoramaSessionGuard(signal);
        assertCurrent();
        const summaries = await dependencies.list(1000, { projectId }, undefined, signal);
        assertCurrent();
        const candidates = summaries.filter((task) => task.type === "canvas_image" && task.clientContext?.source === "director-panorama" && task.clientContext.sceneId === sceneId && (task.status === "succeeded" || task.status === "running" || task.status === "queued"));
        // A pending task can take minutes; it must not hold back already completed history items.
        const results = await Promise.all(candidates.map(async (summary) => {
            if (signal?.aborted) return false;
            try {
                const task = await dependencies.query(summary.id, { signal });
                assertCurrent();
                const completed = task.status === "succeeded" ? task : await dependencies.wait(task.id, { initialTask: task, signal });
                await panoramaFromTask(completed, sceneId, dependencies, assertCurrent, undefined, signal);
                return true;
            } catch (error) {
                if (isUserScopeAbandonedError(error)) throw error;
                if (!signal?.aborted) console.warn("导演台全景图任务恢复失败", summary.id, error);
                return false;
            }
        }));
        return results.filter(Boolean).length;
    } finally {
        consumer.release();
    }
}
