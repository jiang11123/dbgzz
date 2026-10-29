import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const videoMerge = readFileSync(new URL("../src/lib/canvas/canvas-video-merge.ts", import.meta.url), "utf8");
const faceDetection = readFileSync(new URL("../src/lib/canvas/canvas-face-detection.ts", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("explicit slim release preserves clear optional-media degradation", () => {
    expect(videoMerge).toContain("精简版未包含 FFmpeg");
    expect(faceDetection).toContain("精简版未包含自动人脸识别");
    expect(packageJson.scripts["build:slim"]).toContain("BEEFTV_FULL_MEDIA_RESOURCES=0");
});
