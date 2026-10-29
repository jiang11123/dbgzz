import { describe, expect, it } from "bun:test";

import { resolveCanvasVideoDurationMs } from "../src/lib/canvas/canvas-video-duration";

describe("resolveCanvasVideoDurationMs", () => {
    it("uses the loaded video element duration when node metadata is missing", () => {
        expect(resolveCanvasVideoDurationMs(undefined, 6)).toBe(6000);
    });

    it("prefers persisted node duration when it is available", () => {
        expect(resolveCanvasVideoDurationMs(4200, 6)).toBe(4200);
    });

    it("rejects unavailable or invalid durations", () => {
        expect(resolveCanvasVideoDurationMs(undefined, Number.NaN)).toBe(0);
        expect(resolveCanvasVideoDurationMs(0, 0)).toBe(0);
    });
});
