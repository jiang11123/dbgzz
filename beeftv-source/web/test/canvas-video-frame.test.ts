import { describe, expect, test } from "bun:test";

import { buildVideoFrameNodes } from "../src/lib/canvas/canvas-video-frame-nodes";
import { normalizeVideoFrameTimes, resolveVideoFramePresetTimeMs, videoFrameFetchCredentials, videoFrameSeekSeconds, waitForPresentedVideoFrame } from "../src/lib/canvas/canvas-video-frame";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

const sourceNode: CanvasNodeData = {
    id: "video-source",
    type: CanvasNodeType.Video,
    title: "测试视频",
    position: { x: 100, y: 200 },
    width: 640,
    height: 360,
    metadata: { workflowKind: "shot", workflowTitle: "镜头 1", shotIndex: 1 },
};

describe("normalizeVideoFrameTimes", () => {
    test("按时间排序、去重并限制在可解码范围内", () => {
        expect(normalizeVideoFrameTimes([1500, 0, 1500.4, -20, 16000, Number.NaN], 15000)).toEqual([0, 1500, 14900]);
    });

    test("视频时长无效时不返回时间点", () => {
        expect(normalizeVideoFrameTimes([0, 1000], 0)).toEqual([]);
    });

    test("未预先记录视频时长时，尾帧预设会在视频解码后自动对齐到真实尾帧", () => {
        const presetTimeMs = resolveVideoFramePresetTimeMs("last", 0, 0);
        expect(presetTimeMs).toBe(Number.MAX_SAFE_INTEGER);
        expect(normalizeVideoFrameTimes([presetTimeMs], 8000)).toEqual([7900]);
    });
});

describe("resolveVideoFramePresetTimeMs & videoFrameFetchCredentials", () => {
    test("支持首帧、当前帧与已知/未知时长的尾帧计算", () => {
        expect(resolveVideoFramePresetTimeMs("first", 6000, 2300)).toBe(0);
        expect(resolveVideoFramePresetTimeMs("current", 6000, 2300)).toBe(2300);
        expect(resolveVideoFramePresetTimeMs("last", 6000, 2300)).toBe(5999);
        expect(resolveVideoFramePresetTimeMs("last", 0, 0)).toBe(Number.MAX_SAFE_INTEGER);
    });

    test("区分受保护资源路径与跨源 CDN 直链的凭据策略", () => {
        expect(videoFrameFetchCredentials("/api/resources/res-123/file")).toBe("include");
        expect(videoFrameFetchCredentials("http://127.0.0.1:8080/api/resources/res-123/file")).toBe("include");
        expect(videoFrameFetchCredentials("blob:http://localhost:5173/abc")).toBe("same-origin");
    });
});

describe("videoFrameSeekSeconds", () => {
    test("首帧也强制 seek 到可解码时间点，避免缓存视频在 0ms 画出黑帧", () => {
        expect(videoFrameSeekSeconds(0, 6000)).toBe(0.001);
        expect(videoFrameSeekSeconds(1500, 6000)).toBe(1.5);
        expect(videoFrameSeekSeconds(14900, 15000)).toBe(14.9);
    });
});

