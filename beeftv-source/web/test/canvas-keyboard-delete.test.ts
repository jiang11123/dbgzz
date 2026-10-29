import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const keyboardSource = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/use-canvas-keyboard.ts"), "utf8");

describe("画布键盘删除", () => {
    test("处理 Delete/Backspace 后阻止浏览器默认行为并结束当前事件", () => {
        const deleteBlock = keyboardSource.match(/if \(event\.key === "Delete" \|\| event\.key === "Backspace"\) \{[\s\S]*?\n            \}/)?.[0] || "";
        expect(deleteBlock).toContain("event.preventDefault();");
        expect(deleteBlock).toContain("event.stopPropagation();");
        expect(deleteBlock).toContain("return;");
    });
});
