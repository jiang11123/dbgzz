import { expect, test } from "bun:test";

import { ApiError } from "../src/services/api/request";
import { isIgnorablePlanPreviewError, RENDER_PLAN_PREVIEW_DEBOUNCE_MS } from "../src/lib/timeline/timeline-plan-preview";

test("plan preview debounce is slower than typical edit bursts", () => {
    expect(RENDER_PLAN_PREVIEW_DEBOUNCE_MS).toBeGreaterThanOrEqual(500);
});

test("cancelled and rate-limited plan preview errors stay off the editor", () => {
    const aborted = new AbortController();
    aborted.abort();
    expect(isIgnorablePlanPreviewError(new Error("too many requests"), aborted.signal)).toBe(true);
    expect(isIgnorablePlanPreviewError(new DOMException("请求已取消", "AbortError"))).toBe(true);
    expect(isIgnorablePlanPreviewError(Object.assign(new Error("请求已取消"), { name: "AbortError" }))).toBe(true);
    expect(isIgnorablePlanPreviewError(new ApiError("请求过于频繁", { status: 429 }))).toBe(true);
    expect(isIgnorablePlanPreviewError(new Error("时间线没有可渲染的媒体片段"))).toBe(false);
});
