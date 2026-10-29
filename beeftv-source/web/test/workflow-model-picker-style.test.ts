import { expect, test } from "bun:test";

test("分镜生成模型选择器具有明确的下拉控件状态", async () => {
    const css = await Bun.file(new URL("../src/pages/projects/detail/workflow.css", import.meta.url)).text();
    const rule = css.match(/\.workflow-model-picker\.canvas-composer-model-picker\s*\{([\s\S]*?)\}/)?.[1] || "";

    expect(rule).toContain("border: 1px solid var(--workspace-border-strong)");
    expect(rule).toContain("height: 44px");
    expect(css).toContain('.workflow-model-picker.canvas-composer-model-picker[aria-expanded="true"]');
    expect(css).toContain(".workflow-model-picker .canvas-model-picker-chevron");
    expect(css).toContain("box-shadow: 0 0 0 2px");
});
