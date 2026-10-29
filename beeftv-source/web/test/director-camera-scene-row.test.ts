import { describe, expect, test } from "bun:test";
import { createDirectorScene, toggleDirectorCameraLock, toggleDirectorCameraVisibility, visibleDirectorCameras } from "../src/lib/canvas/director/director-scene";
import { resolveDirectorActiveCamera } from "../src/lib/canvas/director/director-view-modes";

describe("导演台机位场景行", () => {
    test("隐藏当前机位只隐藏编辑器辅助图形，不更改镜头引用或机位取景", () => {
        const scene = createDirectorScene();
        const camera = scene.cameras[0];
        const hidden = toggleDirectorCameraVisibility(scene, camera.id);
        expect(hidden.cameras[0].visible).toBe(false);
        expect(visibleDirectorCameras(hidden)).toEqual([]);
        expect(hidden.shots).toEqual(scene.shots);
        expect(resolveDirectorActiveCamera(hidden)?.id).toBe(camera.id);
        expect(toggleDirectorCameraVisibility(hidden, camera.id).cameras[0].visible).toBe(true);
        expect(visibleDirectorCameras(scene)).toEqual(scene.cameras);
    });

    test("机位锁定可切换，未知机位不产生历史变更", () => {
        const scene = createDirectorScene();
        const camera = scene.cameras[0];
        expect(toggleDirectorCameraLock(scene, camera.id).cameras[0].locked).toBe(true);
        expect(toggleDirectorCameraLock(toggleDirectorCameraLock(scene, camera.id), camera.id).cameras[0].locked).toBe(false);
        expect(toggleDirectorCameraLock(scene, "missing")).toBe(scene);
        expect(toggleDirectorCameraVisibility(scene, "missing")).toBe(scene);
    });
});
