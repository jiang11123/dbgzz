import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workbench = readFileSync("src/components/canvas/director/canvas-director-workbench.tsx", "utf8");
const viewport = readFileSync("src/components/canvas/director/director-viewport.tsx", "utf8");

describe("导演台轨迹点选与删除", () => {
    test("左侧素材栏不再额外挂载完整的 3D 视口", () => {
        const leftDock = workbench.split('data-director-left-dock="true"')[1]?.split("</aside>")[0] || "";
        expect(leftDock).not.toContain("<DirectorViewport");
    });

    test("直接点击轨迹线会选中整条轨迹", () => {
        expect(viewport).toMatch(/<Line[^>]*onPointerDown=.*onSelectPath/);
    });

    test("Delete 优先删除整条演员或摄影机轨迹，而不是单个控制点或对象", () => {
        const deleteStart = workbench.indexOf('case "delete-selected":');
        const deleteEnd = workbench.indexOf('case "undo":', deleteStart);
        const deleteBranch = workbench.slice(deleteStart, deleteEnd);
        expect(deleteBranch.indexOf("selectedPathKeyframe")).toBeGreaterThanOrEqual(0);
        expect(deleteBranch.indexOf("selectedPathKeyframe")).toBeLessThan(deleteBranch.indexOf("selectedCamera"));
        expect(deleteBranch).toContain("removeDirectorActorPath");
        expect(deleteBranch).toContain("camera.drawnPath.originalKeyframes");
        expect(deleteBranch).not.toContain("deleteKeyframe");
    });
});
