import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workbench = readFileSync(resolve(import.meta.dir, "../src/components/canvas/director/canvas-director-workbench.tsx"), "utf8");
const project = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/project.tsx"), "utf8");

test("Delete and Backspace on a selected camera are consumed by the director instead of falling through to canvas deletion", () => {
    const deleteAction = workbench.match(/case "delete-selected":[\s\S]*?case "undo":/)?.[0] || "";
    expect(deleteAction).toContain("if (selectedCamera)");
    expect(deleteAction).toContain("removeCamera(selectedCamera.id)");
    expect(deleteAction).toContain("return true;");
});

test("Delete and Backspace are still consumed when nothing is selected, without blocking editable controls", () => {
    const deleteAction = workbench.match(/case "delete-selected":[\s\S]*?case "undo":/)?.[0] || "";
    expect(deleteAction).toMatch(/return true;\s*case "undo":/);
    expect(workbench).toContain("event.stopImmediatePropagation()");
    expect(workbench).toContain("isInteractiveTarget: blocksDirectorShortcut(event.target)");
});

test("the canvas capture-phase keyboard handler is suspended while the director workbench is open", () => {
    const keyboardWiring = project.match(/useCanvasKeyboard\(\{[\s\S]*?\n    \}\);/)?.[0] || "";
    expect(keyboardWiring).toContain("enabled: projectLoaded && !versions.preview && !directorNodeId");
    expect(readFileSync(resolve(import.meta.dir, "../src/pages/canvas/use-canvas-keyboard.ts"), "utf8"))
        .toContain('document.querySelector("[data-director-workbench=\'true\']")');
});
