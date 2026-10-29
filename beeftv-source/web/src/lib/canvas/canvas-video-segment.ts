import { getMediaBlob } from "@/services/file-storage";
import { AUDIO_COPY_OUTPUT_NAME, AUDIO_OUTPUT_NAME, assertUsableSegmentOutput, buildCopyAudioArgs, buildExtractAudioArgs, buildRemoveAudioArgs, buildSegmentTrimArgs, buildVideoCropArgs, CROP_OUTPUT_NAME, isFullSourceRange, MUTED_VIDEO_OUTPUT_NAME, SEGMENT_INPUT_NAME, SEGMENT_OUTPUT_NAME, WAV_OUTPUT_NAME } from "./canvas-video-segment-args";
import { withFFmpegLease } from "./canvas-ffmpeg-session";
import { assertVideoAudioProbe } from "./canvas-video-segment-args";

export type VideoSegmentRange = {
    startMs: number;
    endMs: number;
};

export type VideoSegmentSource = {
    url?: string;
    storageKey?: string;
};

export type VideoSegmentProgress = {
    phase: "loading" | "reading" | "encoding";
    progress: number;
};

const INPUT_NAME = SEGMENT_INPUT_NAME;
const OUTPUT_NAME = SEGMENT_OUTPUT_NAME;

function assertValidRange(range: VideoSegmentRange, durationMs?: number) {
    const startMs = Math.max(0, Math.round(range.startMs));
    const endMs = Math.round(range.endMs);
    if (endMs <= startMs) throw new Error("片段结束时间必须晚于开始时间");
    if (durationMs !== undefined && endMs > Math.round(durationMs)) throw new Error("片段结束时间超过视频时长");
}

async function readVideoSourceBlob(source: VideoSegmentSource) {
    if (source.storageKey) {
        const stored = await getMediaBlob(source.storageKey);
        if (stored) return stored;
    }
    if (source.url) {
        const response = await fetch(source.url);
        if (!response.ok) throw new Error(`视频资源请求失败（${response.status}）`);
        return response.blob();
    }
    throw new Error("找不到视频素材，请重新上传后再操作");
}

function leaseProgress(onProgress?: (progress: VideoSegmentProgress) => void) {
    return ({ phase, progress }: { phase: "loading" | "reading" | "encoding"; progress: number }) => {
        onProgress?.({ phase: phase === "loading" ? "loading" : "reading", progress });
    };
}

async function runSegmentJob(
    source: VideoSegmentSource,
    range: VideoSegmentRange,
    durationMs: number | undefined,
    buildArgs: (startSec: string, durationSec: string, inputName: string, outputName: string) => string[],
    onProgress?: (progress: VideoSegmentProgress) => void,
    outputType = "video/mp4",
    outputName = OUTPUT_NAME,
) {
    assertValidRange(range, durationMs);
    return withFFmpegLease(async ({ ffmpeg, filePrefix }) => {
        const { fetchFile } = await import("@ffmpeg/util");
        const inputName = `${filePrefix}${INPUT_NAME}`;
        const resolvedOutput = `${filePrefix}${outputName}`;
        const blob = await readVideoSourceBlob(source);
        onProgress?.({ phase: "reading", progress: 45 });
        await ffmpeg.writeFile(inputName, await fetchFile(blob));
        const startSec = String(range.startMs / 1000);
        const durationSec = String((range.endMs - range.startMs) / 1000);
        onProgress?.({ phase: "encoding", progress: 55 });
        try {
            const exitCode = await ffmpeg.exec(["-y", ...buildArgs(startSec, durationSec, inputName, resolvedOutput)]);
            if (exitCode !== 0) throw new Error("媒体处理失败，请确认视频编码格式兼容");
            const output = await ffmpeg.readFile(resolvedOutput);
            assertUsableSegmentOutput(output, outputType.startsWith("audio/") ? "audio" : "video");
            onProgress?.({ phase: "encoding", progress: 100 });
            return new Blob([output as BlobPart], { type: outputType });
        } finally {
            await Promise.all([inputName, `${filePrefix}${OUTPUT_NAME}`, resolvedOutput].map((file) => ffmpeg.deleteFile(file).catch(() => undefined)));
        }
    }, { onProgress: leaseProgress(onProgress) });
}

/** 按片段范围截取视频，输出统一编码 MP4（复用时间线 trim 的参数模板）。 */
export async function trimVideoSegment(source: VideoSegmentSource, range: VideoSegmentRange, durationMs?: number, onProgress?: (progress: VideoSegmentProgress) => void) {
    return runSegmentJob(source, range, durationMs, (startSec, durationSec, inputName, outputName) => buildSegmentTrimArgs(startSec, durationSec, inputName, outputName), onProgress, "video/mp4");
}

/** 从视频中移除音轨，保留画面并输出独立无声视频。 */
export async function removeAudioFromVideo(source: VideoSegmentSource, range: VideoSegmentRange, durationMs?: number, onProgress?: (progress: VideoSegmentProgress) => void) {
    const fullSource = isFullSourceRange(range.startMs, range.endMs, durationMs);
    return runSegmentJob(source, range, durationMs, (startSec, durationSec, inputName, outputName) => buildRemoveAudioArgs(startSec, durationSec, outputName, { fullSource, inputName }), onProgress, "video/mp4", MUTED_VIDEO_OUTPUT_NAME);
}

