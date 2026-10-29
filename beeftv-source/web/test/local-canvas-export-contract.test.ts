import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const exportSource = readFileSync(new URL("../src/lib/canvas/canvas-export.ts", import.meta.url), "utf8");
const restoreSource = readFileSync(new URL("../src/lib/canvas/canvas-archive-restore.ts", import.meta.url), "utf8");
const librarySource = readFileSync(new URL("../src/pages/canvas/index.tsx", import.meta.url), "utf8");

test("local canvas export includes media and drawing documents", () => {
    expect(exportSource).toContain("getMediaBlob(storageKey)");
    expect(exportSource).toContain("loadCanvasDrawing(project.id, drawingId, scope)");
    expect(exportSource).toContain("loadCanvasDrawingPreview(project.id, drawingId, scope)");
    expect(exportSource).toContain("loadCanvasDrawingRender(project.id, drawingId, scope)");
    expect(exportSource).toContain("drawingDocuments");
    expect(exportSource).toContain('name: "projects.json"');
});

test("local canvas import restores drawings locally and skips remote sync", () => {
    expect(exportSource).toContain("export async function openCanvasArchive");
    expect(exportSource).toContain("preflightCanvasArchive");
    expect(librarySource).toContain("restoreCanvasArchive(file");
    expect(librarySource).toContain("已导入 ${result.count} 个画布");
    expect(librarySource).not.toContain("openCanvasArchive(file)");
    expect(restoreSource).toContain("saveCanvasDrawing");
    expect(restoreSource).toContain("syncLocalCanvasProjectToBackend");
    expect(restoreSource).toContain("readLocalCanvasProjectFromBackend");
    expect(restoreSource).toContain("画布未保存到工作区");
});
