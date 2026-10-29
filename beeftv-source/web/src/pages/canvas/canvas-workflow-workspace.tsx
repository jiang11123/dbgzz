import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Alert, Button, Dropdown, Popconfirm, Spin, Tooltip } from "antd";
import { MoreHorizontal, Plus, RefreshCw, Scan, Settings2, Trash2, Workflow, X } from "lucide-react";
import { AppDrawer } from "@/components/ui/product/app-drawer";
import { captureUserScope, assertUserScope } from "@/lib/user-scope-guard";
import { compileCanvasWorkflow } from "@/lib/canvas/reusable-workflow";
import { deleteCanvasWorkflow, getWorkflowEditor, listWorkflowOperations, listCanvasWorkflows, saveCanvasWorkflow, type CanvasWorkflow, type WorkflowDefinition, type WorkflowOperation } from "@/services/api/canvas-workflows";
import { abstractWorkflowDefinition } from "@/lib/canvas/workflow-editor";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";
import { CanvasWorkflowSave } from "./canvas-workflow-save";
import { CanvasWorkflowEditor } from "./canvas-workflow-editor";
import "./canvas-assistant-sidebar.css";

export type CanvasWorkflowsHandle = { openLibrary(): void; toggleLibrary(): void; closeLibrary(): void; saveSelection(): void };

