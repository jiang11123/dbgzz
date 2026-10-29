import { canvasNodeMentionToken, type CanvasResourceReference } from "./canvas-resource-references";
import { connectWorkflowDraft, workflowOperationId } from "./workflow-editor";
import type { WorkflowDefinition, WorkflowOperation } from "@/services/api/canvas-workflows";

const mediaNames = { image: "图片", video: "视频", audio: "音频", text: "文本" };
const mediaPorts = { image: "referenceImages", video: "referenceVideos", audio: "referenceAudios", text: "prompt" };
const nodeTokens = /@\[node:([^\]\s]+)\]/g;

export function workflowNodeMentionReferences(definition: WorkflowDefinition, targetId: string, operations: WorkflowOperation[]): CanvasResourceReference[] {
    const target = definition.nodes.find(node => node.id === targetId);
    const ports = operations.find(operation => target && operation.id === workflowOperationId(target))?.inputs || [];
    const descendants = new Set([targetId]);
    const visit = (id: string) => definition.edges.filter(edge => edge.fromNodeId === id).forEach(edge => {
        if (!descendants.has(edge.toNodeId)) { descendants.add(edge.toNodeId); visit(edge.toNodeId); }
    });
    visit(targetId);
    return definition.nodes.filter(node => !descendants.has(node.id) && ports.some(port => port.id === mediaPorts[node.mediaType] && port.mediaType === node.mediaType))
        .map(node => ({ id: node.id, nodeId: node.id, kind: node.mediaType, title: node.title, label: node.title, active: true, mentionToken: canvasNodeMentionToken(node.id) }));
}

export function connectWorkflowPromptReference(definition: WorkflowDefinition, targetId: string, sourceId: string, operations: WorkflowOperation[]) {
    const source = definition.nodes.find(node => node.id === sourceId);
    if (!source) throw new Error("引用的节点已不存在");
    const port = mediaPorts[source.mediaType];
    if (definition.edges.some(edge => edge.fromNodeId === sourceId && edge.toNodeId === targetId && edge.toPort === port)) return definition;
    return connectWorkflowDraft(definition, sourceId, targetId, port, operations);
}

/** Existing provider labels become identity-based references at the editor boundary. */
export function normalizeWorkflowNodeMentions(definition: WorkflowDefinition): WorkflowDefinition {
    return { ...definition, nodes: definition.nodes.map(node => {
        const prompt = node.config?.prompt;
        if (typeof prompt !== "string") return node;
        const aliases = new Map<string, string>();
        for (const edge of definition.edges.filter(edge => edge.toNodeId === node.id)) {
            const source = definition.nodes.find(item => item.id === edge.fromNodeId);
            if (source && source.mediaType !== "text" && edge.toPort === mediaPorts[source.mediaType]) aliases.set(`@${mediaNames[source.mediaType]}${(edge.order ?? 0) + 1}`, canvasNodeMentionToken(source.id));
        }
        return { ...node, config: { ...node.config, prompt: prompt.replace(/@(图片|视频|音频)\d+/g, token => aliases.get(token) || token) } };
    }) };
}

export function workflowPromptDisplayText(prompt: string, definition: WorkflowDefinition) {
    return prompt.replace(nodeTokens, (_, id: string) => `@${definition.nodes.find(node => node.id === id)?.title || "已删除节点"}`);
}

export function remapWorkflowPromptMentions(prompt: string, ids: Map<string, string>) {
    return prompt.replace(nodeTokens, (token, id: string) => ids.has(id) ? canvasNodeMentionToken(ids.get(id)!) : token);
}

export function validateWorkflowPromptMentions(definition: WorkflowDefinition) {
    for (const node of definition.nodes) {
        const prompt = node.config?.prompt;
        if (typeof prompt !== "string") continue;
        for (const [, id] of prompt.matchAll(nodeTokens)) {
            if (!definition.nodes.some(source => source.id === id) || !definition.edges.some(edge => edge.fromNodeId === id && edge.toNodeId === node.id)) throw new Error(`「${node.title}」引用的节点已断开或删除，请重新选择`);
        }
    }
}
