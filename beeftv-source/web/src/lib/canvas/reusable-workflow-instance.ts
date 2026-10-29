import { nanoid } from "nanoid";
import { CanvasNodeType, type CanvasNodeData, type CanvasConnection, type Position } from "@/types/canvas";
import type { CanvasWorkflow, WorkflowDefinition, WorkflowNode, WorkflowValue } from "@/services/api/canvas-workflows";
import { fitNodeSize } from "./canvas-node-size";
import { isWorkflowOperation, workflowOperationId } from "./workflow-editor";
import { canvasNodeResourceId } from "./canvas-resource-id";

export type WorkflowInstanceAction = "start" | "retry" | "cancel";

export function workflowSlotTitle(node: WorkflowNode, definition: WorkflowDefinition): string {
    const title = node.title.trim();
    if (workflowOperationId(node) === "video.depth") return "深度捕捉结果";
    if (node.role === "input" && node.mediaType === "video" && /深度/.test(title)) return "深度参考";
    if (node.role === "input" && node.mediaType === "video" && /剪辑片段|动作|motion/i.test(title)) return "动作参考";
    // Existing templates used raw prompts and filenames as titles. New short labels are kept verbatim.
    if (title.length <= 24 && !/\.(mp4|mov|png|jpe?g|webp|mp3)(?:\s|$)|帮我|生成一个|生成一张/.test(title)) return title;
    if (isWorkflowOperation(node)) return definition.outputNodeIds.includes(node.id) ? "处理结果" : "处理步骤";
    if (/三视图/.test(title)) return "人物三视图";
    if (/人物|角色|人像|女生|男生|女孩|男孩/.test(title)) return "人物参考";
    if (node.mediaType === "video" && definition.edges.some(edge => edge.fromNodeId === node.id && definition.nodes.some(item => item.id === edge.toNodeId && item.role === "depth"))) return "动作参考";
    return ({ image: "图片参考", video: "视频参考", audio: "声音参考", text: "提示词" })[node.mediaType];
}

function workflowLevels(definition: WorkflowDefinition) {
    const depth = new Map<string, number>();
    const level = (id: string, seen = new Set<string>()): number => {
        if (depth.has(id)) return depth.get(id)!;
        if (seen.has(id)) throw new Error("工作流存在循环依赖");
        const next = new Set([...seen, id]);
        const parents = definition.edges.filter(edge => edge.toNodeId === id);
        const value = parents.length ? Math.max(...parents.map(edge => level(edge.fromNodeId, next))) + 1 : 0;
        depth.set(id, value);
        return value;
    };
    return level;
}

export function createWorkflowInstance(workflow: CanvasWorkflow, origin: Position) {
    const instanceId = `workflow-${nanoid()}`;
    const frameId = `workflow-group-${nanoid()}`;
    const ids = new Map(workflow.definition.nodes.map(node => [node.id, `workflow-slot-${nanoid()}`]));
    const level = workflowLevels(workflow.definition);
    const rows = new Map<number, number>();
    const slots = workflow.definition.nodes.map(source => {
        const column = level(source.id);
        const row = rows.get(column) || 0;
        rows.set(column, row + 1);
        const fixed = source.role === "constant";
        return {
            id: ids.get(source.id)!, type: source.mediaType as CanvasNodeType, title: workflowSlotTitle(source, workflow.definition), parentId: frameId,
            position: { x: origin.x + 40 + column * 380, y: origin.y + 320 + row * 330 }, width: 300, height: 260,
            metadata: {
                nodeRole: "result" as const, status: "idle" as const,
                ...((fixed || source.useDefault) && source.resourceId ? { storageKey: `resource:${source.resourceId}` } : {}),
                ...((fixed || source.mediaType === "text" && source.role === "input") && source.text != null ? { content: source.text } : {}),
                workflowSlot: { instanceId, nodeId: source.id, role: source.role, mediaType: source.mediaType },
            },
        } satisfies CanvasNodeData;
    });
    const width = Math.max(720, (Math.max(...workflow.definition.nodes.map(node => level(node.id)), 0) + 1) * 380 + 40);
    const height = 370 + Math.max(...rows.values(), 1) * 330;
    const frame: CanvasNodeData = { id: frameId, type: CanvasNodeType.Workflow, title: workflow.name, position: origin, width, height };
    const control: CanvasNodeData = {
        id: instanceId, type: CanvasNodeType.WorkflowControl, title: workflow.name, parentId: frameId,
        position: { x: origin.x + 40, y: origin.y + 80 }, width: width - 80, height: 180,
        metadata: { reusableWorkflow: { layoutVersion: 1, templateId: workflow.id, templateRevision: workflow.revision || 1, definition: structuredClone(workflow.definition) } },
    };
    const connections: CanvasConnection[] = workflow.definition.edges.map(edge => ({ id: nanoid(), fromNodeId: ids.get(edge.fromNodeId)!, toNodeId: ids.get(edge.toNodeId)! }));
    return { nodes: [frame, control, ...slots], connections, control, frame };
}

