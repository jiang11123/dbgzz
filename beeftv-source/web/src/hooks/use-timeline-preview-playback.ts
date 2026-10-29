import { useEffect, useRef, type RefObject } from "react";
import type { CanvasNodeData } from "@/types/canvas";
import type { TimelineClip, TimelineTrack } from "@/types/timeline";
import { resolveMediaUrl } from "@/services/file-storage";
import { cacheResourceObjectUrl } from "@/services/resource-blob-cache";
import { resourceIdFromStorageKey } from "@/services/api/resources";

export type TimelinePreviewPlaybackOptions = {
    clips: TimelineClip[];
    tracks: TimelineTrack[];
    nodes: CanvasNodeData[];
    playheadMs: number;
    playing: boolean;
    durationMs?: number;
    videoRef: RefObject<HTMLVideoElement | null>;
    activeVideoClipId: string | null;
    onPlayheadChange: (ms: number) => void;
    onRequestPause: () => void;
    onPlaybackError: (message: string) => void;
};

type AudioRecord = { clip: TimelineClip; element: HTMLAudioElement; identity: string; disposed: boolean; error: boolean; loaded: () => void; failed: () => void };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function mediaSource(clip: TimelineClip, nodes: CanvasNodeData[]) {
    const direct = clip.directMedia;
    const node = nodes.find(item => item.id === clip.nodeId);
    return direct
        ? { storageKey: direct.storageKey || "", fallback: direct.url || direct.dataUrl || direct.content || "" }
        : { storageKey: node?.metadata?.storageKey || "", fallback: node?.metadata?.content || "" };
}

async function sourceUrl(source: ReturnType<typeof mediaSource>) {
    if (resourceIdFromStorageKey(source.storageKey)) {
        const cached = await cacheResourceObjectUrl(source.storageKey).catch(() => "");
        if (cached) return cached;
    }
    return resolveMediaUrl(source.storageKey, source.fallback);
}

/** Same linear, sequential fade envelopes used by the two timeline exporters. */
export function timelinePreviewGain(clip: TimelineClip, timeMs: number): number {
    const local = clamp(timeMs - clip.startMs, 0, clip.durationMs);
    const fadeIn = Math.min(clip.durationMs, Math.max(0, clip.fadeInMs || 0));
    const fadeOut = Math.min(clip.durationMs, Math.max(0, clip.fadeOutMs || 0));
    return (clip.volume ?? 1) * (fadeIn ? Math.min(1, local / fadeIn) : 1) * (fadeOut ? Math.min(1, (clip.durationMs - local) / fadeOut) : 1);
}

class TimelinePreviewPlayback {
    private options: TimelinePreviewPlaybackOptions;
    private audios = new Map<string, AudioRecord>();
    private position = 0;
    private running = false;
    private requestedPlaying = false;
    private disposed = false;
    private frame: number | null = null;
    private lastTick: number | null = null;
    private lastPublishAt = 0;
    private lastPublished: number | null = null;
    private pendingElements = new WeakSet<HTMLMediaElement>();

    constructor(options: TimelinePreviewPlaybackOptions) { this.options = options; }

    private duration() { return Math.max(0, this.options.durationMs ?? this.options.clips.reduce((end, clip) => Math.max(end, clip.startMs + clip.durationMs), 0)); }
    private track(clip: TimelineClip) { return this.options.tracks.find(track => track.id === clip.trackId); }
    private active(clip: TimelineClip) { return this.position >= clip.startMs && this.position < clip.startMs + clip.durationMs && this.track(clip)?.visible !== false; }

    update(options: TimelinePreviewPlaybackOptions) {
        const videoChanged = this.options.activeVideoClipId !== options.activeVideoClipId;
        this.options = options;
        const requested = clamp(options.playheadMs, 0, this.duration());
        let externalSeek = this.lastPublished === null || Math.abs(requested - this.lastPublished) > 1;
        if (externalSeek && Math.abs(requested - this.position) > 1) { this.position = requested; this.lastTick = null; }
        this.reconcileAudio();
        if (options.playing !== this.requestedPlaying) {
            this.requestedPlaying = options.playing;
            if (options.playing) {
                if (this.position >= this.duration()) { this.position = 0; externalSeek = true; this.publish(); }
                this.running = this.duration() > 0;
                this.lastTick = null;
                if (this.running && this.frame === null) this.frame = requestAnimationFrame(this.tick);
            } else this.pause();
        }
        this.sync(externalSeek);
        if (videoChanged && !externalSeek) this.syncVideoMetadata();
    }

