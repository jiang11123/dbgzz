import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type SyntheticEvent } from "react";
import { Button, Input, Select } from "antd";
import { Check, ImagePlus, LoaderCircle, Play, Plus, RefreshCw, Square, Upload, X } from "lucide-react";
import { CachedResourceImage } from "@/components/cached-resource-image";
import { useResourceVideoPlayback } from "@/hooks/use-resource-video-playback";
import { canvasNodeResourceId } from "@/lib/canvas/canvas-resource-id";
import { isWorkflowOperation } from "@/lib/canvas/workflow-editor";
import { canExportWorkflowResult, workflowInstanceLocked, type WorkflowInstanceAction } from "@/lib/canvas/reusable-workflow-instance";
import { captureUserScope, assertUserScope } from "@/lib/user-scope-guard";
import { resourceIdFromStorageKey } from "@/services/api/resources";
import { uploadMediaFile } from "@/services/file-storage";
import { cacheResourceObjectUrl } from "@/services/resource-blob-cache";
import type { WorkflowValue } from "@/services/api/canvas-workflows";
import type { CanvasNodeData } from "@/types/canvas";
import { WorkflowSlotHeader, WorkflowSlotSurface } from "./workflow-slot-surface";

const labels: Record<string, string> = { pending: "等待上游", queued: "已排队", running: "进行中", waiting_selection: "请选择一张图片继续", succeeded: "已完成", failed: "失败", cancelled: "已停止" };
const mediaLabels = { image: "图片", video: "视频", audio: "音频", text: "文本" };

function WorkflowVideo({ storageKey }: { storageKey: string }) {
    const playback = useResourceVideoPlayback(storageKey, "");
    return playback.error ? <button className="p-3 text-sm" onClick={() => playback.retry()}>视频预览加载失败，点击重试</button>
        : playback.url ? <video className="h-full w-full object-contain" src={playback.url} controls preload="metadata" onError={() => { if (!playback.requestCompatible()) playback.fail(); }} />
            : <LoaderCircle aria-label="加载视频" className="size-5 animate-spin" />;
}

function WorkflowAudio({ storageKey }: { storageKey: string }) {
    const [url, setUrl] = useState("");
    const [error, setError] = useState(false);
    useEffect(() => { let active = true; setUrl(""); setError(false); void cacheResourceObjectUrl(storageKey).then(value => { if (active) setUrl(value || ""); }).catch(() => { if (active) setError(true); }); return () => { active = false; }; }, [storageKey]);
    return error ? <span className="text-sm">音频预览加载失败</span> : url ? <audio className="w-full" src={url} controls preload="metadata" /> : <LoaderCircle className="size-5 animate-spin" aria-label="加载音频" />;
}

