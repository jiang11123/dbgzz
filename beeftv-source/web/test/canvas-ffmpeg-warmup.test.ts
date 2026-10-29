import { expect, test } from "bun:test";

test("video trim and crop warm the shared FFmpeg worker before confirmation", async () => {
    const tools = await Bun.file(new URL("../src/pages/canvas/use-canvas-media-tools.ts", import.meta.url)).text();
    const worker = await Bun.file(new URL("../src/lib/canvas/canvas-video-merge.ts", import.meta.url)).text();
    const segment = await Bun.file(new URL("../src/lib/canvas/canvas-video-segment.ts", import.meta.url)).text();

    expect(worker).toContain("export function warmFFmpeg()");
    expect(worker).toContain("return loadFFmpeg()");
    expect(worker).toContain("withFFmpegLease");
    expect(segment).toContain("withFFmpegLease");
    expect(segment).not.toContain("loadFFmpeg");
    expect(tools.match(/void warmFFmpeg\(\)\.catch\(\(\) => undefined\)/g)?.length).toBe(2);
    expect(tools.indexOf("void warmFFmpeg().catch(() => undefined)", tools.indexOf("const openInlineVideoTrim"))).toBeLessThan(tools.indexOf("setInlineTrimNodeId(node.id)"));
    expect(tools.indexOf("void warmFFmpeg().catch(() => undefined)", tools.indexOf("const openVideoCrop"))).toBeLessThan(tools.indexOf("setVideoCropNodeId(node.id)", tools.indexOf("const openVideoCrop")));
});
