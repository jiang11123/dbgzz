// Browser wasm export: compile via the local planning API, then lower the
// returned canonical plan. This module must not re-select content from the
// raw timeline if the endpoint fails.
import { compileTimelineRenderPlan } from "@/services/api/timeline-tasks";
import { getMediaBlob } from "@/services/file-storage";
import { applySourceFacts, canonicalSourceIds, type CanonicalSourceFacts, type CanonicalSourceMeta } from "./timeline-canonical-plan";
import { rasterizeTimelineSubtitle } from "./timeline-subtitle-image";
import type { TimelineProject } from "@/types/timeline";
import { lowerCanonicalPlan, type TimelineRenderContext, type TimelineRenderSource } from "./timeline-to-ffmpeg";
import { cleanupRenderFiles, executeTimelineRenderPlan, type TimelineRenderEngine } from "./timeline-render-service";

export type TimelineExportProgress = {
    phase: "loading" | "reading" | "encoding";
    percent: number;
    detail: string;
};

export type TimelineExportOptions = {
    onProgress?: (progress: TimelineExportProgress) => void;
    context?: Partial<TimelineRenderContext>;
    signal?: AbortSignal;
};

async function fetchSourceBlob(source: TimelineRenderSource, signal?: AbortSignal): Promise<Blob> {
    if (source.storageKey) {
        const stored = await getMediaBlob(source.storageKey);
        if (stored) return stored;
    }
    if (source.url) {
        const response = await fetch(source.url, { signal });
        if (!response.ok) throw new Error("视频资源请求失败（" + response.status + "）");
        return response.blob();
    }
    throw new Error("找不到素材 " + source.nodeId + " 的媒体文件");
}

function createWasmEngine(ffmpeg: import("@ffmpeg/ffmpeg").FFmpeg): TimelineRenderEngine {
    let logBuffer = "";
    ffmpeg.on("log", ({ message }) => {
        logBuffer += message + "\n";
    });
    return {
        async writeFile(name, data) {
            await ffmpeg.writeFile(name, typeof data === "string" ? new TextEncoder().encode(data) : data);
        },
        async readFile(name) {
            return await ffmpeg.readFile(name);
        },
        async deleteFile(name) {
            await ffmpeg.deleteFile(name);
        },
        async exec(args) {
            const exitCode = await ffmpeg.exec(["-y", ...args]);
            const log = logBuffer;
            logBuffer = "";
            return { exitCode, log };
        },
    };
}

function toCompileSources(sources: TimelineRenderSource[]): CanonicalSourceMeta[] {
    return sources.map((source) => ({
        id: source.nodeId,
        hasAudio: source.hasAudio,
        durationMs: source.durationMs,
    }));
}

