import { beforeEach, expect, mock, test } from "bun:test";
import { setActiveUserScope } from "../src/lib/user-scope";
import { captureUserScope as captureOwner } from "../src/lib/user-scope-guard";
import type { HttpRequestConfig } from "../src/services/api/request";
import type { ResourcePlayback } from "../src/services/api/resources";

const resources = await import("../src/services/api/resources");
let config: HttpRequestConfig | undefined;
let resolvePlayback!: (value: ResourcePlayback) => void;
let pending: Promise<ResourcePlayback>;
mock.module("../src/services/api/resources", () => ({
    ...resources,
    refreshResource: async () => ({ id: "video", playbackStatus: "ready" }),
    getResourcePlayback: (_key: string, requestConfig?: HttpRequestConfig) => { config = requestConfig; return pending; },
}));
const { acquireCanvasVideoSource } = await import("../src/services/canvas-video-source");

beforeEach(() => {
    config = undefined;
    setActiveUserScope("owner-a");
    pending = new Promise((resolve) => { resolvePlayback = resolve; });
});

test("preview forwards cancellation and the captured account to the full download", async () => {
    const expected = captureOwner();
    const controller = new AbortController();
    const request = acquireCanvasVideoSource("resource:video", "", controller.signal);
    await Promise.resolve();
    expect(config?.signal).toBe(controller.signal);
    expect(config?.expectedScope).toEqual(expected);
    controller.abort();
    resolvePlayback({ blob: new Blob(["bytes"]), compatible: false });
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
});

test("A→B→A account changes reject a late media download", async () => {
    const request = acquireCanvasVideoSource("resource:video");
    await Promise.resolve();
    setActiveUserScope("owner-b");
    setActiveUserScope("owner-a");
    resolvePlayback({ blob: new Blob(["bytes"]), compatible: false });
    await expect(request).rejects.toMatchObject({ name: "UserScopeAbandonedError" });
});

test("owned media creates a releasable Blob URL", async () => {
    const request = acquireCanvasVideoSource("resource:video");
    resolvePlayback({ blob: new Blob(["bytes"], { type: "video/mp4" }), compatible: true });
    const source = await request;
    expect(await (await fetch(source.url)).text()).toBe("bytes");
    source.release();
    await expect(fetch(source.url)).rejects.toThrow();
});
