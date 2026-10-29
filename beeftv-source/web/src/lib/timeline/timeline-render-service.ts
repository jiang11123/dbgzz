// Shared native/wasm execution for a lowered TimelineRenderPlan. Engines only
// run args; this module owns concat/SRT writes, requested-content checks,
// cancel, and cleanup. Subtitle text comes from the canonical plan, not a
// second pass over the raw timeline.
import { isSubtitleFontFailure } from "./subtitle-font-failure";
import {
    SUBTITLE_FILE,
    type TimelineRenderPlan,
    type TimelineRenderRequest,
} from "./timeline-to-ffmpeg";

export type TimelineRenderEngine = {
    writeFile(name: string, data: Uint8Array | string): Promise<void>;
    readFile(name: string): Promise<Uint8Array | string>;
    deleteFile(name: string): Promise<void>;
    exec(args: string[]): Promise<{ exitCode: number; log: string }>;
};

export type TimelineRenderProgress = {
    detail: string;
    percent: number;
};

export type TimelineRenderExecution = {
    output: Uint8Array | string;
    outputName: string;
    completedOutputs: string[];
    subtitleBurned: boolean;
    mixedAudio: boolean;
    request: TimelineRenderRequest;
};

const SUBTITLE_BURN_FAILURE = "字幕烧录失败或缺少所需字体，未导出无字幕成片。请使用已安装中文字幕字体的服务端渲染";

export function assertPlanPreservesRequestedContent(plan: TimelineRenderPlan): void {
    const { request } = plan;
    if (request.videoClipIds.length && !plan.concatEntries.length) {
        throw new Error("导出计划丢失了视频片段，未生成不完整成片");
    }
    if (request.audioClipIds.length && !plan.steps.some((step) => step.kind === "mix")) {
        throw new Error("导出计划丢失了独立音轨，未生成不完整成片");
    }
    if (request.burnSubtitles && !plan.steps.some((step) => step.kind === "burn")) {
        throw new Error("导出计划丢失了字幕烧录，未生成无字幕成片");
    }
}

export async function executeTimelineRenderPlan(options: {
    plan: TimelineRenderPlan;
    engine: TimelineRenderEngine;
    signal?: AbortSignal;
    onProgress?: (progress: TimelineRenderProgress) => void;
    writtenFiles?: Set<string>;
}): Promise<TimelineRenderExecution> {
    const { plan, engine, signal, onProgress } = options;
    const writtenFiles = options.writtenFiles ?? new Set<string>();
    assertPlanPreservesRequestedContent(plan);
    const executableSteps = plan.steps.filter((step) => step.kind !== "subtitle");
    const completedOutputs: string[] = [];
    let stepIndex = 0;

    for (const step of plan.steps) {
        signal?.throwIfAborted();
        if (step.kind === "subtitle") {
            const srt = plan.subtitleSrt || "";
            if (!srt.trim() && plan.request.burnSubtitles) throw new Error("字幕内容为空，未导出无字幕成片");
            if (srt) {
                await engine.writeFile(SUBTITLE_FILE, srt);
                writtenFiles.add(SUBTITLE_FILE);
            }
            continue;
        }
        if (step.args.includes("concat.txt")) {
            const content = plan.concatEntries.map((file) => "file '" + file + "'").join("\n");
            await engine.writeFile("concat.txt", content);
            writtenFiles.add("concat.txt");
        }
        onProgress?.({
            detail: step.description,
            percent: Math.round(10 + (stepIndex / Math.max(1, executableSteps.length)) * 75),
        });
        writtenFiles.add(step.output);
        const { exitCode, log } = await engine.exec(step.args);
        signal?.throwIfAborted();
        if (step.kind === "burn" && (exitCode !== 0 || isSubtitleFontFailure(log))) throw new Error(SUBTITLE_BURN_FAILURE);
        if (exitCode !== 0) throw new Error("导出失败：" + step.description);
        completedOutputs.push(step.output);
        stepIndex += 1;
    }

    const burned = completedOutputs.includes(plan.finalOutput) && plan.steps.some((step) => step.kind === "burn" && step.output === plan.finalOutput);
    const mixOutput = plan.steps.find((step) => step.kind === "mix")?.output;
    const mixedAudio = Boolean(mixOutput && completedOutputs.includes(mixOutput));
    if (plan.request.burnSubtitles && !burned) throw new Error("字幕烧录未完成，未导出无字幕成片");
    if (plan.request.audioClipIds.length && !mixedAudio) throw new Error("独立音轨混合未完成，未导出缺音频成片");

    signal?.throwIfAborted();
    const output = await engine.readFile(plan.finalOutput);
    return {
        output,
        outputName: plan.finalOutput,
        completedOutputs,
        subtitleBurned: burned,
        mixedAudio,
        request: plan.request,
    };
}

export async function cleanupRenderFiles(engine: TimelineRenderEngine, files: Iterable<string>): Promise<void> {
    await Promise.all([...new Set(files)].map((file) => engine.deleteFile(file).catch(() => undefined)));
}
