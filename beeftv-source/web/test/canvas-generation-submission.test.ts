import { describe, expect, test } from "bun:test";

import { canReleaseCanvasGenerationSource, canvasGenerationPromptMetadata, canvasGenerationRequestFingerprint, runCanvasGenerationSubmissionOnce } from "@/lib/canvas/canvas-generation-submission";
import { GENERATION_RESULT_FETCH_STAGE } from "@/lib/generation-delivery-progress";
import type { GenerationTask } from "@/services/api/task-center";

function fingerprint(overrides: Partial<Parameters<typeof canvasGenerationRequestFingerprint>[0]> = {}) {
    return canvasGenerationRequestFingerprint({
        nodeId: "node-1",
        mode: "video",
        prompt: "夜晚的城市",
        model: "video-model",
        options: { size: "16:9", videoSeconds: 10, vquality: "768p" },
        context: {
            referenceImages: [{ id: "image-1", name: "reference.png", type: "image/png", dataUrl: "", storageKey: "resource:image-1" }],
            referenceVideos: [],
            referenceAudios: [],
            characterReferences: [],
            resolvedCharacterVersions: [],
            resolvedCharacterVoices: [],
        },
        ...overrides,
    });
}

describe("canvas generation submission", () => {
    test("only a separate finished video result releases its source", () => {
        const task: GenerationTask = { id: "task", type: "canvas_video", status: "running", prompt: "", attempts: 1, createdAt: "", updatedAt: "", progress: 100 };
        expect(canReleaseCanvasGenerationSource("source", "result", task)).toBe(false);
        const fetching = { ...task, stage: GENERATION_RESULT_FETCH_STAGE };
        expect(canReleaseCanvasGenerationSource("source", "result", fetching)).toBe(true);
        expect(canReleaseCanvasGenerationSource("source", "source", fetching)).toBe(false);
        expect(canReleaseCanvasGenerationSource("source", "result", { ...fetching, type: "canvas_text" })).toBe(false);
        expect(canReleaseCanvasGenerationSource("source", "result", { ...task, status: "succeeded" })).toBe(true);
    });

    test("old delivery completion cannot release a newer submission lock", async () => {
        const locks = new Map<string, Promise<unknown>>();
        let releaseSource!: () => void;
        let finishFirst!: () => void;
        let finishSecond!: () => void;
        const first = runCanvasGenerationSubmissionOnce(locks, "source", async (release) => {
            releaseSource = release;
            await new Promise<void>((resolve) => { finishFirst = resolve; });
        });
        await Promise.resolve();
        releaseSource();
        const second = runCanvasGenerationSubmissionOnce(locks, "source", async () => {
            await new Promise<void>((resolve) => { finishSecond = resolve; });
        });
        await Promise.resolve();
        finishFirst();
        await first;
        expect(locks.get("source")).toBe(second);
        expect(runCanvasGenerationSubmissionOnce(locks, "source", async () => { throw new Error("duplicate send"); })).toBe(second);
        finishSecond();
        await second;
        expect(locks.size).toBe(0);
    });

    test("持久化时分离编辑器槽位提示词和模型提示词", () => {
        expect(canvasGenerationPromptMetadata("自我介绍 @图片1", "电影感：自我介绍 @图片1")).toEqual({
            composerContent: "自我介绍 @图片1",
            prompt: "电影感：自我介绍 @图片1",
        });
    });

    test("同一节点的并发提交只执行一次", async () => {
        const locks = new Map<string, Promise<unknown>>();
        let executions = 0;
        let duplicates = 0;
        let release!: () => void;
        const pending = new Promise<void>((resolve) => {
            release = resolve;
        });
        const run = () =>
            runCanvasGenerationSubmissionOnce(
                locks,
                "node-1",
                async () => {
                    executions += 1;
                    await pending;
                    return "done";
                },
                () => {
                    duplicates += 1;
                },
            );

        const submissions = [run(), run(), run()];
        await Promise.resolve();
        expect(executions).toBe(1);
        expect(duplicates).toBe(2);
        release();
        expect(await Promise.all(submissions)).toEqual(["done", "done", "done"]);

        await run();
        expect(executions).toBe(2);
    });

    test("相同输入生成稳定指纹，关键内容变化会改变指纹", () => {
        expect(fingerprint({ options: { vquality: "768p", videoSeconds: 10, size: "16:9" } })).toBe(fingerprint());
        expect(fingerprint({ prompt: "白天的城市" })).not.toBe(fingerprint());
        expect(fingerprint({ model: "another-model" })).not.toBe(fingerprint());
        expect(fingerprint({ options: { size: "9:16", videoSeconds: 10, vquality: "768p" } })).not.toBe(fingerprint());
        expect(
            fingerprint({
                context: {
                    referenceImages: [{ id: "image-2", name: "other.png", type: "image/png", dataUrl: "", storageKey: "resource:image-2" }],
                    referenceVideos: [],
                    referenceAudios: [],
                    characterReferences: [],
                    resolvedCharacterVersions: [],
                    resolvedCharacterVoices: [],
                },
            }),
        ).not.toBe(fingerprint());
    });
});
