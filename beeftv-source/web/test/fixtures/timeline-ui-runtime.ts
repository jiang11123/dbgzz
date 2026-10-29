import type { TimelineProject } from "../../src/types/timeline";
import type { TimelineRenderSource } from "../../src/lib/timeline/timeline-to-ffmpeg";

// Fault injection at the encoder/task boundary; the mounted React handlers remain real.
export const receipt = {
    local: [] as TimelineRenderSource[][], remote: [] as TimelineProject[],
    downloads: 0, created: 0, aborted: 0,
    failLocal: () => {}, failRemote: () => {},
};

export function exportTimelineToMp4(_project: TimelineProject, sources: TimelineRenderSource[], options: { signal?: AbortSignal }) {
    receipt.local.push(sources);
    return new Promise<Blob>((_resolve, reject) => {
        receipt.failLocal = () => reject(new Error("字幕烧录失败，未导出无字幕成片"));
        options.signal?.addEventListener("abort", () => {
            receipt.aborted++;
            reject(new DOMException("导出已取消", "AbortError"));
        }, { once: true });
    });
}
export async function compileTimelineRenderPlan(_input: unknown, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return {
        version: 1,
        output: { width: 1920, height: 1080, fps: 30, sampleRate: 44100, burnSubtitles: false },
        durationMs: 6000,
        segments: [{ kind: "video", clipId: "video", sourceId: "video", startMs: 0, durationMs: 6000, volume: 1, hasAudio: true }],
        audio: [
            { clipId: "bgm", sourceId: "bgm", startMs: 0, durationMs: 6000, sourceStartMs: 0, volume: 1 },
            { clipId: "voice", sourceId: "voice", startMs: 1000, durationMs: 2000, sourceStartMs: 0, volume: 1 },
        ],
        subtitles: [],
        subtitleSrt: "",
    };
}

export async function createTimelineRenderTask(input: { timeline: TimelineProject }) {
    receipt.remote.push(input.timeline);
    return { id: "render-fixture" };
}
export async function createTimelineTranscriptionTask() {
    throw new Error("渲染界面验收不应提交转写任务");
}
export function waitForGenerationTask() {
    return new Promise((_resolve, reject) => {
        receipt.failRemote = () => reject(new Error("服务端字幕字体缺失，渲染失败"));
    });
}
export function saveAs() { receipt.downloads++; }
