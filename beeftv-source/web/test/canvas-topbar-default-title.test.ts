import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

describe("BeefTV canvas top bar", () => {
    test("maps the local project placeholder to the workspace label", () => {
        const source = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/project.tsx"), "utf8");
        expect(source).toContain('workspaceProject?.title === "未命名项目" || !workspaceProject?.title ? "未命名工作区" : workspaceProject.title');
        expect(source).toContain("项目库仍保留");
    });
});
