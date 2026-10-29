import { expect, test } from "bun:test";
import { normalizeTimelineProject } from "../src/lib/timeline/timeline-tracks";
import { syncNodeSubtitlesToTimeline } from "../src/lib/timeline/timeline-build";
import type { TimelineProject } from "../src/types/timeline";

test("custom tracks survive edit/save/reopen without empty duplicates", () => {
    const original: TimelineProject = {
        version: 2, durationMs: 1000, output: { width: 720, height: 1280, fps: 24 },
        tracks: [
            { id: "shots", kind: "video", label: "画面", order: 4, locked: true, muted: true },
            { id: "voice", kind: "audio", label: "旁白", order: 5 },
            { id: "captions", kind: "subtitle", label: "字幕", order: 9 },
        ],
        clips: [{ id: "v", kind: "video", nodeId: "node", trackId: "shots", startMs: 0, durationMs: 1000 }],
    };
    const edited = syncNodeSubtitlesToTimeline(normalizeTimelineProject(original), "node", [{ index: 0, startMs: 0, endMs: 1000, text: "新的一句字幕" }]);
    const reopened = normalizeTimelineProject(JSON.parse(JSON.stringify(edited)));
    expect(reopened.tracks).toEqual(original.tracks);
    expect(reopened.output).toEqual(original.output);
    expect(reopened.clips.find((clip) => clip.kind === "subtitle")?.trackId).toBe("captions");
    expect(normalizeTimelineProject(reopened)).toEqual(reopened);
});

test("legacy missing track labels/order are filled while existing default flags remain", () => {
    const legacy = normalizeTimelineProject({ tracks: [{ id: "video-1", kind: "video", locked: true, visible: false, muted: true }] as TimelineProject["tracks"] });
    expect(legacy.tracks).toHaveLength(3);
    expect(legacy.tracks[0]).toEqual({ id: "video-1", kind: "video", label: "视频 1", order: 0, locked: true, visible: false, muted: true });
});
