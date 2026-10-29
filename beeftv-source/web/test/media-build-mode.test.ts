import { describe, expect, test } from "bun:test";

const mediaBuildMode = await import("../media-build-mode").catch(() => ({}));

describe("media build mode", () => {
    test("ships FFmpeg media resources by default and only disables them explicitly", () => {
        expect(typeof mediaBuildMode.resolveHeavyMediaEnabled).toBe("function");
        if (!("resolveHeavyMediaEnabled" in mediaBuildMode)) return;

        expect(mediaBuildMode.resolveHeavyMediaEnabled(undefined)).toBe(true);
        expect(mediaBuildMode.resolveHeavyMediaEnabled("1")).toBe(true);
        expect(mediaBuildMode.resolveHeavyMediaEnabled("0")).toBe(false);
    });
});
