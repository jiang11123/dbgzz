import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { resolveMediaUrl } from "@/services/file-storage";
import { cacheResourceObjectUrl } from "@/services/resource-blob-cache";
import { resourceIdFromStorageKey } from "@/services/api/resources";
import { formatTimelineTime } from "@/lib/timeline/timeline-view";
import { rasterizeTimelineSubtitle } from "@/lib/timeline/timeline-subtitle-image";
import { useTimelinePreviewPlayback } from "@/hooks/use-timeline-preview-playback";
import type { TimelineClip, TimelineProject, TimelineTrack } from "@/types/timeline";
import type { CanvasNodeData } from "@/types/canvas";

type CanvasTheme = (typeof canvasThemes)[keyof typeof canvasThemes];

type CanvasTimelinePreviewProps = {
    clips: TimelineClip[];
    tracks?: TimelineTrack[];
    output?: TimelineProject["output"];
    nodes: CanvasNodeData[];
    playheadMs: number;
    playing: boolean;
    theme: CanvasTheme;
    onTogglePlay: () => void;
    onRequestPause: () => void;
    onPlayheadChange: (ms: number) => void;
};

const PREVIEW_WIDTH = 300;
const PREVIEW_HEIGHT = 168;
const EMPTY_TRACKS: TimelineTrack[] = [];

/**
 * 时间线弹窗的所见即所得预览：显示播放头所在视频片段，并叠加当前字幕。
 * 同一时钟同步视频与独立音轨；字幕按工程输出尺寸生成后缩放。
 */
