import { normalizeVideoDuration } from "@/lib/video-generation-options";
import { modelCapabilityConfigFor, videoDurationAllowed } from "@/lib/model-capabilities";
import { channelHasGenerationCredential, isBuiltinBeefAPIChannel, resolveModelChannel } from "@/stores/use-config-store";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import type { ReferenceImage } from "@/types/image";

import type { ResolvedAiConfig } from "./video-contracts";

export function assertVideoCapability(
    profile: NonNullable<ReturnType<typeof modelCapabilityConfigFor>["video"]>,
    references: ReferenceImage[],
    videoReferences: ReferenceVideo[],
    audioReferences: ReferenceAudio[],
    seconds: string,
    options: { deferResourceMetadataToBackend?: boolean } = {},
) {
    const refs = profile.references;
    if (references.length > refs.maxImages) throw new Error(`当前视频模型最多支持 ${refs.maxImages} 张参考图`);
    if (videoReferences.length > refs.maxVideos) throw new Error(`当前视频模型最多支持 ${refs.maxVideos} 个参考视频`);
    if (audioReferences.length > refs.maxAudios) throw new Error(`当前视频模型最多支持 ${refs.maxAudios} 段参考音频`);
    if (audioReferences.length && !references.length && !videoReferences.length && !profile.operations.includes("audio_to_video")) throw new Error("当前视频模型不支持只用音频生成视频，请同时添加参考图片或参考视频");
    if (references.length < refs.minImages) throw new Error(`当前视频模型至少需要 ${refs.minImages} 张参考图`);
    if (!videoDurationAllowed(profile, Number(seconds))) throw new Error("视频时长不在当前模型支持范围内");
    for (const [index, image] of references.entries()) {
        assertReferenceFileBytes("图", index, image.bytes, refs.maxImageBytes);
        assertReferenceGeometry("图", index, image.width, image.height, refs.minImageWidth, refs.maxImageWidth, refs.minImageHeight, refs.maxImageHeight, refs.minImageAspect, refs.maxImageAspect, refs.minImagePixels, refs.maxImagePixels);
    }
    let totalVideoMs = 0;
    for (const [index, video] of videoReferences.entries()) {
        totalVideoMs += video.durationMs || 0;
        if (!referenceDurationIsOpaqueAsset(video) && !(options.deferResourceMetadataToBackend && video.storageKey?.startsWith("resource:") && !video.durationMs)) assertReferenceDuration("视频", index, video.durationMs, refs.minVideoDurationSeconds, refs.maxVideoDurationSeconds);
        assertReferenceFileBytes("视频", index, video.bytes, refs.maxVideoBytes);
        if (refs.minVideoPixels && (!video.width || !video.height) && !/^asset:\/\/[A-Za-z0-9_-]+$/.test(video.url || "") && !(options.deferResourceMetadataToBackend && video.storageKey?.startsWith("resource:"))) throw new Error(`第 ${index + 1} 个参考视频尺寸无法读取，请重新导入素材后再提交`);
        assertReferenceGeometry("视频", index, video.width, video.height, refs.minVideoWidth, refs.maxVideoWidth, refs.minVideoHeight, refs.maxVideoHeight, refs.minVideoAspect, refs.maxVideoAspect, refs.minVideoPixels, refs.maxVideoPixels);
    }
    const maxVideoTotal = refs.maxVideoTotalDurationSeconds || 0;
    if (maxVideoTotal > 0 && totalVideoMs / 1000 > maxVideoTotal) throw new Error(`参考视频总时长为 ${(totalVideoMs / 1000).toFixed(2)} 秒，当前模型最多支持 ${maxVideoTotal} 秒；请裁剪或减少参考视频后再提交`);
    for (const [index, audio] of audioReferences.entries()) {
        if (!referenceDurationIsOpaqueAsset(audio) && !(options.deferResourceMetadataToBackend && audio.storageKey?.startsWith("resource:") && !audio.durationMs)) assertReferenceDuration("音频", index, audio.durationMs, refs.minAudioDurationSeconds, refs.maxAudioDurationSeconds);
        assertReferenceFileBytes("音频", index, audio.bytes, refs.maxAudioBytes);
    }
    const totalAudioSeconds = audioReferences.reduce((total, audio) => total + (audio.durationMs || 0), 0) / 1000;
    const maxAudioTotal = refs.maxAudioTotalDurationSeconds || 0;
    if (maxAudioTotal > 0 && totalAudioSeconds > maxAudioTotal) throw new Error(`参考音频总时长为 ${totalAudioSeconds.toFixed(2)} 秒，当前模型最多支持 ${maxAudioTotal} 秒；请裁剪或减少参考音频后再提交`);
}

function referenceDurationIsOpaqueAsset(media: ReferenceVideo | ReferenceAudio) {
    return !media.durationMs && !media.storageKey?.startsWith("resource:") && /^asset:\/\/[A-Za-z0-9_-]+$/.test(media.url || "");
}

