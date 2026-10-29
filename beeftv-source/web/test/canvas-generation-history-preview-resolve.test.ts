import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { generationHistoryPreviewImageSrc, generationHistoryPreviewStorageKey } from "../src/components/canvas/canvas-generation-history-picker";
import type { GenerationTask } from "../src/services/api/task-center";

const picker = readFileSync(resolve(import.meta.dir, "../src/components/canvas/canvas-generation-history-picker.tsx"), "utf8");
const cachedImage = readFileSync(resolve(import.meta.dir, "../src/components/cached-resource-image.tsx"), "utf8");

function task(partial: Partial<GenerationTask> & Pick<GenerationTask, "id" | "type">): GenerationTask {
    return {
        projectId: "I_96aFkPCCdKBLz2pzja8",
        status: "succeeded",
        prompt: "历史图片",
        attempts: 1,
        createdAt: "2026-09-24T00:00:00.000Z",
        updatedAt: "2026-09-24T00:00:00.000Z",
        ...partial,
    } as GenerationTask;
}

describe("generation history preview after desktop restart", () => {
    test("stale blob plus owned resource resolves to authenticated storageKey, not a naked resource file URL", () => {
        const staleBlob = "blob:wails://wails/4a3118ed-4b31-4132-8e87-0fdc74bec5a9";
        const resourceUrl = "http://127.0.0.1:61688/api/resources/de82573cf3d87261e67ac3ff8b98d53e/file";
        const imageTask = task({
            id: "task-stale-blob",
            type: "canvas_image",
            previewUrl: staleBlob,
            resultJson: JSON.stringify({
                mode: "image",
                images: [{ dataUrl: staleBlob, url: resourceUrl, storageKey: "resource:de82573cf3d87261e67ac3ff8b98d53e" }],
            }),
        });

        expect(generationHistoryPreviewStorageKey(imageTask)).toBe("resource:de82573cf3d87261e67ac3ff8b98d53e");
        expect(generationHistoryPreviewImageSrc(imageTask)).toBe("");
        expect(generationHistoryPreviewImageSrc(imageTask)).not.toBe(staleBlob);
        expect(generationHistoryPreviewImageSrc(imageTask)).not.toBe(resourceUrl);

        const restartedTask = task({
            id: "task-restarted-resource",
            type: "canvas_image",
            previewUrl: resourceUrl,
            resultJson: JSON.stringify({
                mode: "image",
                images: [{ dataUrl: resourceUrl, url: resourceUrl, storageKey: "resource:de82573cf3d87261e67ac3ff8b98d53e" }],
            }),
        });
        expect(generationHistoryPreviewStorageKey(restartedTask)).toBe("resource:de82573cf3d87261e67ac3ff8b98d53e");
        expect(generationHistoryPreviewImageSrc(restartedTask)).toBe("");

        expect(picker).toContain("<CachedResourceImage storageKey={storageKey}");
        expect(picker).not.toContain("resourceFileUrl");
        expect(cachedImage).toContain("cacheResourceObjectUrl(storageKey)");
    });

    test("live blob-only local media remains an inline image source", () => {
        const liveBlob = "blob:http://127.0.0.1:3184/908e7474-0026-4812-bd0d-37a1a8442893";
        const imageTask = task({
            id: "task-live-blob",
            type: "canvas_image",
            previewUrl: liveBlob,
            resultJson: JSON.stringify({
                mode: "image",
                images: [{ dataUrl: liveBlob, storageKey: "image:local-1" }],
            }),
        });
        expect(generationHistoryPreviewStorageKey(imageTask)).toBe("");
        expect(generationHistoryPreviewImageSrc(imageTask)).toBe(liveBlob);
    });

    test("audio stays icon-only and video files are not used as image sources", () => {
        const audioUrl = "http://127.0.0.1:3184/api/resources/audio-owned/file";
        const audioTask = task({
            id: "task-audio",
            type: "canvas_audio",
            previewUrl: audioUrl,
            resultJson: JSON.stringify({ mode: "audio", audio: { dataUrl: audioUrl, storageKey: "resource:audio-owned" } }),
        });
        const videoTask = task({
            id: "task-video",
            type: "canvas_video",
            previewUrl: "http://127.0.0.1:3184/api/resources/video-owned/file",
            resultJson: JSON.stringify({ mode: "video", video: { dataUrl: "http://127.0.0.1:3184/api/resources/video-owned/file" } }),
        });
        const posterTask = task({
            id: "task-video-poster",
            type: "canvas_video",
            previewPosterUrl: "data:image/png;base64,poster",
            resultJson: JSON.stringify({ mode: "video", video: { dataUrl: "http://127.0.0.1:3184/api/resources/video-owned/file", previewUrl: "data:image/png;base64,poster" } }),
        });

        expect(generationHistoryPreviewImageSrc(audioTask)).toBe("");
        expect(generationHistoryPreviewStorageKey(audioTask)).toBe("");
        expect(generationHistoryPreviewImageSrc(videoTask)).toBe("");
        expect(generationHistoryPreviewStorageKey(videoTask)).toBe("");
        expect(generationHistoryPreviewImageSrc(posterTask)).toBe("data:image/png;base64,poster");
        expect(generationHistoryPreviewStorageKey(posterTask)).toBe("");
    });
});
