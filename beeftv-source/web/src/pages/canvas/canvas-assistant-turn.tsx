import { App, Button } from "antd";
import copy from "copy-to-clipboard";
import { Crosshair, Undo2 } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { ASSISTANT_PROPOSAL_INVALIDATED_TEXT, ASSISTANT_PROPOSAL_UNDONE_TEXT, agentAssistantFailureText, type AgentToolCall, type AssistantGenerationProposal, type AssistantTurn } from "@/services/api/agent-assistant";
import { ASSISTANT_UNDONE_INCOMPLETE_TEXT, assistantChangeSummary, assistantSkillLabel, assistantChangedNodeIds, assistantProposalText, assistantProposalProgress, assistantTurnCanContinue, assistantUnresolvedFailures, assistantUndoFailureText, assistantVisibleReply } from "./canvas-assistant-copy";
import type { CanvasNodeData } from "@/types/canvas";
import { dismissedProposalKey, type AssistantTurnStatus } from "./use-canvas-assistant";
import { modelOptionName, resolveModelChannel, useEffectiveConfig } from "@/stores/use-config-store";
import { portraitPriceLines, seedancePortraitModel } from "@/lib/seedance-portrait";
import { portraitGenerationError } from "@/lib/model-selection";
import { CanvasAssistantAttachments } from "./canvas-assistant-attachments";
import { CanvasAssistantOutputs } from "./canvas-assistant-outputs";
import { CanvasAssistantMediaFacts } from "./canvas-assistant-media-facts";
import { formatAssistantDiagnostics } from "@/services/diagnostics/assistant-diagnostics";

type Props = {
    canvasId?: string;
    sessionId?: string | null;
    turn: AssistantTurn;
    status?: AssistantTurnStatus;
    handledProposals: Set<string>;
    proposalFeedback?: Record<string, string>;
    /** Proposals whose 生成 click is still being checked or submitted. */
    runningProposalIds?: ReadonlySet<string>;
    generationDisabled?: boolean;
    onLocate: (nodeIds: string[]) => void;
    onUndo: (turnId: string) => void;
    onRunProposal: (proposal: AssistantGenerationProposal, turnId: string) => void;
    onDismissProposal: (proposalId: string) => void;
    onContinue?: () => void;
    nodes?: CanvasNodeData[];
    onCheckResults?: (nodeIds: string[]) => void;
};

const replyMarkdownComponents: Components = {
    table: ({ children }) => <div className="canvas-assistant-table-scroll" role="region" aria-label="回复表格" tabIndex={0}>
        <table>{children}</table>
    </div>,
};

/** 助手回复用 Markdown 渲染，只走 react-markdown 的安全默认值，不放开原始 HTML。 */
export function CanvasAssistantReply({ text }: { text: string }) {
    const visible = assistantVisibleReply(text);
    if (!visible) return null;
    return (
        <div className="canvas-assistant-reply">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={replyMarkdownComponents}>{visible}</ReactMarkdown>
        </div>
    );
}

export function CanvasAssistantUserMessage({ text, selectedCount, continuationId }: { text: string; selectedCount: number; continuationId?: string | null }) {
    if (!text && !selectedCount) return null;
    const automatic = Boolean(continuationId);
    return (
        <div className="canvas-assistant-user">
            {automatic ? <span className="canvas-assistant-chip">自动继续</span> : null}
            <span style={{ whiteSpace: "pre-wrap" }}>{automatic ? "生成已结束，继续检查结果和制作。" : text}</span>
            {selectedCount > 0 ? <span className="canvas-assistant-meta">{automatic ? `关联了本次生成的 ${selectedCount} 个节点` : `带上了已选的 ${selectedCount} 个节点`}</span> : null}
        </div>
    );
}

