import { describe, expect, test } from "bun:test";

import type { CanonicalTimelinePlan } from "../src/lib/timeline/timeline-canonical-plan";
import { lowerCanonicalPlan, type TimelineRenderSource } from "../src/lib/timeline/timeline-to-ffmpeg";
import { cleanupRenderFiles, executeTimelineRenderPlan, type TimelineRenderEngine } from "../src/lib/timeline/timeline-render-service";

function source(nodeId: string): TimelineRenderSource {
    return { nodeId, fileName: `${nodeId}.mp4`, durationMs: 15_000, hasAudio: true };
}

function videoPlan(extra: Partial<CanonicalTimelinePlan> = {}): CanonicalTimelinePlan {
    return {
        version: 1,
        output: { width: 1920, height: 1080, fps: 30, sampleRate: 44100, burnSubtitles: extra.subtitles?.length ? true : extra.output?.burnSubtitles === true, ...extra.output },
        durationMs: 1000,
        segments: [{ kind: "video", clipId: "v", sourceId: "v", startMs: 0, durationMs: 1000, volume: 1, hasAudio: true }],
        audio: extra.audio ?? [],
        subtitles: extra.subtitles ?? [],
        subtitleSrt: extra.subtitleSrt,
        ...extra,
    };
}

function memoryEngine(options: { burnLog?: string; failBurn?: boolean; abortSignal?: AbortController; abortOn?: string } = {}) {
    const files = new Map<string, Uint8Array | string>();
    const deleted: string[] = [];
    const commands: string[][] = [];
    const engine: TimelineRenderEngine = {
        async writeFile(name, data) { files.set(name, data); },
        async readFile(name) {
            const value = files.get(name);
            if (value === undefined) throw new Error("missing " + name);
            return value;
        },
        async deleteFile(name) { deleted.push(name); files.delete(name); },
        async exec(args) {
            commands.push(args);
            if (options.abortOn && args.includes(options.abortOn)) options.abortSignal?.abort();
            const output = args[args.length - 1]!;
            files.set(output, new Uint8Array([9, 9, 9]));
            if (options.failBurn && args.includes("-filter_complex")) return { exitCode: 1, log: options.burnLog ?? "" };
            return { exitCode: 0, log: options.burnLog ?? "" };
        },
    };
    return { engine, files, deleted, commands };
}

describe("executeTimelineRenderPlan", () => {
    test("writes concat and SRT from the canonical plan, burns subtitles, and returns a result manifest", async () => {
        const canonical = videoPlan({
            output: { width: 1920, height: 1080, fps: 30, sampleRate: 44100, burnSubtitles: true },
            audio: [{ clipId: "voice", sourceId: "voice", startMs: 0, durationMs: 1000, sourceStartMs: 0, volume: 1 }],
            subtitles: [{ clipId: "s", startMs: 0, durationMs: 1000, text: "中文" }],
            subtitleSrt: "1\n00:00:00,000 --> 00:00:01,000\n中文\n\n",
        });
        const plan = lowerCanonicalPlan(canonical, [source("v"), source("voice")], { subtitleImages: ["subtitle-0.png"] });
        const { engine, files, commands } = memoryEngine();
        await engine.writeFile("subtitle-0.png", new Uint8Array([1]));
        const result = await executeTimelineRenderPlan({ plan, engine });
        expect(result.subtitleBurned).toBe(true);
        expect(result.mixedAudio).toBe(true);
        expect(result.request.audioClipIds).toEqual(["voice"]);
        expect(result.request.subtitleClipIds).toEqual(["s"]);
        expect(files.get("concat.txt")).toContain("trim-0.mp4");
        expect(String(files.get("timeline.srt"))).toContain("中文");
        expect(String(files.get("timeline.srt"))).not.toContain("错的");
        expect(result.output).toEqual(new Uint8Array([9, 9, 9]));
        expect(commands.some((args) => args.includes("-filter_complex"))).toBe(true);
    });

    test("normal Glyph-not-found fallback is not a silent subtitle failure", async () => {
        const canonical = videoPlan({
            output: { width: 1920, height: 1080, fps: 30, sampleRate: 44100, burnSubtitles: true },
            subtitles: [{ clipId: "s", startMs: 0, durationMs: 1000, text: "中文" }],
            subtitleSrt: "1\n00:00:00,000 --> 00:00:01,000\n中文\n\n",
        });
        const plan = lowerCanonicalPlan(canonical, [source("v")]);
        const { engine } = memoryEngine({ burnLog: "Glyph 0x4E2D not found, selecting one more font for (Arial, 400, 0)\nfontselect: (Arial, 400, 0) -> NotoSansCJK, 0, NotoSansCJK" });
        const result = await executeTimelineRenderPlan({ plan, engine });
        expect(result.subtitleBurned).toBe(true);
    });

    test("true font failure with successful exit still rejects and does not return output", async () => {
        const canonical = videoPlan({
            output: { width: 1920, height: 1080, fps: 30, sampleRate: 44100, burnSubtitles: true },
            subtitles: [{ clipId: "s", startMs: 0, durationMs: 1000, text: "中文" }],
            subtitleSrt: "1\n00:00:00,000 --> 00:00:01,000\n中文\n\n",
        });
        const plan = lowerCanonicalPlan(canonical, [source("v")]);
        const { engine, deleted } = memoryEngine({ burnLog: "fontselect: failed to find any fallback with glyph 0x4E2D" });
        const writtenFiles = new Set<string>();
        await expect(executeTimelineRenderPlan({ plan, engine, writtenFiles })).rejects.toThrow("字幕烧录失败");
        await cleanupRenderFiles(engine, writtenFiles);
        expect(deleted).toContain("export.mp4");
    });

    test("cancellation during encode keeps AbortError and still allows cleanup of owned files", async () => {
        const plan = lowerCanonicalPlan(videoPlan(), [source("v")]);
        const controller = new AbortController();
        const { engine, deleted } = memoryEngine({ abortSignal: controller, abortOn: "concat.txt" });
        const writtenFiles = new Set<string>();
        await expect(executeTimelineRenderPlan({ plan, engine, signal: controller.signal, writtenFiles })).rejects.toMatchObject({ name: "AbortError" });
        await cleanupRenderFiles(engine, [...writtenFiles, "concat.txt"]);
        expect(deleted.length).toBeGreaterThan(0);
    });
});
