import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const canvasStylesSource = readFileSync(resolve(import.meta.dir, "../src/styles/globals.css"), "utf8");
const nodeSource = readFileSync(resolve(import.meta.dir, "../src/components/canvas/canvas-node.tsx"), "utf8");
const projectSource = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/project.tsx"), "utf8");
const createNodeSource = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/use-canvas-node-operations.ts"), "utf8");
const contextMenuSource = readFileSync(resolve(import.meta.dir, "../src/components/canvas/canvas-context-menu.tsx"), "utf8");
const emptyContentSource = readFileSync(resolve(import.meta.dir, "../src/components/canvas/canvas-node-content.tsx"), "utf8");

const inlineEditBlock = nodeSource.slice(nodeSource.indexOf("canvas-node-inline-edit"), nodeSource.indexOf("data.metadata?.versionLabel"));
const emptyTextBlock = emptyContentSource.slice(emptyContentSource.indexOf("function EmptyTextNodeContent"), emptyContentSource.indexOf("function SkillContent"));
const panelHideRule = canvasStylesSource.match(/data-canvas-editor-panel-open="true"\][\s\S]*?\{[\s\S]*?\}/)?.[0] || "";
const agentHideRule = canvasStylesSource.match(/data-agent-open="true"\] \.canvas-node-inline-action[\s\S]*?\{[\s\S]*?\}/)?.[0] || "";
const inlineActionRule = canvasStylesSource.match(/(?<!:hover)\.canvas-node-inline-action\s*\{[^}]*\}/)?.[0] || "";

/** CSS `pointer-events` is inherited. An explicit child value wins. */
function computedPointerEvents(parent?: string, child?: string) {
    return child || parent || "auto";
}

describe("canvas text inline edit and empty card", () => {
    test("removes unconfigured empty text from hit-testing and the accessibility tree", () => {
        expect(emptyTextBlock).toContain("pointer-events-none");
        expect(emptyTextBlock).toContain("aria-hidden");
        expect(emptyTextBlock).toContain("canvas-node-text-footer");
        expect(emptyTextBlock).not.toContain("GVLM 3.1");
        expect(emptyTextBlock).not.toContain("6 积分");
        expect(emptyTextBlock).not.toContain("node.metadata?.model");
        expect(canvasStylesSource).toMatch(/\.canvas-node-text-footer\s*\{\s*pointer-events: none;/);
    });

    test("hides inline node actions from snapshots while the editor surface is open", () => {
        expect(panelHideRule).toContain(".canvas-node-inline-action");
        expect(panelHideRule).toContain(".canvas-node-inline-edit");
        expect(panelHideRule).toContain("display: none");
        expect(panelHideRule).not.toContain("opacity: 0");
        expect(panelHideRule).not.toContain("pointer-events: none");
        expect(agentHideRule).toContain(".canvas-node-inline-edit");
        expect(agentHideRule).toContain("display: none");
    });

    test("unselected enlarge-edit inherits pointer-events:none instead of a global auto override", () => {
        expect(inlineActionRule).toContain(".canvas-node-inline-action");
        expect(inlineActionRule).not.toMatch(/pointer-events\s*:/);
        expect(inlineEditBlock).toContain('isSelected ? "pointer-events-auto translate-y-0 opacity-100" : "pointer-events-none translate-y-3 opacity-0"');
        const childOverride = inlineActionRule.match(/pointer-events\s*:\s*([a-z]+)/)?.[1];
        expect(computedPointerEvents("none", childOverride)).toBe("none");
        expect(computedPointerEvents("auto", childOverride)).toBe("auto");
        expect(computedPointerEvents("none", "auto")).toBe("auto");
    });

    test("keeps the selected enlarge-edit control in the tree only while it can receive clicks", () => {
        expect(inlineEditBlock).toContain("canvas-node-inline-edit");
        expect(inlineEditBlock).toContain("aria-hidden={!isSelected}");
        expect(inlineEditBlock).toContain("tabIndex={isSelected ? 0 : -1}");
        expect(inlineEditBlock).toContain("pointer-events-auto");
        expect(inlineEditBlock).toContain('aria-label="放大编辑文本"');
        expect(inlineEditBlock).toContain("onMouseDown={(event) => event.stopPropagation()}");
        expect(inlineEditBlock).toContain("onPointerDown={(event) => event.stopPropagation()}");
        expect(inlineEditBlock).toContain("onOpenTextEditor?.(data)");
    });

    test("keeps the supported text editing paths besides the hidden inline control", () => {
        expect(nodeSource).toContain("setIsEditingContent(true)");
        expect(nodeSource).toMatch(/if \(readOnly \|\| data\.type !== CanvasNodeType\.Text\) return;[\s\S]*setIsEditingContent\(true\)/);
        expect(contextMenuSource).toContain('{isText ? <MenuButton icon={<Maximize2 />} label="放大编辑" onClick={() => runAction(onEditText)} /> : null}');
        expect(projectSource).toContain("onEditText={openTextNodeEditor}");
        expect(projectSource).toMatch(/node.type === CanvasNodeType.Text\)\s*\{\s*setDialogNodeId\(node.id\)/);
        expect(createNodeSource).toContain("if (canOpenCanvasNodePromptPanel(node) && type !== CanvasNodeType.Text) setDialogNodeId(node.id);");
    });
});
