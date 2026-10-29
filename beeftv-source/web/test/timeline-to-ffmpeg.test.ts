import { describe, expect, test } from "bun:test";

import type { CanonicalTimelinePlan } from "../src/lib/timeline/timeline-canonical-plan";
import { formatSrtTimestamp, lowerCanonicalPlan, type TimelineRenderSource } from "../src/lib/timeline/timeline-to-ffmpeg";
import { loadEditingPlan } from "./helpers/editing-fixtures";

function source(nodeId: string): TimelineRenderSource {
    return { nodeId, fileName: `input-${nodeId}.mp4`, durationMs: 15_000, url: `file:///${nodeId}.mp4` };
}

function concatTotalSeconds(plan: ReturnType<typeof lowerCanonicalPlan>): number {
    let total = 0;
    for (const entry of plan.concatEntries) {
        const step = plan.steps.find((item) => item.output === entry);
        if (step?.kind === "trim") total += Number(step.args[step.args.indexOf("-t") + 1]);
        if (step?.kind === "gap") {
            const lavfi = step.args.find((arg) => arg.startsWith("color=c=black")) || "";
            total += Number(lavfi.split("d=")[1]);
        }
    }
    return total;
}

function concatStartOffsetsMs(plan: ReturnType<typeof lowerCanonicalPlan>): number[] {
    const offsets: number[] = [];
    let cursor = 0;
    for (const entry of plan.concatEntries) {
        const step = plan.steps.find((item) => item.output === entry);
        if (!step) continue;
        offsets.push(cursor);
        if (step.kind === "trim") cursor += Number(step.args[step.args.indexOf("-t") + 1]) * 1000;
        if (step.kind === "gap") {
            const lavfi = step.args.find((arg) => arg.startsWith("color=c=black")) || "";
            cursor += Number(lavfi.split("d=")[1]) * 1000;
        }
    }
    return offsets;
}

