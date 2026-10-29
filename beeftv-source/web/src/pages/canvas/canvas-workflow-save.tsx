import { useState } from "react";
import { Alert, Button, Checkbox, Input, Select } from "antd";
import { ArrowRight, Check, ChevronDown, Pencil, X } from "lucide-react";
import { AppModal } from "@/components/ui/product/app-modal";
import { prepareWorkflowDefinition } from "@/lib/canvas/reusable-workflow";
import { workflowSlotTitle } from "@/lib/canvas/reusable-workflow-instance";
import { isWorkflowOperation } from "@/lib/canvas/workflow-editor";
import { getNodeIcon } from "@/lib/canvas/node-registry";
import type { CanvasWorkflow, WorkflowDefinition, WorkflowNode, WorkflowNodeRole } from "@/services/api/canvas-workflows";
import "./canvas-workflow.css";

function WorkflowSaveName({ node, disabled, onRename }: { node: WorkflowNode; disabled: boolean; onRename(title: string): void }) {
    const [editing, setEditing] = useState(false);
    const [value, setValue] = useState(node.title);
    return editing ? <Input autoFocus aria-label={`重命名：${node.title}`} maxLength={80} disabled={disabled} value={value}
        onChange={event => setValue(event.target.value)} onPressEnter={event => event.currentTarget.blur()}
        onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setEditing(false); } }}
        onBlur={() => { if (value.trim()) onRename(value.trim()); setEditing(false); }} />
        : <><span className="min-w-0 flex-1 break-words">{node.title}</span><Button type="text" size="small" disabled={disabled} aria-label={`重命名：${node.title}`} icon={<Pencil className="size-3.5" />} onClick={() => { setValue(node.title); setEditing(true); }} /></>;
}

