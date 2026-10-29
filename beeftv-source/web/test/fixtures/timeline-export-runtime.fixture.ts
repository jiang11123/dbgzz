import { expect, mock, test } from "bun:test";
import type { TimelineProject } from "../../src/types/timeline";

(globalThis as any).__BEEFTV_HEAVY_MEDIA_ENABLED__ = true;
let failBurn = false;
let cancelAt: "load" | "encode" | null = null;
let controller: AbortController;
let instances: FakeFFmpeg[] = [];
class FakeFFmpeg {
    deleted: string[] = [];
    terminated = false;
    commands: string[][] = [];
    constructor() { instances.push(this); }
    on() {}
    async load() { if (cancelAt === "load") { controller.abort(); throw new Error("worker terminated"); } }
    async writeFile() {}
    async ffprobe() { return 0; }
    async exec(args: string[]) {
        this.commands.push(args);
        if (cancelAt === "encode") { controller.abort(); throw new Error("worker terminated"); }
        return failBurn && args.includes("-filter_complex") ? 1 : 0;
    }
    async readFile(name: string) { return name === "probe.json" ? JSON.stringify({ streams: [{ codec_type: "video" }, { codec_type: "audio" }], format: { duration: "2" } }) : new Uint8Array([1]); }
    async deleteFile(name: string) { this.deleted.push(name); }
    terminate() { this.terminated = true; }
}
mock.module("@ffmpeg/ffmpeg", () => ({ FFmpeg: FakeFFmpeg }));
mock.module("@ffmpeg/util", () => ({ fetchFile: async () => new Uint8Array([1]) }));
mock.module("@ffmpeg/core?url", () => ({ default: "core.js" }));
mock.module("@ffmpeg/core/wasm?url", () => ({ default: "core.wasm" }));
mock.module("../../src/services/file-storage", () => ({ getMediaBlob: async () => new Blob(["fixture"]) }));
mock.module("../../src/lib/timeline/timeline-subtitle-image", () => ({ rasterizeTimelineSubtitle: async () => new Uint8Array([1]) }));
let planFail: string | null = null;
mock.module("../../src/services/api/timeline-tasks", () => ({
    compileTimelineRenderPlan: async (req: { sources?: { id: string }[] }, signal?: AbortSignal) => {
        signal?.throwIfAborted();
        if (planFail) throw new Error(planFail);
        if (!req.sources?.length) throw new Error("找不到素材");
        return {
            version: 1,
            output: { width: 1920, height: 1080, fps: 30, sampleRate: 44100, burnSubtitles: true },
            durationMs: 1000,
            segments: [{ kind: "video", clipId: "v", sourceId: "v", startMs: 0, durationMs: 1000, volume: 1, hasAudio: true }],
            audio: [],
            subtitles: [{ clipId: "s", startMs: 0, durationMs: 1000, text: "中文" }],
            subtitleSrt: "1\n00:00:00,000 --> 00:00:01,000\n中文\n\n",
        };
    },
}));
const { exportTimelineToMp4 } = await import("../../src/lib/timeline/timeline-export");
const project: TimelineProject = { version: 2, tracks: [], durationMs: 1000, clips: [{ id: "v", nodeId: "v", trackId: "v", kind: "video", startMs: 0, durationMs: 1000 }, { id: "s", nodeId: "s", trackId: "s", kind: "subtitle", text: "中文", startMs: 0, durationMs: 1000 }] };
const sources = [{ nodeId: "v", fileName: "input.mp4", storageKey: "local", durationMs: 1000 }];

test("subtitle failure rejects, never falls back, cleans partial output and worker", async () => {
    failBurn = true; cancelAt = null; planFail = null; instances = []; controller = new AbortController();
    await expect(exportTimelineToMp4(project, sources, { signal: controller.signal })).rejects.toThrow("字幕烧录失败");
    expect(instances[0].commands.filter((args) => args.includes("export.mp4"))).toHaveLength(1);
    expect(instances[0].deleted).toContain("export.mp4");
    expect(instances[0].deleted).toContain("subtitle-0.png");
    expect(instances[0].terminated).toBe(true);
});
test("cancellation during load/encode retains AbortError and terminates owned worker", async () => {
    failBurn = false; planFail = null;
    for (const phase of ["load", "encode"] as const) {
        cancelAt = phase; instances = []; controller = new AbortController();
        await expect(exportTimelineToMp4(project, sources, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
        expect(instances[0].terminated).toBe(true);
    }
});
test("missing source fails before worker creation; independent successful calls own workers", async () => {
    failBurn = false; cancelAt = null; planFail = null; instances = [];
    await expect(exportTimelineToMp4(project, [])).rejects.toThrow("找不到素材");
    expect(instances).toHaveLength(0);
    await Promise.all([exportTimelineToMp4(project, sources), exportTimelineToMp4(project, sources)]);
    expect(instances).toHaveLength(2);
    expect(instances.every((worker) => worker.terminated)).toBe(true);
});
test("planning endpoint failure does not fall back to a local semantic compiler", async () => {
    failBurn = false; cancelAt = null; planFail = "无法生成渲染计划"; instances = [];
    await expect(exportTimelineToMp4(project, sources)).rejects.toThrow("无法生成渲染计划");
    expect(instances).toHaveLength(0);
});