describe("waitForPresentedVideoFrame", () => {
    test("requestVideoFrameCallback 触发前不允许继续绘制", async () => {
        let callback: (() => void) | undefined;
        let resolved = false;
        const video = {
            requestVideoFrameCallback: (next: () => void) => {
                callback = next;
                return 1;
            },
            play: async () => undefined,
            pause: () => undefined,
        } as unknown as HTMLVideoElement;

        const presented = waitForPresentedVideoFrame(video, 1000).then(() => { resolved = true; });
        await Promise.resolve();
        expect(resolved).toBe(false);
        callback?.();
        await presented;
        expect(resolved).toBe(true);
    });

    test("取帧时主动解码播放，并在视频帧真实呈现后暂停", async () => {
        const calls: string[] = [];
        let callback: (() => void) | undefined;
        const video = {
            requestVideoFrameCallback: (next: () => void) => {
                callback = next;
                return 1;
            },
            cancelVideoFrameCallback: () => calls.push("cancel-frame"),
            play: async () => {
                calls.push("play");
                callback?.();
            },
            pause: () => calls.push("pause"),
        } as unknown as HTMLVideoElement;

        await waitForPresentedVideoFrame(video, 1000);

        expect(calls).toEqual(["play", "pause"]);
    });

    test("视频没有真实呈现帧时失败，不把未解码的黑画面作为结果保存", async () => {
        const video = {
            requestVideoFrameCallback: () => 1,
            cancelVideoFrameCallback: () => undefined,
            play: async () => undefined,
            pause: () => undefined,
        } as unknown as HTMLVideoElement;

        await expect(waitForPresentedVideoFrame(video, 1)).rejects.toThrow("视频画面解码超时");
    });

    test("seek 到尾帧附近时等待真正呈现的视频帧，不依赖 ended 后的黑画面", async () => {
        const events = new EventTarget();
        let paused = false;
        let framePresented = false;
        const video = {
            duration: 14,
            currentTime: 13.9,
            addEventListener: events.addEventListener.bind(events),
            removeEventListener: events.removeEventListener.bind(events),
            requestVideoFrameCallback: (callback: () => void) => {
                queueMicrotask(() => {
                    framePresented = true;
                    callback();
                });
                return 1;
            },
            play: async () => {
                queueMicrotask(() => events.dispatchEvent(new Event("ended")));
            },
            pause: () => { paused = true; },
        } as unknown as HTMLVideoElement;

        await waitForPresentedVideoFrame(video, 100);

        expect(paused).toBe(true);
        expect(framePresented).toBe(true);
    });
});

describe("buildVideoFrameNodes", () => {
    test("为每个时间点创建可追溯的图片节点并保持网格布局", () => {
        const nodes = buildVideoFrameNodes(sourceNode, [
            { timeMs: 0, image: { url: "blob:first", storageKey: "image:first", width: 1280, height: 720, bytes: 10, mimeType: "image/png" } },
            { timeMs: 1500, image: { url: "blob:middle", storageKey: "image:middle", width: 1280, height: 720, bytes: 20, mimeType: "image/png" } },
            { timeMs: 14999, image: { url: "blob:last", storageKey: "image:last", width: 1280, height: 720, bytes: 30, mimeType: "image/png" } },
        ]);

        expect(nodes).toHaveLength(3);
        expect(nodes.every((node) => node.type === CanvasNodeType.Image && node.title.startsWith("截图 "))).toBe(true);
        expect(new Set(nodes.map((node) => node.id)).size).toBe(3);
        expect(nodes.map((node) => node.metadata?.videoFrameTimeMs)).toEqual([0, 1500, 14999]);
        expect(nodes.every((node) => node.metadata?.videoFrameSourceNodeId === sourceNode.id)).toBe(true);
        expect(nodes.every((node) => node.metadata?.workflowKind === "shot" && node.metadata?.shotIndex === 1)).toBe(true);
        expect(nodes[0].position.x).toBe(sourceNode.position.x + sourceNode.width + 96);
        expect(nodes[1].position.x).toBeGreaterThan(nodes[0].position.x);
        expect(nodes[2].position.y).toBeGreaterThan(nodes[0].position.y);
    });

    test("重复截取同一视频时把新结果放在已有结果之外", () => {
        const frame = { timeMs: 0, image: { url: "blob:first", storageKey: "image:first", width: 1280, height: 720, bytes: 10, mimeType: "image/png" } };
        const first = buildVideoFrameNodes(sourceNode, [frame]);
        const second = buildVideoFrameNodes(sourceNode, [frame], [sourceNode, ...first]);

        const firstRight = first[0].position.x + first[0].width;
        const firstBottom = first[0].position.y + first[0].height;
        const secondRight = second[0].position.x + second[0].width;
        const secondBottom = second[0].position.y + second[0].height;
        const separated = second[0].position.x >= firstRight
            || secondRight <= first[0].position.x
            || second[0].position.y >= firstBottom
            || secondBottom <= first[0].position.y;

        expect(separated).toBe(true);
    });
});
