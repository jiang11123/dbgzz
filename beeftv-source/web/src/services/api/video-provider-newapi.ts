import { modelCapabilityConfigFor, videoResolutionRequest } from "@/lib/model-capabilities";
import { boolConfig } from "@/lib/seedance-video";
import { h3Duration, h3GenerationControls, h3MediaPayload, isH3Model } from "@/lib/h3-video";
import { getResourceBlob, getResourceOSSUrl } from "@/services/api/resources";
import { beefAPIVideoContract, isBeefAPIEndpoint } from "@/lib/beefapi-video-contracts";
import { modelOptionName } from "@/stores/use-config-store";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import type { ReferenceImage } from "@/types/image";

import type { ApiEnvelope, ApiVideoResponse, RequestOptions, ResolvedAiConfig, VideoGenerationTask, VideoGenerationTaskState } from "./video-contracts";
import type { VideoProviderDeps } from "./video-provider-deps";
import { normalizeVideoSeconds, normalizeVideoSize } from "./video-validation";
import { blobToDataUrl } from "./video-response";

export async function createVideoGenerationsTask(deps: VideoProviderDeps, config: ResolvedAiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const profile = modelCapabilityConfigFor(config, model).video!;
    const contract = isBeefAPIEndpoint(config.baseUrl) ? beefAPIVideoContract(modelOptionName(model)) : undefined;
    if (contract?.maxReferences) {
        for (const [label, count, limit] of [["图片", references.length, contract.maxReferences.image], ["视频", videoReferences.length, contract.maxReferences.video], ["音频", audioReferences.length, contract.maxReferences.audio]] as const) {
            if (limit !== undefined && count > limit) throw new Error(limit === 0 ? `当前模型暂不支持参考${label}，请移除此素材或选择支持该素材的模型` : `当前模型最多支持 ${limit} 个参考${label}，请移除多余素材后重新生成`);
        }
    }
    const inline = contract?.inlineMedia === true && contract.protocol === config.interfaceType;
    if (references.length > profile.references.maxImages) throw new Error(`当前视频模型最多支持 ${profile.references.maxImages} 张参考图`);
    if (videoReferences.length > profile.references.maxVideos) throw new Error(`当前视频模型最多支持 ${profile.references.maxVideos} 个参考视频`);
    if (audioReferences.length > profile.references.maxAudios) throw new Error(`当前视频模型最多支持 ${profile.references.maxAudios} 段参考音频`);
    if (audioReferences.length > 0 && videoReferences.length === 0 && !profile.operations.includes("audio_to_video")) throw new Error("NewAPI Video Generations 的参考音频必须同时提供至少 1 个参考视频；纯音频生视频请切换到支持该模式的渠道");
    const [imageUrls, videoUrls, audioUrls] = await Promise.all([
        Promise.all(references.map((item) => resolveVideoGenerationsUrl(inline ? item.dataUrl || item.url : item.url || item.dataUrl, item.storageKey, inline, profile.references.maxImageBytes))),
        Promise.all(videoReferences.map((item) => resolveVideoGenerationsUrl(item.url, item.storageKey, inline))),
        Promise.all(audioReferences.map((item) => resolveVideoGenerationsUrl(item.url, item.storageKey, inline))),
    ]);
    const resolution = newAPIVideoResolutionRequest(profile, config.vquality, modelOptionName(model));
    const h3 = contract !== undefined && isH3Model(model);
    const h3Media = h3 ? h3MediaPayload(model,[...imageUrls.map((url,i)=>({id:references[i]!.id,type:"image" as const,url})),...videoUrls.map((url,i)=>({id:videoReferences[i]!.id,type:"video" as const,url})),...audioUrls.map((url,i)=>({id:audioReferences[i]!.id,type:"audio" as const,url}))],options,Number(h3Duration(model,config.videoSeconds)),resolution) : undefined;
    const h3Ratio = config.size.trim() || (h3Media?.referenceMode ? "adaptive" : "16:9");
    if (h3 && !h3Media?.referenceMode && !h3Media?.frameMode && h3Ratio==="adaptive") throw new Error("自适应比例仅支持参考生成，请选择固定比例");
    const payload = {
        model: modelOptionName(model),
        prompt: prompt.trim(),
        ...(h3 ? h3GenerationControls(model, options?.videoH3Options) : {}),
        ...(isApiMartVideoConfig(config)
            ? { duration: normalizeVideoSeconds(config.videoSeconds), size: normalizeVideoSize(config.size) || "16:9" }
            : { seconds: h3 ? h3Duration(model, config.videoSeconds) : normalizeVideoSeconds(config.videoSeconds), ...(h3 ? (h3Media?.frameMode ? {} : {aspect_ratio: h3Ratio}) : {aspect_ratio: normalizeVideoSize(config.size) || "16:9"}) }),
        ...(resolution ? { resolution } : {}),
        ...(!h3 && profile.generateAudio.supported ? { generate_audio: boolConfig(config.videoGenerateAudio, profile.generateAudio.default) } : {}),
        ...(h3 ? h3Media?.payload : {
            ...(imageUrls.length ? {image_urls: imageUrls} : {}),
            ...(videoUrls.length ? {video_urls: videoUrls} : {}),
            ...(audioUrls.length ? {audio_urls: audioUrls} : {}),
        }),
    };
    try {
        const raw = await deps.transport.post<ApiVideoResponse>(deps.transport.apiUrl(isApiMartVideoConfig(config) ? "/videos/generations" : "/video/generations"), payload, options);
        const created = isApiMartVideoConfig(config) ? unwrapApiMartCreate(raw) : deps.response.unwrapVideoResponse(raw);
        const id = deps.response.videoTaskId(created);
        if (!id) throw new Error("NewAPI Video Generations 没有返回任务 ID");
        return { id, provider: "video-generations", model };
    } catch (error) {
        throw new Error(deps.response.readAxiosError(error, "NewAPI Video Generations 任务创建失败"));
    }
}

