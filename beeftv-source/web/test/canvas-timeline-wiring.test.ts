import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const dialog = readFileSync(new URL("../src/components/canvas/canvas-timeline-dialog.tsx", import.meta.url), "utf8");
const project = readFileSync(new URL("../src/pages/canvas/project.tsx", import.meta.url), "utf8");
const editorDialogs = readFileSync(new URL("../src/pages/canvas/canvas-project-editor-dialogs.tsx", import.meta.url), "utf8");

test("timeline media actions are required and wired back to the canvas", () => {
    expect(dialog).toContain("onUploadLocalFiles: (files: File[]) => Promise<TimelineDirectMedia[]>");
    expect(dialog).toContain("onCreateAssembledNode: (blob: Blob, title: string) => Promise<CanvasNodeData | null>");
    expect(dialog).not.toContain("本地上传暂未接线");
    expect(dialog).not.toContain("保存回画布暂未接线");
    expect(project).toContain("onUploadLocalFiles: uploadTimelineMedia");
    expect(project).toContain("onCreateAssembledNode: createVideoNodeFromBlob");
    expect(editorDialogs).toContain("onUploadLocalFiles={timeline.onUploadLocalFiles}");
    expect(editorDialogs).toContain("onCreateAssembledNode={timeline.onCreateAssembledNode}");
});