export const CanvasWorkflowWorkspace = forwardRef<CanvasWorkflowsHandle, {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    selection: Set<string>;
    readOnly: boolean;
    dockable: boolean;
    visible: boolean;
    onOpenChange(open: boolean): void;
    onInstantiate(workflow: CanvasWorkflow): Promise<void>;
}>(function CanvasWorkflowWorkspace({ nodes, connections, selection, readOnly, dockable, visible, onOpenChange, onInstantiate }, ref) {
    const [scope] = useState(captureUserScope);
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState<{ definition: WorkflowDefinition; externalCount: number } | null>(null);
    const [workflows, setWorkflows] = useState<CanvasWorkflow[]>([]);
    const [adding, setAdding] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [editing, setEditing] = useState<{ workflow: CanvasWorkflow; operations: WorkflowOperation[] }>();
    const [openingEditor, setOpeningEditor] = useState<string>();
    const [deleting, setDeleting] = useState<string>();
    const setLibraryOpen = (next: boolean) => { setOpen(next); if (!next) setDeleting(undefined); onOpenChange(next); };
    const alive = useRef(true);
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    const load = async () => {
        setLoading(true);
        setError("");
        try {
            const result = await listCanvasWorkflows({ expectedScope: scope });
            assertUserScope(scope);
            if (alive.current) setWorkflows(result.workflows);
        } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : "读取工作流失败"); }
        finally { if (alive.current) setLoading(false); }
    };
    const saveSelection = () => {
        if (readOnly) return;
        try { setDraft(compileCanvasWorkflow(nodes, connections, selection)); }
        catch (cause) { setError(cause instanceof Error ? cause.message : "无法转换选中节点"); setLibraryOpen(true); }
    };
    useImperativeHandle(ref, () => ({ openLibrary: () => { setLibraryOpen(true); void load(); }, toggleLibrary: () => { setLibraryOpen(!open); if (!open) void load(); }, closeLibrary: () => setLibraryOpen(false), saveSelection }));
    const save = async (input: { name: string; description: string; definition: WorkflowDefinition }) => {
        const workflow = await saveCanvasWorkflow(input, { expectedScope: scope });
        assertUserScope(scope);
        if (alive.current) {
            setWorkflows(current => [workflow, ...current.filter(item => item.id !== workflow.id)]);
            setDraft(null);
            setLibraryOpen(true);
            setError("");
        }
        return workflow;
    };
    const remove = async (id: string) => {
        try {
            await deleteCanvasWorkflow(id, { expectedScope: scope });
            assertUserScope(scope);
            if (alive.current) setWorkflows(current => current.filter(item => item.id !== id));
        } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : "删除失败"); }
    };
    const add = async (workflow: CanvasWorkflow) => {
        if (adding || readOnly) return;
        setAdding(workflow.id);
        try {
            await onInstantiate(workflow.definition.presentationVersion ? workflow : { ...workflow, definition: abstractWorkflowDefinition(workflow.definition) });
            if (alive.current) { setLibraryOpen(false); setError(""); }
        } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : "添加失败"); }
        finally { if (alive.current) setAdding(null); }
    };
    const edit = async (workflow: CanvasWorkflow) => {
        if (openingEditor) return;
        setOpeningEditor(workflow.id);
        try {
            const detail = await getWorkflowEditor(workflow.id, undefined, { expectedScope: scope });
            assertUserScope(scope);
            if (alive.current) { setEditing(detail); setLibraryOpen(false); }
        } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : "打开工作流设定失败"); }
        finally { if (alive.current) setOpeningEditor(undefined); }
    };
    const create = async () => {
        if (readOnly || openingEditor) return;
        setOpeningEditor("new");
        try {
            const { operations } = await listWorkflowOperations({ expectedScope: scope });
            assertUserScope(scope);
            if (alive.current) { setEditing({ operations, workflow: { id: "", name: "新工作流", description: "", createdAt: "", updatedAt: "", revision: 1, definition: { version: 1, nodes: [], edges: [], outputNodeIds: [] } } }); setLibraryOpen(false); }
        } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : "无法创建工作流"); }
        finally { if (alive.current) setOpeningEditor(undefined); }
    };
    const content = <section className="canvas-assistant-panel" aria-label="工作流库" data-canvas-no-zoom data-canvas-no-drag data-canvas-wheel-scroll>
        <header className="canvas-assistant-header">
            <h2>工作流</h2>
            <Tooltip title="从选中节点创建"><Button type="text" size="small" aria-label="从选中节点创建工作流" icon={<Scan className="size-4" />} onClick={saveSelection} disabled={readOnly || selection.size === 0} /></Tooltip>
            <Tooltip title="刷新"><Button type="text" size="small" aria-label="刷新工作流" icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void load()} /></Tooltip>
            <Tooltip title="关闭工作流"><Button type="text" size="small" aria-label="关闭工作流" icon={<X className="size-4" />} onClick={() => setLibraryOpen(false)} /></Tooltip>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-5 pt-2">
            {error ? <Alert type="error" title={error} showIcon /> : null}
            {!readOnly ? <Button block type="text" className="!h-9 !rounded-lg !bg-muted hover:!bg-accent" icon={<Plus className="size-4" />} onClick={() => void create()} disabled={Boolean(openingEditor)} loading={openingEditor === "new"}>新建工作流</Button> : null}
            <div className="flex flex-col gap-2" aria-busy={loading}>
                {loading && !workflows.length ? <div className="grid min-h-32 place-items-center"><Spin size="small" /></div> : workflows.length ? workflows.map(workflow => <article key={workflow.id} className="flex items-center gap-3 rounded-xl bg-muted/50 p-3 transition-colors hover:bg-muted motion-reduce:transition-none" aria-label={workflow.name}>
                    <Workflow className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                    <button type="button" className="flex min-w-0 flex-1 flex-col gap-1 text-left outline-none focus-visible:rounded focus-visible:ring-1 focus-visible:ring-ring" disabled={Boolean(openingEditor)} onClick={() => void edit(workflow)} title={workflow.name} aria-label={`${readOnly ? "查看" : "编辑"}工作流：${workflow.name}`}>
                        <span className="line-clamp-2 break-words text-sm font-medium leading-5">{workflow.name}</span>
                        {workflow.description ? <span className="line-clamp-2 break-words text-xs leading-relaxed text-muted-foreground">{workflow.description}</span> : null}
                    </button>
                    <Tooltip title="添加到画布"><Button type="text" size="small" className="shrink-0" aria-label={`添加${workflow.name}到画布`} icon={<Plus className="size-4" />} disabled={readOnly || Boolean(adding)} loading={adding === workflow.id} onClick={() => void add(workflow)} /></Tooltip>
                    <Popconfirm title="删除这个工作流？" open={deleting === workflow.id} onOpenChange={next => { if (!next) setDeleting(undefined); }} okText="删除" cancelText="取消" onConfirm={() => remove(workflow.id)} onCancel={() => setDeleting(undefined)}>
                        <Dropdown trigger={["click"]} placement="bottomRight" menu={{ items: [{ key: "edit", label: readOnly ? "查看" : "编辑", icon: <Settings2 className="size-4" />, onClick: () => void edit(workflow) }, ...(!readOnly ? [{ key: "delete", label: "删除", danger: true, icon: <Trash2 className="size-4" />, onClick: () => setDeleting(workflow.id) }] : [])] }}>
                            <Button type="text" size="small" className="shrink-0" aria-label={`工作流操作：${workflow.name}`} loading={openingEditor === workflow.id} icon={<MoreHorizontal className="size-4" />} />
                        </Dropdown>
                    </Popconfirm>
                </article>) : !error ? <p className="py-8 text-center text-sm text-muted-foreground">暂无工作流</p> : null}
            </div>
        </div>
    </section>;
    return <>
        {editing ? <CanvasWorkflowEditor key={`${editing.workflow.id}:${editing.workflow.revision}`} initial={editing.workflow} operations={editing.operations} canvasNodes={nodes} canvasConnections={connections} readOnly={readOnly} onClose={() => { setEditing(undefined); setLibraryOpen(true); }} onReturnToCanvas={() => { setEditing(undefined); setLibraryOpen(false); }} onSaved={workflow => { setWorkflows(current => [workflow, ...current.filter(item => item.id !== workflow.id)]); setEditing(undefined); setLibraryOpen(true); }} /> : null}
        {draft ? <CanvasWorkflowSave initial={draft.definition} externalCount={draft.externalCount} onClose={() => setDraft(null)} onSave={save} /> : null}
        {open && visible ? dockable ? <aside className="canvas-assistant-sidebar" style={{ width: 380, flexBasis: 380 }} aria-label="工作流">{content}</aside>
            : <AppDrawer flush open placement="right" title={null} closable={false} size="min(380px, 92vw)" onClose={() => setLibraryOpen(false)} aria-label="工作流">{content}</AppDrawer> : null}
    </>;
});