    private publish() {
        this.lastPublished = Math.round(this.position);
        this.options.onPlayheadChange(this.lastPublished);
    }

    private tick = (now: number) => {
        this.frame = null;
        if (!this.running || this.disposed) return;
        // Advance a running clock before correcting drift. A throttled frame
        // must not seek playing media back to the previous frame's position.
        if (!this.ready()) {
            this.sync(false);
            this.lastTick = now;
            if (this.running) this.frame = requestAnimationFrame(this.tick);
            return;
        }
        let next = this.lastTick === null ? this.position : Math.min(this.duration(), this.position + Math.max(0, now - this.lastTick));
        const boundary = this.options.clips.filter(clip => clip.kind === "audio" || clip.kind === "video").flatMap(clip => [clip.startMs, clip.startMs + clip.durationMs]).filter(time => time > this.position && time <= next).sort((a, b) => a - b)[0];
        if (boundary !== undefined) next = boundary;
        this.position = next;
        this.lastTick = now;
        this.sync(false);
        if (!this.running) return;
        if (this.position >= this.duration()) { this.publish(); this.pause(); this.options.onRequestPause(); return; }
        // Publish a boundary once so the parent mounts the next video. While it
        // buffers, subsequent ticks hold this exact position and publish nothing.
        if (boundary !== undefined || now - this.lastPublishAt >= 80) { this.lastPublishAt = now; this.publish(); }
        this.frame = requestAnimationFrame(this.tick);
    };

    private ready() {
        const ready = (element: HTMLMediaElement | null) => Boolean(element?.src && element.readyState >= 2 &&
            (element.ended || (!element.paused && !this.pendingElements.has(element))));
        for (const record of this.audios.values()) if (this.active(record.clip) && !this.track(record.clip)?.muted && !ready(record.element)) return false;
        const activeVideo = this.options.clips.find(clip => clip.kind === "video" && this.active(clip));
        return !activeVideo || (activeVideo.id === this.options.activeVideoClipId && ready(this.options.videoRef.current));
    }

    private prepared() {
        const loaded = (element: HTMLMediaElement | null) => Boolean(element?.src && element.readyState >= 2);
        for (const record of this.audios.values()) if (this.active(record.clip) && !this.track(record.clip)?.muted && !loaded(record.element)) return false;
        const video = this.options.clips.find(clip => clip.kind === "video" && this.active(clip));
        return !video || (video.id === this.options.activeVideoClipId && loaded(this.options.videoRef.current));
    }

    private pause() {
        this.running = false;
        if (this.frame !== null) cancelAnimationFrame(this.frame);
        this.frame = null;
        this.lastTick = null;
        for (const record of this.audios.values()) record.element.pause();
        this.options.videoRef.current?.pause();
    }

    private fail(message: string) {
        if (!this.running || this.disposed) return;
        this.pause();
        this.publish();
        this.options.onPlaybackError(message);
        this.options.onRequestPause();
    }

    private reconcileAudio() {
        const keep = new Set<string>();
        for (const clip of this.options.clips) {
            if (clip.kind !== "audio") continue;
            keep.add(clip.id);
            const source = mediaSource(clip, this.options.nodes);
            const identity = JSON.stringify(source);
            const previous = this.audios.get(clip.id);
            if (previous?.identity === identity) { previous.clip = clip; continue; }
            if (previous) this.release(previous);
            const element = new Audio();
            element.preload = "auto";
            const record: AudioRecord = { clip, element, identity, disposed: false, error: false, loaded: () => this.syncAudio(record, true), failed: () => { record.error = true; if (this.active(record.clip) && !this.track(record.clip)?.muted) this.fail("音轨预览未能播放，请重新打开剪辑后重试。"); } };
            element.addEventListener("loadedmetadata", record.loaded);
            element.addEventListener("error", record.failed);
            this.audios.set(clip.id, record);
            void sourceUrl(source).then(url => {
                if (record.disposed || this.disposed) return;
                if (!url) { record.failed(); return; }
                element.src = url;
                element.load();
            }).catch(record.failed);
        }
        for (const [id, record] of this.audios) if (!keep.has(id)) { this.release(record); this.audios.delete(id); }
    }