/** 导出时间线为 MP4：取语义计划 → 写媒体 → 按计划逐步执行 → 返回 Blob（下载由调用方处理） */
export async function exportTimelineToMp4(timeline: TimelineProject, sources: TimelineRenderSource[], options: TimelineExportOptions = {}): Promise<Blob> {
    const { onProgress, context, signal } = options;
    signal?.throwIfAborted();
    onProgress?.({ phase: "loading", percent: 0, detail: "生成渲染计划" });
    const canonical = await compileTimelineRenderPlan({
        timeline,
        sources: toCompileSources(sources),
        options: {
            width: context?.width,
            height: context?.height,
            fps: context?.fps,
            sampleRate: context?.sampleRate,
            burnSubtitles: context?.burnSubtitles,
        },
    }, signal);
    signal?.throwIfAborted();
    const sourceById = new Map(sources.map((item) => [item.nodeId, item]));
    for (const sourceId of canonicalSourceIds(canonical)) {
        if (!sourceById.has(sourceId)) throw new Error("找不到素材：" + sourceId);
    }
    if (!__BEEFTV_HEAVY_MEDIA_ENABLED__) throw new Error("精简版未包含 FFmpeg 本地媒体工具，请安装完整媒体包");
    onProgress?.({ phase: "loading", percent: 0, detail: "加载 FFmpeg" });
    const [{ FFmpeg }, { default: coreURL }, { default: wasmURL }, { fetchFile }] = await Promise.all([import("@ffmpeg/ffmpeg"), import("@ffmpeg/core?url"), import("@ffmpeg/core/wasm?url"), import("@ffmpeg/util")]);
    signal?.throwIfAborted();
    // Each export owns its worker: cancellation cannot interrupt video merge or another dialog.
    const ffmpeg = new FFmpeg();
    const abort = () => ffmpeg.terminate();
    signal?.addEventListener("abort", abort, { once: true });
    const writtenFiles = new Set<string>();
    const preparedSources: TimelineRenderSource[] = [];
    const facts: Record<string, CanonicalSourceFacts> = {};
    const engine = createWasmEngine(ffmpeg);
    const width = canonical.output.width;
    const height = canonical.output.height;

    try {
        await ffmpeg.load({ coreURL, wasmURL });
        for (const sourceId of canonicalSourceIds(canonical)) {
            const source = sourceById.get(sourceId)!;
            signal?.throwIfAborted();
            onProgress?.({ phase: "reading", percent: 5, detail: "读取素材 " + source.fileName });
            const blob = await fetchSourceBlob(source, signal);
            signal?.throwIfAborted();
            writtenFiles.add(source.fileName);
            await ffmpeg.writeFile(source.fileName, await fetchFile(blob));
            writtenFiles.add("probe.json");
            await ffmpeg.writeFile("probe.json", new Uint8Array());
            const probeCode = await ffmpeg.ffprobe(["-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", source.fileName, "-o", "probe.json"]);
            // Shipped core 0.12.10 returns -1 after a successful ffprobe write. Require fresh valid metadata below.
            if (probeCode !== 0 && probeCode !== -1) throw new Error("无法解析素材：" + source.nodeId);
            const probe = JSON.parse(await ffmpeg.readFile("probe.json", "utf8") as string) as { streams?: { codec_type: string }[]; format?: { duration?: string } };
            const hasAudio = probe.streams?.some((stream) => stream.codec_type === "audio") ?? false;
            const hasVideo = probe.streams?.some((stream) => stream.codec_type === "video") ?? false;
            const durationMs = Number(probe.format?.duration) * 1000;
            facts[source.nodeId] = { hasAudio, hasVideo, durationMs: Number.isFinite(durationMs) ? durationMs : 0 };
            preparedSources.push({ ...source, hasAudio });
        }
        applySourceFacts(canonical, facts);

        const subtitleImages: string[] = [];
        if (canonical.output.burnSubtitles !== false) {
            for (const clip of canonical.subtitles || []) {
                signal?.throwIfAborted();
                const name = `subtitle-${subtitleImages.length}.png`;
                const bytes = await rasterizeTimelineSubtitle(clip.text, width, height);
                signal?.throwIfAborted();
                writtenFiles.add(name);
                await ffmpeg.writeFile(name, bytes);
                subtitleImages.push(name);
            }
        }
        const plan = lowerCanonicalPlan(canonical, preparedSources, { outputName: context?.outputName, subtitleImages });
        onProgress?.({ phase: "encoding", percent: 10, detail: "开始编码" });
        const execution = await executeTimelineRenderPlan({
            plan,
            engine,
            signal,
            writtenFiles,
            onProgress: (progress) => onProgress?.({ phase: "encoding", percent: progress.percent, detail: progress.detail }),
        });
        signal?.throwIfAborted();
        onProgress?.({ phase: "encoding", percent: 100, detail: "导出完成" });
        return new Blob([execution.output as BlobPart], { type: "video/mp4" });
    } catch (error) {
        signal?.throwIfAborted();
        throw error;
    } finally {
        signal?.removeEventListener("abort", abort);
        if (!signal?.aborted) await cleanupRenderFiles(engine, [...writtenFiles, "concat.txt"]);
        ffmpeg.terminate();
    }
}