describe("lowerCanonicalPlan 片段与黑场对齐", () => {
    test("共享 gap-mix 夹具：中间空隙插黑场，配音裁剪/音量/淡化进入 mix", () => {
        const canonical = loadEditingPlan("gap-mix.plan.json");
        const plan = lowerCanonicalPlan(canonical, [source("node-a"), source("node-b"), source("voice")], { width: 1280, height: 720, fps: 30, outputName: "out.mp4" });
        expect(plan.concatEntries).toEqual(["trim-0.mp4", "gap-1.mp4", "trim-2.mp4"]);
        const gaps = plan.steps.filter((step) => step.kind === "gap");
        expect(gaps).toHaveLength(1);
        expect(gaps[0].args.join(" ")).toContain("d=10");
        expect(concatTotalSeconds(plan)).toBe(40);
        expect(concatStartOffsetsMs(plan)).toEqual([0, 15_000, 25_000]);
        const mix = plan.steps.find((step) => step.kind === "mix")!;
        expect(mix.args.join(" ")).toContain("atrim=start=0.1:duration=1.5");
        expect(mix.args.join(" ")).toContain("volume=0,afade=t=in:st=0:d=0.1,afade=t=out:st=1.3:d=0.2,adelay=500:all=1");
        expect(mix.args.join(" ")).toContain("amix=inputs=2:normalize=0:duration=first");
        expect(mix.args.join(" ")).not.toContain("alimiter");
        expect(plan.request).toEqual({
            videoClipIds: ["a", "b"],
            audioClipIds: ["voice"],
            subtitleClipIds: ["sub"],
            durationMs: 40000,
            burnSubtitles: true,
        });
        expect(plan.steps.some((step) => step.kind === "burn")).toBe(true);
        expect(plan.subtitleSrt).toContain("中文");
    });

    test("共享 six-second-mix 夹具：无黑场、concat 顺序=片段顺序", () => {
        const canonical = loadEditingPlan("six-second-mix.plan.json");
        const plan = lowerCanonicalPlan(canonical, [source("v0"), source("v1"), source("v2"), source("voice"), source("bgm")], { width: 320, height: 180, fps: 30, outputName: "out.mp4" });
        expect(plan.steps.filter((step) => step.kind === "gap")).toHaveLength(0);
        expect(concatTotalSeconds(plan)).toBe(6);
        expect(plan.concatEntries).toEqual(["trim-0.mp4", "trim-1.mp4", "trim-2.mp4"]);
        expect(plan.request.audioClipIds).toEqual(["bgm", "voice"]);
        expect(plan.subtitleSrt).toContain("中文字幕完整性验证");
    });

    test("缺少计划所需媒体源必须明确失败", () => {
        const canonical = loadEditingPlan("gap-mix.plan.json");
        expect(() => lowerCanonicalPlan(canonical, [source("node-a")])).toThrow("找不到素材");
    });

    test("静音独立音轨仍进入 mix，音量为 0", () => {
        const canonical = structuredClone(loadEditingPlan("six-second-mix.plan.json"));
        canonical.audio.find((clip) => clip.clipId === "bgm")!.muted = true;
        const plan = lowerCanonicalPlan(canonical, [source("v0"), source("v1"), source("v2"), source("voice"), source("bgm")]);
        const mix = plan.steps.find((step) => step.kind === "mix")!;
        expect(mix.args.join(" ")).toContain("volume=0");
        expect(plan.steps.some((step) => step.kind === "mix")).toBe(true);
    });

    test("未探测音轨时保留计划 hasAudio，探测失败才改静音", () => {
        const keepPlan: CanonicalTimelinePlan = {
            version: 1,
            output: { width: 1280, height: 720, fps: 30, sampleRate: 44100, burnSubtitles: false },
            durationMs: 1000,
            segments: [{ kind: "video", clipId: "a", sourceId: "node-a", startMs: 0, durationMs: 1000, volume: 1, hasAudio: true }],
            audio: [],
            subtitles: [],
        };
        const keep = lowerCanonicalPlan(keepPlan, [source("node-a")]);
        expect(keep.steps.find((step) => step.kind === "trim")!.args.join(" ")).toContain("-map 0:a:0");
        const silent = lowerCanonicalPlan({ ...keepPlan, segments: [{ ...keepPlan.segments[0], hasAudio: false }] }, [{ ...source("node-a"), hasAudio: false }]);
        expect(silent.steps.find((step) => step.kind === "trim")!.args.join(" ")).toContain("-map 1:a:0");
    });

    test("图片片段 lowering 使用 -loop 1，不抛错", () => {
        const canonical: CanonicalTimelinePlan = {
            version: 1,
            output: { width: 1280, height: 720, fps: 30, sampleRate: 44100, burnSubtitles: false },
            durationMs: 2000,
            segments: [
                { kind: "video", clipId: "v", sourceId: "v", startMs: 0, durationMs: 1000, volume: 1, hasAudio: true },
                { kind: "image", clipId: "still", sourceId: "still", startMs: 1000, durationMs: 1000, volume: 1, hasAudio: false },
            ],
            audio: [],
            subtitles: [],
        };
        const plan = lowerCanonicalPlan(canonical, [source("v"), { ...source("still"), fileName: "still.png" }]);
        const image = plan.steps.find((step) => step.description.includes("图片"))!;
        expect(image.args.slice(0, 4)).toEqual(["-loop", "1", "-t", "1"]);
        const lastInput = image.args.lastIndexOf("-i");
        const outputDuration = image.args.map((arg, index) => (arg === "-t" && index > lastInput ? Number(image.args[index + 1]) : -1)).find((value) => value >= 0);
        expect(outputDuration).toBe(1);
        expect(image.args).toContain("-shortest");
        expect(image.args.join(" ")).toContain("anullsrc=r=44100:cl=stereo");
    });

    test("执行器不得覆盖计划中的输出尺寸或字幕策略", () => {
        const canonical = loadEditingPlan("gap-mix.plan.json");
        const sources = [source("node-a"), source("node-b"), source("voice")];
        expect(() => lowerCanonicalPlan(canonical, sources, { width: 1920, height: 1080 })).toThrow("导出尺寸必须与渲染计划一致");
        expect(() => lowerCanonicalPlan(canonical, sources, { fps: 24 })).toThrow("导出帧率必须与渲染计划一致");
        expect(() => lowerCanonicalPlan(canonical, sources, { burnSubtitles: false })).toThrow("字幕烧录必须与渲染计划一致");
        const matched = lowerCanonicalPlan(canonical, sources, { width: 1280, height: 720, fps: 30, outputName: "out.mp4" });
        expect(matched.finalOutput).toBe("out.mp4");
        expect(matched.steps.find((step) => step.kind === "gap")!.args.join(" ")).toContain("1280x720");
    });

    test("共享 image-gap-sub 夹具：图片输出时长有界，采样率来自计划", () => {
        const canonical = loadEditingPlan("image-gap-sub.plan.json");
        const plan = lowerCanonicalPlan(canonical, [
            { ...source("still"), fileName: "still.png" },
            { ...source("voice"), fileName: "voice.wav" },
        ], { outputName: "out.mp4" });
        const image = plan.steps.find((step) => step.kind === "trim")!;
        const lastInput = image.args.lastIndexOf("-i");
        expect(image.args.slice(0, lastInput).includes("-t")).toBe(true);
        expect(image.args.slice(lastInput).includes("-t")).toBe(true);
        expect(plan.steps.find((step) => step.kind === "gap")).toBeTruthy();
        expect(plan.steps.find((step) => step.kind === "mix")!.args.join(" ")).toContain("aresample=44100");
        expect(plan.steps.find((step) => step.kind === "mix")!.args.join(" ")).not.toContain("alimiter");
        expect(plan.request.subtitleClipIds).toEqual(["sub"]);
        expect(concatTotalSeconds(plan)).toBe(3);
    });
});

describe("trim 步骤输出 seek（-ss 在 -i 之后）", () => {
    test("裁切参数必须把 -ss 放在 -i 之后：输入 seek 会按关键帧对齐导致切点偏移", () => {
        const canonical = loadEditingPlan("six-second-mix.plan.json");
        const plan = lowerCanonicalPlan(canonical, [source("v0"), source("v1"), source("v2"), source("voice"), source("bgm")], { width: 320, height: 180, fps: 30, outputName: "out.mp4" });
        const trims = plan.steps.filter((step) => step.kind === "trim");
        expect(trims.length).toBeGreaterThan(0);
        for (const trim of trims) {
            const inputIndex = trim.args.indexOf("-i");
            const ssIndex = trim.args.indexOf("-ss");
            expect(inputIndex).toBeGreaterThan(-1);
            expect(ssIndex).toBeGreaterThan(-1);
            expect(ssIndex).toBeGreaterThan(inputIndex);
        }
    });
});

describe("formatSrtTimestamp", () => {
    test("SRT 时间码毫秒对齐三位", () => {
        expect(formatSrtTimestamp(3_600_000 + 60_000 + 1_234)).toBe("01:01:01,234");
        expect(formatSrtTimestamp(0)).toBe("00:00:00,000");
    });
});