/** Upgrade only proven workflow instances, preserving IDs, receipts and media bindings. */
export function normalizeWorkflowContainers(nodes: CanvasNodeData[]): CanvasNodeData[] {
    const patches = new Map<string, CanvasNodeData>();
    for (const control of nodes.filter(node => node.metadata?.reusableWorkflow)) {
        const parent = nodes.find(node => node.id === control.parentId && (node.type === CanvasNodeType.Frame || node.type === CanvasNodeType.Workflow));
        if (control.type !== CanvasNodeType.WorkflowControl) patches.set(control.id, { ...control, type: CanvasNodeType.WorkflowControl });
        if (!parent) continue;
        const legacy = parent.type === CanvasNodeType.Frame || control.type !== CanvasNodeType.WorkflowControl;
        const collapsed = parent.metadata?.frame?.collapsed;
        const width = collapsed ? parent.metadata?.frame?.expandedWidth || parent.width : parent.width;
        let height = collapsed ? parent.metadata?.frame?.expandedHeight || parent.height : parent.height;
        const children = nodes.filter(node => node.parentId === parent.id && node.metadata?.workflowSlot);
        const state = control.metadata!.reusableWorkflow!;
        const repairLayout = state.layoutVersion !== 1;
        if (repairLayout) {
            const level = workflowLevels(state.definition);
            const rows = new Map<number, number>();
            for (const source of state.definition.nodes) {
                const column = level(source.id);
                const row = rows.get(column) || 0;
                rows.set(column, row + 1);
                const child = children.find(node => node.metadata?.workflowSlot?.nodeId === source.id);
                if (child) patches.set(child.id, { ...child, width: 300, height: 260,
                    position: { x: parent.position.x + 40 + column * 380, y: parent.position.y + 320 + row * 330 } });
            }
        }

        const dy = !repairLayout && legacy && children.length ? Math.max(0, parent.position.y + 320 - Math.min(...children.map(node => node.position.y))) : 0;
        if (dy) {
            children.forEach(node => patches.set(node.id, { ...node, position: { ...node.position, y: node.position.y + dy } }));
            height += dy;
        }
        if (parent.type !== CanvasNodeType.Workflow || dy) patches.set(parent.id, { ...parent, type: CanvasNodeType.Workflow,
            ...(!collapsed ? { height } : {}), metadata: { ...parent.metadata, frame: { collapsed: Boolean(collapsed), expandedWidth: width, expandedHeight: height } } });
        const position = { x: parent.position.x + 40, y: parent.position.y + 80 };
        if (control.type !== CanvasNodeType.WorkflowControl || control.width !== width - 80 || control.height !== 180 || control.position.x !== position.x || control.position.y !== position.y) {
            patches.set(control.id, { ...control, type: CanvasNodeType.WorkflowControl, width: width - 80, height: 180, position });
        }
        if (repairLayout) {
            const next = patches.get(control.id) || control;
            patches.set(control.id, { ...next, metadata: { ...next.metadata, reusableWorkflow: { ...state, layoutVersion: 1 } } });
        }
    }
    return patches.size ? nodes.map(node => patches.get(node.id) || node) : nodes;
}

export function workflowInstanceInputs(control: CanvasNodeData, nodes: CanvasNodeData[]): Record<string, WorkflowValue> {
    const definition = control.metadata?.reusableWorkflow?.definition;
    if (!definition) throw new Error("工作流实例不存在");
    return Object.fromEntries(definition.nodes.filter(node => node.role === "input").map(source => {
        const slot = nodes.find(node => node.metadata?.workflowSlot?.instanceId === control.id && node.metadata.workflowSlot.nodeId === source.id);
        if (!slot) throw new Error(`输入节点「${workflowSlotTitle(source, definition)}」已删除，请重新添加工作流`);
        const value = source.mediaType === "text" ? { text: slot.metadata?.content || "" } : { resourceId: canvasNodeResourceId(slot) };
        if (source.mediaType === "text" && !value.text?.trim()) throw new Error(`请先填写「${slot.title}」`);
        if (source.mediaType !== "text" && !value.resourceId) throw new Error(`请先添加「${slot.title}」`);
        return [source.id, value];
    }));
}

export function workflowInstanceLocked(control?: CanvasNodeData) {
    const state = control?.metadata?.reusableWorkflow;
    return Boolean(state?.intent || state?.run?.status === "queued" || state?.run?.status === "running");
}

export function isWorkflowMaterialSource(source: CanvasNodeData) {
    return source.type === CanvasNodeType.Image || source.type === CanvasNodeType.Video
        || source.type === CanvasNodeType.Audio || source.type === CanvasNodeType.Text;
}

