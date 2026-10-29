import { useLayoutEffect, useRef, useState } from "react";
import { Button, Input } from "antd";
import { ArrowRight, Check, Maximize2, Minus, Pencil, Plus, Trash2 } from "lucide-react";
import { isTextEditableTarget } from "@/lib/backspace-navigation-guard";
import { canvasThemes } from "@/lib/canvas-theme";
import { getNodeIcon } from "@/lib/canvas/node-registry";
import { workflowFitViewport, workflowEditorPositions, workflowOperationId } from "@/lib/canvas/workflow-editor";
import type { WorkflowDefinition, WorkflowNode, WorkflowOperation } from "@/services/api/canvas-workflows";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";

const WIDTH = 300;
const cardHeight = (operation?: WorkflowOperation) => operation ? 80 + operation.inputs.length * 42 : 112;

export function CanvasWorkflowEditorGraph({ definition, operations, selected, connecting, onSelect, onOutput, onInput, onConnect, onCancelConnection, onMove, onRemoveEdge, onRename, onDelete, readOnly, libraryOpen }: {
    libraryOpen?: boolean; definition: WorkflowDefinition; operations: WorkflowOperation[]; selected?: string; connecting?: string;
    onSelect(id: string): void; onOutput(id: string): void; onInput(id: string, port: string): void;
    onConnect(from: string, to: string, port: string): void; onCancelConnection(): void;
    onMove(id: string, position: { x: number; y: number }): void; onRemoveEdge(index: number): void;
    onRename(id: string, title: string): void; onDelete(id: string): void; readOnly?: boolean;
}) {
    const container = useRef<HTMLDivElement>(null);
    const theme = canvasThemes[useActiveTheme()];
    const [view, setView] = useState({ x: 16, y: 16, k: .8 });
    const [preview, setPreview] = useState<{ id: string; x: number; y: number }>();
    const [renaming, setRenaming] = useState<{ id: string; title: string }>();
    const [linkPoint, setLinkPoint] = useState<{ x: number; y: number }>();
    const linkGesture = useRef<{ source: string; x: number; y: number; moved: boolean } | undefined>(undefined);
    const gesture = useRef<{ id?: string; x: number; y: number; initialX: number; initialY: number } | undefined>(undefined);
    const navigated = useRef(false);
    const positions = workflowEditorPositions(definition);
    if (preview) positions[preview.id] = preview;
    const operationFor = (node?: WorkflowNode) => operations.find(item => item.id === (node && workflowOperationId(node)));
    const portCenter = () => 85;
    const fit = () => {
        const rect = container.current?.getBoundingClientRect();
        if (!rect || !definition.nodes.length) return;
        const left = Math.min(...Object.values(positions).map(p => p.x)), top = Math.min(...Object.values(positions).map(p => p.y)) - 48;
        const right = Math.max(...definition.nodes.map(n => positions[n.id].x + WIDTH));
        const bottom = Math.max(...definition.nodes.map(n => positions[n.id].y + cardHeight(operationFor(n))));
        setView(workflowFitViewport({ left, top, right, bottom }, rect.width, rect.height, Boolean(libraryOpen)));
    };
    const latestFit = useRef(fit);
    latestFit.current = fit;
    useLayoutEffect(() => {
        if (!container.current) return;
        const observer = new ResizeObserver(() => { if (!navigated.current) latestFit.current(); });
        observer.observe(container.current);
        return () => observer.disconnect();
    }, []);
    const previousIds = useRef(new Set(definition.nodes.map(node => node.id)));
    useLayoutEffect(() => {
        const added = definition.nodes.some(node => !previousIds.current.has(node.id));
        previousIds.current = new Set(definition.nodes.map(node => node.id));
        if (added) { latestFit.current(); return; }
        const rect = container.current?.getBoundingClientRect(), position = selected && positions[selected];
        const node = definition.nodes.find(n => n.id === selected);
        if (!rect || !position || !node) return;
        const x = view.x + position.x * view.k, y = view.y + position.y * view.k;
        if (x < 24 || y < 48 || x + WIDTH * view.k > rect.width - 24 || y + cardHeight(operationFor(node)) * view.k > rect.height - 48) {
            setView(v => ({ ...v, x: rect.width / 2 - (position.x + WIDTH / 2) * v.k, y: rect.height / 2 - (position.y + cardHeight(operationFor(node)) / 2) * v.k }));
        }
        // A newly added or searched node must be visible; panning stays under user control.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selected, definition.nodes]);
    useLayoutEffect(() => { latestFit.current(); }, [libraryOpen]);
    return <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden" data-canvas-no-zoom style={{ backgroundColor: theme.canvas.background }}>
        <div ref={container} className="absolute inset-0 touch-none outline-none" role="region" tabIndex={0} aria-label="工作流节点图"
            onKeyDown={event => {
                if (isTextEditableTarget(event.target) || event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
                if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); linkGesture.current = undefined; setLinkPoint(undefined); onCancelConnection(); return; }
                if (event.key === "Delete" || event.key === "Backspace") {
                    event.preventDefault(); event.stopPropagation();
                    if (selected && !readOnly) onDelete(selected);
                }
            }}
            style={{ backgroundImage: `radial-gradient(${theme.canvas.dot} 1px, transparent 1px)`, backgroundSize: `${32 * view.k}px ${32 * view.k}px`, backgroundPosition: `${view.x}px ${view.y}px` }}
            onWheel={event => { navigated.current = true; event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); const x = event.clientX - rect.left, y = event.clientY - rect.top; setView(old => { const k = Math.max(.25, Math.min(1.8, old.k * (event.deltaY < 0 ? 1.1 : .9))); return { x: x - (x - old.x) * k / old.k, y: y - (y - old.y) * k / old.k, k }; }); }}
            onPointerDown={event => { if (event.button !== 0 || (event.target as Element).closest("button,input,[data-workflow-editor-node]")) return; onCancelConnection(); setLinkPoint(undefined); navigated.current = true; event.currentTarget.setPointerCapture(event.pointerId); gesture.current = { x: event.clientX, y: event.clientY, initialX: view.x, initialY: view.y }; }}
            onPointerMove={event => {
                const link = linkGesture.current;
                if (link || connecting) {
                    const rect = event.currentTarget.getBoundingClientRect();
                    setLinkPoint({ x: (event.clientX - rect.left - view.x) / view.k, y: (event.clientY - rect.top - view.y) / view.k });
                    if (link && Math.hypot(event.clientX - link.x, event.clientY - link.y) > 4) link.moved = true;
                    if (link) return;
                }
                const g = gesture.current; if (!g) return; const dx = event.clientX - g.x, dy = event.clientY - g.y; if (g.id) setPreview({ id: g.id, x: g.initialX + dx / view.k, y: g.initialY + dy / view.k }); else setView(old => ({ ...old, x: g.initialX + dx, y: g.initialY + dy }));
            }}
            onPointerUp={event => {
                const link = linkGesture.current;
                if (link) {
                    linkGesture.current = undefined;
                    if (link.moved) {
                        const hit = document.elementFromPoint(event.clientX, event.clientY);
                        const target = hit?.closest<HTMLElement>("[data-workflow-editor-node]");
                        const port = hit?.closest<HTMLElement>("[data-workflow-input]");
                        if (target && container.current?.contains(target)) onConnect(link.source, target.dataset.workflowEditorNode!, port?.dataset.workflowPort || "");
                        else onCancelConnection();
                        setLinkPoint(undefined);
                    }
                } else if (gesture.current?.id) {
                    const g = gesture.current;
                    onMove(g.id!, { x: g.initialX + (event.clientX - g.x) / view.k, y: g.initialY + (event.clientY - g.y) / view.k });
                }
                gesture.current = undefined; setPreview(undefined);
            }}
            onPointerCancel={() => { linkGesture.current = undefined; setLinkPoint(undefined); onCancelConnection(); gesture.current = undefined; setPreview(undefined); }}>
            <div className="absolute inset-0 origin-top-left" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
                <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width="1" height="1" aria-label="工作流连线">
                    {connecting && positions[connecting] && linkPoint ? (() => {
                        const from = positions[connecting], node = definition.nodes.find(n => n.id === connecting);
                        const x = from.x + WIDTH, y = from.y + cardHeight(operationFor(node)) / 2;
                        return <path d={`M${x},${y} C${x + 64},${y} ${linkPoint.x - 64},${linkPoint.y} ${linkPoint.x},${linkPoint.y}`} fill="none" stroke={theme.node.activeStroke} strokeWidth="2" strokeDasharray="6 4" />;
                    })() : null}
                    {definition.edges.map((edge, index) => {
                        const from = positions[edge.fromNodeId], to = positions[edge.toNodeId];
                        const source = definition.nodes.find(n => n.id === edge.fromNodeId), target = definition.nodes.find(n => n.id === edge.toNodeId);
                        if (!from || !to) return null;
                        const port = Math.max(0, operationFor(target)?.inputs.findIndex(p => p.id === edge.toPort) ?? 0);
                        const sx = from.x + WIDTH + 6, sy = from.y + cardHeight(operationFor(source)) / 2;
                        const tx = to.x - 6, ty = to.y + portCenter() + port * 42;
                        const d = `M${sx},${sy} C${sx + 64},${sy} ${tx - 64},${ty} ${tx},${ty}`;
                        return <g key={`${edge.fromNodeId}:${edge.toNodeId}:${index}`}><path d={d} fill="none" stroke={theme.node.muted} strokeWidth="1.5" /><path d={d} fill="none" stroke="transparent" strokeWidth="18" className="pointer-events-auto cursor-pointer" role="button" tabIndex={0} aria-label={`删除连线：${source?.title}到${target?.title}`} onPointerDown={event => event.stopPropagation()} onClick={() => onRemoveEdge(index)} onKeyDown={event => { if (event.key === "Enter" || event.key === "Delete") onRemoveEdge(index); }} /></g>;
                    })}
                </svg>
                {definition.nodes.map(node => {
                    const position = positions[node.id], operation = operationFor(node), output = definition.outputNodeIds.includes(node.id);
                    return <div key={node.id} data-workflow-editor-node={node.id} className="absolute rounded-xl" style={{ left: position.x, top: position.y, width: WIDTH, height: cardHeight(operation), boxShadow: theme.node.shadow, outline: selected === node.id ? `2px solid ${theme.node.activeStroke}` : undefined }}
                        onClick={event => { if (connecting && !(event.target as Element).closest("button,input")) { event.stopPropagation(); onInput(node.id, ""); } }}
                        onPointerDown={event => { if (event.button !== 0 || (event.target as Element).closest("button,input")) return; event.stopPropagation(); if (connecting) return; navigated.current = true; onSelect(node.id); container.current?.focus({ preventScroll: true }); if (readOnly) return; container.current?.setPointerCapture(event.pointerId); gesture.current = { id: node.id, x: event.clientX, y: event.clientY, initialX: position.x, initialY: position.y }; }}>
                        <div className="flex h-16 flex-col justify-center gap-1 rounded-t-xl px-4" style={{ background: theme.node.fill, color: theme.node.label }}>
                        <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
                            {renaming?.id === node.id ? <Input autoFocus aria-label={`重命名工作流节点：${node.title}`} maxLength={100} value={renaming.title} onChange={event => setRenaming({ id: node.id, title: event.target.value })} onPressEnter={event => event.currentTarget.blur()} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setRenaming(undefined); } }} onBlur={() => { if (renaming.title.trim() && renaming.title.trim() !== node.title) onRename(node.id, renaming.title.trim()); setRenaming(undefined); }} /> : <>
                                <div role="button" tabIndex={0} className="flex min-w-0 flex-1 cursor-grab items-center gap-2 active:cursor-grabbing" onClick={() => { onSelect(node.id); container.current?.focus({ preventScroll: true }); }} onKeyDown={event => { if (event.key === "Enter") { onSelect(node.id); container.current?.focus({ preventScroll: true }); } }} title={node.title}><span className="shrink-0 [&_svg]:size-5">{getNodeIcon(node.mediaType)}</span><span className="truncate">{node.title}</span>{output ? <span className="flex shrink-0 items-center gap-1 text-xs font-normal text-muted-foreground"><Check className="size-3" />最终输出</span> : null}</div>
                                {!readOnly ? <button type="button" className="shrink-0 rounded p-1 text-muted-foreground hover:bg-[var(--surface-hover)] hover:text-foreground" aria-label={`重命名${node.title}`} title="重命名" onClick={() => { onSelect(node.id); setRenaming({ id: node.id, title: node.title }); }}><Pencil className="size-3.5" /></button> : null}
                                {!readOnly ? <button type="button" className="shrink-0 rounded p-1 text-muted-foreground hover:bg-[var(--surface-hover)] hover:text-destructive focus-visible:outline focus-visible:outline-1" aria-label={`删除工作流节点：${node.title}`} title="删除节点（Delete / Backspace）" onClick={() => onDelete(node.id)}><Trash2 className="size-3.5" /></button> : null}
                            </>}
                        </div>
                            {node.role === "input" || node.role === "constant" ? <span className="text-xs text-muted-foreground">{node.role === "input" ? "每次可替换" : "固定内容"}</span> : null}
                        </div>
                            <div className="relative flex flex-col overflow-hidden rounded-b-xl" style={{ height: cardHeight(operation) - 64, background: theme.node.fill }}>
                                {operation ? <>
                                    <div className="flex shrink-0 flex-col px-4">{operation.inputs.map(port => {
                                        const edges = definition.edges.filter(e => e.toNodeId === node.id && e.toPort === port.id).sort((a, b) => (a.order || 0) - (b.order || 0));
                                        const names = edges.map(e => definition.nodes.find(n => n.id === e.fromNodeId)?.title).filter(Boolean).join("、");
                                        return <button key={port.id} type="button" data-workflow-input={node.id} data-workflow-port={port.id} className="flex h-[42px] min-w-0 items-center gap-2 text-left disabled:opacity-40" disabled={readOnly} onClick={() => connecting ? onInput(node.id, port.id) : onSelect(node.id)} aria-label={`连接参考${node.title}：${port.label}`}><span className="shrink-0 text-sm">{port.label}</span><span className="truncate text-xs text-muted-foreground" title={names}>{names || (port.required ? "待连接" : "可选")}</span></button>;
                                    })}</div>
                                </> : node.mediaType === "text" ? <p className="overflow-hidden whitespace-pre-wrap break-words px-4 text-sm text-muted-foreground">{node.text || ""}</p> : null}
                            </div>
                        {operation?.inputs.map((port, index) => <button key={port.id} type="button" data-workflow-input={node.id} data-workflow-port={port.id} disabled={readOnly} className="absolute -left-3 grid size-6 place-items-center rounded-full" style={{ top: portCenter() - 12 + index * 42, background: theme.node.fill, color: connecting ? theme.node.activeStroke : theme.node.muted }} aria-label={`连接到${node.title}：${port.label}`} title={port.label} onClick={() => onInput(node.id, port.id)}><span className="size-2.5 rounded-full border-2 border-current" /></button>)}
                        <button type="button" disabled={readOnly} className="absolute -right-3 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-full" style={{ background: theme.node.fill, color: connecting === node.id ? theme.node.activeStroke : theme.node.muted }} aria-label={`从${node.title}连接`} title="拖动到输入端口连接，也可点击后选择输入" onPointerDown={event => {
                            if (readOnly || event.button !== 0) return;
                            event.preventDefault(); event.stopPropagation();
                            onCancelConnection(); onOutput(node.id);
                            container.current?.focus({ preventScroll: true });
                            container.current?.setPointerCapture(event.pointerId);
                            linkGesture.current = { source: node.id, x: event.clientX, y: event.clientY, moved: false };
                            setLinkPoint({ x: position.x + WIDTH + 48, y: position.y + cardHeight(operation) / 2 });
                        }} onClick={event => { if (event.detail === 0) onOutput(node.id); }}><ArrowRight className="size-3.5" /></button>
                    </div>;
                })}
            </div>
        </div>
        {!definition.nodes.length ? <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">点击“添加”，选择素材或处理步骤</p> : null}
        <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-xl bg-[var(--surface-card)] p-1.5 shadow-lg">
            <Button type="text" size="small" aria-label="缩小工作流设定图" icon={<Minus className="size-4" />} onClick={() => { navigated.current = true; setView(v => ({ ...v, k: Math.max(.25, v.k / 1.2) })); }} />
            <span className="min-w-10 text-center text-xs">{Math.round(view.k * 100)}%</span>
            <Button type="text" size="small" aria-label="放大工作流设定图" icon={<Plus className="size-4" />} onClick={() => { navigated.current = true; setView(v => ({ ...v, k: Math.min(1.8, v.k * 1.2) })); }} />
            <Button type="text" size="small" aria-label="适合工作流设定图" icon={<Maximize2 className="size-4" />} onClick={fit} />
        </div>
    </div>;
}
