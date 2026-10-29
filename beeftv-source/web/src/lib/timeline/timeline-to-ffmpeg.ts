// wasm executor lowering: turn a canonical semantic plan into stepwise ffmpeg.wasm
// commands. Selection/order/gaps/mute/gain/fades/subtitles come from the plan;
// this module must not re-decide content from the raw timeline.

import type { TimelineClip, TimelineProject } from "@/types/timeline";
import {
    assertCanonicalPlan,
    type CanonicalAudioClip,
    type CanonicalSegment,
    type CanonicalTimelinePlan,
} from "./timeline-canonical-plan";

export type TimelineRenderSource = {
    nodeId: string;
    /** 已写入 ffmpeg 工作区的文件名（如 input-0.mp4） */
    fileName: string;
    durationMs: number;
    hasAudio?: boolean;
    /** 媒体定位（运行时用）：本地缓存 storageKey 或远程资源地址，至少提供一个 */
    storageKey?: string;
    url?: string;
};

export type TimelineRenderStep = {
    kind: "trim" | "gap" | "concat" | "subtitle" | "burn" | "mix";
    /** 本步骤输出文件名 */
    output: string;
    /** ffmpeg 参数数组（不含可执行文件名与 -y 覆盖参数） */
    args: string[];
    description: string;
    /** 该步骤依赖 libass 与字体；失败必须阻止导出。 */
    requiresLibass?: boolean;
};

export type TimelineRenderContext = {
    width: number;
    height: number;
    fps: number;
    sampleRate: number;
    /** 是否烧录字幕；false 时跳过 burn 步骤 */
    burnSubtitles: boolean;
    /** 最终输出文件名 */
    outputName: string;
    subtitleImages?: string[];
};

export type TimelineRenderRequest = {
    videoClipIds: string[];
    audioClipIds: string[];
    subtitleClipIds: string[];
    durationMs: number;
    burnSubtitles: boolean;
};

export type TimelineRenderPlan = {
    steps: TimelineRenderStep[];
    finalOutput: string;
    /** concat 输入文件列表（trim/gap 输出），运行时据此写 concat.txt */
    concatEntries: string[];
    /** Requested export content. Execution must not succeed after dropping any of these. */
    request: TimelineRenderRequest;
    subtitleSrt?: string;
};

export const SUBTITLE_FILE = "timeline.srt";

export function getExportClips(timeline: TimelineProject): TimelineClip[] {
    return timeline.clips.filter((clip) => {
        const track = timeline.tracks.find((item) => item.id === clip.trackId);
        return track?.visible !== false && !(clip.kind === "audio" && track?.muted);
    });
}

/** Visible video/image/audio clips, including muted audio that the plan still mixes at volume 0. */
export function getVisibleMediaClips(timeline: TimelineProject): TimelineClip[] {
    return timeline.clips.filter((clip) => {
        const track = timeline.tracks.find((item) => item.id === clip.trackId);
        return track?.visible !== false && (clip.kind === "video" || clip.kind === "image" || clip.kind === "audio");
    });
}

export function getOrderedVideoClips(timeline: TimelineProject): TimelineClip[] {
    return getExportClips(timeline)
        .filter((clip) => clip.kind === "video")
        .slice()
        .sort((a, b) => a.startMs - b.startMs || a.trackId.localeCompare(b.trackId));
}

export function getOrderedSubtitleClips(timeline: TimelineProject): TimelineClip[] {
    return getExportClips(timeline)
        .filter((clip) => clip.kind === "subtitle")
        .slice()
        .sort((a, b) => a.startMs - b.startMs || a.trackId.localeCompare(b.trackId));
}

/** 毫秒 → SRT 时间码 hh:mm:ss,mmm */
export function formatSrtTimestamp(ms: number): string {
    const safe = Math.max(0, Math.round(ms));
    const pad = (value: number, length = 2) => String(value).padStart(length, "0");
    const hours = Math.floor(safe / 3_600_000);
    const minutes = Math.floor((safe % 3_600_000) / 60_000);
    const seconds = Math.floor((safe % 60_000) / 1_000);
    const millis = safe % 1_000;
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
}

/** 字幕轨片段 → SRT 文件内容（时间线全局时间，直接用于烧录） */
export function buildSubtitleSrt(clips: TimelineClip[]): string {
    return getOrderedSubtitleClips({ version: 2, tracks: [], clips, durationMs: 0 })
        .filter((clip) => clip.text && clip.durationMs > 0)
        .map((clip, index) => {
            const text = (clip.text || "").replace(/\r?\n/g, " ").trim();
            return [String(index + 1), `${formatSrtTimestamp(clip.startMs)} --> ${formatSrtTimestamp(clip.startMs + clip.durationMs)}`, text].join("\n");
        })
        .join("\n\n");
}

function defaultContext(plan: CanonicalTimelinePlan): TimelineRenderContext {
    return {
        width: plan.output.width,
        height: plan.output.height,
        fps: plan.output.fps,
        sampleRate: plan.output.sampleRate || 44100,
        burnSubtitles: plan.output.burnSubtitles !== false,
        outputName: "export.mp4",
    };
}

