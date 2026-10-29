import { describe, expect, test } from "bun:test";

import { CANVAS_DEVELOPING_LABEL, getCanvasNodeCreationDisabledReason, isCanvasNodeCreationEnabled } from "../src/lib/canvas/canvas-feature-availability";
import { CanvasNodeType } from "../src/types/canvas";

describe("canvas developing features", () => {
    test.each([CanvasNodeType.MediaConversion, CanvasNodeType.Frame, CanvasNodeType.Script])("blocks creation of %s", (type) => {
        expect(getCanvasNodeCreationDisabledReason(type)).toBe(CANVAS_DEVELOPING_LABEL);
        expect(isCanvasNodeCreationEnabled(type)).toBeFalse();
    });

    test("keeps released media generation nodes available", () => {
        for (const type of [CanvasNodeType.Text, CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio]) {
            expect(getCanvasNodeCreationDisabledReason(type)).toBeUndefined();
            expect(isCanvasNodeCreationEnabled(type)).toBeTrue();
        }
    });
});
