import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { Check, Film, LoaderCircle, Pause, Play, X } from "lucide-react";

import { CanvasNodePanelOverlay } from "@/components/canvas/canvas-workspace-overlays";
import {
    INLINE_VIDEO_TRIM_MIN_MS,
    moveInlineVideoTrimRange,
    normalizeInlineVideoTrimRange,
    placeInlineVideoTrimDuration,
    type InlineVideoTrimRange,
} from "@/lib/canvas/canvas-video-inline-trim";
import { canvasNodeVideoPreviewUrl } from "@/lib/canvas/canvas-media-preview";
import { cacheResourceObjectUrl } from "@/services/resource-blob-cache";
import { resourceIdFromStorageKey } from "@/services/api/resources";
import { resolveMediaUrl } from "@/services/file-storage";
import type { CanvasNodeData, Position, ViewportTransform } from "@/types/canvas";

type CanvasVideoInlineTrimProps = {
    node: CanvasNodeData;
    busy: boolean;
    onCancel: () => void;
    onConfirm: (range: InlineVideoTrimRange) => void;
};

type CanvasVideoInlineTrimOverlayProps = CanvasVideoInlineTrimProps & {
    viewport: ViewportTransform;
    containerRef: RefObject<HTMLDivElement | null>;
    dragOffset?: Position | null;
    isDragging?: boolean;
};

type DragSession = {
    kind: "start" | "end" | "range";
    pointerId: number;
    clientX: number;
    range: InlineVideoTrimRange;
};

const FRAME_COUNT = 14;

export function CanvasVideoInlineTrimOverlay({ node, viewport, containerRef, dragOffset, isDragging = false, busy, onCancel, onConfirm }: CanvasVideoInlineTrimOverlayProps) {
    return (
        <CanvasNodePanelOverlay
            node={node}
            viewport={viewport}
            containerRef={containerRef}
            panelMinWidth={520}
            panelMaxWidth={920}
            panelWidthScale={1.5}
            panelHeight={82}
            allowOverflow
            keepBelowNode
            avoidBottomDock
            className="canvas-video-trim-overlay"
            dragOffset={dragOffset}
            isDragging={isDragging}
        >
            <CanvasVideoInlineTrim node={node} busy={busy} onCancel={onCancel} onConfirm={onConfirm} />
        </CanvasNodePanelOverlay>
    );
}