    private apply(element: HTMLMediaElement, clip: TimelineClip, forceSeek: boolean, record?: AudioRecord) {
        const active = this.active(clip);
        const muted = this.track(clip)?.muted === true;
        if (record?.error && active && !muted && this.running) { this.fail("音轨预览未能播放，请重新打开剪辑后重试。"); return; }
        const shouldPlay = active && (clip.kind === "video" || !muted) && this.running && this.prepared();
        element.muted = muted;
        const gain = timelinePreviewGain(clip, this.position);
        if ((clip.volume ?? 1) > 1 && shouldPlay) { this.fail("当前音量超过预览范围，请将片段音量调至 100% 以内后试听。"); return; }
        element.volume = clamp(gain, 0, 1);
        // A source can finish between throttled animation frames. Let the
        // clock reach its clip boundary without seeking and replaying the tail.
        if (element.ended && !forceSeek) return;
        if (element.readyState >= 1 && (active || forceSeek)) {
            const sourceMs = (clip.sourceStartMs || 0) + clamp(this.position - clip.startMs, 0, clip.durationMs);
            const maxTime = Number.isFinite(element.duration) ? Math.max(0, element.duration - 0.001) : sourceMs / 1000;
            const target = Math.min(sourceMs / 1000, maxTime);
            if (forceSeek || Math.abs(element.currentTime - target) > 0.12) element.currentTime = target;
        }
        if (!shouldPlay) { element.pause(); return; }
        if (!element.src || element.readyState < 2 || !element.paused || this.pendingElements.has(element)) return;
        this.pendingElements.add(element);
        void element.play().then(() => {
            if (this.disposed || record?.disposed || !this.running || !this.active(clip) || (clip.kind !== "video" && this.track(clip)?.muted)) element.pause();
        }).catch(() => {
            if (!this.disposed && !record?.disposed && this.running && this.active(clip) && (clip.kind === "video" || !this.track(clip)?.muted)) this.fail("预览未能播放，请再次点击播放重试。");
        }).finally(() => { this.pendingElements.delete(element); });
    }

    private syncAudio(record: AudioRecord, forceSeek: boolean) { if (!record.disposed && !this.disposed) this.apply(record.element, record.clip, forceSeek, record); }
    private sync(forceSeek: boolean) {
        for (const record of this.audios.values()) this.syncAudio(record, forceSeek);
        this.syncVideoMetadata(forceSeek);
    }

    syncVideoMetadata = (forceSeek = true) => {
        const video = this.options.videoRef.current;
        const clip = this.options.clips.find(clip => clip.id === this.options.activeVideoClipId && clip.kind === "video");
        if (video?.error && clip && this.running && this.active(clip)) { this.fail("视频预览未能播放，请重新打开剪辑后重试。"); return; }
        if (video && clip) this.apply(video, clip, forceSeek);
        else video?.pause();
    };

    private release(record: AudioRecord) {
        record.disposed = true;
        record.element.removeEventListener("loadedmetadata", record.loaded);
        record.element.removeEventListener("error", record.failed);
        record.element.pause();
        record.element.removeAttribute("src");
        record.element.load();
    }

    dispose() { this.disposed = true; this.pause(); for (const record of this.audios.values()) this.release(record); this.audios.clear(); }
}

/** Local to one preview: each clip owns an audio element; one clock drives every media element. */
export function useTimelinePreviewPlayback(options: TimelinePreviewPlaybackOptions) {
    const current = useRef(options);
    current.current = options;
    const playback = useRef<TimelinePreviewPlayback | null>(null);
    useEffect(() => {
        const instance = new TimelinePreviewPlayback(current.current);
        playback.current = instance;
        instance.update(current.current);
        return () => { instance.dispose(); if (playback.current === instance) playback.current = null; };
    }, []);
    useEffect(() => playback.current?.update(options), [options.clips, options.tracks, options.nodes, options.playheadMs, options.playing, options.durationMs, options.activeVideoClipId]);
    return { syncVideoMetadata: () => playback.current?.syncVideoMetadata() };
}
