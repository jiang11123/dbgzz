import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Brush, LoaderCircle, Redo2, Save, Square, Type, Undo2, X } from "lucide-react";
import { Tooltip } from "@/components/ui/base/tooltip";
import { imageToDataUrl } from "@/services/image-storage";
import { annotationHistory, normalizeAnnotationRect, type AnnotationHistory, type AnnotationOperation, type AnnotationPoint } from "./canvas-image-annotation-model";

type Tool = "brush" | "rectangle" | "text";
const colors = ["#ef4444", "#f59e0b", "#22c55e", "#14b8a6", "#3b82f6", "#a855f7", "#ffffff", "#111827"];

export function CanvasImageAnnotationEditor({ image, scale, onCancel, onConfirm }: { image: { url: string; storageKey?: string }; scale: number; onCancel: () => void; onConfirm: (dataUrl: string) => void | Promise<void> }) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const sourceImageRef = useRef<HTMLImageElement | null>(null);
    const draftRef = useRef<AnnotationOperation | null>(null);
    const rectOriginRef = useRef<AnnotationPoint | null>(null);
    const [size, setSize] = useState({ width: 0, height: 0 });
    const [tool, setTool] = useState<Tool>("brush");
    const [color, setColor] = useState(colors[0]);
    const [strokeSize, setStrokeSize] = useState(18);
    const [textSize, setTextSize] = useState(42);
    const [history, setHistory] = useState<AnnotationHistory>(() => annotationHistory.empty());
    const [textDraft, setTextDraft] = useState<{ point: AnnotationPoint; value: string } | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void imageToDataUrl(image).then((dataUrl) => {
            if (cancelled || !dataUrl) return;
            const element = new Image();
            element.onload = () => { if (!cancelled) { sourceImageRef.current = element; setSize({ width: element.naturalWidth, height: element.naturalHeight }); setHistory(annotationHistory.empty()); } };
            element.src = dataUrl;
        });
        return () => { cancelled = true; };
    }, [image.storageKey, image.url]);
    useEffect(() => redraw(canvasRef.current, history.items), [history, size]);
    useEffect(() => {
        const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") { if (textDraft) setTextDraft(null); else onCancel(); } };
        window.addEventListener("keydown", keydown);
        return () => window.removeEventListener("keydown", keydown);
    }, [onCancel, textDraft]);

    const pointFor = (event: ReactPointerEvent<HTMLCanvasElement>) => canvasPoint(event.currentTarget, event.clientX, event.clientY);
    const begin = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        event.preventDefault(); event.stopPropagation();
        const point = pointFor(event);
        if (tool === "text") { setTextDraft({ point, value: "" }); return; }
        event.currentTarget.setPointerCapture(event.pointerId);
        rectOriginRef.current = point;
        draftRef.current = tool === "brush" ? { type: "brush", color, size: strokeSize, points: [point] } : { type: "rectangle", color, size: strokeSize, x: point.x, y: point.y, width: 0, height: 0 };
    };
    const move = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        const draft = draftRef.current;
        if (!draft) return;
        event.preventDefault(); event.stopPropagation();
        if (draft.type === "brush") draft.points.push(pointFor(event));
        else if (draft.type === "rectangle" && rectOriginRef.current) Object.assign(draft, normalizeAnnotationRect(rectOriginRef.current, pointFor(event)));
        redraw(canvasRef.current, [...history.items, draft]);
    };
    const finish = () => {
        const draft = draftRef.current;
        draftRef.current = null; rectOriginRef.current = null;
        if (!draft || (draft.type === "rectangle" && (!draft.width || !draft.height))) return;
        setHistory((current) => annotationHistory.push(current, draft));
    };
    const commitText = () => {
        if (!textDraft?.value.trim()) { setTextDraft(null); return; }
        setHistory((current) => annotationHistory.push(current, { type: "text", color, size: textSize, ...textDraft.point, text: textDraft.value.trim() }));
        setTextDraft(null);
    };
    const save = async () => {
        if (isSubmitting || !history.items.length || !sourceImageRef.current || !canvasRef.current) return;
        setIsSubmitting(true);
        try {
            const output = document.createElement("canvas"); output.width = size.width; output.height = size.height;
            const context = output.getContext("2d"); if (!context) return;
            context.drawImage(sourceImageRef.current, 0, 0, output.width, output.height); context.drawImage(canvasRef.current, 0, 0);
            await onConfirm(output.toDataURL("image/png"));
        } finally { setIsSubmitting(false); }
    };
    const currentSize = tool === "text" ? textSize : strokeSize;

    return <div data-image-annotation-inline="true" className="absolute inset-0 z-[calc(var(--node-z-overlay)+3)] overflow-visible rounded-[inherit]" onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
        <canvas ref={canvasRef} width={size.width || 1} height={size.height || 1} aria-label="图片标注画布" className="absolute inset-0 h-full w-full touch-none cursor-crosshair rounded-[inherit]" onPointerDown={begin} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} />
        {textDraft ? <input autoFocus aria-label="标注文字" value={textDraft.value} onChange={(event) => setTextDraft({ ...textDraft, value: event.target.value })} onBlur={commitText} onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Enter") commitText(); if (event.key === "Escape") setTextDraft(null); }} className="absolute z-20 min-w-24 border-b-2 bg-black/55 px-1 py-0.5 text-white outline-none" style={{ left: `${textDraft.point.x / Math.max(1, size.width) * 100}%`, top: `${textDraft.point.y / Math.max(1, size.height) * 100}%`, borderColor: color, fontSize: Math.max(12, textSize * 0.45) }} /> : null}
        <div data-canvas-no-zoom="true" className="absolute bottom-[calc(100%+14px)] left-1/2 flex h-14 items-center gap-1 rounded-2xl border border-white/10 bg-[#242424]/96 p-1.5 text-white shadow-2xl backdrop-blur-xl" style={{ transform: `translateX(-50%) scale(var(--canvas-live-inverse-scale, ${1 / Math.max(scale, 0.01)}))`, transformOrigin: "center bottom" }}>
            <ToolButton title="关闭标注" onClick={onCancel}><X /></ToolButton><Divider />
            <ToolButton title="画笔" active={tool === "brush"} onClick={() => setTool("brush")}><Brush /></ToolButton><ToolButton title="矩形" active={tool === "rectangle"} onClick={() => setTool("rectangle")}><Square /></ToolButton><ToolButton title="文字" active={tool === "text"} onClick={() => setTool("text")}><Type /></ToolButton><Divider />
            <label className="relative grid size-9 cursor-pointer place-items-center rounded-xl hover:bg-white/10" title="颜色"><span className="size-5 rounded-full border border-white/70" style={{ background: color }} /><input aria-label="标注颜色" type="color" value={color} onChange={(event) => setColor(event.target.value)} className="absolute inset-0 cursor-pointer opacity-0" /></label>
            <input aria-label={tool === "text" ? "文字字号" : "线条粗细"} type="range" min={tool === "text" ? 18 : 3} max={tool === "text" ? 96 : 80} value={currentSize} onChange={(event) => tool === "text" ? setTextSize(Number(event.target.value)) : setStrokeSize(Number(event.target.value))} className="mx-2 w-24 accent-white" /><Divider />
            <ToolButton title="撤销" disabled={!history.items.length} onClick={() => setHistory(annotationHistory.undo)}><Undo2 /></ToolButton><ToolButton title="重做" disabled={!history.redo.length} onClick={() => setHistory(annotationHistory.redo)}><Redo2 /></ToolButton>
            <button type="button" aria-label={isSubmitting ? "正在保存" : "保存标注"} title={isSubmitting ? "正在保存" : "保存标注"} disabled={!history.items.length || isSubmitting} onClick={() => void save()} className="ml-2 grid size-10 place-items-center rounded-xl bg-white text-neutral-900 transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-40">{isSubmitting ? <LoaderCircle className="size-4 animate-spin text-neutral-900" /> : <Save className="size-4 text-neutral-900" />}</button>
        </div>
    </div>;
}

