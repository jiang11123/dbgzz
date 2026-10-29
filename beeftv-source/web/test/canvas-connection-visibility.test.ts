import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

describe("LibTV canvas connection visibility", () => {
    test("defaults to visible and persists the scoped preference", () => {
        const project = readFileSync(resolve(root, "src/pages/canvas/project.tsx"), "utf8");
        expect(project).toContain('scopedLocalStorage.getItem("canvas:show-connections") !== "0"');
        expect(project).toContain('scopedLocalStorage.setItem("canvas:show-connections", visible ? "1" : "0")');
        expect(project).toContain("const renderedConnections = showConnections ? displayConnections : [];");
    });

    test("exposes the toggle in the appearance controls", () => {
        const controls = readFileSync(resolve(root, "src/components/canvas/canvas-appearance-controls.tsx"), "utf8");
        expect(controls).toContain("显示连线");
        expect(controls).toContain("onShowConnectionsChange");
    });

    test("moves connection and minimap controls from the top bar into the bottom view dock", () => {
        const project = readFileSync(resolve(root, "src/pages/canvas/project.tsx"), "utf8");
        const topBar = readFileSync(resolve(root, "src/pages/canvas/canvas-project-top-bar.tsx"), "utf8");
        const zoomControls = readFileSync(resolve(root, "src/components/canvas/canvas-zoom-controls.tsx"), "utf8");

        expect(topBar).not.toContain('aria-label={showConnections ? "隐藏节点连线" : "显示节点连线"}');
        expect(topBar).not.toContain('aria-label="切换小地图" aria-pressed={isMiniMapOpen}');
        expect(zoomControls).toContain('{ id: "zoom-connections", label: showConnections ? "隐藏节点连线" : "显示节点连线"');
        expect(zoomControls).toContain('{ id: "zoom-minimap", label: "切换小地图", icon: <Map />');
        expect(project).toContain("showConnections={showConnections}");
        expect(project).toContain("onToggleConnections={() => setShowConnections");
    });

    test("keeps canvas cleanup in the view dock and moves grid snapping out of the main creation dock", () => {
        const project = readFileSync(resolve(root, "src/pages/canvas/project.tsx"), "utf8");
        const mainToolbar = readFileSync(resolve(root, "src/components/canvas/canvas-toolbar.tsx"), "utf8");
        const zoomControls = readFileSync(resolve(root, "src/components/canvas/canvas-zoom-controls.tsx"), "utf8");

        expect(mainToolbar).not.toContain('id: "tool-auto-arrange"');
        expect(mainToolbar).not.toContain('id: "tool-snap-grid"');
        expect(zoomControls).toContain('id: "zoom-auto-arrange"');
        expect(zoomControls).toContain('id: "zoom-snap-grid"');
        expect(zoomControls).toContain("snapToGrid: boolean;");
        expect(project).toContain("snapToGrid={snapToGrid}");
        expect(project).toContain("onSnapToGridChange={(enabled) => {");
    });
});