/** 从视频片段提取声音；优先 MP3，精简 FFmpeg 内核不支持 MP3 时自动回退 WAV。 */
export async function extractVideoAudio(source: VideoSegmentSource, range: VideoSegmentRange, durationMs?: number, onProgress?: (progress: VideoSegmentProgress) => void) {
    assertValidRange(range, durationMs);
    return withFFmpegLease(async ({ ffmpeg, filePrefix }) => {
        const { fetchFile } = await import("@ffmpeg/util");
        const inputName = `${filePrefix}${INPUT_NAME}`;
        const audioName = `${filePrefix}${AUDIO_OUTPUT_NAME}`;
        const wavName = `${filePrefix}${WAV_OUTPUT_NAME}`;
        const audioCopyName = `${filePrefix}${AUDIO_COPY_OUTPUT_NAME}`;
        const probeName = `${filePrefix}audio-probe.json`;
        const blob = await readVideoSourceBlob(source);
        onProgress?.({ phase: "reading", progress: 45 });
        await ffmpeg.writeFile(inputName, await fetchFile(blob));
        const startSec = String(range.startMs / 1000);
        const durationSec = String((range.endMs - range.startMs) / 1000);
        onProgress?.({ phase: "encoding", progress: 55 });
        try {
            const probeCode = await ffmpeg.ffprobe(["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=index:format=duration", "-of", "json", inputName, "-o", probeName]);
            // The bundled ffprobe writes valid JSON while leaving ret at -1.
            // Validate its output and duration; do not mistake that sentinel for an encoder failure.
            if (probeCode !== 0 && probeCode !== -1) throw new Error("无法读取视频音轨信息，请检查素材是否完整");
            const probe = await ffmpeg.readFile(probeName);
            assertVideoAudioProbe(typeof probe === "string" ? probe : new TextDecoder().decode(probe));
            const args = (audioCodec: string, outputName = audioName) => buildExtractAudioArgs(audioCodec, startSec, durationSec, outputName, inputName);
            let outputName = audioName;
            let outputType = "audio/mpeg";
            // 大多数 MP4 音轨本身就是 AAC；优先直接复制，避免无谓的整段重编码。
            let exitCode = await ffmpeg.exec(["-y", ...buildCopyAudioArgs(startSec, durationSec, audioCopyName, inputName)]);
            if (exitCode === 0) {
                outputName = audioCopyName;
                outputType = "audio/mp4";
            }
            if (exitCode !== 0) exitCode = await ffmpeg.exec(["-y", ...args("libmp3lame")]);
            if (exitCode !== 0) exitCode = await ffmpeg.exec(["-y", ...args("mp3")]);
            if (exitCode !== 0) {
                // 若内核缺少音频编码器，直接复制源音轨到 M4A，避免重编码依赖。
                outputName = audioCopyName;
                outputType = "audio/mp4";
                exitCode = await ffmpeg.exec(["-y", ...buildCopyAudioArgs(startSec, durationSec, outputName, inputName)]);
            }
            if (exitCode !== 0) {
                // The bundled core may omit both MP3 encoders. PCM/WAV is broadly
                // available and remains a valid audio node payload, so preserve
                // the extraction workflow instead of failing after the dialog.
                outputName = wavName;
                outputType = "audio/wav";
                exitCode = await ffmpeg.exec(["-y", ...args("pcm_s16le", outputName)]);
            }
            if (exitCode !== 0) throw new Error("音频提取失败：当前 FFmpeg 内核不支持可用的音频编码");
            const output = await ffmpeg.readFile(outputName);
            assertUsableSegmentOutput(output, "audio");
            onProgress?.({ phase: "encoding", progress: 100 });
            return new Blob([output as BlobPart], { type: outputType });
        } finally {
            await Promise.all([inputName, `${filePrefix}${OUTPUT_NAME}`, audioName, wavName, audioCopyName, probeName].map((file) => ffmpeg.deleteFile(file).catch(() => undefined)));
        }
    }, { onProgress: leaseProgress(onProgress) });
}

export type VideoCropRect = { x: number; y: number; width: number; height: number };

/** 按源视频像素裁切画面，保留原音轨并输出新视频。 */
export async function cropVideo(source: VideoSegmentSource, crop: VideoCropRect, onProgress?: (progress: VideoSegmentProgress) => void) {
    return withFFmpegLease(async ({ ffmpeg, filePrefix }) => {
        const { fetchFile } = await import("@ffmpeg/util");
        const inputName = `${filePrefix}${INPUT_NAME}`;
        const cropName = `${filePrefix}${CROP_OUTPUT_NAME}`;
        const blob = await readVideoSourceBlob(source);
        onProgress?.({ phase: "reading", progress: 45 });
        await ffmpeg.writeFile(inputName, await fetchFile(blob));
        onProgress?.({ phase: "encoding", progress: 55 });
        try {
            const exitCode = await ffmpeg.exec(["-y", ...buildVideoCropArgs(crop.x, crop.y, crop.width, crop.height, inputName, cropName)]);
            if (exitCode !== 0) throw new Error("视频画面裁切失败，请确认视频编码格式兼容");
            const output = await ffmpeg.readFile(cropName);
            assertUsableSegmentOutput(output, "video");
            onProgress?.({ phase: "encoding", progress: 100 });
            return new Blob([output as BlobPart], { type: "video/mp4" });
        } finally {
            await Promise.all([inputName, cropName].map((file) => ffmpeg.deleteFile(file).catch(() => undefined)));
        }
    }, { onProgress: leaseProgress(onProgress) });
}
