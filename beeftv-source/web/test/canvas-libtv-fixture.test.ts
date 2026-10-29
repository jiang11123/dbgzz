import { describe, expect, test } from "bun:test";

import { createLibTvAudioFixture, createLibTvEmptyTextFixture, createLibTvGeneratingFixture, createLibTvReadonlyDenseFixture, createLibTvStoryboardFixture, createLibTvTextFixture, createLibTvVideoFixture } from "@/lib/canvas/canvas-libtv-fixture";
import { CanvasNodeType } from "@/types/canvas";

describe("LibTV visual fixtures", () => {
    test("storyboard fixture keeps two semantic frame groups", () => {
        const nodes = createLibTvStoryboardFixture();
        expect(nodes.filter((node) => node.type === CanvasNodeType.Frame)).toHaveLength(2);
        expect(nodes.filter((node) => node.parentId)).toHaveLength(6);
    });

    test("readonly dense fixture keeps the current public node-type contract", () => {
        const nodes = createLibTvReadonlyDenseFixture();
        expect(nodes.filter((node) => node.type === CanvasNodeType.Frame)).toHaveLength(0);
        expect(nodes).toHaveLength(61);
        expect(nodes.filter((node) => node.type === CanvasNodeType.Image)).toHaveLength(38);
        expect(nodes.filter((node) => node.type === CanvasNodeType.Video)).toHaveLength(17);
        expect(nodes.filter((node) => node.type === CanvasNodeType.Audio)).toHaveLength(6);
    });

    test("video fixture exposes a completed local result without network media", () => {
        const [video] = createLibTvVideoFixture();
        expect(video.type).toBe(CanvasNodeType.Video);
        expect(video.metadata?.fixture).toBe("libtv-video");
        expect(video.metadata?.status).toBe("success");
        expect(video.metadata?.content).toMatch(/^data:video\/mp4;base64,/);
        expect(video.metadata?.previewContent).toMatch(/^data:image\/svg\+xml,/);
        expect(video.metadata?.durationMs).toBe(5000);
    });

    test("audio fixture exposes a completed local wav result", () => {
        const [audio] = createLibTvAudioFixture();
        expect(audio.type).toBe(CanvasNodeType.Audio);
        expect(audio.metadata?.fixture).toBe("libtv-audio");
        expect(audio.metadata?.status).toBe("success");
        expect(audio.metadata?.content).toMatch(/^data:audio\/wav;base64,/);
        expect(audio.metadata?.audioVoice).toBe("中文");
        expect(audio.metadata?.audioFormat).toBe("wav");
    });

    test("text fixture exposes a completed styleboard result", () => {
        const [text] = createLibTvTextFixture();
        expect(text.type).toBe(CanvasNodeType.Text);
        expect(text.metadata?.fixture).toBe("libtv-text");
        expect(text.metadata?.status).toBe("success");
        expect(text.metadata?.content).toContain("冷色自然光");
        expect(text.width).toBe(420);
        expect(text.height).toBe(240);
    });

    test("empty text fixture matches the default LibTV text node state", () => {
        const [text] = createLibTvEmptyTextFixture();
        expect(text.type).toBe(CanvasNodeType.Text);
        expect(text.metadata?.fixture).toBe("libtv-text-empty");
        expect(text.metadata?.content).toBe("");
        expect(text.title).toBe("文本节点1");
        expect(text.width).toBe(350);
        expect(text.height).toBe(350);
    });

    test("generating fixture exposes a running task with progress metadata", () => {
        const [image] = createLibTvGeneratingFixture();
        expect(image.type).toBe(CanvasNodeType.Image);
        expect(image.metadata?.fixture).toBe("libtv-generating");
        expect(image.metadata?.status).toBe("loading");
        expect(image.metadata?.taskStatus).toBe("running");
        expect(image.metadata?.taskId).toBe("libtv-fixture-task-42");
        expect(image.metadata?.taskCreatedAt).toBe(new Date(0).toISOString());
        expect(image.metadata?.taskProgress).toBe(42);
        expect(image.metadata?.taskStage).toBe("正在生成画面");
    });
});
