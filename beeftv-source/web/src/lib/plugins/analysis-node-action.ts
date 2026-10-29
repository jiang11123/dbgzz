import { nanoid } from "nanoid";
import type { CanvasNodeMetadata } from "@/types/canvas";
import type { PluginAgentAction } from "./plugin-types";

export function prepareAnalysisNodeAction(nodeType: string, title: string, metadata: () => CanvasNodeMetadata): PluginAgentAction {
    return {
        id: "prepare-input",
        description: `为已有图片准备${title}节点及连线，复用相同输入的已有节点；仅准备输入，不启动分析或收费。`,
        inputSchema: { type: "object", properties: { sourceNodeId: { type: "string" } }, required: ["sourceNodeId"], additionalProperties: false },
        buildOperations(input, snapshot) {
            if (Object.keys(input).some((key) => key !== "sourceNodeId")) throw new Error("只接受 sourceNodeId");
            const source = snapshot.nodes.find((node) => node.id === input.sourceNodeId && node.type === "image");
            if (!source || !(source.metadata?.storageKey || source.metadata?.content || source.metadata?.previewContent)) throw new Error("请提供当前画布已有图片节点的真实 ID");
            const existing = snapshot.nodes.find((node) => node.type === nodeType && snapshot.connections.some((edge) => edge.fromNodeId === source.id && edge.toNodeId === node.id));
            if (existing) return [{ type: "select_nodes", ids: [existing.id] }];
            const id = `${nodeType}-${nanoid()}`;
            return [
                { type: "add_node", id, nodeType, title, position: { x: Math.max(...snapshot.nodes.map((node) => node.position.x + node.width)) + 120, y: source.position.y }, metadata: metadata() },
                { type: "connect_nodes", fromNodeId: source.id, toNodeId: id },
                { type: "select_nodes", ids: [id] },
            ];
        },
    };
}
