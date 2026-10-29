import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DirectorWorkbenchRail } from "@/components/canvas/director/director-workbench-rail";

describe("导演台左侧导航", () => {
    test("所有可见入口都有名称，当前入口明确标记", () => {
        const markup = renderToStaticMarkup(<DirectorWorkbenchRail active="scene" onChange={() => {}} onHelp={() => {}} />);
        for (const label of ["场景", "添加角色", "添加机位", "选择画幅比例", "AI 识图导入"]) expect(markup).toContain(`aria-label="${label}"`);
        expect(markup).toContain('aria-label="场景" aria-pressed="true"');
        expect(markup).toContain('aria-label="添加角色" aria-pressed="false"');
        expect(markup).toContain('aria-label="帮助与快捷键"');
        expect(markup).toContain('data-director-rail-help="true"');
        expect(markup).toContain('class="h-2 w-8 border-b"');
        expect(markup).toContain('class="flex size-8 items-center justify-center');
    });
});
