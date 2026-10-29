// 视频片段处理（裁切/提音轨）的 ffmpeg 参数构造，纯函数便于单测。
// 精确裁切：-ss 放在 -i 之后并重编码。输入 seek + stream copy 只会落到关键帧，
// 任意部分区间不能靠 -c:v copy 保证切点。
// 整段去音：不要带 -ss/-t 的输出 seek copy。MP4 在 ss=0 时仍可能写出无 mdat 的空文件。
// 用 -map 0:V:0 跳过 attached pic。

export const SEGMENT_INPUT_NAME = "segment-input.mp4";
export const SEGMENT_OUTPUT_NAME = "segment-output.mp4";
export const AUDIO_OUTPUT_NAME = "segment-output.mp3";
export const WAV_OUTPUT_NAME = "segment-output.wav";
export const AUDIO_COPY_OUTPUT_NAME = "segment-output.m4a";
export const MUTED_VIDEO_OUTPUT_NAME = "segment-muted-output.mp4";
export const CROP_OUTPUT_NAME = "segment-crop-output.mp4";

/** 视频片段裁切参数：输出统一编码 MP4。 */
export function buildSegmentTrimArgs(startSec: string, durationSec: string, inputName = SEGMENT_INPUT_NAME, outputName = SEGMENT_OUTPUT_NAME): string[] {
    return ["-i", inputName, "-ss", startSec, "-t", durationSec, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-movflags", "+faststart", outputName];
}

/** 从视频片段提取声音：同样使用输出 seek，保证起点与裁切路径一致。 */
export function buildExtractAudioArgs(audioCodec: string, startSec: string, durationSec: string, outputName = SEGMENT_OUTPUT_NAME, inputName = SEGMENT_INPUT_NAME): string[] {
    return ["-i", inputName, "-ss", startSec, "-t", durationSec, "-vn", "-c:a", audioCodec, "-q:a", "2", outputName];
}

/** 直接复制原音轨，绕过精简内核缺少 MP3/AAC 编码器的问题。 */
export function buildCopyAudioArgs(startSec: string, durationSec: string, outputName = AUDIO_COPY_OUTPUT_NAME, inputName = SEGMENT_INPUT_NAME): string[] {
    return ["-i", inputName, "-ss", startSec, "-t", durationSec, "-map", "0:a:0?", "-vn", "-c:a", "copy", "-movflags", "+faststart", outputName];
}

export function isFullSourceRange(startMs: number, endMs: number, durationMs?: number) {
    if (startMs > 0) return false;
    if (durationMs === undefined || !(durationMs > 0)) return false;
    return endMs >= durationMs - 1;
}

function asBytes(output: Uint8Array | string) {
    return typeof output === "string" ? new TextEncoder().encode(output) : output;
}

export function assertUsableSegmentOutput(output: Uint8Array | string, kind: "video" | "audio") {
    const bytes = asBytes(output);
    if (kind === "audio") {
        if (hasIsoBmffTrack(bytes, "soun") || isWaveAudio(bytes) || isMpegAudio(bytes)) return;
        throw new Error("音频提取失败：输出没有可用的音轨");
    }
    if (!hasIsoBmffTrack(bytes, "vide")) {
        throw new Error("无声视频生成失败：输出没有可用的视频轨道");
    }
}

/** 去掉原视频音轨。整段可复制画面；部分区间必须重编码，不能 stream copy。 */
export function buildRemoveAudioArgs(startSec: string, durationSec: string, outputName = MUTED_VIDEO_OUTPUT_NAME, options?: { fullSource?: boolean; inputName?: string }): string[] {
    const inputName = options?.inputName ?? SEGMENT_INPUT_NAME;
    if (options?.fullSource) {
        return ["-i", inputName, "-map", "0:V:0", "-an", "-c:v", "copy", "-movflags", "+faststart", outputName];
    }
    return ["-i", inputName, "-ss", startSec, "-t", durationSec, "-map", "0:V:0", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-movflags", "+faststart", outputName];
}

/** 空间裁切视频，坐标和尺寸使用源视频像素值。 */
export function buildVideoCropArgs(x: number, y: number, width: number, height: number, inputName = SEGMENT_INPUT_NAME, outputName = CROP_OUTPUT_NAME): string[] {
    return ["-i", inputName, "-vf", `crop=${Math.round(width)}:${Math.round(height)}:${Math.round(x)}:${Math.round(y)}`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-movflags", "+faststart", outputName];
}

// 可用性看容器结构：ftyp、mdat 载荷、trak 内 vide/soun 且 sample_count>0。
// 短片可以小于 4KiB；空壳仍带 ftyp/mdat 四字符，不能靠子串扫描。

const ISO_NEST = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "mvex", "moof", "traf"]);
const MAX_ISO_BOXES = 8192;
const MAX_ISO_DEPTH = 16;

type IsoTrack = { handler: string; samples: number };

function u32(bytes: Uint8Array, offset: number) {
    if (offset + 4 > bytes.byteLength) return 0;
    return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
}

function ascii4(bytes: Uint8Array, offset: number) {
    if (offset + 4 > bytes.byteLength) return "";
    return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

function readIsoBox(bytes: Uint8Array, offset: number, end: number) {
    if (offset + 8 > end) return undefined;
    let size = u32(bytes, offset);
    const type = ascii4(bytes, offset + 4);
    let header = 8;
    if (size === 1) {
        if (offset + 16 > end) return undefined;
        const high = u32(bytes, offset + 8);
        const low = u32(bytes, offset + 12);
        if (high > 0x1fffff) return undefined;
        size = high * 0x100000000 + low;
        header = 16;
    } else if (size === 0) {
        size = end - offset;
    }
    if (size < header || offset + size > end) return undefined;
    return { type, size, start: offset, payloadStart: offset + header, payloadEnd: offset + size };
}

function inspectIsoBmff(bytes: Uint8Array) {
    let hasFtyp = false;
    let mdatPayload = 0;
    let boxes = 0;
    const tracks: IsoTrack[] = [];

    const walk = (start: number, end: number, depth: number, track: IsoTrack | null) => {
        let offset = start;
        while (offset + 8 <= end && boxes < MAX_ISO_BOXES && depth <= MAX_ISO_DEPTH) {
            const box = readIsoBox(bytes, offset, end);
            if (!box) break;
            boxes += 1;
            if (box.type === "ftyp") hasFtyp = true;
            else if (box.type === "mdat") mdatPayload += box.payloadEnd - box.payloadStart;
            else if (box.type === "trak") {
                const next: IsoTrack = { handler: "", samples: 0 };
                tracks.push(next);
                walk(box.payloadStart, box.payloadEnd, depth + 1, next);
            } else if (box.type === "hdlr" && track && box.payloadEnd - box.payloadStart >= 12) {
                track.handler = ascii4(bytes, box.payloadStart + 8);
            } else if (box.type === "stsz" && track && box.payloadEnd - box.payloadStart >= 12) {
                track.samples = Math.max(track.samples, u32(bytes, box.payloadStart + 8));
            } else if (box.type === "stts" && track && box.payloadEnd - box.payloadStart >= 8) {
                const entryCount = u32(bytes, box.payloadStart + 4);
                let samples = 0;
                let cursor = box.payloadStart + 8;
                for (let index = 0; index < entryCount && cursor + 8 <= box.payloadEnd; index += 1, cursor += 8) {
                    samples += u32(bytes, cursor);
                }
                track.samples = Math.max(track.samples, samples);
            } else if (ISO_NEST.has(box.type)) {
                walk(box.payloadStart, box.payloadEnd, depth + 1, track);
            }
            offset = box.start + box.size;
        }
    };

    walk(0, bytes.byteLength, 0, null);
    return { hasFtyp, mdatPayload, tracks };
}

function hasIsoBmffTrack(bytes: Uint8Array, handler: "vide" | "soun") {
    const first = readIsoBox(bytes, 0, bytes.byteLength);
    if (!first || first.type !== "ftyp") return false;
    const info = inspectIsoBmff(bytes);
    return info.hasFtyp && info.mdatPayload > 0 && info.tracks.some((track) => track.handler === handler && track.samples > 0);
}

function isWaveAudio(bytes: Uint8Array) {
    return bytes.byteLength >= 12 && ascii4(bytes, 0) === "RIFF" && ascii4(bytes, 8) === "WAVE";
}

function isMpegAudio(bytes: Uint8Array) {
    if (bytes.byteLength >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true;
    return bytes.byteLength >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0;
}

export function assertVideoAudioProbe(raw: string) {
    let payload: { streams?: Array<{ index?: number }>; format?: { duration?: string } };
    try { payload = JSON.parse(raw); } catch { throw new Error("无法读取视频音轨信息，请检查素材是否完整"); }
    const duration = Number(payload?.format?.duration);
    if (!Number.isFinite(duration) || duration <= 0 || !Array.isArray(payload?.streams) || payload.streams.some((stream) => !Number.isInteger(stream?.index))) {
        throw new Error("无法读取视频音轨信息，请检查素材是否完整");
    }
    if (!payload.streams.length) throw new Error("原视频没有音轨，无法分离音频。画面中的人物或动作不代表文件包含声音；请换用带声音的视频。");
}
