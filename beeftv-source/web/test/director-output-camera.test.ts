import { expect, test } from "bun:test";

import { restoreDirectorPlaybackOnEnd, waitForDirectorCaptureCamera } from "../src/lib/canvas/director/director-output-camera";

test("关闭录制同步归还播放状态，旧录制迟到的 finally 不覆盖重开会话", () => {
    const controller = new AbortController();
    let state = { playing: false, playhead: 3, viewMode: "free" };
    const initial = state;
    let restores = 0;
    const finish = restoreDirectorPlaybackOnEnd(controller.signal, () => { state = initial; restores++; });
    state = { playing: true, playhead: 0, viewMode: "camera" };
    controller.abort();
    expect(state).toEqual(initial);
    state = { playing: false, playhead: 8, viewMode: "orthographic" };
    finish();
    expect(state.playhead).toBe(8);
    expect(restores).toBe(1);
});

test("输出须等活动机位接管渲染并稳定一帧才开始录制", async () => {
    let camera: "free" | "camera" | null = "free";
    let frames = 0;
    await waitForDirectorCaptureCamera(() => camera, async () => {
        frames += 1;
        if (frames === 2) camera = "camera";
    });
    expect(frames).toBe(3);
});

test("无有效机位时不录制导演观察视角", async () => {
    let frames = 0;
    await expect(waitForDirectorCaptureCamera(() => "free", async () => { frames += 1; }, 3)).rejects.toThrow("没有可用机位");
    expect(frames).toBe(3);
});
