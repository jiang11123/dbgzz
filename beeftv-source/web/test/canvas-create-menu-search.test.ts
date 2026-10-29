import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(import.meta.dir, "../src/components/canvas/canvas-create-menu.tsx"), "utf8");
const toolbarSource = readFileSync(resolve(import.meta.dir, "../src/components/canvas/canvas-toolbar.tsx"), "utf8");
const definitions = readFileSync(resolve(import.meta.dir, "../src/lib/canvas/tool-registry/definitions/add-node-menu-tools.tsx"), "utf8");
const contextMenuSource = readFileSync(resolve(import.meta.dir, "../src/components/canvas/canvas-context-menu.tsx"), "utf8");

describe("LibTV add-node menu search", () => {
    test("exposes a list-layout search control", () => {
        expect(source).toContain('aria-label={searchOpen ? "关闭节点搜索" : "搜索节点"}');
        expect(source).toContain('placeholder="搜索节点"');
    });

    test("filters labels and badges without changing command callbacks", () => {
        expect(source).toContain('`${command.label} ${command.badge || ""}`');
        expect(source).toContain("visibleCommands.filter");
        expect(source).toContain("if (!command.disabledReason) command.onClick()");
    });

    test("uses the LibTV compact list and exposes the resource-history entry", () => {
        expect(toolbarSource).toContain('<CanvasCreateMenu commands={commands} layout="list" />');
        expect(toolbarSource).toContain("w-[232px]");
        expect(definitions).toContain('label: "智能剪辑"');
        expect(definitions).toContain('label: "从生成历史选择"');
        expect(definitions).toContain('label: "上传"');
    });

    test("carries a developing command's disabled state into the right-click menu", () => {
        expect(definitions).toContain("CANVAS_DEVELOPING_LABEL");
        expect(definitions).toContain("getCanvasNodeCreationDisabledReason");
        expect(contextMenuSource).toContain("disabledReason: command.disabledReason");
    });

});
