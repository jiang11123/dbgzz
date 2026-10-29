import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Brush, Eraser, LoaderCircle, RotateCcw, Settings2, WandSparkles, X } from "lucide-react";

import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { ModelPicker } from "@/components/model-picker";
import { Tooltip } from "@/components/ui/base/tooltip";
import { canvasThemes } from "@/lib/canvas-theme";
import { defaultImageParamsForModel } from "@/lib/model-selection";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import type { AiConfig } from "@/stores/use-config-store";

export type CanvasImageMaskEditPayload = {
    prompt: string;
    maskDataUrl: string;
    generationConfig?: Partial<Pick<AiConfig, "model" | "imageModel" | "size" | "quality" | "count" | "transparentBackground">>;
};

type DrawMode = "paint" | "erase";
const defaultBrushSize = 100;
const maskFillColor = "rgba(37, 99, 235, .38)";
const maskBorderColor = "rgba(255, 255, 255, .72)";

export function CanvasImageMaskEditor({ imageDimensions, scale, config, onCancel, onConfirm }: {
    imageDimensions: { width: number; height: number };
    scale: number;
    config: AiConfig;
    onCancel: () => void;
    onConfirm: (payload: CanvasImageMaskEditPayload) => void | Promise<void>;
}) {
    const maskCanvasRef = useRef<HTMLCanvasElement>(null);
    const previewCanvasRef = useRef<HTMLCanvasElement>(null);
    const drawingRef = useRef<{ active: boolean; last: { x: number; y: number } | null }>({ active: false, last: null });
    const [prompt, setPrompt] = useState("");
    const [brushSize, setBrushSize] = useState(defaultBrushSize);
    const [mode, setMode] = useState<DrawMode>("paint");
    const [error, setError] = useState("");
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [generationConfig, setGenerationConfig] = useState<AiConfig>(() => config);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const theme = canvasThemes[useActiveTheme()];

    useEffect(() => {
        setPrompt(""); setBrushSize(defaultBrushSize); setMode("paint"); setError(""); setSettingsOpen(false);
        clearCanvas(maskCanvasRef.current); clearCanvas(previewCanvasRef.current);
    }, [imageDimensions.height, imageDimensions.width]);
    useEffect(() => {
        const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") settingsOpen ? setSettingsOpen(false) : onCancel(); };
        window.addEventListener("keydown", keydown);
        return () => window.removeEventListener("keydown", keydown);
    }, [onCancel, settingsOpen]);

    const draw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        const point = readCanvasPoint(event.currentTarget, event.clientX, event.clientY);
        const context = maskCanvasRef.current?.getContext("2d");
        if (!context) return;
        context.lineCap = "round"; context.lineJoin = "round"; context.lineWidth = brushSize;
        context.globalCompositeOperation = mode === "paint" ? "source-over" : "destination-out";
        context.strokeStyle = "#000"; context.fillStyle = "#000";
        drawMaskStroke(context, drawingRef.current.last || point, point, brushSize);
        if (maskCanvasRef.current) renderMaskPreview(maskCanvasRef.current, previewCanvasRef.current);
        drawingRef.current.last = point;
        if (mode === "paint") setError("");
    };
    const startDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
        drawingRef.current = { active: true, last: null }; draw(event);
    };
    const moveDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => { if (drawingRef.current.active) { event.preventDefault(); draw(event); } };
    const stopDraw = () => {
        drawingRef.current = { active: false, last: null };
        if (maskCanvasRef.current) renderMaskPreview(maskCanvasRef.current, previewCanvasRef.current, canvasHasPaint(maskCanvasRef.current));
    };
    const resetMask = () => { clearCanvas(maskCanvasRef.current); clearCanvas(previewCanvasRef.current); setError(""); };
    const submit = async () => {
        const nextPrompt = prompt.trim(); const canvas = maskCanvasRef.current;
        if (!nextPrompt) return setError("请输入修改要求");
        if (!canvas || !canvasHasPaint(canvas)) return setError("请先涂抹局部区域");
        if (isSubmitting) return;
        setIsSubmitting(true);
        try {
            await onConfirm({ prompt: nextPrompt, maskDataUrl: buildEditMask(canvas), generationConfig: { model: generationConfig.model, imageModel: generationConfig.imageModel, size: generationConfig.size, quality: generationConfig.quality, count: generationConfig.count, transparentBackground: generationConfig.transparentBackground } });
        } finally { setIsSubmitting(false); }
    };
    const inverseScale = 1 / Math.max(scale, 0.01);
    const screenTransform = `translateX(-50%) scale(var(--canvas-live-inverse-scale, ${inverseScale}))`;

    return <div data-image-mask-edit-inline="true" className="absolute inset-0 z-[calc(var(--node-z-overlay)+3)] overflow-visible rounded-[inherit]" onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
        <canvas ref={maskCanvasRef} width={imageDimensions.width} height={imageDimensions.height} className="hidden" />
        <canvas ref={previewCanvasRef} width={imageDimensions.width} height={imageDimensions.height} aria-label="局部重绘蒙版" className="absolute inset-0 h-full w-full cursor-crosshair touch-none rounded-[inherit]" onPointerDown={startDraw} onPointerMove={moveDraw} onPointerUp={stopDraw} onPointerCancel={stopDraw} />

        <div data-canvas-no-zoom="true" className="absolute bottom-[calc(100%+14px)] left-1/2 flex h-14 items-center gap-1 rounded-2xl border border-white/10 bg-[#242424]/96 p-1.5 text-white shadow-2xl backdrop-blur-xl" style={{ transform: screenTransform, transformOrigin: "center bottom" }}>
            <ToolButton title="关闭局部重绘" onClick={onCancel}><X /></ToolButton><Divider />
            <ToolButton title="画笔" active={mode === "paint"} onClick={() => setMode("paint")}><Brush /></ToolButton>
            <ToolButton title="擦除" active={mode === "erase"} onClick={() => setMode("erase")}><Eraser /></ToolButton>
            <input aria-label="笔刷大小" type="range" min={8} max={160} step={2} value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} className="mx-2 w-24 accent-white" />
            <span className="w-11 text-center text-xs tabular-nums text-white/65">{brushSize}px</span><Divider />
            <ToolButton title="重置蒙版" onClick={resetMask}><RotateCcw /></ToolButton>
        </div>

        <div data-canvas-no-zoom="true" className="absolute left-1/2 top-[calc(100%+14px)] flex w-[min(520px,90vw)] items-center gap-1.5 rounded-2xl border border-white/10 bg-[#242424]/96 p-1.5 text-white shadow-2xl backdrop-blur-xl" style={{ transform: screenTransform, transformOrigin: "center top" }}>
            <div className="relative min-w-0 flex-1">
                <input aria-label="局部重绘要求" type="text" value={prompt} placeholder="描述选中区域需要如何修改…" onChange={(event) => { setPrompt(event.target.value); setError(""); }} onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Enter") void submit(); }} className="block h-9 w-full rounded-xl border border-white/10 bg-white/[0.06] px-3 text-sm text-white outline-none placeholder:text-white/35 focus:border-white/25" />
                {error ? <div className="absolute left-1 top-[calc(100%+8px)] whitespace-nowrap rounded-lg bg-[#242424]/96 px-2 py-1 text-xs font-medium text-red-400 shadow-lg">{error}</div> : null}
            </div>
            <div className="relative">
                <button type="button" aria-label="局部重绘设置" title="局部重绘设置" onClick={() => setSettingsOpen((value) => !value)} className={`grid size-9 place-items-center rounded-xl transition ${settingsOpen ? "bg-white/16 text-white" : "text-white/72 hover:bg-white/10 hover:text-white"}`}><Settings2 className="size-4" /></button>
                {settingsOpen ? <div className="absolute bottom-11 right-0 w-80 space-y-3 rounded-2xl border border-white/10 bg-[#242424] p-3 text-white shadow-2xl" onPointerDown={(event) => event.stopPropagation()}>
                    <ModelPicker config={generationConfig} value={generationConfig.imageModel || generationConfig.model} capability="image" fullWidth onChange={(model) => setGenerationConfig((current) => ({ ...current, model, imageModel: model, ...defaultImageParamsForModel(current, model) }))} />
                    <ImageSettingsPanel config={generationConfig} showTitle={false} showCount={false} className="space-y-3" theme={theme} onConfigChange={(key, value) => setGenerationConfig((current) => ({ ...current, [key]: value }))} />
                </div> : null}
            </div>
            <button type="button" aria-label={isSubmitting ? "正在修改" : "AI 修改"} title={isSubmitting ? "正在修改" : "AI 修改"} disabled={isSubmitting} onClick={() => void submit()} className="grid size-9 place-items-center rounded-xl bg-white text-neutral-900 transition hover:bg-white/90 disabled:cursor-wait disabled:opacity-60">{isSubmitting ? <LoaderCircle className="size-4 animate-spin text-neutral-900" /> : <WandSparkles className="size-4 text-neutral-900" />}</button>
        </div>
    </div>;
}