export function workflowDropSlot(nodes: CanvasNodeData[], source: CanvasNodeData, point: Position) {
    if (!isWorkflowMaterialSource(source)) return undefined;
    if (source.metadata?.status === "loading") return undefined;
    if (source.metadata?.workflowSlot && workflowInstanceLocked(nodes.find(node => node.id === source.metadata?.workflowSlot?.instanceId))) return undefined;
    if (source.type !== "text" && !canvasNodeResourceId(source)) return undefined;
    return [...nodes].reverse().find(node => {
        const slot = node.metadata?.workflowSlot;
        return node.id !== source.id && slot?.role === "input" && slot.mediaType === source.type && slot.instanceId !== source.metadata?.workflowSlot?.instanceId && !workflowInstanceLocked(nodes.find(item => item.id === slot.instanceId))
            && point.x >= node.position.x && point.x <= node.position.x + node.width && point.y >= node.position.y && point.y <= node.position.y + node.height;
    });
}


export function workflowAtPoint(nodes: CanvasNodeData[], point: Position) {
    return [...nodes].reverse().find(node => node.type === CanvasNodeType.Workflow && !node.metadata?.frame?.collapsed
        && point.x >= node.position.x && point.x <= node.position.x + node.width
        && point.y >= node.position.y && point.y <= node.position.y + node.height);
}

export function canExportWorkflowResult(node: CanvasNodeData, nodes: CanvasNodeData[]) {
    const slot = node.metadata?.workflowSlot;
    return Boolean(slot && ["operation", "generation", "depth"].includes(slot.role)
        && !workflowInstanceLocked(nodes.find(item => item.id === slot.instanceId))
        && (slot.mediaType === "text" ? node.metadata?.content : canvasNodeResourceId(node)));
}

export function createWorkflowResultNode(source: CanvasNodeData, point: Position): CanvasNodeData {
    const meta = source.metadata || {};
    const size = source.type === "text" ? { width: 420, height: 260 } : fitNodeSize(meta.naturalWidth || source.width, meta.naturalHeight || source.height);
    return { id: `workflow-result-${nanoid()}`, type: source.type, title: source.title,
        position: { x: point.x - size.width / 2, y: point.y - size.height / 2 }, ...size,
        metadata: { nodeRole: "result", resultOrigin: "generated", content: meta.content, storageKey: meta.storageKey,
            assetId: meta.assetId, naturalWidth: meta.naturalWidth, naturalHeight: meta.naturalHeight,
            mimeType: meta.mimeType, bytes: meta.bytes, durationMs: meta.durationMs, status: "success" } };
}

export function upgradeWorkflowInstance(control: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[], workflow: CanvasWorkflow) {
    if (workflowInstanceLocked(control)) throw new Error("请等待当前工作流结束后再更新");
    const frame = nodes.find(node => node.id === control.parentId && node.type === CanvasNodeType.Workflow);
    if (!frame) throw new Error("工作流容器已不存在，请从模板重新添加");
    const previous = nodes.filter(node => node.parentId === frame.id);
    const next = createWorkflowInstance(workflow, frame.position);
    const ids = new Map<string, string>([[next.frame.id, frame.id], [next.control.id, control.id]]);
    for (const slot of next.nodes.filter(node => node.metadata?.workflowSlot)) {
        const old = previous.find(node => node.metadata?.workflowSlot?.nodeId === slot.metadata?.workflowSlot?.nodeId && node.type === slot.type);
        if (old) ids.set(slot.id, old.id);
    }
    const replacements = next.nodes.map(node => {
        const value: CanvasNodeData = { ...node, id: ids.get(node.id) || node.id, parentId: node.parentId ? ids.get(node.parentId) || node.parentId : frame.parentId };
        if (value.metadata?.workflowSlot) {
            const slot = value.metadata.workflowSlot;
            const old = previous.find(item => item.id === value.id);
            const keepInput = slot.role === "input" && old?.metadata?.workflowSlot?.role === "input";
            value.metadata = { ...(keepInput ? old.metadata : value.metadata), workflowSlot: { ...slot, instanceId: control.id } };
        }
        return value;
    });
    const removed = new Set([frame.id, ...previous.map(node => node.id)]);
    return { nodes: [...nodes.filter(node => !removed.has(node.id)), ...replacements],
        connections: [...connections.filter(edge => !removed.has(edge.fromNodeId) && !removed.has(edge.toNodeId)), ...next.connections.map(edge => ({ ...edge, fromNodeId: ids.get(edge.fromNodeId) || edge.fromNodeId, toNodeId: ids.get(edge.toNodeId) || edge.toNodeId }))],
        frame: replacements.find(node => node.id === frame.id)!, added: next.nodes.filter(node => node.metadata?.workflowSlot && !previous.some(old => old.metadata?.workflowSlot?.nodeId === node.metadata?.workflowSlot?.nodeId)).length,
        removed: previous.filter(node => node.metadata?.workflowSlot && !workflow.definition.nodes.some(source => source.id === node.metadata?.workflowSlot?.nodeId)).length };
}