function assertPlanOwnedOutput(plan: CanonicalTimelinePlan, context: Partial<TimelineRenderContext>): void {
    const output = defaultContext(plan);
    if (context.width != null && context.width !== output.width) throw new Error("导出尺寸必须与渲染计划一致");
    if (context.height != null && context.height !== output.height) throw new Error("导出尺寸必须与渲染计划一致");
    if (context.fps != null && context.fps !== output.fps) throw new Error("导出帧率必须与渲染计划一致");
    if (context.sampleRate != null && context.sampleRate !== output.sampleRate) throw new Error("导出采样率必须与渲染计划一致");
    if (context.burnSubtitles != null && context.burnSubtitles !== output.burnSubtitles) throw new Error("字幕烧录必须与渲染计划一致");
}

function renderContext(plan: CanonicalTimelinePlan, context: Partial<TimelineRenderContext>): TimelineRenderContext {
    assertPlanOwnedOutput(plan, context);
    const defaults = defaultContext(plan);
    return {
        ...defaults,
        outputName: context.outputName || defaults.outputName,
        subtitleImages: context.subtitleImages,
    };
}

function audioFadeFilter(clip: { fadeInMs?: number; fadeOutMs?: number; durationMs: number }): string {
    const duration = clip.durationMs / 1000;
    const fadeIn = Math.min(duration, Math.max(0, clip.fadeInMs || 0) / 1000);
    const fadeOut = Math.min(duration, Math.max(0, clip.fadeOutMs || 0) / 1000);
    let filter = "";
    if (fadeIn > 0) filter += `,afade=t=in:st=0:d=${fadeIn}`;
    if (fadeOut > 0) filter += `,afade=t=out:st=${duration - fadeOut}:d=${fadeOut}`;
    return filter;
}

function fileForSource(sourceId: string | undefined, files: Map<string, string>): string {
    if (!sourceId || !files.has(sourceId)) throw new Error("找不到素材：" + (sourceId || ""));
    return files.get(sourceId)!;
}

function lowerGap(segment: CanonicalSegment, index: number, cfg: TimelineRenderContext): TimelineRenderStep {
    const durationSec = segment.durationMs / 1000;
    const output = `gap-${index}.mp4`;
    return {
        kind: "gap",
        output,
        args: [
            "-f", "lavfi", "-i", `color=c=black:s=${cfg.width}x${cfg.height}:r=${cfg.fps}:d=${durationSec}`,
            "-f", "lavfi", "-i", `anullsrc=r=${cfg.sampleRate}:cl=stereo`,
            "-t", String(durationSec),
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-shortest", output,
        ],
        description: `补黑场 ${(segment.durationMs / 1000).toFixed(2)}s`,
    };
}

function lowerVisual(segment: CanonicalSegment, index: number, fileName: string, cfg: TimelineRenderContext): TimelineRenderStep {
    const durationSec = segment.durationMs / 1000;
    const output = `trim-${index}.mp4`;
    const volume = segment.volume ?? 1;
    const audioMap = segment.hasAudio && !segment.muted ? "0:a:0" : "1:a:0";
    const anullsrc = `anullsrc=r=${cfg.sampleRate}:cl=stereo`;
    const args = segment.kind === "image"
        ? ["-loop", "1", "-t", String(durationSec), "-i", fileName, "-f", "lavfi", "-i", anullsrc, "-map", "0:v:0", "-map", "1:a:0", "-t", String(durationSec), "-shortest"]
        : ["-i", fileName, "-f", "lavfi", "-i", anullsrc, "-ss", String((segment.sourceStartMs || 0) / 1000), "-t", String(durationSec), "-map", "0:v:0", "-map", audioMap];
    args.push(
        "-vf", `scale=${cfg.width}:${cfg.height}:force_original_aspect_ratio=decrease,pad=${cfg.width}:${cfg.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${cfg.fps},format=yuv420p`,
        "-af", `aresample=${cfg.sampleRate},aformat=channel_layouts=stereo,volume=${volume}${audioFadeFilter(segment)},apad`,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "128k", output,
    );
    return {
        kind: "trim",
        output,
        args,
        description: segment.kind === "image" ? `图片片段 ${index + 1}` : `裁切片段 ${index + 1}`,
    };
}

