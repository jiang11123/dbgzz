import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { annotationHistory, normalizeAnnotationRect } from "../src/components/canvas/canvas-image-annotation-model";

describe("inline image annotation model", () => {
    test("keeps the compact annotation toolbar icon-only", () => {
        const source = readFileSync(resolve(import.meta.dir, "../src/components/canvas/canvas-node-annotation-dialog.tsx"), "utf8");
        expect(source).not.toContain('font-medium">标注</span>');
        expect(source).not.toContain("}保存</button>");
        expect(source).toContain('aria-label={isSubmitting ? "正在保存" : "保存标注"}');
        expect(source).toContain("text-neutral-900");
    });
    test("normalizes rectangles drawn in any direction", () => {
        expect(normalizeAnnotationRect({ x: 90, y: 80 }, { x: 20, y: 30 })).toEqual({ x: 20, y: 30, width: 70, height: 50 });
    });

    test("undo and redo preserve complete annotation operations", () => {
        const brush = { type: "brush" as const, color: "#f00", size: 4, points: [{ x: 1, y: 1 }] };
        const rectangle = { type: "rectangle" as const, color: "#0f0", size: 6, x: 2, y: 3, width: 20, height: 30 };
        const withTwo = annotationHistory.push(annotationHistory.push(annotationHistory.empty(), brush), rectangle);
        const undone = annotationHistory.undo(withTwo);
        expect(undone.items).toEqual([brush]);
        expect(annotationHistory.redo(undone).items).toEqual([brush, rectangle]);
    });

    test("a new operation clears the redo stack", () => {
        const brush = { type: "brush" as const, color: "#f00", size: 4, points: [{ x: 1, y: 1 }] };
        const undone = annotationHistory.undo(annotationHistory.push(annotationHistory.empty(), brush));
        const text = { type: "text" as const, color: "#fff", size: 24, x: 5, y: 8, text: "重点" };
        expect(annotationHistory.push(undone, text).redo).toEqual([]);
    });
});
