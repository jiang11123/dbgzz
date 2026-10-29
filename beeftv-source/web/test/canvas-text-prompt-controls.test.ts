import { expect, test } from "bun:test";

test("all canvas prompt footers omit the preset trigger", async () => {
    const panel = await Bun.file(new URL("../src/components/canvas/canvas-node-prompt-panel.tsx", import.meta.url)).text();
    const footer = panel.slice(panel.indexOf("const renderComposerControls"), panel.indexOf("const renderPromptEditor"));
    expect(footer.match(/<CanvasPresetPicker/g)?.length ?? 0).toBe(0);
    const configComposer = await Bun.file(new URL("../src/components/canvas/canvas-config-composer.tsx", import.meta.url)).text();
    expect(configComposer.match(/<CanvasPresetPicker/g)?.length ?? 0).toBe(0);
});

test("video prompt tools move camera control below the prompt", async () => {
    const panel = await Bun.file(new URL("../src/components/canvas/canvas-node-prompt-panel.tsx", import.meta.url)).text();
    const toolsStart = panel.indexOf("const tools = [");
    const tools = panel.slice(toolsStart, panel.indexOf("];", toolsStart));
    expect(tools).not.toContain('label: "参考"');
    expect(tools).not.toContain('label: "标记"');
    expect(tools).not.toContain('label: "特效"');
    expect(tools).not.toContain('label: "角色库"');
    expect(panel).toContain('label="运镜"');
});
