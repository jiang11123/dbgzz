import { expect, test } from "bun:test";
import { CANVAS_SHORTCUTS } from "../src/lib/canvas/canvas-shortcuts";

test("canvas shortcuts keeps the twelve approved actions in display order", () => {
    expect(CANVAS_SHORTCUTS.map((item) => item.id)).toEqual([
        "search", "assistant", "focus", "move-tool", "hand-tool", "select-all",
        "zoom-in", "zoom-out", "actual-size", "fit-canvas", "fit-selection", "escape",
    ]);
});

test("canvas shortcuts only documents the approved key combinations", () => {
    expect(CANVAS_SHORTCUTS.find((item) => item.id === "search")?.keys).toEqual([["⌘", "F"]]);
    expect(CANVAS_SHORTCUTS.find((item) => item.id === "fit-canvas")?.keys).toEqual([["⌘", "0"], ["⌘", "2"]]);
    expect(CANVAS_SHORTCUTS.find((item) => item.id === "escape")?.title).toBe("关闭节点搜索");
});
