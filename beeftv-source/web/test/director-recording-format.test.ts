import { expect, test } from "bun:test";

import { selectDirectorRecordingMimeType, waitForDirectorDecodedFrame } from "../src/lib/canvas/director/director-recording-format";

test("导演台优先录制桌面端可播放的 H.264 MP4，而不是 VP9 WebM", () => {
    const supported = new Set(["video/mp4;codecs=avc1.42E01E", "video/webm;codecs=vp9"]);
    expect(selectDirectorRecordingMimeType((type) => supported.has(type))).toBe("video/mp4;codecs=avc1.42E01E");
});

test("录制环境不支持 MP4 时才退回可用的 WebM", () => {
    expect(selectDirectorRecordingMimeType((type) => type === "video/webm;codecs=vp8")).toBe("video/webm;codecs=vp8");
});

test("只读到媒体时长不算导出成功，必须等到可解码的首帧", async () => {
    const video = new EventTarget() as HTMLVideoElement;
    let settled = false;
    const pending = waitForDirectorDecodedFrame(video, 100).then(() => { settled = true; });
    video.dispatchEvent(new Event("loadedmetadata"));
    await Promise.resolve();
    expect(settled).toBe(false);
    video.dispatchEvent(new Event("loadeddata"));
    await pending;
    expect(settled).toBe(true);
});

test("媒体解码报错时拒绝把视频回写为成功节点", async () => {
    const video = new EventTarget() as HTMLVideoElement;
    const pending = waitForDirectorDecodedFrame(video, 100);
    video.dispatchEvent(new Event("loadedmetadata"));
    video.dispatchEvent(new Event("error"));
    await expect(pending).rejects.toThrow("无法解码");
});
