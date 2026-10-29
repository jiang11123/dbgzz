import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { directorClayVideoMetadata, isSilentDirectorClayVideo } from "../src/lib/canvas/director/director-clay-output";
import { DirectorExportNotice } from "../src/components/canvas/director/director-export-notice";
import { normalizeVideoPlayerMimeType } from "../src/components/video-player";
import { canvasNodeVideoPreviewUrl } from "../src/lib/canvas/canvas-media-preview";
import { CanvasNodeType } from "../src/types/canvas";

const image = { url: "/api/resources/cover/file", storageKey: "resource:cover", width: 1280, height: 720, bytes: 2000, mimeType: "image/png" };
const video = { url: "/api/resources/clay/file", storageKey: "resource:clay", bytes: 3000, mimeType: "video/webm" };

test("导演台白膜视频复用已导出的构图作封面，并明确标记静音以允许画布自动播放", () => {
    const metadata = directorClayVideoMetadata(video, image);
    expect(metadata.content).toBe(video.url);
    expect(metadata.storageKey).toBe(video.storageKey);
    expect(metadata.hasAudio).toBe(false);
    expect(metadata.videoPreview).toMatchObject({ content: image.url, storageKey: image.storageKey, sourceKey: video.storageKey });
    expect(canvasNodeVideoPreviewUrl({ id: "clay", type: CanvasNodeType.Video, title: "白膜视频", position: { x: 0, y: 0 }, width: 360, height: 220, metadata })).toBe(image.url);
});

test("视频本身已有可用封面时优先使用视频封面", () => {
    const preview = { ...image, url: "/api/resources/video-poster/file", storageKey: "resource:video-poster" };
    const metadata = directorClayVideoMetadata({ ...video, preview }, image);
    expect(metadata.videoPreview?.content).toBe(preview.url);
    expect(metadata.videoPreview?.sourceKey).toBe(video.storageKey);
});

test("录制器的 WebM codec 参数不会让画布播放器误按 MP4 解析", () => {
    const metadata = directorClayVideoMetadata({ ...video, mimeType: "video/webm;codecs=vp9" }, image);
    expect(metadata.mimeType).toBe("video/webm");
    expect(normalizeVideoPlayerMimeType("video/webm;codecs=vp9")).toBe("video/webm");
    expect(normalizeVideoPlayerMimeType("video/mp4;codecs=avc1")).toBe("video/mp4");
});

test("已导出的旧白膜节点仍识别为静音", () => {
    expect(isSilentDirectorClayVideo({ workflowKind: "reference_video", assetTags: ["导演台白膜"] })).toBe(true);
    expect(isSilentDirectorClayVideo({ workflowKind: "reference_video", assetTags: ["其他视频"] })).toBe(false);
});

test("导演台导出成功与失败反馈均可在工作台内直接看到", () => {
    const success = renderToStaticMarkup(<DirectorExportNotice kind="success" text="白膜视频已导出，可在画布中预览播放" />);
    const warning = renderToStaticMarkup(<DirectorExportNotice kind="warning" text="白膜视频已导出，文件目前只在这台设备上" />);
    const error = renderToStaticMarkup(<DirectorExportNotice kind="error" text="导出失败，请重试" />);
    expect(success).toContain('role="status"');
    expect(success).toContain("白膜视频已导出，可在画布中预览播放");
    expect(warning).toContain('role="status"');
    expect(warning).toContain("白膜视频已导出，文件目前只在这台设备上");
    expect(error).toContain('role="alert"');
    expect(error).toContain("导出失败，请重试");
});
