import { useEffect, useRef, useState, type ReactNode } from "react";

import { CachedResourceImage } from "@/components/cached-resource-image";
import { useResourceVideoPlayback } from "@/hooks/use-resource-video-playback";
import type { Asset } from "@/stores/use-asset-store";

type AssetMediaPreviewProps = {
    asset?: Asset | null;
    alt: string;
    className?: string;
    fallback?: ReactNode;
    hoverPlayDelayMs?: number;
};

export function AssetMediaPreview({ asset, alt, className = "", fallback = null, hoverPlayDelayMs }: AssetMediaPreviewProps) {
    const hoverTimerRef = useRef<number | null>(null);
    const [mediaFailed, setMediaFailed] = useState(false);
    const videoStorageKey = asset?.kind === "video" ? asset.data.storageKey : undefined;
    const videoFallbackUrl = asset?.kind === "video" ? asset.data.url : "";
    const playback = useResourceVideoPlayback(videoStorageKey || "", videoFallbackUrl || "", asset?.kind === "video");
    const resolvedVideoUrl = playback.url;
    useEffect(() => { setMediaFailed(false); }, [asset?.id]);
    useEffect(() => () => { if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current); }, []);
    if (!asset) return fallback;
    if (mediaFailed || playback.error) return fallback;

    if (asset.kind === "video" && asset.data.url) {
        if (!resolvedVideoUrl) return fallback;
        const clearHoverTimer = () => {
            if (hoverTimerRef.current !== null) {
                window.clearTimeout(hoverTimerRef.current);
                hoverTimerRef.current = null;
            }
        };
        const poster = asset.coverUrl && asset.coverUrl !== asset.data.url ? asset.coverUrl : undefined;
        return (
            <video
                src={resolvedVideoUrl}
                poster={poster}
                aria-label={alt}
                muted
                playsInline
                preload="auto"
                className={className}
                onError={() => { if (!playback.requestCompatible()) setMediaFailed(true); }}
                onMouseEnter={(event) => {
                    if (hoverPlayDelayMs === undefined) return;
                    const video = event.currentTarget;
                    clearHoverTimer();
                    hoverTimerRef.current = window.setTimeout(() => {
                        void video.play().catch(() => undefined);
                    }, hoverPlayDelayMs);
                }}
                onMouseLeave={(event) => {
                    if (hoverPlayDelayMs === undefined) return;
                    clearHoverTimer();
                    event.currentTarget.pause();
                    event.currentTarget.currentTime = 0;
                }}
                onLoadedMetadata={(event) => {
                    // 主动触发首帧附近的解码，避免只有 metadata 时长期停留在空白画面。
                    const video = event.currentTarget;
                    if (!poster && video.currentTime === 0 && video.duration > 0) video.currentTime = Math.min(0.001, video.duration);
                }}
                onLoadedData={(event) => {
                    const video = event.currentTarget;
                    if (!poster && video.readyState >= 2) {
                        video.currentTime = 0;
                        video.pause();
                    }
                }}
            />
        );
    }

    const storageKey = asset.kind === "image" ? asset.data.storageKey : undefined;
    const imageUrl = asset.coverUrl || (asset.kind === "image" ? asset.data.dataUrl : "");
    if (!imageUrl && !storageKey) return fallback;
    return <CachedResourceImage storageKey={storageKey} src={imageUrl} alt={alt} loading="lazy" decoding="async" className={className} fallback={fallback} />;
}
