import { getMediaBlob } from "@/services/file-storage";
import { assertUsableSegmentOutput } from "./canvas-video-segment-args";
import { prewarmFFmpeg, withFFmpegLease, type CanvasFFmpegProgress } from "./canvas-ffmpeg-session";

export type MergeVideoInput = { id: string; url?: string; storageKey?: string };
export type MergeVideoProgress = CanvasFFmpegProgress | { phase: "saving" | "binding" | "done"; progress: number };

// ffmpeg 只在用户明确合并视频时加载，避免把 wasm 和 worker 放进画布首屏包体。
export async function loadFFmpeg(onProgress?: (progress: MergeVideoProgress) => void) {
    if (typeof __BEEFTV_HEAVY_MEDIA_ENABLED__ !== "undefined" && !__BEEFTV_HEAVY_MEDIA_ENABLED__) {
        throw new Error("精简版未包含 FFmpeg 本地媒体工具；请安装完整媒体包或使用模型生成与原素材编排");
    }
    return prewarmFFmpeg(onProgress);
}

/**
 * Start the shared browser worker before a user confirms a media operation.
 * The promise and worker are identical to `loadFFmpeg`, so this only moves
 * first-use initialization out of the blocking submit path.
 */
export function warmFFmpeg() {
    return loadFFmpeg();
}

export async function mergeVideos(inputs: MergeVideoInput[], onProgress?: (progress: MergeVideoProgress) => void, signal?: AbortSignal) {
    if (inputs.length < 2) throw new Error("至少选择 2 个视频才能合并");
    signal?.throwIfAborted();
    return withFFmpegLease(async ({ ffmpeg, filePrefix }) => {
        const { fetchFile } = await import("@ffmpeg/util");
        const files: string[] = [];
        const concatName = `${filePrefix}concat.txt`;
        const mergedName = `${filePrefix}merged.mp4`;
        try {
            for (let index = 0; index < inputs.length; index += 1) {
                signal?.throwIfAborted();
                const input = inputs[index];
                const storedBlob = input.storageKey ? await getMediaBlob(input.storageKey) : null;
                const remoteBlob = !storedBlob && input.url ? await fetch(input.url, { signal }).then((response) => {
                    if (!response.ok) throw new Error(`视频资源请求失败（${response.status}）`);
                    return response.blob();
                }) : null;
                const blob = storedBlob || remoteBlob;
                if (!blob) throw new Error(`无法读取第 ${index + 1} 个视频`);
                const name = `${filePrefix}input-${index}.mp4`;
                await ffmpeg.writeFile(name, await fetchFile(blob));
                files.push(name);
                onProgress?.({ phase: "reading", progress: Math.round(((index + 1) / inputs.length) * 45) });
            }
            const concatList = files.map((file) => `file '${file}'`).join("\n");
            await ffmpeg.writeFile(concatName, concatList);
            onProgress?.({ phase: "encoding", progress: 55 });
            // 先尝试无损拼接；不同模型输出的编码参数不一致时再回退到统一转码。
            let exitCode = await ffmpeg.exec(["-f", "concat", "-safe", "0", "-i", concatName, "-c", "copy", mergedName]);
            if (exitCode !== 0) {
                exitCode = await ffmpeg.exec(["-f", "concat", "-safe", "0", "-i", concatName, "-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart", mergedName]);
            }
            if (exitCode !== 0) throw new Error("视频编码失败，请确认视频编码格式兼容");
            signal?.throwIfAborted();
            const output = await ffmpeg.readFile(mergedName);
            assertUsableSegmentOutput(output, "video");
            onProgress?.({ phase: "encoding", progress: 100 });
            return new Blob([output as BlobPart], { type: "video/mp4" });
        } catch (error) {
            signal?.throwIfAborted();
            throw error;
        } finally {
            if (!signal?.aborted) await Promise.all([...files, concatName, mergedName].map((file) => ffmpeg.deleteFile(file).catch(() => undefined)));
        }
    }, { signal, onProgress });
}
