import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(import.meta.dir, "../src/services/local-workspace-sync.ts"), "utf8");

test("syncLocalCanvasSnapshot 把文档字段合成一次提交，viewport 只留在本地", () => {
    expect(source).toContain("const { viewport, ...documentPatch } = patch;");
    expect(source).toContain("if (viewport) useCanvasStore.getState().updateProject(id, { viewport });");
    expect(source).toContain("const expected = expectedScope ?? captureUserScope();");
    expect(source).toContain("if (Object.keys(documentPatch).length > 0) await persistCanvasDocument(id, documentPatch, expected);");
    expect(source).not.toContain("await syncLocalCanvasProjectToBackend(id)");
    expect(source).not.toContain("documentPatch.nodes || documentPatch.connections");
});

test("loadCanvasProjectForEditing 对 historyRestore 走恢复而不是打开当前稿", () => {
    expect(source).toContain("if (options.historyRestore)");
    expect(source).toContain("restoreLocalCanvasProjectFromHistory(id, options.historyRestore, expected)");
    expect(source).not.toContain("if (options.historyRestore) {\n    const project = await openLocalCanvasProjectFromBackend");
});
