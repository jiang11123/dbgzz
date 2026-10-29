import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { createDirectorReproScene } from "../src/lib/canvas/director/director-repro-fixture";
import { DirectorCameraScreenshotTabs, groupDirectorCameraScreenshots } from "../src/components/canvas/director/director-camera-screenshot-tabs";
import type { DirectorScreenshot } from "../src/types/director";

const screenshot = (id: string): DirectorScreenshot => ({ id, name: `${id}-shot-01`, storageKey: `resource:${id}`, url: `/api/resources/${id}`, width: 640, height: 360, createdAt: "2026-09-29T00:00:00.000Z" });

describe("导演台摄影机截图页", () => {
    test("汇总所有镜头的截图并按摄影机归组，不丢掉其他镜头", () => {
        const scene = createDirectorReproScene();
        const first = scene.cameras[0];
        const second = { ...first, id: "camera-two", name: "机位2" };
        const shot = scene.shots[0];
        const withCaptures = { ...scene, cameras: [first, second], shots: [
            { ...shot, screenshots: [screenshot("first")] },
            { ...shot, id: "shot-two", cameraId: second.id, screenshots: [screenshot("second")] },
            { ...shot, id: "shot-three", screenshots: [screenshot("third")] },
        ] };
        expect(groupDirectorCameraScreenshots(withCaptures)).toEqual([
            { cameraId: first.id, cameraName: first.name, screenshots: [screenshot("first"), screenshot("third")] },
            { cameraId: second.id, cameraName: "机位2", screenshots: [screenshot("second")] },
        ]);
    });

    test("默认显示属性页并暴露可切换的截图页", () => {
        const scene = createDirectorReproScene();
        const html = renderToStaticMarkup(createElement(DirectorCameraScreenshotTabs, { scene, children: createElement("span", null, "可编辑镜头参数") }));
        expect(html).toContain("摄像机");
        expect(html).toContain('role="tab" aria-selected="true"');
        expect(html).toContain("可编辑镜头参数");
        expect(html).toContain("截图");
    });

    test("截图页展示跨镜头内容，不把属性控件重复渲染进去", () => {
        const scene = createDirectorReproScene();
        const withCapture = { ...scene, shots: scene.shots.map((shot) => ({ ...shot, screenshots: [screenshot("first")] })) };
        const html = renderToStaticMarkup(createElement(DirectorCameraScreenshotTabs, { scene: withCapture, tab: "screenshots", children: createElement("span", null, "可编辑镜头参数") }));
        expect(html).toContain("first-shot-01");
        expect(html).toContain(`${scene.cameras[0].name}截图`);
        expect(html).not.toContain("可编辑镜头参数");
    });

    test("运动轨迹页只显示机位运动控制，不混入属性或截图", () => {
        const scene = createDirectorReproScene();
        const html = renderToStaticMarkup(createElement(DirectorCameraScreenshotTabs, {
            scene,
            tab: "motion",
            motionContent: createElement("span", null, "可编辑轨迹参数"),
            children: createElement("span", null, "可编辑镜头参数"),
        }));
        expect(html).toContain("运动轨迹");
        expect(html).toContain("可编辑轨迹参数");
        expect(html).not.toContain("可编辑镜头参数");
    });
});
