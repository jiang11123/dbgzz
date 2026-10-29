// 时间线轨道管理（移植自 lingji-cut 的 timeline-tracks.ts，按本项目类型精简）。
// 默认三轨：视频轨、音频轨、字幕轨；提供轨道查询与规范化。

import type { TimelineProject, TimelineTrack } from "@/types/timeline";

export const DEFAULT_VIDEO_TRACK_ID = "video-1";
export const DEFAULT_AUDIO_TRACK_ID = "audio-1";
export const DEFAULT_SUBTITLE_TRACK_ID = "subtitle-1";

export function createDefaultTracks(): TimelineTrack[] {
    return [
        { id: DEFAULT_VIDEO_TRACK_ID, kind: "video", label: "视频 1", order: 0 },
        { id: DEFAULT_AUDIO_TRACK_ID, kind: "audio", label: "音频 1", order: 1 },
        { id: DEFAULT_SUBTITLE_TRACK_ID, kind: "subtitle", label: "字幕 1", order: 2 },
    ];
}

export function getVisualTracks(tracks: TimelineTrack[]): TimelineTrack[] {
    return tracks.filter((track) => track.kind === "video" || track.kind === "image" || track.kind === "text").sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function getAudioTracks(tracks: TimelineTrack[]): TimelineTrack[] {
    return tracks.filter((track) => track.kind === "audio").sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function getSubtitleTracks(tracks: TimelineTrack[]): TimelineTrack[] {
    return tracks.filter((track) => track.kind === "subtitle").sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function getTracksByKind(tracks: TimelineTrack[], kind: TimelineTrack["kind"]): TimelineTrack[] {
    return tracks.filter((track) => track.kind === kind).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** 保留已有轨道身份，仅为缺少的类型补默认轨。 */
export function normalizeTimelineProject(timeline: Partial<TimelineProject> | null | undefined): TimelineProject {
    const rawTracks = Array.isArray(timeline?.tracks) ? timeline.tracks : [];
    const seen = new Set<string>();
    const deduped = rawTracks.filter((track) => {
        if (seen.has(track.id)) return false;
        seen.add(track.id);
        return true;
    });
    const baseTracks = createDefaultTracks();
    const names = { video: "视频", image: "图片", audio: "音频", subtitle: "字幕", text: "文字" };
    const counts = new Map<string, number>();
    const tracks = deduped.map((track, index) => {
        const number = (counts.get(track.kind) ?? 0) + 1;
        counts.set(track.kind, number);
        return { ...track, label: track.label?.trim() || `${names[track.kind]} ${number}`, order: Number.isFinite(track.order) ? track.order : index };
    });
    for (const track of baseTracks) {
        if (!tracks.some((item) => item.kind === track.kind) && !seen.has(track.id)) {
            tracks.push({ ...track, order: Math.max(-1, ...tracks.map((item) => item.order)) + 1 });
        }
    }
    const clips = Array.isArray(timeline?.clips) ? timeline.clips : [];
    const durationMs = clips.reduce((max, clip) => Math.max(max, clip.startMs + clip.durationMs), 0);
    return {
        version: 2,
        tracks,
        clips,
        durationMs,
        updatedAt: timeline?.updatedAt,
        ...(timeline?.output ? { output: { ...timeline.output } } : {}),
    };
}
