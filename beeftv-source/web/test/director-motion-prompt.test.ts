import { expect, test } from "bun:test";

import { createDirectorMotionPresetKeyframes } from "@/lib/canvas/director/director-camera-paths";
import { compileDirectorPrompt } from "@/lib/canvas/director/director-prompt-compiler";
import { createDirectorReproScene } from "@/lib/canvas/director/director-repro-fixture";

test("已有实际机位运动时输出提示词描述关键帧，不误称固定机位", () => {
    const scene = createDirectorReproScene();
    const camera = scene.cameras[0];
    const shot = scene.shots[0];
    const { keyframes } = createDirectorMotionPresetKeyframes("push_in", "replace", camera, shot.duration);
    const prompt = compileDirectorPrompt({ ...scene, cameras: [{ ...camera, keyframes }] }, shot);
    expect(prompt).toContain("2 个关键帧");
    expect(prompt).toContain("0 秒");
    expect(prompt).toContain("2 秒");
    expect(prompt).not.toContain("固定机位");
});

test("两个姿态相同的摄影机关键帧不会被误称为运镜", () => {
    const scene = createDirectorReproScene();
    const camera = scene.cameras[0];
    const keys = [0, 2].map((time) => ({ id: `same-${time}`, time, transform: camera.transform }));
    const prompt = compileDirectorPrompt({ ...scene, cameras: [{ ...camera, keyframes: keys }] }, scene.shots[0]);
    expect(prompt).toContain("固定机位");
    expect(prompt).not.toContain("执行机位轨迹");
});
