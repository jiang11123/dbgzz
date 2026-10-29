import { useCallback, useRef, useState } from "react";

import { confirmAssistantProduction, confirmAssistantProposalRunnable, type AssistantGenerationProposal } from "@/services/api/agent-assistant";
import { armAssistantContinuation, registerAssistantSubmission } from "@/services/api/assistant-continuation";
import type { Skill } from "@/services/api/skills";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

import { executeAssistantProposal } from "./canvas-assistant-proposal-execution";
import { AssistantProposalBlockedError, prepareAssistantProposalSnapshot } from "./canvas-assistant-proposal-snapshot";
import { recordAssistantProposalCanvasRejection, readAssistantProposalSourceState, readPersistedAssistantProposalSource } from "./canvas-assistant-proposal-source";
import { useCanvasOwnerLifetime } from "./canvas-owner-epoch";
import type { CanvasNodeGenerationOptions } from "./use-canvas-generation-executor";

type GenerateNode = (nodeId: string, mode: "image" | "video", prompt: string, options?: CanvasNodeGenerationOptions) => Promise<unknown>;

type UseCanvasAssistantProposalOptions = {
    projectId: string;
    addedSkills: Skill[];
    nodesRef: { current: CanvasNodeData[] };
    connectionsRef: { current: CanvasConnection[] };
    handledProposals: ReadonlySet<string>;
    markProposalHandled: (proposalId: string) => void;
    handleGenerateNode: GenerateNode;
    continuationSessionId?: string | null;
    continuePlan?: boolean;
    onContinuationArmed?: () => void;
};

