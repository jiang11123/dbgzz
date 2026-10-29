import { describe, expect, test } from "bun:test";

import { assertUsableSegmentOutput, buildCopyAudioArgs, buildExtractAudioArgs, buildRemoveAudioArgs, buildSegmentTrimArgs, isFullSourceRange, AUDIO_COPY_OUTPUT_NAME, MUTED_VIDEO_OUTPUT_NAME, SEGMENT_INPUT_NAME, SEGMENT_OUTPUT_NAME } from "../src/lib/canvas/canvas-video-segment-args";

describe("buildSegmentTrimArgs seek 顺序", () => {
    test("-ss 必须放在 -i 之后（输出 seek）：输入 seek 按关键帧对齐，切点会偏移最多一个 GOP", () => {
        const args = buildSegmentTrimArgs("10.5", "4");
        expect(args.indexOf("-ss")).toBeGreaterThan(args.indexOf("-i"));
        expect(args).toEqual(["-i", SEGMENT_INPUT_NAME, "-ss", "10.5", "-t", "4", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-movflags", "+faststart", SEGMENT_OUTPUT_NAME]);
    });
});

describe("buildExtractAudioArgs seek 顺序", () => {
    test("音频提取与裁切路径一致，同样使用输出 seek", () => {
        const args = buildExtractAudioArgs("libmp3lame", "10.5", "4");
        expect(args.indexOf("-ss")).toBeGreaterThan(args.indexOf("-i"));
        expect(args).toEqual(["-i", SEGMENT_INPUT_NAME, "-ss", "10.5", "-t", "4", "-vn", "-c:a", "libmp3lame", "-q:a", "2", SEGMENT_OUTPUT_NAME]);
    });
});

describe("buildCopyAudioArgs", () => {
    test("复制源音轨并显式映射第一条音频流", () => {
        expect(buildCopyAudioArgs("0", "5")).toEqual([
            "-i", SEGMENT_INPUT_NAME, "-ss", "0", "-t", "5", "-map", "0:a:0?", "-vn", "-c:a", "copy", "-movflags", "+faststart", AUDIO_COPY_OUTPUT_NAME,
        ]);
    });
});

describe("isFullSourceRange", () => {
    test("起点为 0 且覆盖片长时视为整段", () => {
        expect(isFullSourceRange(0, 6041, 6041)).toBe(true);
        expect(isFullSourceRange(0, 6041, 6042)).toBe(true);
        expect(isFullSourceRange(0, 3000, 6041)).toBe(false);
        expect(isFullSourceRange(120, 6041, 6041)).toBe(false);
        expect(isFullSourceRange(0, 6041)).toBe(false);
    });
});

describe("buildRemoveAudioArgs", () => {
    test("整段去音：不 seek，复制主视频流并跳过封面图", () => {
        expect(buildRemoveAudioArgs("0", "6.04", MUTED_VIDEO_OUTPUT_NAME, { fullSource: true })).toEqual([
            "-i", SEGMENT_INPUT_NAME, "-map", "0:V:0", "-an", "-c:v", "copy", "-movflags", "+faststart", MUTED_VIDEO_OUTPUT_NAME,
        ]);
        expect(buildRemoveAudioArgs("0", "6.04", MUTED_VIDEO_OUTPUT_NAME, { fullSource: true }).includes("-ss")).toBe(false);
    });

    test("部分区间去音：输出 seek 并重编码，不使用 stream copy", () => {
        const args = buildRemoveAudioArgs("1", "1.5");
        expect(args.indexOf("-ss")).toBeGreaterThan(args.indexOf("-i"));
        expect(args).toEqual([
            "-i", SEGMENT_INPUT_NAME, "-ss", "1", "-t", "1.5", "-map", "0:V:0", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-movflags", "+faststart", MUTED_VIDEO_OUTPUT_NAME,
        ]);
        expect(args.includes("copy")).toBe(false);
    });
});

describe("assertUsableSegmentOutput", () => {
    test("accepts a structured tiny MP4 with a video sample and mdat payload", () => {
        const tiny = isoBmff({
            handler: "vide",
            samples: 1,
            mdatPayload: 48,
        });
        expect(tiny.byteLength).toBeLessThan(4096);
        expect(() => assertUsableSegmentOutput(tiny, "video")).not.toThrow();
    });

    test("rejects the empty ffmpeg copy shell that still contains ftyp and mdat", () => {
        // Real output-seek+copy artifact: ftyp + empty mdat + moov without trak.
        const emptyShell = Uint8Array.from(Buffer.from("AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAAAhtZGF0AAAA1W1vb3YAAABsbXZoZAAAAAAAAAAAAAAAAAAAMAAAAAAAAAEAAAEAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAABhdWR0YQAAAFltZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAACxpbHN0AAAAJKl0b28AAAAcZGF0YQAAAAEAAAAATGF2ZjYzLjEuMTAy", "base64"));
        expect(emptyShell.byteLength).toBe(261);
        expect(Buffer.from(emptyShell).includes("ftyp")).toBe(true);
        expect(Buffer.from(emptyShell).includes("mdat")).toBe(true);
        expect(() => assertUsableSegmentOutput(emptyShell, "video")).toThrow(/没有可用的视频轨道/);
    });

    test("rejects junk that only contains ftyp/mdat as substrings", () => {
        const junk = new TextEncoder().encode(`padding ftyp isom mdat ${"x".repeat(5000)}`);
        expect(junk.byteLength).toBeGreaterThan(4096);
        expect(() => assertUsableSegmentOutput(junk, "video")).toThrow(/没有可用的视频轨道/);
    });

    test("rejects ftyp+mdat without a video sample table", () => {
        expect(() => assertUsableSegmentOutput(isoBmff({ handler: "vide", samples: 0, mdatPayload: 64 }), "video")).toThrow(/没有可用的视频轨道/);
        expect(() => assertUsableSegmentOutput(isoBmff({ handler: "vide", samples: 1, mdatPayload: 0 }), "video")).toThrow(/没有可用的视频轨道/);
        expect(() => assertUsableSegmentOutput(isoBmff({ handler: "soun", samples: 1, mdatPayload: 64 }), "video")).toThrow(/没有可用的视频轨道/);
    });

    test("audio accepts a soun track or a WAVE/MPEG header, not an empty buffer", () => {
        expect(() => assertUsableSegmentOutput(isoBmff({ handler: "soun", samples: 1, mdatPayload: 32 }), "audio")).not.toThrow();
        expect(() => assertUsableSegmentOutput(waveHeader(), "audio")).not.toThrow();
        expect(() => assertUsableSegmentOutput(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), "audio")).not.toThrow();
        expect(() => assertUsableSegmentOutput(new Uint8Array(128), "audio")).toThrow(/没有可用的音轨/);
        expect(() => assertUsableSegmentOutput(isoBmff({ handler: "vide", samples: 1, mdatPayload: 32 }), "audio")).toThrow(/没有可用的音轨/);
    });
});

function isoBmff(options: { handler: "vide" | "soun"; samples: number; mdatPayload: number }) {
    const hdlr = new Uint8Array(24);
    writeAscii(hdlr, 8, options.handler);
    const stsz = new Uint8Array(12);
    new DataView(stsz.buffer).setUint32(8, options.samples);
    const stts = new Uint8Array(16);
    new DataView(stts.buffer).setUint32(4, 1);
    new DataView(stts.buffer).setUint32(8, options.samples);
    const mdat = new Uint8Array(options.mdatPayload);
    return concat([
        box("ftyp", new TextEncoder().encode("isom")),
        box("mdat", mdat),
        box("moov", box("trak", box("mdia", concat([
            box("hdlr", hdlr),
            box("minf", box("stbl", concat([box("stsz", stsz), box("stts", stts)]))),
        ])))),
    ]);
}

function waveHeader() {
    const bytes = new Uint8Array(44);
    writeAscii(bytes, 0, "RIFF");
    writeAscii(bytes, 8, "WAVE");
    writeAscii(bytes, 12, "fmt ");
    return bytes;
}

function box(type: string, payload: Uint8Array) {
    const bytes = new Uint8Array(8 + payload.byteLength);
    new DataView(bytes.buffer).setUint32(0, bytes.byteLength);
    writeAscii(bytes, 4, type);
    bytes.set(payload, 8);
    return bytes;
}

function concat(parts: Uint8Array[]) {
    const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
        bytes.set(part, offset);
        offset += part.byteLength;
    }
    return bytes;
}

function writeAscii(bytes: Uint8Array, offset: number, value: string) {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
}
import { assertVideoAudioProbe } from "../src/lib/canvas/canvas-video-segment-args";

test("audio extraction distinguishes a silent source from encoder failure", () => {
    expect(() => assertVideoAudioProbe('{"streams":[],"format":{"duration":"15.042"}}')).toThrow("没有音轨");
    expect(() => assertVideoAudioProbe('{"streams":[{"index":1}],"format":{"duration":"3"}}')).not.toThrow();
    expect(() => assertVideoAudioProbe('{"streams":[]}')).toThrow("无法读取");
    expect(() => assertVideoAudioProbe('not-json')).toThrow("无法读取");
    expect(() => assertVideoAudioProbe('{}')).toThrow("无法读取");
});
