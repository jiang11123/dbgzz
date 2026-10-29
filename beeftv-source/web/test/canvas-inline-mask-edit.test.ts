import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const read = (path: string) => readFileSync(resolve(import.meta.dir, path), "utf8");

describe("inline canvas mask editing", () => {
    test("mounts mask editing inside the image node instead of a modal", () => {
        const node = read("../src/components/canvas/canvas-node.tsx");
        const editor = read("../src/components/canvas/canvas-node-mask-edit-dialog.tsx");
        expect(node).toContain("maskEditActive && maskEditConfig && hasImageContent");
        expect(node).toContain("<CanvasImageMaskEditor");
        expect(editor).toContain('data-image-mask-edit-inline="true"');
        expect(editor).not.toContain("<Modal");
    });

    test("hides the ordinary node toolbar while mask editing", () => {
        const project = read("../src/pages/canvas/project.tsx");
        expect(project).toContain("nodeImageSettingsOpen || annotationNodeId || maskEditNodeId || emotionNodeId");
    });

    test("closes and suppresses the ordinary prompt panel while mask editing", () => {
        const project = read("../src/pages/canvas/project.tsx").replace(/\s+/g, " ");
        expect(project).toContain("{dialogNode && !maskEditNodeId &&");
        expect(project).toContain("onMaskEdit={(node) => { setDialogNodeId(null); setMaskEditNodeId(node.id); }}");
    });

    test("keeps prompt, settings and icon-only submit controls accessible", () => {
        const editor = read("../src/components/canvas/canvas-node-mask-edit-dialog.tsx");
        expect(editor).toContain('<input aria-label="局部重绘要求"');
        expect(editor).not.toContain('<textarea aria-label="局部重绘要求"');
        expect(editor).toContain("items-center gap-1.5");
        expect(editor).toContain('aria-label="局部重绘设置"');
        expect(editor).toContain('aria-label={isSubmitting ? "正在修改" : "AI 修改"}');
    });
});
