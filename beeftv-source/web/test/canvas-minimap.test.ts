import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

describe("LibTV canvas minimap contract", () => {
    test("persists the minimap preference in the scoped canvas store", () => {
        const project = readFileSync(resolve(root, "src/pages/canvas/project.tsx"), "utf8");
        expect(project).toContain('scopedLocalStorage.getItem("canvas:minimap")');
        expect(project).toContain('scopedLocalStorage.setItem("canvas:minimap", next ? "1" : "0")');
    });

    test("exposes a stable accessible minimap surface", () => {
        const minimap = readFileSync(resolve(root, "src/components/canvas/canvas-mini-map.tsx"), "utf8");
        expect(minimap).toContain("data-canvas-minimap");
        expect(minimap).toContain('aria-label="画布小地图"');
        expect(minimap).toContain("borderColor: theme.toolbar.border");
    });
});
