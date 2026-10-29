import { describe, expect, test } from "bun:test";

import { buildGenerationTaskNodeResult, type GenerationResultMediaIO } from "../src/lib/canvas/canvas-generation-task-sync";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import type { GenerationTask } from "../src/services/api/task-center";

function mediaNode(type: CanvasNodeType.Image | CanvasNodeType.Video | CanvasNodeType.Audio): CanvasNodeData {
    return {
        id: `${type}-node`,
        type,
        title: type,
        position: { x: 40, y: 40 },
        width: 320,
        height: 180,
        metadata: { prompt: "历史结果" },
    };
}

function task(type: string, result: unknown): GenerationTask {
    return {
        id: `task-${type}`,
        projectId: "7vvfM674HnenwTekmj88V",
        type,
        status: "succeeded",
        prompt: "历史结果",
        resultJson: JSON.stringify(result),
        attempts: 1,
        createdAt: "2026-09-24T00:00:00.000Z",
        updatedAt: "2026-09-24T00:00:00.000Z",
    };
}

function mockIO() {
    const resolveImageCalls: Array<[string | undefined, string]> = [];
    const resolveMediaCalls: Array<[string | undefined, string]> = [];
    const uploaded: string[] = [];
    const storedVideo: string[] = [];
    const storedAudio: string[] = [];
    const fetched: string[] = [];
    const io: GenerationResultMediaIO = {
        resolveImageUrl: async (storageKey, fallback = "") => {
            resolveImageCalls.push([storageKey, fallback]);
            return `resolved-image:${storageKey}:${fallback}`;
        },
        uploadImage: async (src) => {
            uploaded.push(src);
            return { url: "uploaded-image", storageKey: "image:new", width: 12, height: 8, bytes: 4, mimeType: "image/png" };
        },
        resolveMediaUrl: async (storageKey, fallback = "") => {
            resolveMediaCalls.push([storageKey, fallback]);
            return `resolved-media:${storageKey}:${fallback}`;
        },
        storeGeneratedVideo: async (result) => {
            storedVideo.push(result.url || "");
            return { url: "uploaded-video", storageKey: "video:new", bytes: 8, mimeType: "video/mp4", width: 16, height: 9 };
        },
        storeGeneratedAudio: async (blob) => {
            storedAudio.push(blob.type);
            return { url: "uploaded-audio", storageKey: "audio:new", bytes: 8, mimeType: "audio/mpeg", durationMs: 1200 };
        },
        fetchBlob: async (url) => {
            fetched.push(url);
            return new Blob(["x"], { type: "audio/mpeg" });
        },
    };
    return { io, resolveImageCalls, resolveMediaCalls, uploaded, storedVideo, storedAudio, fetched };
}

describe("buildGenerationTaskNodeResult history reuse", () => {
    test("reuses image:/video:/audio: IndexedDB keys without upload even when the blob URL is expired", async () => {
        const { io, resolveImageCalls, resolveMediaCalls, uploaded, storedVideo, storedAudio, fetched } = mockIO();
        const image = await buildGenerationTaskNodeResult(
            mediaNode(CanvasNodeType.Image),
            task("canvas_image", {
                images: [{ dataUrl: "blob:http://127.0.0.1/expired-image", storageKey: "image:local-1", width: 64, height: 36 }],
            }),
            undefined,
            io,
        );
        const video = await buildGenerationTaskNodeResult(
            mediaNode(CanvasNodeType.Video),
            task("canvas_video", {
                video: { dataUrl: "blob:http://127.0.0.1/expired-video", storageKey: "video:local-1", width: 64, height: 36 },
            }),
            undefined,
            io,
        );
        const audio = await buildGenerationTaskNodeResult(
            mediaNode(CanvasNodeType.Audio),
            task("canvas_audio", {
                audio: { dataUrl: "blob:http://127.0.0.1/expired-audio", storageKey: "audio:local-1", durationMs: 1500 },
            }),
            undefined,
            io,
        );

        expect(image.metadata?.storageKey).toBe("image:local-1");
        expect(video.metadata?.storageKey).toBe("video:local-1");
        expect(audio.metadata?.storageKey).toBe("audio:local-1");
        expect(resolveImageCalls).toEqual([["image:local-1", "blob:http://127.0.0.1/expired-image"]]);
        expect(resolveMediaCalls).toEqual([
            ["video:local-1", "blob:http://127.0.0.1/expired-video"],
            ["audio:local-1", "blob:http://127.0.0.1/expired-audio"],
        ]);
        expect(uploaded).toEqual([]);
        expect(storedVideo).toEqual([]);
        expect(storedAudio).toEqual([]);
        expect(fetched).toEqual([]);
    });

    test("reuses owned resource HTTP URLs for image, video, and audio when storageKey is missing", async () => {
        const { io, resolveImageCalls, resolveMediaCalls, uploaded, storedVideo, storedAudio, fetched } = mockIO();
        const imageUrl = "http://127.0.0.1:3184/api/resources/image-owned/file";
        const videoUrl = "http://127.0.0.1:3184/api/resources/video-owned/file";
        const audioUrl = "http://127.0.0.1:3184/api/resources/audio-owned/file";
        const image = await buildGenerationTaskNodeResult(
            mediaNode(CanvasNodeType.Image),
            task("canvas_image", {
                images: [{ dataUrl: imageUrl, width: 64, height: 36 }],
            }),
            undefined,
            io,
        );
        const video = await buildGenerationTaskNodeResult(
            mediaNode(CanvasNodeType.Video),
            task("canvas_video", {
                video: { url: videoUrl, width: 64, height: 36 },
            }),
            undefined,
            io,
        );
        const audio = await buildGenerationTaskNodeResult(
            mediaNode(CanvasNodeType.Audio),
            task("canvas_audio", {
                audio: { dataUrl: audioUrl, durationMs: 1500 },
            }),
            undefined,
            io,
        );

        expect(image.metadata?.storageKey).toBe("resource:image-owned");
        expect(video.metadata?.storageKey).toBe("resource:video-owned");
        expect(audio.metadata?.storageKey).toBe("resource:audio-owned");
        expect(resolveImageCalls[0]?.[0]).toBe("resource:image-owned");
        expect(resolveMediaCalls.map((call) => call[0])).toEqual(["resource:video-owned", "resource:audio-owned"]);
        expect(uploaded).toEqual([]);
        expect(storedVideo).toEqual([]);
        expect(storedAudio).toEqual([]);
        expect(fetched).toEqual([]);
    });
});


test("fixed-output history restores each image from its own index", async () => {
    const { io, resolveImageCalls, uploaded } = mockIO();
    const output = task("canvas_image", { images: Array.from({ length: 4 }, (_, index) => ({ dataUrl: `expired:${index}`, storageKey: `image:four-${index}`, width: 1024, height: 1024 })) });
    for (let index = 0; index < 4; index++) {
        const node = mediaNode(CanvasNodeType.Image);
        node.metadata = { ...node.metadata, taskOutputIndex: index };
        const recovered = await buildGenerationTaskNodeResult(node, output, undefined, io);
        expect(recovered.metadata?.storageKey).toBe(`image:four-${index}`);
    }
    expect(resolveImageCalls.map(([key]) => key)).toEqual(["image:four-0", "image:four-1", "image:four-2", "image:four-3"]);
    expect(uploaded).toEqual([]);
});
