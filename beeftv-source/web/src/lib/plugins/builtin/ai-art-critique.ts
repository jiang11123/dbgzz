import { registerPlugin } from "@/lib/plugins/plugin-registry";
import type { PluginManifest, RegisteredPlugin } from "@/lib/plugins/plugin-types";

import { ART_CRITIQUE_NODE_TYPE, ART_CRITIQUE_PLUGIN_ID, artCritiqueSourceFingerprint, createDefaultArtCritiqueState } from "@/lib/art-critique/contracts";
import { prepareAnalysisNodeAction } from "../analysis-node-action";

const manifest: PluginManifest = {
    apiVersion: "beeftv.plugin/v1",
    id: ART_CRITIQUE_PLUGIN_ID,
    name: "AI 审美批改",
    version: "0.1.0",
    description: "分析图片的构图、色彩、光线和比例问题，输出结构化批改报告与可视化标注。prepare-input 准备节点；canvas_start_art_critique 准备并启动分析；canvas_read_plugin_node 读取结果。",
    author: "内置工具",
    surfaces: ["node", "fullscreen"],
    permissions: ["canvas.read", "canvas.write", "media.read", "ai.text"],
    trusted: true,
    runtime: { backend: "trusted-backend", web: "declarative" },
    contributes: {
        canvasNodes: [
            {
                id: ART_CRITIQUE_NODE_TYPE,
                label: "AI 审美批改",
                defaultTitle: "AI 审美批改",
                defaultSize: { width: 560, height: 420 },
                schema: { type: "object", properties: { artCritique: { type: "object" } } },
                renderer: "declarative",
                acceptsInputKind: "image",
                showOutputConnection: false,
            },
        ],
    },
};

export const artCritiquePlugin: RegisteredPlugin = {
    manifest,
    agentActions: [prepareAnalysisNodeAction(ART_CRITIQUE_NODE_TYPE, "AI 审美批改", () => ({ artCritique: createDefaultArtCritiqueState() }))],
    readAgentNode: (node, snapshot) => {
        const state = node.metadata?.artCritique;
        const sources = snapshot.nodes.filter((item) => item.type === "image" && snapshot.connections.some((edge) => edge.fromNodeId === item.id && edge.toNodeId === node.id));
        const currentReport = state?.report && sources.length === 1 && state.report.sourceFingerprint === artCritiqueSourceFingerprint(sources[0]) ? state.report : undefined;
        return { status: state?.report && !currentReport ? "stale" : state?.status || "idle", stage: state?.analysisStage, stageTaskIds: state?.stageTaskIds, sourceNodeId: state?.sourceNodeId, summary: currentReport?.summary, strengths: currentReport?.strengths, issues: currentReport?.issues, options: currentReport?.options, error: state?.errorMessage, execution: "已有报告仅在输入指纹一致时返回；canvas_start_art_critique 准备分析，用户确认后执行。" };
    },
};

registerPlugin(artCritiquePlugin);
