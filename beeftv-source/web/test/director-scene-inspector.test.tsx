import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DirectorSceneInspector } from "@/components/canvas/director/director-scene-inspector";
import { createDirectorSceneFromTemplate } from "@/lib/canvas/director/director-templates";

describe("导演台场景属性", () => {
    test("场景页提供可辨识的天空、光照和网格控件", () => {
        const markup = renderToStaticMarkup(<DirectorSceneInspector scene={createDirectorSceneFromTemplate("empty")} onChange={() => {}} />);
        expect(markup).toContain("3D场景");
        expect(markup).toContain("天空颜色");
        expect(markup).toContain("环境亮度");
        expect(markup).toContain("显示网格");
        expect(markup).toContain('aria-label="显示网格"');
        expect(markup).toContain('aria-label="显示地面"');
        expect(markup).toContain('aria-label="地面透明度"');
        expect(markup).toContain('aria-label="地面高度"');
        expect(markup).toContain('aria-label="场景缩放"');
        for (const axis of ["X", "Y", "Z"]) {
            expect(markup).toContain(`aria-label="场景平移${axis}"`);
            expect(markup).toContain(`aria-label="场景旋转${axis}"`);
        }
        expect(markup.indexOf('aria-label="场景变换"')).toBeLessThan(markup.indexOf('aria-label="全景背景"'));
        expect(markup).toContain('aria-label="角色标签"');
        expect(markup.indexOf('aria-label="角色标签"')).toBeGreaterThan(markup.indexOf('aria-label="全景球"'));
    });

    test("旧场景默认显示角色标签，新场景可显式关闭", () => {
        const scene = createDirectorSceneFromTemplate("empty");
        delete scene.labelsVisible;
        const legacy = renderToStaticMarkup(<DirectorSceneInspector scene={scene} onChange={() => {}} />);
        expect(legacy).toMatch(/<button(?=[^>]*aria-label="角色标签")(?=[^>]*aria-checked="true")[^>]*>/);
        const hidden = renderToStaticMarkup(<DirectorSceneInspector scene={{ ...scene, labelsVisible: false }} onChange={() => {}} />);
        expect(hidden).toMatch(/<button(?=[^>]*aria-label="角色标签")(?=[^>]*aria-checked="false")[^>]*>/);
    });

    test("场景标题后直接是变换控件，天空颜色可从色块或十六进制输入", () => {
        const scene = createDirectorSceneFromTemplate("empty");
        scene.background = "#060608";
        const markup = renderToStaticMarkup(<DirectorSceneInspector scene={scene} onChange={() => {}} />);
        expect(markup).not.toMatch(/<h3[^>]*>场景变换<\/h3>/);
        expect(markup).toMatch(/<input[^>]*type="color"[^>]*value="#060608"/);
        expect(markup).toMatch(/<input[^>]*aria-label="天空颜色色值"[^>]*value="060608"/);
    });
});