export function CanvasTimelinePreview({ clips, tracks = EMPTY_TRACKS, output, nodes, playheadMs, playing, theme, onTogglePlay, onRequestPause, onPlayheadChange }: CanvasTimelinePreviewProps) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [resolvedVideo, setResolvedVideo] = useState({ key: "", url: "" });
    const [playbackError, setPlaybackError] = useState("");
    const [subtitleImage, setSubtitleImage] = useState<{ key: string; url?: string; error?: string } | null>(null);
    // Omitted output fields use the same defaults as Go's editing.NormalizeOptions.
    const outputWidth = output?.width || 1920;
    const outputHeight = output?.height || 1080;
    const visibleTracks = useMemo(() => new Map(tracks.map(track => [track.id, track.visible !== false])), [tracks]);
    const videoClips = useMemo(() => clips.filter((clip) => clip.kind === "video" && visibleTracks.get(clip.trackId) !== false).sort((a, b) => a.startMs - b.startMs), [clips, visibleTracks]);
    const activeVideoClip = useMemo(() => videoClips.find((clip) => playheadMs >= clip.startMs && playheadMs < clip.startMs + clip.durationMs) || null, [playheadMs, videoClips]);
    const activeSubtitleClip = useMemo(() => clips.find((clip) => clip.kind === "subtitle" && visibleTracks.get(clip.trackId) !== false && playheadMs >= clip.startMs && playheadMs < clip.startMs + clip.durationMs && Boolean(clip.text?.trim())) || null, [clips, playheadMs, visibleTracks]);
    const activeNode = useMemo(() => (activeVideoClip ? nodes.find((node) => node.id === activeVideoClip.nodeId) || null : null), [activeVideoClip, nodes]);
    const media = activeVideoClip?.directMedia;
    const storageKey = media ? media.storageKey || "" : activeNode?.metadata?.storageKey || "";
    const fallback = media ? media.url || media.dataUrl || media.content || "" : activeNode?.metadata?.content || "";
    const videoSourceKey = JSON.stringify([activeVideoClip?.id, storageKey, fallback]);
    const videoUrl = resolvedVideo.key === videoSourceKey ? resolvedVideo.url : "";
    const subtitleText = output?.burnSubtitles === false ? "" : activeSubtitleClip?.text || "";
    const subtitleKey = JSON.stringify([subtitleText, outputWidth, outputHeight]);
    useEffect(() => {
        if (!subtitleText) return;
        let cancelled = false;
        let url: string | undefined;
        void rasterizeTimelineSubtitle(subtitleText, outputWidth, outputHeight).then((bytes) => {
            if (cancelled) return;
            url = URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], { type: "image/png" }));
            setSubtitleImage({ key: subtitleKey, url });
        }).catch((error: unknown) => {
            if (!cancelled) setSubtitleImage({ key: subtitleKey, error: error instanceof Error ? error.message : "字幕预览失败" });
        });
        return () => {
            cancelled = true;
            if (url) URL.revokeObjectURL(url);
        };
    }, [subtitleText, subtitleKey, outputWidth, outputHeight]);
    const currentSubtitleImage = subtitleText && subtitleImage?.key === subtitleKey ? subtitleImage : null;

    // 解析当前片段视频地址（与字幕弹窗同一套缓存/回退策略）。
    useEffect(() => {
        if (!storageKey && !fallback) return;
        let cancelled = false;
        // 直连媒体片段（directMedia，不落画布）与画布节点走同一套缓存/回退解析策略
        const applyUrl = (url: string) => {
            if (!cancelled) setResolvedVideo({ key: videoSourceKey, url });
        };
        void (async () => {
            if (resourceIdFromStorageKey(storageKey)) {
                const cached = await cacheResourceObjectUrl(storageKey).catch(() => undefined);
                if (cached) return cached;
            }
            return resolveMediaUrl(storageKey, fallback);
        })().then(applyUrl).catch(() => {
            if (!cancelled) {
                setPlaybackError("视频预览未能载入，请重新打开剪辑后重试。");
                onRequestPause();
            }
        });
        return () => {
            cancelled = true;
        };
    }, [storageKey, fallback, videoSourceKey]);
    const { syncVideoMetadata } = useTimelinePreviewPlayback({ clips, tracks, nodes, playheadMs, playing, videoRef,
        activeVideoClipId: activeVideoClip?.id || null, onPlayheadChange, onRequestPause, onPlaybackError: setPlaybackError });

    const previewDisplay = useMemo(() => {
        const ratio = outputWidth / outputHeight;
        let width = PREVIEW_WIDTH;
        let height = width / ratio;
        if (height > PREVIEW_HEIGHT) {
            height = PREVIEW_HEIGHT;
            width = Math.round(height * ratio);
        }
        return { width: Math.round(width), height: Math.round(height) };
    }, [outputWidth, outputHeight]);

    return (
        <div className="canvas-timeline-preview flex items-center gap-3 border-b px-4 py-2.5" style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}>
            <div className="relative grid shrink-0 place-items-center overflow-hidden rounded-lg bg-black" style={{ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT }} data-canvas-no-zoom>
                {videoUrl && activeVideoClip ? (
                    <div className="relative bg-black" data-timeline-output-frame style={previewDisplay}>
                        <video ref={videoRef} className="block h-full w-full object-contain" src={videoUrl} playsInline preload="auto" onLoadedMetadata={syncVideoMetadata} />
                        {currentSubtitleImage?.url ? <img className="pointer-events-none absolute inset-0 h-full w-full" src={currentSubtitleImage.url} alt="" data-timeline-subtitle-preview /> : null}
                    </div>
                ) : (
                    <div className="px-4 text-center text-xs opacity-55">该位置无视频片段</div>
                )}
                <button
                    type="button"
                    className="absolute inset-0 z-10 grid place-items-center"
                    aria-label={playing ? "暂停预览" : "播放预览"}
                    onClick={(event) => {
                        event.stopPropagation();
                        setPlaybackError("");
                        onTogglePlay();
                    }}
                >
                    <span className="grid size-10 place-items-center rounded-full bg-black/45 text-white backdrop-blur transition hover:scale-105 hover:bg-black/60">
                        {playing ? <Pause className="size-4 fill-current" /> : <Play className="size-4 fill-current" />}
                    </span>
                </button>
            </div>
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-xs">
                    <span className="truncate font-semibold" style={{ color: theme.accent.primary }}>
                        {activeVideoClip?.title || "无视频片段"}
                    </span>
                    <span className="opacity-45 tabular-nums">{activeVideoClip ? `${formatTimelineTime(activeVideoClip.startMs)} ~ ${formatTimelineTime(activeVideoClip.startMs + activeVideoClip.durationMs)}` : ""}</span>
                </div>
                <div className="mt-1.5 max-h-16 min-h-10 overflow-y-auto rounded-lg border px-2.5 py-1.5 text-xs leading-5" style={{ borderColor: theme.toolbar.border, background: theme.node.fill }}>
                    {activeSubtitleClip ? activeSubtitleClip.text : <span className="opacity-40">此处无字幕，点选字幕片段后在下方编辑</span>}
                </div>
                {currentSubtitleImage?.error ? <div role="alert" className="mt-1 text-xs">{currentSubtitleImage.error}</div> : null}
                {playbackError ? <div role="alert" className="mt-1 text-xs">{playbackError}</div> : null}
            </div>
        </div>
    );
}
