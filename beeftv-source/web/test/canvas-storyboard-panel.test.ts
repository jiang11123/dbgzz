import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const source = (name: string) => readFileSync(resolve(import.meta.dir, `../src/pages/canvas/${name}`), "utf8");

describe("storyboard prompt panel boundaries", () => {
    test("creation and duplication clear the previous node panel", () => {
        const operations = source("use-canvas-node-operations.ts");
        expect(operations).toContain("if (type === CanvasNodeType.Script) setDialogNodeId(null)");
        expect(operations).toContain("canOpenCanvasNodePromptPanel(copiedNodes.find((node) => node.id === id)) ? id : null");
        expect(operations).toContain("canOpenCanvasNodePromptPanel(primaryNode) ? primaryNode!.id : null");
    });

    test("single and batch connection creation clear the previous panel", () => {
        const connections = source("use-canvas-connection-controller.ts");
        expect(connections.match(/canOpenCanvasNodePromptPanel\(newNode\)/g)).toHaveLength(2);
    });

    test("focusing a storyboard does not open a panel", () => {
        expect(source("use-canvas-viewport-controller.ts")).toContain("canOpenCanvasNodePromptPanel(node) ? node.id : null");
    });

    test("click and overlay guards remain while the storyboard editor stays available", () => {
        const project = source("project.tsx");
        expect(project).toMatch(/else if \(node.type === CanvasNodeType.Script\) \{\s*setDialogNodeId\(null\)/);
        expect(project).toContain("dialogNode.type !== CanvasNodeType.Script");
        expect(project).toContain("onOpen={() => setScriptEditorNodeId(contentNode.id)}");
        expect(project).toContain("onGenerateScript={(prompt) => void generateScriptRows(contentNode.id, prompt)}");
    });
});