export function assertReferenceDuration(kind: string, index: number, durationMs: number | undefined, minimum = 0, maximum = 0) {
    if (minimum <= 0 && maximum <= 0) return;
    const name = `第 ${index + 1} 段参考${kind}`;
    if (!Number.isFinite(durationMs) || !durationMs || durationMs <= 0) throw new Error(`${name}的时长无法读取，请重新导入素材后再提交`);
    const minMs = Math.round(minimum * 1000);
    const maxMs = maximum > 0 ? Math.round(maximum * 1000) : 0;
    if (durationMs < minMs || (maxMs > 0 && durationMs > maxMs)) throw new Error(`${name}时长为 ${(durationMs / 1000).toFixed(2)} 秒，需要 ${referenceBound(minimum, maximum)} 秒；请裁剪或更换这段素材后再提交`);
}

function referenceBound(minimum: number, maximum: number) {
    if (minimum <= 0) return `不超过 ${maximum}`;
    if (maximum <= 0) return `至少 ${minimum}`;
    return `${minimum}–${maximum}`;
}

function assertReferenceFileBytes(kind: string, index: number, bytes: number | undefined, maximum = 0) {
    if (!maximum || !bytes || bytes <= maximum) return;
    const unit = kind === "图" ? "张" : kind === "音频" ? "段" : "个";
    throw new Error(`第 ${index + 1} ${unit}参考${kind}文件过大，当前模型单文件上限为 ${formatMediaByteLimit(maximum)}；请压缩或更换后再提交`);
}

function assertReferenceGeometry(
    kind: string,
    index: number,
    width?: number,
    height?: number,
    minWidth = 0,
    maxWidth = 0,
    minHeight = 0,
    maxHeight = 0,
    minAspect = 0,
    maxAspect = 0,
    minPixels = 0,
    maxPixels = 0,
) {
    if (!width || !height) return;
    const unit = kind === "图" ? "张" : "个";
    const label = `第 ${index + 1} ${unit}参考${kind}`;
    if ((minWidth && width < minWidth) || (maxWidth && width > maxWidth)) throw new Error(`${label}宽度为 ${width} 像素，需要 ${referenceBound(minWidth, maxWidth)} 像素；请调整尺寸或更换后再提交`);
    if ((minHeight && height < minHeight) || (maxHeight && height > maxHeight)) throw new Error(`${label}高度为 ${height} 像素，需要 ${referenceBound(minHeight, maxHeight)} 像素；请调整尺寸或更换后再提交`);
    const aspect = width / height;
    if ((minAspect && aspect < minAspect) || (maxAspect && aspect > maxAspect)) throw new Error(`${label}宽高比为 ${aspect.toFixed(2)}，需要 ${referenceBound(minAspect, maxAspect)}；请调整尺寸或更换后再提交`);
    const pixels = width * height;
    if ((minPixels && pixels < minPixels) || (maxPixels && pixels > maxPixels)) throw new Error(`${label}像素总量为 ${pixels}（${width}×${height}），需要 ${referenceBound(minPixels, maxPixels)} 像素；请调整这份素材的尺寸或更换原文件，修改生成分辨率不会改变参考素材`);
}

function formatMediaByteLimit(bytes: number) {
    return bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)}MB` : `${bytes} 字节`;
}

export function assertVideoConfig(config: ResolvedAiConfig, selectedModel: string) {
    if (!selectedModel.trim() && !config.model.trim()) throw new Error("请先配置视频模型");
    if (!config.baseUrl.trim()) throw new Error("请先配置 Base URL");
    const channel = resolveModelChannel(config, selectedModel || config.model);
    if (!channelHasGenerationCredential(channel, selectedModel || config.model)) {
        throw new Error(isBuiltinBeefAPIChannel(channel) ? "请先连接 BeefTV" : "请先配置 API Key");
    }
    if (config.apiFormat === "gemini" && config.interfaceType !== "gemini-veo") throw new Error("当前 Gemini 文本协议不支持视频生成，请为该模型选择 Gemini Veo 协议");
}

export function normalizeVideoSeconds(value: string) {
    return normalizeVideoDuration(value);
}

export function normalizeVideoSize(value: string) {
    if (value === "auto") return null;
    const size = (value || "1280x720").trim().toLowerCase().replace("×", "x");
    if (/^\d+x\d+$/.test(size)) return size;
    const ratio = size.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    if (!ratio) return "1280x720";
    const widthRatio = Number(ratio[1]);
    const heightRatio = Number(ratio[2]);
    if (!Number.isFinite(widthRatio) || !Number.isFinite(heightRatio) || widthRatio <= 0 || heightRatio <= 0) return "1280x720";
    const aspect = widthRatio / heightRatio;
    const width = aspect >= 1 ? 1280 : Math.max(256, Math.round((720 * aspect) / 2) * 2);
    const height = aspect >= 1 ? Math.max(256, Math.round((1280 / aspect) / 2) * 2) : 720;
    return `${width}x${height}`;
}

export function normalizeVideoResolution(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    if (value.toLowerCase() === "2k") return "1440p";
    if (value.toLowerCase() === "4k") return "2160p";
    const resolution = value.replace(/p$/i, "") || "720";
    return `${resolution}p`;
}

export function isPublicMediaUrl(value: string) {
    return /^https?:\/\//i.test(value || "");
}