export function CanvasAssistantTurnView({ turn, canvasId, sessionId, status, handledProposals, proposalFeedback, runningProposalIds, generationDisabled, onLocate, onUndo, onRunProposal, onDismissProposal, onContinue, nodes, onCheckResults }: Props) {
    const { message } = App.useApp();
    const config = useEffectiveConfig();
    const summary = assistantChangeSummary(turn.change);
    const changedNodeIds = assistantChangedNodeIds(turn.change);
    const changedCanvasCount = new Set(turn.change?.canvasChanges?.map(item => item.canvasId) || []).size;
    const failedActions = assistantUnresolvedFailures(turn.toolCalls);
    const undone = Boolean(status?.undone);
    const canContinue = Boolean(turn.error && assistantTurnCanContinue(turn.errorReason));
    // 停下前已经改了画布：保留改动，可在输入框确认后接着做；不自动重发。
    const stoppedWithChanges = Boolean(turn.cancelled && !turn.error && summary && !undone);
    const copyDiagnostics = async () => {
        try {
            const text = formatAssistantDiagnostics(turn, { canvasId, assistantSessionId: sessionId || undefined });
            if (await copy(text)) message.success("排查信息已复制"); else message.error("复制失败，请导出诊断包");
        } catch { message.error("复制失败，请导出诊断包"); }
    };

    return (
        <div className="canvas-assistant-turn">
            <CanvasAssistantUserMessage text={turn.userText} selectedCount={turn.selectedNodeIds?.length ?? 0} continuationId={turn.continuationId} />
            <CanvasAssistantAttachments attachments={turn.attachments || []} />
            {(turn.skills || []).map(skill => <span className="canvas-assistant-chip" key={skill.skillId}>{assistantSkillLabel(skill)}</span>)}
            {turn.supplementInputs?.length ? turn.supplementInputs.map((input, index) => <div key={`supplement:${index}`}>
                <CanvasAssistantUserMessage text={input.message} selectedCount={0} /><CanvasAssistantAttachments attachments={input.attachments || []} />
                {(input.skills || []).map(skill => <span className="canvas-assistant-chip" key={skill.skillId}>{assistantSkillLabel(skill)}</span>)}
            </div>) : (turn.supplements || []).map((text, index) => <CanvasAssistantUserMessage key={`supplement:${index}`} text={text} selectedCount={0} />)}
            {turn.reply ? <CanvasAssistantReply text={turn.reply} /> : null}
            <CanvasAssistantMediaFacts calls={turn.toolCalls || []} nodes={nodes} />
            {turn.outputs?.length ? <CanvasAssistantOutputs outputs={turn.outputs} /> : null}
            {turn.cancelled && stoppedWithChanges ? (
                <div className="canvas-assistant-incomplete" role="status">
                    <strong>这一条已经停下了</strong>
                    <span>停下前的改动保留在画布上。</span>
                    {onContinue ? <>
                        <Button size="small" onClick={onContinue}>继续处理</Button>
                        <span className="canvas-assistant-meta">在输入框里确认或补充要求后发送。</span>
                    </> : null}
                </div>
            ) : turn.cancelled ? <p className="canvas-assistant-meta">这一条已经停下了。</p> : null}
            {turn.error ? (
                <div className={canContinue ? "canvas-assistant-incomplete" : "canvas-assistant-feedback"} role="status">
                    <strong>{canContinue ? "尚未完成" : "这一步没有完成"}</strong>
                    <span className={canContinue ? undefined : "canvas-assistant-failed"}>{undone ? ASSISTANT_UNDONE_INCOMPLETE_TEXT : agentAssistantFailureText(turn.errorReason ?? undefined, "这一轮没有全部完成，请核对已经落地的改动。")}</span>
                    {canContinue && onContinue && !undone ? <>
                        <Button size="small" onClick={onContinue}>继续处理</Button>
                        <span className="canvas-assistant-meta">在输入框里确认或补充要求后发送。</span>
                    </> : null}
                </div>
            ) : null}
            {turn.error || turn.cancelled ? <Button size="small" onClick={() => void copyDiagnostics()}>复制排查信息</Button> : null}

            {failedActions.length > 0 ? (
                <div className="canvas-assistant-feedback" role="status">
                    {failedActions.map((text) => (
                        <span key={text} className="canvas-assistant-failed">
                            {text}
                        </span>
                    ))}
                </div>
            ) : null}

            {summary ? (
                <div className="canvas-assistant-change">
                    <strong>{summary}</strong>
                    {undone ? (
                        <span className="canvas-assistant-meta">{changedCanvasCount > 1 ? "已撤销这一轮全部画布改动" : "已撤销"}</span>
                    ) : (
                        <>
                            {changedCanvasCount > 1 ? <span className="canvas-assistant-meta">撤销会恢复这 {changedCanvasCount} 个画布本轮的全部改动。</span> : null}
                            <div className="canvas-assistant-card-actions">
                                {changedNodeIds.length > 0 ? (
                                    <Button type="text" size="small" icon={<Crosshair className="size-3.5" />} onClick={() => onLocate(changedNodeIds)}>
                                        在画布上查看
                                    </Button>
                                ) : null}
                                <Button type="text" size="small" icon={<Undo2 className="size-3.5" />} loading={status?.undoing} onClick={() => onUndo(turn.turnId)}>
                                    撤销这一轮
                                </Button>
                            </div>
                            {status?.undoFailure ? <span className="canvas-assistant-meta">{changedCanvasCount > 1 && status.undoFailure === "canvas_changed" ? "其中一个画布后来又改过，这一轮未撤销。" : assistantUndoFailureText(status.undoFailure)}</span> : null}
                        </>
                    )}
                </div>
            ) : null}

            {(turn.proposals || []).map((proposal) => {
                const started = handledProposals.has(proposal.proposalId);
                const skipped = handledProposals.has(dismissedProposalKey(proposal.proposalId));
                const selectedModel = proposal.modelKey || proposal.model;
                const portrait = seedancePortraitModel(selectedModel);
                const profile = proposal.kind === "video" ? resolveModelChannel(config, selectedModel).modelProfiles?.find((item) => item.model === modelOptionName(selectedModel)) : undefined;
                const priceError = portrait ? portraitGenerationError(config, selectedModel) : "";
                const running = Boolean(runningProposalIds?.has(proposal.proposalId));
                const progress = started && nodes ? assistantProposalProgress(proposal, nodes) : null;
                return (
                    <div key={proposal.proposalId} className="canvas-assistant-card">
                        <span style={{ whiteSpace: "pre-line", overflowWrap: "anywhere" }}>{assistantProposalText(proposal, portraitPriceLines(profile?.videoPricing), !started && !skipped && !undone && !turn.proposalsInvalidated)}</span>
                        {priceError && !started && !skipped && !undone && !turn.proposalsInvalidated ? <span className="canvas-assistant-meta" role="status">{priceError}</span> : null}
                        {!skipped && !running && ((!undone && !turn.proposalsInvalidated) || started) && proposalFeedback?.[proposal.proposalId] ? <span className="canvas-assistant-meta" role="status" style={{ overflowWrap: "anywhere" }}>{proposalFeedback[proposal.proposalId]}</span> : null}
                        {started ? (
                            <>
                                <span className="canvas-assistant-meta" role="status">{progress?.text || "已开始生成"}</span>
                                {progress && onCheckResults && !undone && !proposal.production ? <div className="canvas-assistant-card-actions">
                                    <Button size="small" disabled={running || !progress.ready} onClick={() => onCheckResults(progress.nodeIds)}>检查结果</Button>
                                    <span className="canvas-assistant-meta">填入检查要求后，由你发送。</span>
                                </div> : null}
                            </>
                        ) : undone ? (
                            <span className="canvas-assistant-meta">{ASSISTANT_PROPOSAL_UNDONE_TEXT}</span>
                        ) : skipped ? (
                            <span className="canvas-assistant-meta">这次没有生成</span>
                        ) : turn.proposalsInvalidated ? (
                            <span className="canvas-assistant-meta" role="status">{ASSISTANT_PROPOSAL_INVALIDATED_TEXT}</span>
                        ) : (
                            <div className="canvas-assistant-card-actions">
                                <Button size="small" type="primary" autoInsertSpace={false} loading={running} disabled={generationDisabled || Boolean(priceError)} onClick={() => onRunProposal(proposal, turn.turnId)}>
                                    {proposal.production ? "确认并制作整片" : "生成"}
                                </Button>
                                <Button size="small" disabled={running} onClick={() => onDismissProposal(proposal.proposalId)}>
                                    先不用
                                </Button>
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
