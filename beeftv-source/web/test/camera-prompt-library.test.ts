import { describe, expect, test } from "bun:test";

import { APERTURES, CAMERA_PROFILES, FOCAL_LENGTHS, LENS_PROFILES, buildCameraPrompt } from "../src/lib/canvas/camera-prompt-library";

describe("camera prompt contract", () => {
    test("builds a deterministic prompt from registered camera parameters", () => {
        const prompt = buildCameraPrompt({
            cameraId: CAMERA_PROFILES[0].id,
            lensId: LENS_PROFILES[0].id,
            focalLengthMm: FOCAL_LENGTHS[0],
            apertureF: APERTURES[0],
        });

        expect(prompt).toContain(CAMERA_PROFILES[0].shortTag);
        expect(prompt).toContain(LENS_PROFILES[0].shortTag);
    });

    test("rejects unknown persisted parameters instead of silently changing generation semantics", () => {
        const valid = {
            cameraId: CAMERA_PROFILES[0].id,
            lensId: LENS_PROFILES[0].id,
            focalLengthMm: FOCAL_LENGTHS[0],
            apertureF: APERTURES[0],
        };

        expect(() => buildCameraPrompt({ ...valid, cameraId: "unknown-camera" })).toThrow("不支持的相机配置");
        expect(() => buildCameraPrompt({ ...valid, lensId: "unknown-lens" })).toThrow("不支持的镜头配置");
        expect(() => buildCameraPrompt({ ...valid, focalLengthMm: 47 })).toThrow("不支持的焦距");
        expect(() => buildCameraPrompt({ ...valid, apertureF: 3.2 })).toThrow("不支持的光圈");
    });
});