export function CanvasVideoInlineTrim({ node, busy, onCancel, onConfirm }: CanvasVideoInlineTrimProps) {
    const timelineRef = useRef<HTMLDivElement>(null);
    const durationRef = useRef<HTMLOutputElement>(null);
    const dragRef = useRef<DragSession | null>(null);
    const [videoUrl, setVideoUrl] = useState(node.metadata?.content || "");
    const [durationMs, setDurationMs] = useState(Math.max(0, node.metadata?.durationMs || 0));
    const [range, setRange] = useState<InlineVideoTrimRange>(() => ({ startMs: 0, endMs: Math.max(INLINE_VIDEO_TRIM_MIN_MS, node.metadata?.durationMs || INLINE_VIDEO_TRIM_MIN_MS) }));
    const [frames, setFrames] = useState<string[]>([]);
    const [frameStatus, setFrameStatus] = useState<"loading" | "ready" | "unavailable">("loading");
    const [trackMetrics, setTrackMetrics] = useState({ width: 0, labelWidth: 0 });
    const [playing, setPlaying] = useState(false);

    useEffect(() => {
        let cancelled = false;
        const storageKey = node.metadata?.storageKey || "";
        const fallback = node.metadata?.content || "";
        const resolve = async () => {
            const cached = resourceIdFromStorageKey(storageKey) ? await cacheResourceObjectUrl(storageKey) : null;
            const nextUrl = cached || await resolveMediaUrl(storageKey, fallback);
            if (!cancelled) setVideoUrl(nextUrl || fallback);
        };
        void resolve().catch(() => { if (!cancelled) setVideoUrl(fallback); });
        return () => { cancelled = true; };
    }, [node.id, node.metadata?.content, node.metadata?.storageKey]);

    useEffect(() => {
        const nextDuration = Math.max(INLINE_VIDEO_TRIM_MIN_MS, node.metadata?.durationMs || durationMs || INLINE_VIDEO_TRIM_MIN_MS);
        setDurationMs(nextDuration);
        setRange({ startMs: 0, endMs: nextDuration });
    }, [node.id, node.metadata?.durationMs]);

    useEffect(() => {
        setFrames([]);
        setFrameStatus(videoUrl ? "loading" : "unavailable");
        if (!videoUrl || typeof document === "undefined") return;
        let cancelled = false;
        const source = document.createElement("video");
        source.muted = true;
        source.playsInline = true;
        source.preload = "auto";
        source.src = videoUrl;
        const capture = async () => {
            await waitForMediaEvent(source, "loadedmetadata");
            if (cancelled) return;
            const seconds = Number.isFinite(source.duration) && source.duration > 0 ? source.duration : durationMs / 1000;
            if (seconds > 0) {
                const nextDuration = Math.round(seconds * 1000);
                setDurationMs(nextDuration);
                setRange((current) => normalizeInlineVideoTrimRange(current.endMs <= INLINE_VIDEO_TRIM_MIN_MS ? { startMs: 0, endMs: nextDuration } : current, nextDuration));
            }
            const canvas = document.createElement("canvas");
            canvas.width = 144;
            canvas.height = 82;
            const context = canvas.getContext("2d");
            if (!context || !seconds) {
                setFrameStatus("unavailable");
                return;
            }
            const captured: string[] = [];
            for (let index = 0; index < FRAME_COUNT && !cancelled; index += 1) {
                source.currentTime = Math.min(Math.max(0, seconds - 0.04), (seconds * (index + 0.5)) / FRAME_COUNT);
                await waitForMediaEvent(source, "seeked");
                if (cancelled) return;
                context.drawImage(source, 0, 0, canvas.width, canvas.height);
                captured.push(canvas.toDataURL("image/jpeg", 0.72));
                setFrames([...captured]);
                setFrameStatus("ready");
            }
        };
        void capture().catch(() => { if (!cancelled) setFrameStatus("unavailable"); });
        return () => {
            cancelled = true;
            source.removeAttribute("src");
            source.load();
        };
    }, [durationMs, videoUrl]);

    useEffect(() => {
        const preview = canvasNodeVideo(node.id);
        if (!preview) return;
        preview.muted = false;
        preview.loop = false;
        const handleTimeUpdate = () => {
            if (preview.currentTime * 1000 < range.endMs - 20) return;
            preview.pause();
            setPlaying(false);
        };
        const handlePause = () => setPlaying(false);
        preview.addEventListener("timeupdate", handleTimeUpdate);
        preview.addEventListener("pause", handlePause);
        return () => {
            preview.removeEventListener("timeupdate", handleTimeUpdate);
            preview.removeEventListener("pause", handlePause);
        };
    }, [node.id, range.endMs, range.startMs]);

    useEffect(() => () => canvasNodeVideo(node.id)?.pause(), [node.id]);

    useEffect(() => {
        const timeline = timelineRef.current;
        const label = durationRef.current;
        if (!timeline || !label) return;
        const measure = () => {
            const width = timeline.getBoundingClientRect().width;
            const labelWidth = label.getBoundingClientRect().width;
            setTrackMetrics((current) => current.width === width && current.labelWidth === labelWidth ? current : { width, labelWidth });
        };
        measure();
        if (typeof ResizeObserver === "undefined") {
            window.addEventListener("resize", measure);
            return () => window.removeEventListener("resize", measure);
        }
        const observer = new ResizeObserver(measure);
        observer.observe(timeline);
        observer.observe(label);
        return () => observer.disconnect();
    }, []);

    const startPercent = durationMs ? (range.startMs / durationMs) * 100 : 0;
    const endPercent = durationMs ? (range.endMs / durationMs) * 100 : 100;
    const selectedDuration = Math.max(0, range.endMs - range.startMs);
    const durationPlacement = placeInlineVideoTrimDuration(trackMetrics.width, startPercent, endPercent, trackMetrics.labelWidth);
    const fallbackFrame = canvasNodeVideoPreviewUrl(node);
    const visibleFrames = useMemo(() => Array.from({ length: FRAME_COUNT }, (_, index) => frames[index] || frames[0] || fallbackFrame), [fallbackFrame, frames]);
    const showFrameStatus = !visibleFrames.some(Boolean);

    const seekPreview = (timeMs: number) => {
        const preview = canvasNodeVideo(node.id);
        if (preview) preview.currentTime = Math.max(0, timeMs) / 1000;
    };

    const beginDrag = (kind: DragSession["kind"], event: ReactPointerEvent<HTMLElement>) => {
        if (busy || !durationMs) return;
        event.preventDefault();
        event.stopPropagation();
        dragRef.current = { kind, pointerId: event.pointerId, clientX: event.clientX, range };
        event.currentTarget.setPointerCapture(event.pointerId);
    };

    const continueDrag = (event: ReactPointerEvent<HTMLElement>) => {
        const session = dragRef.current;
        const timeline = timelineRef.current;
        if (!session || session.pointerId !== event.pointerId || !timeline || !durationMs) return;
        const deltaMs = ((event.clientX - session.clientX) / Math.max(1, timeline.getBoundingClientRect().width)) * durationMs;
        let next: InlineVideoTrimRange;
        if (session.kind === "range") next = moveInlineVideoTrimRange(session.range, deltaMs, durationMs);
        else if (session.kind === "start") next = normalizeInlineVideoTrimRange({ startMs: Math.min(session.range.endMs - INLINE_VIDEO_TRIM_MIN_MS, session.range.startMs + deltaMs), endMs: session.range.endMs }, durationMs);
        else next = normalizeInlineVideoTrimRange({ startMs: session.range.startMs, endMs: Math.max(session.range.startMs + INLINE_VIDEO_TRIM_MIN_MS, session.range.endMs + deltaMs) }, durationMs);
        setRange(next);
        seekPreview(session.kind === "end" ? next.endMs : next.startMs);
    };

    const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
        const session = dragRef.current;
        if (!session || session.pointerId !== event.pointerId) return;
        dragRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    };

    const togglePlayback = () => {
        const preview = canvasNodeVideo(node.id);
        if (!preview) return;
        if (!preview.paused) {
            preview.pause();
            setPlaying(false);
            return;
        }
        if (preview.currentTime * 1000 < range.startMs || preview.currentTime * 1000 >= range.endMs) preview.currentTime = range.startMs / 1000;
        preview.muted = false;
        void preview.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    };

    return (
        <section
            role="dialog"
            aria-label="视频片段剪辑"
            aria-modal="false"
            className="canvas-video-inline-trim"
            data-canvas-no-zoom
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            <button type="button" className="canvas-video-trim-icon-button is-cancel" aria-label="取消剪辑" disabled={busy} onClick={onCancel}><X /></button>
            <span className="canvas-video-trim-separator" aria-hidden />
            <button type="button" className="canvas-video-trim-icon-button" aria-label={playing ? "暂停片段预览" : "播放片段预览"} onClick={togglePlayback}>{playing ? <Pause /> : <Play />}</button>
            <Film className="canvas-video-trim-film-icon" aria-hidden />

            <div className="canvas-video-trim-track">
            <div className="canvas-video-trim-timeline" ref={timelineRef} data-video-trim-filmstrip="true">
                <div className="canvas-video-trim-frames" aria-hidden>
                    {visibleFrames.map((frame, index) => <span key={index} style={frame ? { backgroundImage: `url(${JSON.stringify(frame)})` } : undefined} />)}
                </div>
                <div className="canvas-video-trim-dim is-before" style={{ width: `${startPercent}%` }} aria-hidden />
                <div className="canvas-video-trim-dim is-after" style={{ left: `${endPercent}%` }} aria-hidden />
                <button
                    type="button"
                    className="canvas-video-trim-selection"
                    aria-label="移动已选片段"
                    style={{ left: `${startPercent}%`, width: `${Math.max(0, endPercent - startPercent)}%` }}
                    onPointerDown={(event) => beginDrag("range", event)}
                    onPointerMove={continueDrag}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                >
                </button>
                <button
                    type="button"
                    className="canvas-video-trim-handle is-start"
                    aria-label="调整片段起点"
                    style={{ left: `${startPercent}%` }}
                    onPointerDown={(event) => beginDrag("start", event)}
                    onPointerMove={continueDrag}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                ><span /></button>
                <button
                    type="button"
                    className="canvas-video-trim-handle is-end"
                    aria-label="调整片段终点"
                    style={{ left: `${endPercent}%` }}
                    onPointerDown={(event) => beginDrag("end", event)}
                    onPointerMove={continueDrag}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                ><span /></button>
                {showFrameStatus ? <span className="canvas-video-trim-frame-status" role="status">{frameStatus === "unavailable" ? "缩略图不可用" : "正在读取缩略图"}</span> : null}
            </div>
            <output
                ref={durationRef}
                className={`canvas-video-trim-duration${durationPlacement.floating ? " is-floating" : ""}`}
                style={{ left: trackMetrics.width ? `${durationPlacement.left}px` : `${(startPercent + endPercent) / 2}%` }}
                aria-label="所选片段时长"
            >{formatTrimDuration(selectedDuration)}</output>
            </div>
            <button type="button" className="canvas-video-trim-confirm" aria-label="确认剪辑" disabled={busy || !durationMs} onClick={() => onConfirm(range)}>{busy ? <LoaderCircle className="animate-spin" /> : <Check />}</button>
        </section>
    );
}

function canvasNodeVideo(nodeId: string) {
    if (typeof document === "undefined") return null;
    return document.querySelector<HTMLVideoElement>(`[data-node-id="${CSS.escape(nodeId)}"] video`);
}

function waitForMediaEvent(element: HTMLMediaElement, eventName: "loadedmetadata" | "seeked") {
    if (eventName === "loadedmetadata" && element.readyState >= 1) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
        const onReady = () => { cleanup(); resolve(); };
        const onError = () => { cleanup(); reject(new Error("视频帧读取失败")); };
        const cleanup = () => {
            element.removeEventListener(eventName, onReady);
            element.removeEventListener("error", onError);
        };
        element.addEventListener(eventName, onReady, { once: true });
        element.addEventListener("error", onError, { once: true });
    });
}

function formatTrimDuration(durationMs: number) {
    return `${(Math.max(0, durationMs) / 1000).toFixed(2)} s`;
}
