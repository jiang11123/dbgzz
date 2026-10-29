import { describe, expect, test } from "bun:test";
import { isSubtitleFontFailure } from "../src/lib/timeline/subtitle-font-failure";

describe("isSubtitleFontFailure", () => {
    test("treats unrecoverable fontconfig/libass errors as failure", () => {
        for (const message of [
            "can't find selected font provider",
            "fontselect: failed to find any fallback with glyph 0x4E2D",
            "couldn't find font family",
            "missing glyph 0x4E2D",
            "no fonts found",
            "no usable fontconfig",
            "failed to find font NotoSansCJK",
        ]) {
            expect(isSubtitleFontFailure(message)).toBe(true);
        }
    });

    test("does not treat normal Glyph-not-found font fallback as failure", () => {
        for (const message of [
            "Glyph 0x4E2D not found, selecting one more font for (Arial, 400, 0)",
            "fontselect: (Arial, 400, 0) -> NotoSansCJK, 0, NotoSansCJK",
            "fontselect: using Chinese font",
        ]) {
            expect(isSubtitleFontFailure(message)).toBe(false);
        }
    });
});