export function useCanvasAssistantProposal({
    projectId,
    addedSkills,
    nodesRef,
    connectionsRef,
    handledProposals,
    markProposalHandled,
    handleGenerateNode,
    continuationSessionId,
    continuePlan,
    onContinuationArmed,
}: UseCanvasAssistantProposalOptions) {
    const claimsRef = useRef(new Set<string>());
    const attemptedProductionsRef = useRef(new Set<string>());
    const [assistantProposalFeedback, setAssistantProposalFeedback] = useState<Record<string, string>>({});
    const [runningProposalIds, setRunningProposalIds] = useState<ReadonlySet<string>>(() => new Set());
    const handledRef = useRef(handledProposals);
    handledRef.current = handledProposals;
    const markHandledRef = useRef(markProposalHandled);
    markHandledRef.current = markProposalHandled;
    const handleGenerateNodeRef = useRef(handleGenerateNode);
    handleGenerateNodeRef.current = handleGenerateNode;
    const addedSkillsRef = useRef(addedSkills);
    addedSkillsRef.current = addedSkills;
    const projectIdRef = useRef(projectId);
    projectIdRef.current = projectId;
    const { lifetime } = useCanvasOwnerLifetime(projectId);

    const runAssistantProposal = useCallback(
        (proposal: AssistantGenerationProposal, turnId: string) => {
            const owner = lifetime.capture(projectId);
            const generateForThisRun = handleGenerateNodeRef.current;
            const proposalId = proposal.proposalId;
            const sessionId = continuationSessionId;
            let continuationId: string | undefined;
            setAssistantProposalFeedback((current) => ({ ...current, [proposalId]: "" }));
            setRunningProposalIds((current) => new Set(current).add(proposalId));
            if (proposal.production) {
                if (claimsRef.current.has(proposalId) || handledRef.current.has(proposalId)) {
                    setRunningProposalIds(current => { const next = new Set(current); next.delete(proposalId); return next; });
                    return;
                }
                claimsRef.current.add(proposalId);
                const confirmationKey = `${owner.canvasId}:${turnId}:${proposalId}`;
                void (async () => {
                    if (!attemptedProductionsRef.current.has(confirmationKey)) {
                        await prepareAssistantProposalSnapshot(
                            proposal,
                            () => readAssistantProposalSourceState(owner.canvasId, nodesRef.current, connectionsRef.current, addedSkillsRef.current),
                            () => readPersistedAssistantProposalSource(owner.canvasId),
                        );
                    }
                    if (!lifetime.matches(owner, projectIdRef.current)) return;
                    // An unknown HTTP result is recovered using the same immutable
                    // plan. The backend rechecks it and reuses accepted task IDs.
                    attemptedProductionsRef.current.add(confirmationKey);
                    await confirmAssistantProduction(owner.canvasId, turnId, proposal);
                    if (!lifetime.matches(owner, projectIdRef.current)) return;
                    markHandledRef.current(proposalId);
                    onContinuationArmed?.();
                    setAssistantProposalFeedback(current => ({ ...current, [proposalId]: "正在按已确认方案制作，素材保存后会自动继续。" }));
                })().catch(error => {
                    if (!lifetime.matches(owner, projectIdRef.current)) return;
                    if (error instanceof AssistantProposalBlockedError && (error.reason === "canvas_saving" || error.reason === "canvas_conflict")) recordAssistantProposalCanvasRejection(owner.canvasId);
                    setAssistantProposalFeedback(current => ({ ...current, [proposalId]: error instanceof AssistantProposalBlockedError ? error.message : "暂未确认制作是否开始，请重试查询同一方案，不会重复提交已接受的素材。" }));
                }).finally(() => {
                    claimsRef.current.delete(proposalId);
                    setRunningProposalIds(current => { const next = new Set(current); next.delete(proposalId); return next; });
                });
                return;
            }
            if (proposal.kind === "audio") {
                setAssistantProposalFeedback(current => ({ ...current, [proposalId]: "请让助手把配音加入完整制作方案后再确认。" }));
                setRunningProposalIds(current => { const next = new Set(current); next.delete(proposalId); return next; });
                return;
            }
            void executeAssistantProposal({
                proposal,
                nodes: nodesRef.current,
                claims: claimsRef.current,
                isHandled: handledRef.current.has(proposal.proposalId),
                confirmRunnable: () => confirmAssistantProposalRunnable(turnId, proposal.proposalId, owner.canvasId),
                prepare: async () => {
                    const snapshot = await prepareAssistantProposalSnapshot(
                        proposal,
                        () => readAssistantProposalSourceState(owner.canvasId, nodesRef.current, connectionsRef.current, addedSkillsRef.current),
                        () => readPersistedAssistantProposalSource(owner.canvasId),
                    ).catch(error => {
                        if (error instanceof AssistantProposalBlockedError && (error.reason === "canvas_saving" || error.reason === "canvas_conflict") && lifetime.matches(owner, projectIdRef.current)) recordAssistantProposalCanvasRejection(owner.canvasId);
                        throw error;
                    });
                    if (continuePlan && sessionId) { continuationId = (await armAssistantContinuation(owner.canvasId, sessionId, turnId, proposal)).id; onContinuationArmed?.(); }
                    return snapshot;
                },
                generate: (id, kind, prompt, options) => generateForThisRun(id, kind, prompt, { ...options, ...(continuationId ? { onSubmissionPlan: manifest => registerAssistantSubmission(continuationId!, manifest).then(() => undefined) } : {}) }),
                stillOwns: () => lifetime.matches(owner, projectIdRef.current),
                markHandled: (proposalId) => markHandledRef.current(proposalId),
                notify: (content) => {
                    setAssistantProposalFeedback((current) => ({ ...current, [proposalId]: content }));
                },
            }).finally(() => {
                setRunningProposalIds((current) => {
                    const next = new Set(current);
                    next.delete(proposalId);
                    return next;
                });
            });
        },
        [connectionsRef, lifetime, nodesRef, projectId, continuationSessionId, continuePlan, onContinuationArmed],
    );

    return { runAssistantProposal, assistantProposalFeedback, runningProposalIds };
}
