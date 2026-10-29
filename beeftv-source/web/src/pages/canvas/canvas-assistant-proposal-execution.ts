import type { AssistantGenerationProposal } from "@/services/api/agent-assistant";
import { ApiError } from "@/services/api/request";
import type { CanvasNodeData } from "@/types/canvas";
import type { CanvasNodeGenerationOptions } from "./use-canvas-generation-executor";
import { buildGenerationConfig } from "@/lib/canvas/canvas-project-generation";
import { ASSISTANT_PROPOSAL_BLOCKED_TEXT, AssistantProposalBlockedError, type ConfirmedGenerationInputs } from "./canvas-assistant-proposal-snapshot";

export const CANVAS_OWNER_CHANGED_PROPOSAL_MESSAGE = "画布或账号已切换，未提交生成。请重新确认提案。";

type ProposalExecution = {
    proposal: AssistantGenerationProposal;
    nodes: CanvasNodeData[];
    claims: Set<string>;
    isHandled: boolean;
    /** 后端确认这一轮仍有效；返回的文案表示拒绝，不会提交任何生成。 */
    confirmRunnable?: () => Promise<string | null>;
    prepare: () => Promise<ConfirmedGenerationInputs>;
    generate: (nodeId: string, mode: "image" | "video", prompt: string, options?: CanvasNodeGenerationOptions) => Promise<unknown>;
    markHandled: (proposalId: string) => void;
    notify: (content: string) => void;
    stillOwns?: () => boolean;
};

function proposalModelKey(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

/** 兼容性解析可能改选模型，所以每次解析之后都再核对用户确认过的模型。 */
export function buildConfirmedGenerationConfig(
    config: Parameters<typeof buildGenerationConfig>[0],
    node: Parameters<typeof buildGenerationConfig>[1],
    mode: Parameters<typeof buildGenerationConfig>[2],
    requirements: Parameters<typeof buildGenerationConfig>[3],
    confirmedModelKey?: string,
) {
    const result = buildGenerationConfig(config, node, mode, requirements);
    if (confirmedModelKey !== undefined && (!confirmedModelKey.trim() || result.model !== confirmedModelKey || result.taskWorkflowProvider !== "model")) {
        throw new Error("当前模型与生成提案不一致。请让助手重新提出生成方案，核对模型后再确认。");
    }
    return result;
}

export async function executeAssistantProposal({ proposal, nodes, claims, isHandled, confirmRunnable, prepare, generate, markHandled, notify, stillOwns }: ProposalExecution) {
    const kind = proposal.kind;
    if (kind === "audio") { notify("请将配音加入完整制作方案后确认。"); return; }
    if (isHandled || claims.has(proposal.proposalId)) {
        notify("这项提案已提交或正在提交，请在任务列表查看进度。");
        return;
    }
    const targets = [...new Set(proposal.nodeIds)].map((id) => nodes.find((node) => node.id === id));
    if (!targets.length || targets.some((node) => !node)) {
        notify("提案中的节点已发生变化，请让助手重新提出生成方案后再确认。");
        return;
    }
    const modelKey = proposalModelKey(proposal.modelKey);
    if (!modelKey) {
        notify("这项提案缺少模型信息，请让助手重新提出生成方案后再确认。");
        return;
    }
    // 先占住这次确认，避免连点发出第二单；没有任务回执时在 finally 里放开。
    claims.add(proposal.proposalId);
    let receivedTask = false;
    const started = new Set<string>();
    try {
        const rejection = confirmRunnable ? await confirmRunnable() : null;
        if (rejection) {
            notify(rejection);
            return;
        }
        let confirmedInputs: ConfirmedGenerationInputs;
        try {
            confirmedInputs = await prepare();
        } catch (error) {
            if (stillOwns && !stillOwns()) {
                notify(CANVAS_OWNER_CHANGED_PROPOSAL_MESSAGE);
                return;
            }
            notify(error instanceof AssistantProposalBlockedError ? ASSISTANT_PROPOSAL_BLOCKED_TEXT[error.reason]
                : error instanceof ApiError && error.reason === "continuation_intent_changed" ? "要求已更新，请让助手重新提出生成方案。"
                : "无法核对提案的最新内容，请检查连接后重试。");
            return;
        }
        if (stillOwns && !stillOwns()) {
            notify(CANVAS_OWNER_CHANGED_PROPOSAL_MESSAGE);
            return;
        }
        const confirmedTargets = [...new Set(proposal.nodeIds)].map((id) => confirmedInputs.nodes.find((node) => node.id === id));
        if (confirmedTargets.some((node) => !node)) {
            notify(ASSISTANT_PROPOSAL_BLOCKED_TEXT.canvas_changed);
            return;
        }
        await Promise.allSettled(confirmedTargets.map(async (node) => {
            if (!node) return;
            await generate(node.id, kind, node.metadata?.composerContent ?? node.metadata?.prompt ?? "", {
                confirmedModelKey: modelKey,
                confirmedInputs,
                clientOperationId: `proposal:${proposal.proposalId}:${node.id}`,
                onTaskUpdate: (task) => {
                    if (!task.id) return;
                    receivedTask = true;
                    if (task.status !== "queued" && task.status !== "running" && task.status !== "succeeded") return;
                    const first = started.size === 0;
                    started.add(node.id);
                    if (first) markHandled(proposal.proposalId);
                },
            });
        }));
        if (!started.size) {
            notify("未确认有生成任务开始。请检查节点提示和任务列表，再让助手重新提出生成方案。");
        } else if (started.size < targets.length) {
            notify(`仅 ${started.size}/${targets.length} 个节点确认开始生成。请检查其余节点的提示和任务列表，不要重复提交整项提案。`);
        }
    } finally {
        if (!receivedTask) claims.delete(proposal.proposalId);
    }
}
