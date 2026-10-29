import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowUp, LoaderCircle, X } from "lucide-react";

import { moveVideoCrop, resizeVideoCrop, type VideoCropHandle, type VideoCropRect } from "@/lib/canvas/video-crop-geometry";

export type CanvasVideoCropRect = VideoCropRect;

const cropHandles: VideoCropHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

type CanvasVideoCropEditorProps = {
    videoUrl: string;
    videoDimensions: { width: number; height: number };
    onCancel: () => void;
    onConfirm: (crop: CanvasVideoCropRect, sourceDimensions: { width: number; height: number }) => void | Promise<void>;
};

export function CanvasVideoCropEditor({ videoUrl, videoDimensions, onCancel, onConfirm }: CanvasVideoCropEditorProps) {
    const frameRef = useRef<HTMLDivElement>(null);
    const [sourceDimensions, setSourceDimensions] = useState(videoDimensions);
    const [crop, setCrop] = useState<CanvasVideoCropRect>(() => initialVideoCrop(videoDimensions));
    const [isSubmitting, setIsSubmitting] = useState(false);

    useEffect(() => {
        setSourceDimensions(videoDimensions);
        setCrop(initialVideoCrop(videoDimensions));
    }, [videoDimensions.height, videoDimensions.width, videoUrl]);
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [onCancel]);

    const beginDrag = (event: ReactPointerEvent, handle?: VideoCropHandle) => {
        const frame = frameRef.current?.getBoundingClientRect();
        if (!frame?.width || !frame.height) return;
        event.preventDefault();
        event.stopPropagation();
        const startPointer = { x: event.clientX, y: event.clientY };
        const startCrop = crop;
        const scale = { x: sourceDimensions.width / frame.width, y: sourceDimensions.height / frame.height };
        const onMove = (moveEvent: PointerEvent) => {
            const deltaX = (moveEvent.clientX - startPointer.x) * scale.x;
            const deltaY = (moveEvent.clientY - startPointer.y) * scale.y;
            setCrop(handle
                ? resizeVideoCrop(startCrop, sourceDimensions, handle, deltaX, deltaY)
                : moveVideoCrop(startCrop, sourceDimensions, deltaX, deltaY));
        };
        const onUp = () => {
            document.removeEventListener("pointermove", onMove);
            document.removeEventListener("pointerup", onUp);
        };
        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
    };

    const left = crop.x / sourceDimensions.width * 100;
    const top = crop.y / sourceDimensions.height * 100;
    const width = crop.width / sourceDimensions.width * 100;
    const height = crop.height / sourceDimensions.height * 100;
    const sizeLabel = `${crop.width} × ${crop.height}`;
    const screenScale = "scale(var(--canvas-live-inverse-scale, 1))";
    const confirmCrop = async () => {
        if (isSubmitting) return;
        setIsSubmitting(true);
        try {
            await onConfirm(crop, sourceDimensions);
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div
            ref={frameRef}
            data-video-crop-inline="true"
            aria-label="视频裁切选区"
            className="absolute inset-0 z-[calc(var(--node-z-overlay)+2)] overflow-visible rounded-[inherit] select-none"
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
        >
            <video
                data-video-crop-metadata-loader="true"
                src={videoUrl}
                preload="metadata"
                muted
                playsInline
                className="hidden"
                onLoadedMetadata={(event) => {
                    const { videoWidth, videoHeight } = event.currentTarget;
                    if (!videoWidth || !videoHeight) return;
                    const dimensions = { width: videoWidth, height: videoHeight };
                    setSourceDimensions(dimensions);
                    setCrop(initialVideoCrop(dimensions));
                }}
            />
            <div className="absolute inset-0 overflow-hidden rounded-[inherit] bg-black/10">
                <div className="pointer-events-none absolute inset-0 bg-black/16" />
                <div
                    className="absolute cursor-move border border-white shadow-[0_0_0_9999px_rgba(0,0,0,.58)]"
                    style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }}
                    onPointerDown={(event) => beginDrag(event)}
                >
                    <span data-canvas-no-zoom className="pointer-events-none absolute left-1.5 top-1.5 rounded-md bg-black/72 px-1.5 py-0.5 text-xs font-medium tabular-nums text-white shadow-sm" style={{ transform: screenScale, transformOrigin: "left top" }}>{sizeLabel}</span>
                    <div className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3 opacity-50" aria-hidden>
                        <i className="border-b border-r border-white/60" /><i className="border-b border-r border-white/60" /><i className="border-b border-white/60" />
                        <i className="border-b border-r border-white/60" /><i className="border-b border-r border-white/60" /><i className="border-b border-white/60" />
                        <i className="border-r border-white/60" /><i className="border-r border-white/60" /><i />
                    </div>
                    {cropHandles.map((handle) => (
                        <button key={handle} type="button" aria-label={`resize-${handle}`} data-canvas-no-zoom className="absolute z-10 grid size-5 place-items-center rounded-full" style={{ ...handlePosition(handle), transform: `translate(-50%, -50%) ${screenScale}`, transformOrigin: "center" }} onPointerDown={(event) => beginDrag(event, handle)}>
                            <span className="pointer-events-none size-3 rounded-full border-2 border-white bg-neutral-900 shadow-sm" />
                        </button>
                    ))}
                </div>
            </div>

            <div data-canvas-no-zoom className="absolute left-1/2 flex h-11 items-center gap-2 rounded-2xl border border-white/12 bg-[#202020]/94 p-1.5 pl-2.5 text-white shadow-xl backdrop-blur-xl" style={{ top: "calc(100% + 12px * var(--canvas-live-inverse-scale, 1))", transform: `translateX(-50%) ${screenScale}`, transformOrigin: "center top" }}>
                <button type="button" aria-label="取消裁切" title="取消裁切" onClick={onCancel} className="grid size-8 place-items-center rounded-xl text-white/72 transition hover:bg-white/10 hover:text-white"><X className="size-4" /></button>
                <span className="border-l border-white/12 pl-3 pr-1 text-xs font-medium tabular-nums text-white/88">{sizeLabel}</span>
                <button type="button" aria-label={isSubmitting ? "正在裁切" : "确认裁切"} title={isSubmitting ? "正在裁切" : "确认裁切"} disabled={isSubmitting} onClick={() => void confirmCrop()} className="grid size-8 place-items-center rounded-xl bg-white text-black transition hover:bg-white/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:cursor-wait disabled:opacity-80">{isSubmitting ? <LoaderCircle className="size-4 animate-spin" stroke="#111111" strokeWidth={2.25} /> : <ArrowUp className="size-4" stroke="#111111" strokeWidth={2.25} />}</button>
            </div>
        </div>
    );
}

function initialVideoCrop(video: { width: number; height: number }): CanvasVideoCropRect {
    const x = Math.round(video.width * 0.1);
    const y = Math.round(video.height * 0.1);
    return { x, y, width: Math.max(16, video.width - x * 2), height: Math.max(16, video.height - y * 2) };
}

function handlePosition(handle: VideoCropHandle) {
    return { left: handle.includes("w") ? "0%" : handle.includes("e") ? "100%" : "50%", top: handle.includes("n") ? "0%" : handle.includes("s") ? "100%" : "50%" };
}