function lowerMix(plan: CanonicalTimelinePlan, concatOutput: string, files: Map<string, string>, audioClips: CanonicalAudioClip[], cfg: TimelineRenderContext): TimelineRenderStep {
    const durationSec = plan.durationMs / 1000;
    const args = ["-i", concatOutput];
    const filters = ["[0:v]null[v]", "[0:a]apad[base]"];
    audioClips.forEach((clip, index) => {
        args.push("-i", fileForSource(clip.sourceId, files));
        const duration = clip.durationMs / 1000;
        const volume = clip.muted ? 0 : clip.volume ?? 1;
        filters.push(`[${index + 1}:a]atrim=start=${(clip.sourceStartMs || 0) / 1000}:duration=${duration},asetpts=PTS-STARTPTS,aresample=${cfg.sampleRate},aformat=channel_layouts=stereo,volume=${volume}${audioFadeFilter(clip)},adelay=${clip.startMs}:all=1[a${index}]`);
    });
    filters.push(`[base]${audioClips.map((_, index) => `[a${index}]`).join("")}amix=inputs=${audioClips.length + 1}:normalize=0:duration=first[a]`);
    args.push("-filter_complex", filters.join(";"), "-map", "[v]", "-map", "[a]", "-t", String(durationSec), "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "timeline-mixed.mp4");
    return { kind: "mix", output: "timeline-mixed.mp4", args, description: "混合配音与背景音乐" };
}

/**
 * Lower a canonical semantic plan into wasm stepwise commands.
 * Does not inspect the raw timeline; missing source files fail explicitly.
 */
export function lowerCanonicalPlan(plan: CanonicalTimelinePlan, sources: TimelineRenderSource[], context: Partial<TimelineRenderContext> = {}): TimelineRenderPlan {
    assertCanonicalPlan(plan);
    const cfg = renderContext(plan, context);
    const files = new Map(sources.map((item) => [item.nodeId, item.fileName]));
    const steps: TimelineRenderStep[] = [];
    const concatEntries: string[] = [];

    plan.segments.forEach((segment, index) => {
        if (segment.kind === "gap") {
            const step = lowerGap(segment, index, cfg);
            steps.push(step);
            concatEntries.push(step.output);
            return;
        }
        const step = lowerVisual(segment, index, fileForSource(segment.sourceId, files), cfg);
        steps.push(step);
        concatEntries.push(step.output);
    });

    let concatOutput = "timeline-video.mp4";
    if (concatEntries.length) {
        steps.push({
            kind: "concat",
            output: concatOutput,
            args: ["-f", "concat", "-safe", "0", "-i", "concat.txt", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", concatOutput],
            description: "拼接视频轨",
        });
    }

    const audioClips = plan.audio || [];
    if (audioClips.length) {
        const mix = lowerMix(plan, concatOutput, files, audioClips, cfg);
        steps.push(mix);
        concatOutput = mix.output;
    }

    const subtitles = plan.output.burnSubtitles === false ? [] : plan.subtitles || [];
    if (subtitles.length) {
        steps.push({ kind: "subtitle", output: SUBTITLE_FILE, args: [], description: "生成字幕 SRT" });
    }

    const finalOutput = cfg.outputName;
    if (concatEntries.length && steps.some((step) => step.kind === "subtitle") && cfg.subtitleImages) {
        if (cfg.subtitleImages.length !== subtitles.length) throw new Error("字幕图像不完整");
        const args = ["-i", concatOutput];
        const filters: string[] = [];
        subtitles.forEach((clip, index) => {
            args.push("-i", cfg.subtitleImages![index]);
            filters.push(`[${index ? `sub${index - 1}` : "0:v"}][${index + 1}:v]overlay=enable='gte(t,${clip.startMs / 1000})*lt(t,${(clip.startMs + clip.durationMs) / 1000})'[sub${index}]`);
        });
        args.push("-filter_complex", filters.join(";"), "-map", `[sub${subtitles.length - 1}]`, "-map", "0:a", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "copy", finalOutput);
        steps.push({ kind: "burn", output: finalOutput, args, description: "烧录字幕并输出" });
    } else if (concatEntries.length && steps.some((step) => step.kind === "subtitle")) {
        steps.push({
            kind: "burn",
            output: finalOutput,
            args: ["-i", concatOutput, "-vf", `subtitles=${SUBTITLE_FILE}`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "copy", finalOutput],
            description: "烧录字幕并输出",
            requiresLibass: true,
        });
    } else if (concatEntries.length) {
        steps.push({
            kind: "concat",
            output: finalOutput,
            args: ["-i", concatOutput, "-c", "copy", finalOutput],
            description: "输出成片（无字幕）",
        });
    }

    const request: TimelineRenderRequest = {
        videoClipIds: plan.segments.filter((segment) => segment.kind !== "gap").map((segment) => segment.clipId || ""),
        audioClipIds: audioClips.map((clip) => clip.clipId),
        subtitleClipIds: subtitles.map((clip) => clip.clipId),
        durationMs: plan.durationMs,
        burnSubtitles: subtitles.length > 0,
    };
    if (request.videoClipIds.length && !concatEntries.length) throw new Error("导出计划丢失了视频片段，未生成不完整成片");
    if (request.audioClipIds.length && !steps.some((step) => step.kind === "mix")) throw new Error("导出计划丢失了独立音轨，未生成不完整成片");
    if (request.burnSubtitles && !steps.some((step) => step.kind === "burn")) throw new Error("导出计划丢失了字幕烧录，未生成无字幕成片");

    return { steps, finalOutput, concatEntries, request, subtitleSrt: plan.subtitleSrt };
}

/** 供导出对话框/文档展示的人类可读命令预览 */
export function describeRenderPlan(plan: TimelineRenderPlan): string {
    return plan.steps.map((step) => `# ${step.description}\nffmpeg -y ${step.args.join(" ")}`).join("\n\n");
}