export function CanvasWorkflowSave({ initial, externalCount, onClose, onSave }: {
    initial: WorkflowDefinition; externalCount: number; onClose(): void;
    onSave(input: { name: string; description: string; definition: WorkflowDefinition }): Promise<CanvasWorkflow>;
}) {
    const [name, setName] = useState("我的工作流");
    const [description, setDescription] = useState("");
    const [definition, setDefinition] = useState(() => {
        const titles = initial.nodes.map(node => workflowSlotTitle(node, initial));
        const reserved = new Set(titles), used = new Set<string>();
        return { ...initial, nodes: initial.nodes.map((node, index) => {
            const base = titles[index];
            let title = base, suffix = 2;
            while (used.has(title) || (title !== base && reserved.has(title))) title = `${base} ${suffix++}`;
            used.add(title);
            return { ...node, title };
        }) };
    });
    const [saving, setSaving] = useState(false);
    const [choosingResults, setChoosingResults] = useState(false);
    const [error, setError] = useState("");
    const rename = (id: string, title: string) => setDefinition(current => ({ ...current, nodes: current.nodes.map(node => node.id === id ? { ...node, title } : node) }));
    const setOutput = (id: string, checked: boolean) => setDefinition(current => ({ ...current, outputNodeIds: checked ? [...new Set([...current.outputNodeIds, id])] : current.outputNodeIds.filter(value => value !== id) }));
    const setRole = (id: string, role: WorkflowNodeRole) => {
        const original = initial.nodes.find(node => node.id === id)!;
        setDefinition(current => ({ ...current, nodes: current.nodes.map(node => node.id === id ? { ...node, role,
            config: role === "operation" ? original.config : undefined,
            operationId: role === "operation" ? original.operationId : undefined,
            operationVersion: role === "operation" ? original.operationVersion : undefined,
            sourceTaskId: ["generation", "operation"].includes(role) ? original.sourceTaskId : undefined } : node) }));
    };
    // Preview the same retained path that will be saved when an intermediate result is frozen.
    let preview = definition;
    try { preview = prepareWorkflowDefinition(definition); } catch { /* Keep invalid choices visible for correction. */ }
    const inputs = preview.nodes.filter(node => !isWorkflowOperation(node));
    const steps = preview.nodes.filter(isWorkflowOperation);
    const results = definition.nodes.filter(node => definition.outputNodeIds.includes(node.id) || (choosingResults && isWorkflowOperation(node)));
    const nameRow = (node: WorkflowNode) => <div className="flex min-w-0 flex-1 items-center gap-2"><span className="shrink-0 text-muted-foreground [&_svg]:size-4">{getNodeIcon(node.mediaType)}</span><WorkflowSaveName node={node} disabled={saving} onRename={title => rename(node.id, title)} /></div>;
    const save = async () => {
        if (saving) return;
        setSaving(true); setError("");
        try {
            if (!name.trim()) throw new Error("请填写工作流名称");
            if (definition.nodes.some(node => !node.title.trim())) throw new Error("请填写节点名称");
            await onSave({ name: name.trim(), description: description.trim(), definition: prepareWorkflowDefinition(definition) });
        } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败，请重试"); }
        finally { setSaving(false); }
    };
    return <AppModal open flush closable={false} footer={null} width="min(1040px, calc(100vw - 32px))" onCancel={() => { if (!saving) onClose(); }} maskClosable={!saving} keyboard={!saving}>
        <section className="workflow-surface flex max-h-[90vh] flex-col" data-canvas-no-zoom data-canvas-no-drag data-canvas-wheel-scroll aria-label="保存工作流">
            <header className="flex items-center justify-between border-b border-border px-6 py-4"><h2 className="font-semibold">保存工作流</h2><Button type="text" aria-label="关闭保存工作流" icon={<X className="size-4" />} disabled={saving} onClick={onClose} /></header>
            <div className="flex min-h-0 flex-col gap-6 overflow-y-auto p-6">
                {error ? <Alert type="error" title={error} showIcon /> : null}
                <label className="flex flex-col gap-2">名称<Input autoFocus value={name} onChange={event => setName(event.target.value)} maxLength={80} disabled={saving} aria-label="工作流名称" /></label>
                <div className="workflow-save-path">
                    <section className="workflow-save-stage"><h3>可替换素材</h3><p>勾选的素材，每次使用时重新选择。</p>
                        {inputs.length ? inputs.map(node => <div key={node.id} className="workflow-save-node"><Checkbox aria-label={`每次替换：${node.title}`} checked={node.role === "input"} disabled={saving} onChange={event => setRole(node.id, event.target.checked ? "input" : "constant")} />{nameRow(node)}{node.role === "constant" ? <span className="shrink-0 text-xs text-muted-foreground">固定</span> : null}</div>) : <p>无需额外素材</p>}
                    </section>
                    <ArrowRight className="workflow-save-arrow size-4 text-muted-foreground" aria-hidden />
                    <section className="workflow-save-stage"><h3>处理过程</h3><p>沿用已成功运行的模型和参数。</p>
                        {steps.map(node => {
                            const parents = preview.edges.filter(edge => edge.toNodeId === node.id).map(edge => preview.nodes.find(item => item.id === edge.fromNodeId)?.title).filter(Boolean);
                            return <div key={node.id} className="workflow-save-node flex-col items-stretch"><div className="flex items-center gap-2">{nameRow(node)}</div>{parents.length ? <span className="text-xs leading-relaxed text-muted-foreground">来自：{[...new Set(parents)].join("、")}</span> : null}</div>;
                        })}
                    </section>
                    <ArrowRight className="workflow-save-arrow size-4 text-muted-foreground" aria-hidden />
                    <section className="workflow-save-stage"><div className="flex items-center justify-between"><h3>保存结果</h3><Button type="text" size="small" disabled={saving} onClick={() => setChoosingResults(value => !value)}>{choosingResults ? "完成" : "更改"}</Button></div><p>每次运行后，得到这些结果。</p>
                        {results.map(node => <div key={node.id} className="workflow-save-node">{choosingResults ? <Checkbox aria-label={`输出：${node.title}`} checked={definition.outputNodeIds.includes(node.id)} disabled={saving} onChange={event => setOutput(node.id, event.target.checked)} /> : <Check className="size-4 shrink-0 text-muted-foreground" />}{nameRow(node)}</div>)}
                        {!results.length ? <p>请选择至少一个结果</p> : null}
                    </section>
                </div>
                {externalCount > 0 ? <p className="text-xs text-muted-foreground">相关参考素材已自动包含。</p> : null}
                <details className="workflow-details border-t border-border pt-4"><summary>更多设置<ChevronDown className="size-4" /></summary><div className="mt-4 flex flex-col gap-4">
                    <label className="flex flex-col gap-2 text-sm">说明（可选）<Input.TextArea value={description} onChange={event => setDescription(event.target.value)} maxLength={500} autoSize={{ minRows: 1, maxRows: 3 }} disabled={saving} placeholder="例如：替换人物，复用同一段动作" aria-label="工作流说明" /></label>
                    {definition.nodes.map(node => {
                        const original = initial.nodes.find(item => item.id === node.id)!;
                        return <div key={node.id} className="flex flex-wrap items-center gap-3"><span className="min-w-32 flex-1 break-words text-sm">{node.title}</span><Select aria-label={`${node.title}的复用方式`} className="min-w-36" value={node.role} disabled={saving} onChange={role => setRole(node.id, role)} options={[{ value: "input", label: "每次可替换" }, { value: "constant", label: "固定内容" }, ...(isWorkflowOperation(original) ? [{ value: original.role, label: "执行处理步骤" }] : [])]} /><Checkbox checked={definition.outputNodeIds.includes(node.id)} disabled={saving} onChange={event => setOutput(node.id, event.target.checked)}>输出</Checkbox></div>;
                    })}
                </div></details>
            </div>
            <footer className="flex shrink-0 justify-end gap-2 border-t border-border px-6 py-4"><Button type="text" disabled={saving} onClick={onClose}>取消</Button><Button type="primary" loading={saving} onClick={() => void save()}>保存工作流</Button></footer>
        </section>
    </AppModal>;
}
