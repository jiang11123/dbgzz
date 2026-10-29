import { describe, expect, test } from "bun:test";

import { CANVAS_DELETE_DIALOG_ID_KEYS, clearDeletedCanvasDialogIds } from "@/pages/canvas/use-canvas-project-dialogs";

describe("clearDeletedCanvasDialogIds", () => {
    test("clears editor dialogs for removed nodes and leaves the timeline dialog id", () => {
        const ids = {
            textEditorNodeId: "text-1",
            characterReferenceNodeId: "char-1",
            drawingNodeId: "draw-1",
            infoNodeId: "info-1",
            subtitleNodeId: "sub-1",
            superResolveNodeId: "sr-1",
            previewNodeId: "preview-1",
            scriptEditorNodeId: "script-1",
            artCritiqueNodeId: "art-1",
            directorNodeId: "director-1",
            versionCompareRootId: "version-1",
            timelineNodeId: "timeline-1",
        };
        const next = clearDeletedCanvasDialogIds(ids, new Set(["text-1", "timeline-1", "director-1"]));
        expect(next.textEditorNodeId).toBeNull();
        expect(next.directorNodeId).toBeNull();
        expect(next.timelineNodeId).toBe("timeline-1");
        expect(CANVAS_DELETE_DIALOG_ID_KEYS).not.toContain("timelineNodeId");
        expect(clearDeletedCanvasDialogIds(ids, new Set(["missing"]))).toBe(ids);
    });
});
