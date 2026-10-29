import { videoMetadata } from "@/lib/canvas/canvas-generation-task-sync";
import { CANVAS_VIDEO_PREVIEW_VERSION } from "@/services/canvas-video-preview";
import type { UploadedFile } from "@/services/file-storage";
import type { UploadedImage } from "@/services/image-storage";
import type { CanvasNodeMetadata } from "@/types/canvas";

export function isSilentDirectorClayVideo(metadata: CanvasNodeMetadata | undefined) {
    return metadata?.workflowKind === "reference_video" && metadata.assetTags?.includes("导演台白膜") === true;
}

/** The director records a canvas-only stream, so its exported clip has no audio track. */
export function directorClayVideoMetadata(video: UploadedFile, beauty: UploadedImage) {
    const metadata = videoMetadata(video);
    const cover = video.preview || beauty;
    return {
        ...metadata,
        mimeType: metadata.mimeType?.split(";", 1)[0]?.trim() || "video/webm",
        hasAudio: false,
        videoPreview: {
            content: cover.url,
            storageKey: cover.storageKey,
            width: cover.width,
            height: cover.height,
            bytes: cover.bytes,
            mimeType: cover.mimeType,
            captureVersion: CANVAS_VIDEO_PREVIEW_VERSION,
            sourceKey: video.storageKey || video.url,
        },
    };
}
