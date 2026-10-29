import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DirectorScreenshotGallery } from "../src/components/canvas/director/director-screenshot-gallery";

describe("导演台截图历史展示", () => {
    test("当前镜头有截图时显示可辨识的图片与名称", () => {
        const html = renderToStaticMarkup(createElement(DirectorScreenshotGallery, { screenshots: [{ id: "one", name: "机位3-shot-01", storageKey: "resource:image-1", url: "/api/resources/image-1", width: 1920, height: 1080, createdAt: "2026-09-29T00:00:00.000Z" }] }));
        expect(html).toContain("相机截图");
        expect(html).toContain("机位3-shot-01");
        expect(html).toContain('alt="机位3-shot-01"');
    });

    test("摄影机截图页使用方形缩略图且不叠加卡片边框", () => {
        const html = renderToStaticMarkup(createElement(DirectorScreenshotGallery, { title: "机位3截图", compact: true, screenshots: [{ id: "one", name: "机位3-shot-01", storageKey: "resource:image-1", url: "/api/resources/image-1", width: 1920, height: 1080, createdAt: "2026-09-29T00:00:00.000Z" }] }));
        expect(html).toContain("机位3截图");
        expect(html).toContain("aspect-square");
        expect(html).not.toContain("rounded-lg border");
    });
});
