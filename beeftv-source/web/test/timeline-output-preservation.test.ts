import { expect, test } from "bun:test";
import { createEditorStore } from "../src/stores/editor/editor-store";
import { normalizeTimelineProject } from "../src/lib/timeline/timeline-tracks";
import type { TimelineProject } from "../src/types/timeline";

test("GUI subtitle command, save and reopen retain project output", async () => {
    const saves: TimelineProject[] = [];
    const store = createEditorStore({
        saveTimeline: async (project) => { saves.push(JSON.parse(JSON.stringify(project))); },
        debounceMs: 10_000,
    });
    const output = { width: 720, height: 1280, fps: 24 };
    store.getState().load(normalizeTimelineProject({
        version: 2, durationMs: 1000, output,
        tracks: [{ id: "captions", kind: "subtitle", label: "字幕", order: 0 }],
        clips: [{ id: "caption", kind: "subtitle", nodeId: "", trackId: "captions", startMs: 0, durationMs: 1000, text: "原句" }],
    }));
    store.getState().dispatch({ op: "setClipProperty", payload: { id: "caption", patch: { text: "修改后的字幕" } } });
    await store.getState().flushSave();
    expect(saves).toHaveLength(1);
    expect(saves[0].output).toEqual(output);
    store.getState().load(normalizeTimelineProject(saves[0]));
    expect(store.getState().project?.output).toEqual(output);
    expect(store.getState().project?.clips[0].text).toBe("修改后的字幕");
});
