import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowUp, LoaderCircle, X } from "lucide-react";

export type CanvasImageCropRect = { x: number; y: number; width: number; height: number };
type ResizeHandle = "n" | "e" | "s" | "w" | "ne" | "nw" | "se" | "sw";

const handles: ResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const minSize = 0.06;
const defaultCrop: CanvasImageCropRect = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };

type CanvasImageCropEditorProps = {
    imageUrl: string;
    imageDimensions: { width: number; height: number };
    onCancel: () => void;
    onConfirm: (crop: CanvasImageCropRect) => void | Promise<void>;
};

export function CanvasImageCropEditor({ imageUrl, imageDimensions, onCancel, onConfirm }: CanvasImageCropEditorProps) {
    const frameRef = useRef<HTMLDivElement>(null);
    const [crop, setCrop] = useState<CanvasImageCropRect>(defaultCrop);
    const [isSubmitting, setIsSubmitting] = useState(false);

    useEffect(() => setCrop(defaultCrop), [imageDimensions.height, imageDimensions.width, imageUrl]);
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") onCancel();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [onCancel]);

    const beginDrag = (event: ReactPointerEvent, handle?: ResizeHandle) => {
        const frame = frameRef.current?.getBoundingClientRect();
        if (!frame?.width || !frame.height) return;
        event.preventDefault();
        event.stopPropagation();
        const startPointer = { x: event.clientX, y: event.clientY };
        const startCrop = crop;
        const onMove = (moveEvent: PointerEvent) => {
            const dx = (moveEvent.clientX - startPointer.x) / frame.width;
            const dy = (moveEvent.clientY - startPointer.y) / frame.height;
            setCrop(handle ? resizeImageCrop(startCrop, dx, dy, handle) : moveImageCrop(startCrop, dx, dy));
        };
        const onUp = () => {
            document.removeEventListener("pointermove", onMove);
            document.removeEventListener("pointerup", onUp);
        };
        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
    };

    const sizeLabel = `${Math.max(1, Math.round(crop.width * imageDimensions.width))} × ${Math.max(1, Math.round(crop.height * imageDimensions.height))}`;
    const screenScale = "scale(var(--canvas-live-inverse-scale, 1))";
    const confirmCrop = async () => {
        if (isSubmitting) return;
        setIsSubmitting(true);
        try {
            await onConfirm(crop);
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div
            ref={frameRef}
            data-image-crop-inline="true"
            aria-label="图片裁切选区"
            className="absolute inset-0 z-[calc(var(--node-z-overlay)+2)] overflow-visible rounded-[inherit] select-none"
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
        >
            <div className="absolute inset-0 overflow-hidden rounded-[inherit] bg-black/10">
                <div className="pointer-events-none absolute inset-0 bg-black/16" />
                <div
                    className="absolute cursor-move border border-white shadow-[0_0_0_9999px_rgba(0,0,0,.58)]"
                    style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` }}
                    onPointerDown={(event) => beginDrag(event)}
                >
                    <span data-canvas-no-zoom className="pointer-events-none absolute left-1.5 top-1.5 rounded-md bg-black/72 px-1.5 py-0.5 text-xs font-medium tabular-nums text-white shadow-sm" style={{ transform: screenScale, transformOrigin: "left top" }}>{sizeLabel}</span>
                    <div className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3 opacity-50" aria-hidden>
                        <i className="border-b border-r border-white/60" />
                        <i className="border-b border-r border-white/60" />
                        <i className="border-b border-white/60" />
                        <i className="border-b border-r border-white/60" />
                        <i className="border-b border-r border-white/60" />
                        <i className="border-b border-white/60" />
                        <i className="border-r border-white/60" />
                        <i className="border-r border-white/60" />
                        <i />
                    </div>
                    {handles.map((handle) => (
                        <button key={handle} type="button" aria-label={`resize-${handle}`} data-canvas-no-zoom className="absolute z-10 grid size-5 place-items-center rounded-full" style={{ ...handlePosition(handle), transform: `translate(-50%, -50%) ${screenScale}`, transformOrigin: "center" }} onPointerDown={(event) => beginDrag(event, handle)}>
                            <span className="pointer-events-none size-3 rounded-full border-2 border-white bg-neutral-900 shadow-sm" />
                        </button>
                    ))}
                </div>
            </div>
            <div data-canvas-no-zoom className="absolute left-1/2 flex h-11 items-center gap-2 rounded-2xl border border-white/12 bg-[#202020]/94 p-1.5 pl-2.5 text-white shadow-xl backdrop-blur-xl" style={{ top: "calc(100% + 12px * var(--canvas-live-inverse-scale, 1))", transform: `translateX(-50%) ${screenScale}`, transformOrigin: "center top" }}>
                <button type="button" aria-label="取消裁切" title="取消裁切" onClick={onCancel} className="grid size-8 place-items-center rounded-xl text-white/72 transition hover:bg-white/10 hover:text-white">
                    <X className="size-4" />
                </button>
                <span className="border-l border-white/12 pl-3 pr-1 text-xs font-medium tabular-nums text-white/88">{sizeLabel}</span>
                <button
                    type="button"
                    aria-label={isSubmitting ? "正在裁切" : "确认裁切"}
                    title={isSubmitting ? "正在裁切" : "确认裁切"}
                    disabled={isSubmitting}
                    onClick={() => void confirmCrop()}
                    className="grid size-8 place-items-center rounded-xl bg-white text-black transition hover:bg-white/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:cursor-wait disabled:opacity-80"
                >
                    {isSubmitting ? <LoaderCircle className="size-4 animate-spin" stroke="#111111" strokeWidth={2.25} /> : <ArrowUp className="size-4" stroke="#111111" strokeWidth={2.25} />}
                </button>
            </div>
        </div>
    );
}

export function moveImageCrop(crop: CanvasImageCropRect, dx: number, dy: number): CanvasImageCropRect {
    return { ...crop, x: clamp(crop.x + dx, 0, 1 - crop.width), y: clamp(crop.y + dy, 0, 1 - crop.height) };
}

export function resizeImageCrop(crop: CanvasImageCropRect, dx: number, dy: number, handle: ResizeHandle): CanvasImageCropRect {
    let next = { ...crop };
    if (handle.includes("e")) next.width = crop.width + dx;
    if (handle.includes("s")) next.height = crop.height + dy;
    if (handle.includes("w")) {
        next.x = crop.x + dx;
        next.width = crop.width - dx;
    }
    if (handle.includes("n")) {
        next.y = crop.y + dy;
        next.height = crop.height - dy;
    }
    next.width = clamp(next.width, minSize, 1);
    next.height = clamp(next.height, minSize, 1);
    next.x = clamp(next.x, 0, 1 - next.width);
    next.y = clamp(next.y, 0, 1 - next.height);
    return next;
}

function handlePosition(handle: ResizeHandle) {
    return { left: handle.includes("w") ? "0%" : handle.includes("e") ? "100%" : "50%", top: handle.includes("n") ? "0%" : handle.includes("s") ? "100%" : "50%", cursor: `${handle}-resize` };
}

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}