export function ReusableWorkflowNode({ node, nodes, readOnly, dropTarget, onAction, onValue, onUploadBusy, onError, onResultDrag, onUpdate }: {
    node: CanvasNodeData; nodes: CanvasNodeData[]; readOnly: boolean; dropTarget?: boolean;
    onAction(id: string, action: WorkflowInstanceAction): Promise<void>;
    onValue(id: string, value: WorkflowValue): Promise<void>;
    onUploadBusy(id: string, busy: boolean): void;
    onError(message: string): void;
    onResultDrag?: (event: ReactPointerEvent, nodeId: string) => void;
    onUpdate?: (nodeId: string) => Promise<void>;
}) {
    const state = node.metadata?.reusableWorkflow;
    const slot = node.metadata?.workflowSlot;
    const control = state ? node : nodes.find(item => item.id === slot?.instanceId);
    const locked = workflowInstanceLocked(control) || readOnly;
    const [busy, setBusy] = useState(false);
    const [dragOver, setDragOver] = useState(false);
    const [pickerOpen, setPickerOpen] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const active = useRef(true);
    useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
    const setValue = async (value: WorkflowValue) => {
        setBusy(true);
        try { await onValue(node.id, value); setPickerOpen(false); }
        catch (cause) { if (active.current) onError(cause instanceof Error ? cause.message : "替换失败"); }
        finally { if (active.current) setBusy(false); }
    };
    const upload = async (file?: File) => {
        if (!file || !slot || locked || busy || slot.role !== "input" || slot.mediaType === "text") return;
        if (!file.type.startsWith(`${slot.mediaType}/`)) { onError(`「${node.title}」需要${mediaLabels[slot.mediaType]}文件`); return; }
        const scope = captureUserScope();
        setBusy(true);
        onUploadBusy(node.id, true);
        try {
            const result = await uploadMediaFile(file, slot.mediaType, undefined, scope);
            assertUserScope(scope);
            if (!active.current) return;
            const resourceId = resourceIdFromStorageKey(result.storageKey);
            if (!resourceId || result.pendingRemoteUpload) throw new Error("素材尚未保存完成，请稍后重试");
            await onValue(node.id, { resourceId });
        } catch (cause) { if (active.current) onError(cause instanceof Error ? cause.message : "上传失败"); }
        finally { onUploadBusy(node.id, false); if (active.current) setBusy(false); }
    };
    const stop = (event: SyntheticEvent) => event.stopPropagation();
    if (state) {
        const run = state.run;
        const running = run?.status === "queued" || run?.status === "running";
        const waitingSelection = run?.status === "running" && run.steps.some(step => step.status === "waiting_selection");
        const recoverOriginal = run?.status === "failed" && !state.inputsChanged && run.steps.some(step => step.status === "failed" && state.definition.nodes.find(item => item.id === step.nodeId)?.operationId?.endsWith(".ai-upscale"));
        const ready = state.definition.nodes.filter(item => item.role === "input").filter(item => nodes.some(candidate => candidate.metadata?.workflowSlot?.instanceId === node.id && candidate.metadata.workflowSlot.nodeId === item.id && (item.mediaType === "text" || canvasNodeResourceId(candidate)))).length;
        const total = state.definition.nodes.filter(item => item.role === "input").length;
        const operations = state.definition.nodes.filter(isWorkflowOperation);
        const completed = operations.filter(item => run?.steps.some(step => step.nodeId === item.id && step.status === "succeeded")).length;
        return <div className="flex h-full w-full flex-col justify-between gap-3 rounded-[inherit] bg-[var(--surface-card)] p-5 text-foreground" data-canvas-no-drag data-canvas-no-zoom onMouseDown={stop} onPointerDown={stop} onDoubleClick={stop}>
            <div className="flex flex-wrap items-center gap-3 text-2xl"><span className="font-medium">{state.inputsChanged && run ? "输入已更新" : waitingSelection ? "等待选择图片" : run ? labels[run.status] : ready === total ? "素材已就绪" : "准备素材"}</span><span className="text-xl tabular-nums text-muted-foreground">{ready}/{total}</span></div>
            {waitingSelection ? <p className="text-sm text-muted-foreground">在“选择图片结果”节点中选择一张，随后继续处理。</p> : null}
            {state.error || run?.error ? <p role="alert" className="max-h-14 overflow-auto text-lg text-destructive" data-canvas-wheel-scroll>{state.error || run?.error}</p> : null}
            <div className="flex items-center gap-3"><div role="progressbar" aria-label="工作流执行进度" aria-valuemin={0} aria-valuemax={operations.length} aria-valuenow={completed} className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--surface-active)]"><div className="h-full rounded-full bg-[var(--workspace-accent)]" style={{ width: `${operations.length ? completed / operations.length * 100 : 0}%` }} /></div><span className="shrink-0 text-lg tabular-nums text-muted-foreground">步骤 {completed}/{operations.length}</span></div>
            <div className="flex flex-wrap items-center justify-end gap-2" data-workflow-actions>
                {onUpdate ? <Button type="text" className="mr-auto" disabled={readOnly || busy || running || Boolean(state.intent)} onClick={() => void onUpdate(node.id)}>版本 {state.templateRevision || 1} · 更新实例</Button> : null}
                <Button size="large" style={{ fontSize: 20 }} type="primary" icon={running ? <LoaderCircle className="size-4 animate-spin" /> : <Play className="size-4" />} disabled={readOnly || busy || running || ready < total && !state.intent} loading={busy} onClick={() => { setBusy(true); void onAction(node.id, recoverOriginal ? "retry" : "start").finally(() => { if (active.current) setBusy(false); }); }}>{state.intent ? "确认上次提交" : running ? "运行中" : recoverOriginal ? "继续原任务" : run ? "重新运行" : "运行工作流"}</Button>
                {running ? <Button icon={<Square className="size-3" />} disabled={readOnly || busy} onClick={() => void onAction(node.id, "cancel")}>停止</Button> : run?.status === "failed" && !state.inputsChanged && !recoverOriginal ? <Button icon={<RefreshCw className="size-4" />} disabled={readOnly || busy || Boolean(state.intent)} onClick={() => void onAction(node.id, "retry")}>重试失败步骤</Button> : null}
            </div>
        </div>;
    }
    if (!slot) return null;
    const isInput = slot.role === "input";
    const exportable = !readOnly && canExportWorkflowResult(node, nodes);
    const startResultDrag = (event: ReactPointerEvent) => {
        event.stopPropagation();
        if (!exportable || event.button !== 0 || !onResultDrag) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        onResultDrag(event, node.id);
    };
    const resourceId = canvasNodeResourceId(node);
    const step = control?.metadata?.reusableWorkflow?.run?.steps.find(item => item.nodeId === slot.nodeId);
    const choices = step?.candidates?.filter(item => item.resourceId) || [];
    const selecting = step?.status === "waiting_selection" && control?.metadata?.reusableWorkflow?.run?.status === "running";
    const hasValue = slot.mediaType === "text" ? Boolean(node.metadata?.content) : Boolean(resourceId);
    const status = slot.role === "constant" ? "固定素材" : isInput ? hasValue ? "已添加" : "待添加" : labels[slot.status || "pending"] || "待运行";
    const candidates = nodes.filter(item => item.id !== node.id && item.type === slot.mediaType && item.metadata?.workflowSlot?.instanceId !== slot.instanceId && canvasNodeResourceId(item));
    const recipeNode = control?.metadata?.reusableWorkflow?.definition.nodes.find(item => item.id === slot.nodeId);
    const modelSummary = recipeNode?.config?.modelOption ? [String(recipeNode.config.modelOption).split("::").at(-1), recipeNode.config.vquality, recipeNode.config.size].filter(Boolean).join(" · ") : "";
    return <WorkflowSlotSurface data-workflow-slot={slot.nodeId} data-workflow-drop-active={dropTarget || dragOver ? "true" : undefined} data-canvas-no-zoom
        style={{ outline: dropTarget || dragOver ? "2px solid var(--primary)" : undefined }}
        onDragOver={event => { if (!isInput || locked) return; event.preventDefault(); event.stopPropagation(); setDragOver(true); }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false); }}
        onDrop={event => { if (!isInput || locked) return; event.preventDefault(); event.stopPropagation(); setDragOver(false); void upload(event.dataTransfer.files[0]); }}>
        {modelSummary ? <div className="shrink-0 break-words text-sm text-muted-foreground" title={modelSummary}>{modelSummary}</div> : null}
        <WorkflowSlotHeader status={<span className={slot.status === "failed" ? "text-destructive" : undefined}>{status}</span>} />
        <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-md bg-[var(--bg-secondary)]" data-canvas-no-drag onMouseDown={stop} onPointerDown={exportable && slot.mediaType === "image" ? startResultDrag : stop} onDoubleClick={stop}>
            {slot.mediaType === "image" && choices.length > 1 && (selecting || !resourceId) ? <div className="grid h-full w-full grid-cols-2 gap-2 overflow-auto p-2" data-canvas-wheel-scroll>{choices.map((value, index) => <button key={value.resourceId} type="button" aria-label={`选择图片 ${index + 1}`} disabled={readOnly || busy || !selecting} className="relative min-h-20 overflow-hidden rounded bg-[var(--surface-card)] hover:outline hover:outline-2 hover:outline-[var(--primary)]" onPointerDown={stop} onClick={() => void setValue(value)}><CachedResourceImage storageKey={`resource:${value.resourceId}`} alt={`候选图片 ${index + 1}`} className="h-full w-full object-contain" draggable={false} /><span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-xs text-white">{index + 1}</span></button>)}</div> : slot.mediaType === "text" ? isInput ? <Input.TextArea aria-label={node.title} value={node.metadata?.content || ""} disabled={locked} className="h-full! resize-none!" placeholder={`填写${node.title}`} onChange={event => { void onValue(node.id, { text: event.target.value }).catch(cause => onError(cause instanceof Error ? cause.message : "保存文本失败")); }} /> : <p className="h-full w-full overflow-auto whitespace-pre-wrap break-words p-2 text-sm" data-canvas-wheel-scroll>{node.metadata?.content || "等待生成文本"}</p>
                : resourceId ? slot.mediaType === "image" ? <CachedResourceImage storageKey={`resource:${resourceId}`} alt={node.title} className="h-full w-full object-contain" draggable={false} fallback={<span className="p-3 text-sm">预览加载失败，请重新选择素材</span>} loadingFallback={<LoaderCircle className="size-5 animate-spin" />} />
                    : slot.mediaType === "video" ? <WorkflowVideo storageKey={`resource:${resourceId}`} /> : <WorkflowAudio storageKey={`resource:${resourceId}`} />
                    : isInput ? <button type="button" aria-label={`上传${node.title}`} disabled={locked || busy} className="flex h-full w-full flex-col items-center justify-center gap-2 border border-dashed border-border p-3 hover:bg-[var(--surface-hover)] disabled:opacity-50" onClick={() => inputRef.current?.click()}>{busy ? <LoaderCircle className="size-7 animate-spin" /> : <Plus className="size-8" />}<span className="text-xs text-muted-foreground">上传{mediaLabels[slot.mediaType]}或拖入画布素材</span></button>
                        : <div className="flex flex-col items-center gap-2 p-3 text-center text-muted-foreground">{slot.status === "running" ? <LoaderCircle className="size-7 animate-spin" /> : slot.status === "succeeded" ? <Check className="size-7" /> : <ImagePlus className="size-7" />}<span className="text-sm">{slot.status === "failed" ? "处理失败" : `${node.title}将在这里显示`}</span></div>}
        </div>
        {exportable && onResultDrag ? <button type="button" className="shrink-0 cursor-grab px-1 py-1 text-left text-sm text-muted-foreground active:cursor-grabbing" aria-label={`拖出${node.title}到画布`} onMouseDown={stop} onPointerDown={startResultDrag}>拖出到画布</button> : null}
        {slot.error ? <p role="alert" className="line-clamp-2 break-words text-xs text-destructive" title={slot.error}>{slot.error}</p> : null}
        {isInput && slot.mediaType !== "text" ? <div className="flex items-center gap-1" data-canvas-no-drag onMouseDown={stop} onPointerDown={stop}>
            <Button type="text" size="small" icon={<Upload className="size-3.5" />} disabled={locked || busy} loading={busy} onClick={() => inputRef.current?.click()}>{hasValue ? "替换" : "上传"}</Button>
            <Button type="text" size="small" disabled={locked || busy} onClick={() => setPickerOpen(value => !value)}>画布素材</Button>
            {hasValue ? <Button type="text" size="small" className="ml-auto" aria-label={`清空${node.title}`} icon={<X className="size-3.5" />} disabled={locked || busy} onClick={() => void setValue({})} /> : null}
            <input ref={inputRef} className="hidden" type="file" accept={`${slot.mediaType}/*`} aria-label={`选择文件：${node.title}`} disabled={locked || busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; void upload(file); }} />
        </div> : null}
        {pickerOpen && isInput ? <Select autoFocus open className="w-full" aria-label={`选择画布素材：${node.title}`} placeholder="选择当前画布素材" disabled={locked || busy} options={candidates.map(item => ({ value: item.id, label: item.title }))} onOpenChange={setPickerOpen} onChange={id => { const source = candidates.find(item => item.id === id); if (source) void setValue({ resourceId: canvasNodeResourceId(source) }); }} /> : null}
    </WorkflowSlotSurface>;
}