function Divider() { return <span className="mx-1 h-7 w-px bg-white/12" />; }
function ToolButton({ title, active, children, onClick }: { title: string; active?: boolean; children: ReactNode; onClick: () => void }) { return <Tooltip title={title}><button type="button" aria-label={title} className={`grid size-10 place-items-center rounded-xl transition ${active ? "bg-white/16 text-white" : "text-white/72 hover:bg-white/10 hover:text-white"}`} onClick={onClick}>{children}</button></Tooltip>; }
function readCanvasPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number) { const rect = canvas.getBoundingClientRect(); return { x: (clientX - rect.left) / Math.max(1, rect.width) * canvas.width, y: (clientY - rect.top) / Math.max(1, rect.height) * canvas.height }; }
function clearCanvas(canvas: HTMLCanvasElement | null) { const context = canvas?.getContext("2d"); if (canvas && context) context.clearRect(0, 0, canvas.width, canvas.height); }
function drawMaskStroke(context: CanvasRenderingContext2D, from: { x: number; y: number }, to: { x: number; y: number }, size: number) { context.beginPath(); if (from.x === to.x && from.y === to.y) { context.arc(to.x, to.y, size / 2, 0, Math.PI * 2); context.fill(); } else { context.moveTo(from.x, from.y); context.lineTo(to.x, to.y); context.stroke(); } }
function canvasHasPaint(canvas: HTMLCanvasElement) { const data = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data; if (!data) return false; for (let index = 3; index < data.length; index += 4) if (data[index] > 0) return true; return false; }
function renderMaskPreview(maskCanvas: HTMLCanvasElement, previewCanvas: HTMLCanvasElement | null, withBorder = false) { const context = previewCanvas?.getContext("2d"); if (!previewCanvas || !context) return; context.clearRect(0, 0, previewCanvas.width, previewCanvas.height); context.fillStyle = maskFillColor; context.fillRect(0, 0, previewCanvas.width, previewCanvas.height); context.globalCompositeOperation = "destination-in"; context.drawImage(maskCanvas, 0, 0); context.globalCompositeOperation = "source-over"; if (withBorder) drawDashedMaskBorder(context, maskCanvas); }
function drawDashedMaskBorder(context: CanvasRenderingContext2D, maskCanvas: HTMLCanvasElement) { const maskContext = maskCanvas.getContext("2d"); if (!maskContext) return; const { width, height } = maskCanvas; const data = maskContext.getImageData(0, 0, width, height).data; const step = Math.max(1, Math.round(Math.max(width, height) / 1200)); const dash = step * 8; const period = dash + step * 5; context.save(); context.fillStyle = maskBorderColor; for (let y = step; y < height - step; y += step) for (let x = step; x < width - step; x += step) { const offset = (y * width + x) * 4 + 3; if (data[offset] === 0 || !isMaskEdge(data, width, x, y, step) || (x + y) % period > dash) continue; context.fillRect(x - step / 2, y - step / 2, Math.max(1.5, step), Math.max(1.5, step)); } context.restore(); }
function isMaskEdge(data: Uint8ClampedArray, width: number, x: number, y: number, step: number) { return data[((y - step) * width + x) * 4 + 3] === 0 || data[((y + step) * width + x) * 4 + 3] === 0 || data[(y * width + x - step) * 4 + 3] === 0 || data[(y * width + x + step) * 4 + 3] === 0; }
function buildEditMask(selectionCanvas: HTMLCanvasElement) { const canvas = document.createElement("canvas"); canvas.width = selectionCanvas.width; canvas.height = selectionCanvas.height; const context = canvas.getContext("2d"); if (!context) return selectionCanvas.toDataURL("image/png"); context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height); const selection = selectionCanvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height); if (!selection) return canvas.toDataURL("image/png"); const mask = context.getImageData(0, 0, canvas.width, canvas.height); for (let index = 3; index < mask.data.length; index += 4) if (selection.data[index] > 0) mask.data[index] = 0; context.putImageData(mask, 0, 0); return canvas.toDataURL("image/png"); }