function Divider() { return <span className="mx-1 h-7 w-px bg-white/12" />; }
function ToolButton({ title, active, disabled, children, onClick }: { title: string; active?: boolean; disabled?: boolean; children: ReactNode; onClick: () => void }) { return <Tooltip title={title}><button type="button" aria-label={title} disabled={disabled} className={`grid size-10 place-items-center rounded-xl transition disabled:opacity-25 ${active ? "bg-white/16 text-white" : "text-white/72 hover:bg-white/10 hover:text-white"}`} onClick={onClick}>{children}</button></Tooltip>; }
function canvasPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number): AnnotationPoint { const rect = canvas.getBoundingClientRect(); return { x: (clientX - rect.left) / Math.max(1, rect.width) * canvas.width, y: (clientY - rect.top) / Math.max(1, rect.height) * canvas.height }; }
function redraw(canvas: HTMLCanvasElement | null, operations: AnnotationOperation[]) { const context = canvas?.getContext("2d"); if (!canvas || !context) return; context.clearRect(0, 0, canvas.width, canvas.height); operations.forEach((operation) => drawOperation(context, operation)); }
function drawOperation(context: CanvasRenderingContext2D, operation: AnnotationOperation) {
    context.save(); context.strokeStyle = operation.color; context.fillStyle = operation.color; context.lineWidth = operation.size; context.lineCap = "round"; context.lineJoin = "round";
    if (operation.type === "brush") { const first = operation.points[0]; if (first) { context.beginPath(); if (operation.points.length === 1) { context.arc(first.x, first.y, operation.size / 2, 0, Math.PI * 2); context.fill(); } else { context.moveTo(first.x, first.y); operation.points.slice(1).forEach((point) => context.lineTo(point.x, point.y)); context.stroke(); } } }
    if (operation.type === "rectangle") context.strokeRect(operation.x, operation.y, operation.width, operation.height);
    if (operation.type === "text") { context.font = `600 ${operation.size}px sans-serif`; context.textBaseline = "top"; context.fillText(operation.text, operation.x, operation.y); }
    context.restore();
}
