import { expect, test } from "bun:test";
import { shouldUseTaskTextEvents } from "../src/services/api/task-center";
import { shouldEnableCanvasActiveTaskQuery } from "../src/pages/canvas/use-canvas-active-tasks";

test("media task waits use durable task status polling instead of the text-only SSE path", () => {
    expect(shouldUseTaskTextEvents({})).toBe(false);
    expect(shouldUseTaskTextEvents({ onTaskUpdate: () => undefined })).toBe(false);
});

test("text generation opts into resumable SSE when it needs text deltas", () => {
    expect(shouldUseTaskTextEvents({ onTextDelta: () => undefined })).toBe(true);
    expect(shouldUseTaskTextEvents({ useTextEvents: true })).toBe(true);
});

test("local canvas task panel continues querying authoritative task state", () => {
    expect(shouldEnableCanvasActiveTaskQuery(true, "local-project")).toBe(true);
    expect(shouldEnableCanvasActiveTaskQuery(false, "local-project")).toBe(false);
    expect(shouldEnableCanvasActiveTaskQuery(true, "")).toBe(false);
});
