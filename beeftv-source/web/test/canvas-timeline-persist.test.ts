import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { runTimelineDialogSaveAttempt } from "@/components/canvas/canvas-timeline-dialog";
import { createDefaultTracks, normalizeTimelineProject } from "@/lib/timeline/timeline-tracks";
import { useCanvasStore, withCanvasStorePersistenceSuppressed } from "@/stores/canvas/use-canvas-store";
import type { TimelineProject } from "@/types/timeline";

function sampleTimeline(): TimelineProject {
    return normalizeTimelineProject({
        version: 2,
        tracks: createDefaultTracks(),
        durationMs: 5600,
        clips: [
            {
                id: "clip-audio-1",
                kind: "audio",
                nodeId: "7vvfM674HnenwTekmj88V",
                trackId: "audio-1",
                startMs: 0,
                durationMs: 5600,
                title: "旁白",
                sourceStartMs: 0,
                sourceDurationMs: 5600,
            },
        ],
    });
}

function reloadedTimeline(project: unknown): TimelineProject {
    const payload = JSON.parse(JSON.stringify(project)) as { timeline?: TimelineProject };
    expect(payload.timeline).toBeDefined();
    return payload.timeline!;
}

describe("canvas timeline persistence", () => {
    test("saved timeline clips, tracks and duration survive JSON save/load", () => {
        const previous = useCanvasStore.getState().projects;
        try {
            withCanvasStorePersistenceSuppressed(() => {
                useCanvasStore.setState({ projects: [] });
                const id = useCanvasStore.getState().createProject("验收画布");
                const timeline = sampleTimeline();
                useCanvasStore.getState().updateProject(id, { timeline });
                const stored = useCanvasStore.getState().openProject(id);
                const loaded = reloadedTimeline(stored);
                expect(loaded.durationMs).toBe(5600);
                expect(loaded.clips).toHaveLength(1);
                expect(loaded.clips[0]).toMatchObject({
                    id: "clip-audio-1",
                    kind: "audio",
                    nodeId: "7vvfM674HnenwTekmj88V",
                    trackId: "audio-1",
                    startMs: 0,
                    durationMs: 5600,
                });
                expect(loaded.tracks.map((track) => track.kind)).toEqual(["video", "audio", "subtitle"]);
            });
        } finally {
            withCanvasStorePersistenceSuppressed(() => useCanvasStore.setState({ projects: previous }));
        }
    });

    test("later node-only persist does not drop the saved timeline document", () => {
        const previous = useCanvasStore.getState().projects;
        try {
            withCanvasStorePersistenceSuppressed(() => {
                useCanvasStore.setState({ projects: [] });
                const id = useCanvasStore.getState().createProject("验收画布");
                useCanvasStore.getState().updateProject(id, { timeline: sampleTimeline() });
                useCanvasStore.getState().updateProject(id, {
                    nodes: [{ id: "7vvfM674HnenwTekmj88V", type: "audio", title: "旁白", position: { x: 0, y: 0 }, width: 320, height: 120, metadata: { durationMs: 5600 } }] as never,
                });
                const loaded = reloadedTimeline(useCanvasStore.getState().openProject(id));
                expect(loaded.durationMs).toBe(5600);
                expect(loaded.clips[0]?.nodeId).toBe("7vvfM674HnenwTekmj88V");
                expect(loaded.tracks).toHaveLength(3);
            });
        } finally {
            withCanvasStorePersistenceSuppressed(() => useCanvasStore.setState({ projects: previous }));
        }
    });

    test("timeline dialog does not close when save rejects", async () => {
        let closed = false;
        const error = await runTimelineDialogSaveAttempt(
            async () => {
                throw new Error("画布后端持久化失败");
            },
            () => {
                closed = true;
            },
        );
        expect(closed).toBe(false);
        expect((error as Error).message).toBe("画布后端持久化失败");
        closed = false;
        const ok = await runTimelineDialogSaveAttempt(
            async () => undefined,
            () => {
                closed = true;
            },
        );
        expect(ok).toBeUndefined();
        expect(closed).toBe(true);
    });

    test("timeline dialog subtitle does not expose an implementation phase", () => {
        const source = readFileSync(new URL("../src/components/canvas/canvas-timeline-dialog.tsx", import.meta.url), "utf8");
        expect(source).toContain("多轨时间线");
        expect(source).not.toContain("第二期 ·");
        expect(source).toContain("loading={saving}");
        expect(source).toContain("if (saving) return");
    });

    test("all dialog close controls guard finalization and rendering cancellation aborts", () => {
        const source = readFileSync(new URL("../src/components/canvas/canvas-timeline-dialog.tsx", import.meta.url), "utf8");
        expect(source).toContain("onCancel={handleClose}");
        expect(source).toContain("disabled={saving || finalizingExport} onClick={handleClose}");
        expect(source).not.toContain("onClick={onClose}");
        expect(source).toContain("disabled={saving || exporting || !draft.clips.length} onClick={() => void handleSave()}");
        const close = source.slice(source.indexOf("const handleClose ="), source.indexOf("const handleSave ="));
        expect(close).toContain("if (saving || finalizingExportRef.current) return");
        expect(close.indexOf("exportControllerRef.current?.abort()")).toBeLessThan(close.indexOf("onClose()"));
        const save = source.slice(source.indexOf("const handleSave ="), source.indexOf("const runExport ="));
        expect(save.indexOf("if (exportControllerRef.current) return")).toBeLessThan(save.indexOf("runTimelineDialogSaveAttempt"));
        expect(source).toContain("if (!finalizingExportRef.current) exportControllerRef.current?.abort()");
        expect(source.match(/finalizingExportRef.current = true;\s+setFinalizingExport\(true\)/g)).toHaveLength(2);
        expect(source).toContain("finalizingExportRef.current = false;");
    });
});
