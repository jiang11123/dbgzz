import { afterEach, expect, test } from "bun:test";
import { apiClient } from "../src/services/api/request";
import { resolveResourceVideoPlayback } from "../src/services/resource-video-playback";

const originalAdapter = apiClient.defaults.adapter;
afterEach(() => { apiClient.defaults.adapter = originalAdapter; });

test("就绪记录缺少副本时，返回的原件仍可触发解码失败恢复", async () => {
    const original = new Blob(["HEVC"], { type: "video/mp4" });
    const urls: string[] = [];
    apiClient.defaults.adapter = async (config) => {
        urls.push(config.url!);
        return { data: config.url!.includes("/file") ? original : { code: 0, data: { resource: { id: "missing-copy", playbackStatus: "ready" } } }, status: 200, statusText: "OK", headers: { etag: '"original"' }, config };
    };
    expect(await resolveResourceVideoPlayback("resource:missing-copy", "original", new AbortController().signal)).toEqual({ blob: original, compatible: false });
    expect(urls).toEqual(["/resources/missing-copy", "/resources/missing-copy/file?variant=playback&proxy=1"]);
});

test("等待兼容副本就绪再拉取播放文件，原视频不作为副本缓存", async () => {
    const urls: string[] = [];
    let polls = 0;
    const compatible = new Blob(["H264"], { type: "video/mp4" });
    apiClient.defaults.adapter = async (config) => {
        urls.push(config.url!);
        return { data: config.url!.includes("/file") ? compatible : { code: 0, data: { resource: { id: "hevc-ready", playbackStatus: ++polls === 1 ? "processing" : "ready" } } }, status: 200, statusText: "OK", headers: { etag: '"preview:pb"' }, config };
    };
    expect(await resolveResourceVideoPlayback("resource:hevc-ready", "original", new AbortController().signal)).toEqual({ blob: compatible, compatible: true });
    expect(urls).toEqual(["/resources/hevc-ready", "/resources/hevc-ready", "/resources/hevc-ready/file?variant=playback&proxy=1"]);
});

test("关闭视频中止等待，不继续下载兼容副本", async () => {
    let requests = 0;
    const controller = new AbortController();
    apiClient.defaults.adapter = async (config) => {
        requests++;
        return { data: { code: 0, data: { resource: { id: "hevc-cancel", playbackStatus: "processing" } } }, status: 200, statusText: "OK", headers: {}, config };
    };
    const pending = resolveResourceVideoPlayback("resource:hevc-cancel", "original", controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toBeTruthy();
    expect(requests).toBe(1);
});

test("兼容副本失败保留原文件地址并返回可读错误，不下载坏副本", async () => {
    let requests = 0;
    apiClient.defaults.adapter = async (config) => {
        requests++;
        return { data: { code: 0, data: { resource: { id: "hevc-failed", playbackStatus: "failed" } } }, status: 200, statusText: "OK", headers: {}, config };
    };
    await expect(resolveResourceVideoPlayback("resource:hevc-failed", "original", new AbortController().signal, true)).rejects.toThrow("视频已导入");
    expect(requests).toBe(2);
});

test("浏览器解码失败后才申请兼容预览", async () => {
    const urls: string[] = [];
    const compatible = new Blob(["H264"], { type: "video/mp4" });
    apiClient.defaults.adapter = async (config) => {
        urls.push(config.url!);
        const resource = { id: "hevc-demand", playbackStatus: config.method === "post" ? "ready" : "none" };
        return { data: config.url!.includes("/file") ? compatible : { code: 0, data: { resource } }, status: 200, statusText: "OK", headers: { etag: '"preview:pb"' }, config };
    };
    expect(await resolveResourceVideoPlayback("resource:hevc-demand", "original", new AbortController().signal, true)).toEqual({ blob: compatible, compatible: true });
    expect(urls).toEqual(["/resources/hevc-demand", "/resources/hevc-demand/playback", "/resources/hevc-demand/file?variant=playback&proxy=1"]);
});
