import { describe, expect, test } from "bun:test";

import { createDirectorReproScene } from "../src/lib/canvas/director/director-repro-fixture";
import { appendDirectorScreenshot, nextDirectorScreenshotName } from "../src/lib/canvas/director/director-session";

const capture = {
    id: "capture-1", name: "主摄影机-shot-01", storageKey: "resource:image-1", url: "/api/resources/image-1",
    width: 1920, height: 1080, createdAt: "2026-09-29T00:00:00.000Z",
};

describe("导演台相机截图记录", () => {
    test("附加到指定镜头且保留期间对场景做的其他编辑", () => {
        const scene = createDirectorReproScene();
        const edited = { ...scene, title: "上传期间的新标题" };
        const next = appendDirectorScreenshot(edited, { sceneId: scene.id, shotId: scene.activeShotId, screenshot: capture });
        expect(next.title).toBe("上传期间的新标题");
        expect(next.shots.find((shot) => shot.id === scene.activeShotId)?.screenshots).toEqual([capture]);
        expect(edited.shots.find((shot) => shot.id === scene.activeShotId)?.screenshots).toBeUndefined();
    });

    test("场景或镜头已被切换或删除时不写入错误位置", () => {
        const scene = createDirectorReproScene();
        expect(appendDirectorScreenshot(scene, { sceneId: "other-scene", shotId: scene.activeShotId, screenshot: capture })).toBe(scene);
        expect(appendDirectorScreenshot(scene, { sceneId: scene.id, shotId: "missing-shot", screenshot: capture })).toBe(scene);
    });

    test("每次截图采用机位名与递增编号，不复用上一张名称", () => {
        expect(nextDirectorScreenshotName("机位3", 0)).toBe("机位3-shot-01");
        expect(nextDirectorScreenshotName("机位3", 1)).toBe("机位3-shot-02");
    });
});