export async function pollVideoGenerationsTask(deps: VideoProviderDeps, config: ResolvedAiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const raw = await deps.transport.get<ApiEnvelope<Record<string, unknown>>>(deps.transport.apiUrl(isApiMartVideoConfig(config) ? `/tasks/${encodeURIComponent(task.id)}` : `/video/generations/${encodeURIComponent(task.id)}`), options);
        const state = deps.response.unwrapEnvelopeRecord(raw);
        const status = String(state.status || "").toUpperCase();
        if (status === "SUCCESS" || status === "SUCCEEDED" || status === "COMPLETED") {
            const url = videoResultUrl(state);
            if (!url) return { status: "failed", error: "视频任务已完成但没有返回视频地址" };
            return { status: "completed", result: await deps.response.videoResultFromUrl(url, options) };
        }
        if (status === "FAILURE" || status === "FAILED" || status === "CANCELLED") return { status: "failed", error: String(state.fail_reason || state.error || "视频生成失败") };
        return { status: "pending" };
    } catch (error) {
        throw new Error(deps.response.readAxiosError(error, "NewAPI Video Generations 任务查询失败"));
    }
}

function isApiMartVideoConfig(config: ResolvedAiConfig) {
    return /api\.apimart\.ai/i.test(config.baseUrl);
}

function videoResultUrl(state: Record<string, unknown>) {
    const direct = String(state.result_url || state.video_url || state.url || "");
    if (direct) return direct;
    const result = state.result;
    if (!result || typeof result !== "object") return "";
    const videos = (result as { videos?: Array<{ url?: string | string[] }> }).videos;
    const value = videos?.[0]?.url;
    return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}

function unwrapApiMartCreate(payload: unknown): { task_id?: string; id?: string } {
    const data = payload && typeof payload === "object" ? (payload as { data?: unknown }).data : undefined;
    const item = Array.isArray(data) ? data[0] : data;
    if (!item || typeof item !== "object") throw new Error("APIMart 没有返回视频任务");
    return item as { task_id?: string; id?: string };
}

function newAPIVideoResolutionRequest(profile: NonNullable<ReturnType<typeof modelCapabilityConfigFor>["video"]>, value: string, model: string) {
    if (model.trim().toLowerCase() === "grok-video-1.5-1080p") return "1080p";
    return videoResolutionRequest(profile, value);
}

async function resolveVideoGenerationsUrl(value: string | undefined, storageKey?: string, inline = false, maxBytes = 0) {
    if (inline && storageKey?.startsWith("resource:")) {
        const blob = await getResourceBlob(storageKey);
        if (!blob) throw new Error("参考素材无法读取，请重新导入后重试");
        if (maxBytes > 0 && blob.size > maxBytes) throw new Error("参考图片超过当前模型的大小限制，请压缩后重新导入");
        return blobToDataUrl(blob);
    }
    if (inline && value?.startsWith("data:")) {
        if (maxBytes > 0 && value.length > Math.ceil(maxBytes / 3) * 4 + 256) throw new Error("参考图片超过当前模型的大小限制，请压缩后重新导入");
        return value;
    }
    if (storageKey?.startsWith("resource:")) return getResourceOSSUrl(storageKey);
    if (isPublicMediaUrl(value || "")) return String(value);
    throw new Error("NewAPI Video Generations 的参考素材需要公网 URL；本地素材不能直接发送到该渠道，请改用支持本地素材的渠道或提供公网素材地址");
}

function isPublicMediaUrl(value: string) {
    return /^https?:\/\//i.test(value || "");
}
