import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/services/api/request";
import { cancelAssistantContinuations, claimAssistantContinuation, listAssistantContinuations, type AssistantContinuation } from "@/services/api/assistant-continuation";
import { subscribeGenerationTasks } from "@/services/api/task-center";
import { captureUserScope, userScopeMatches } from "@/lib/user-scope-guard";
import type { CanvasNodeData } from "@/types/canvas";
import type { CanvasAssistantController } from "./use-canvas-assistant";
import { cancelAgentChat } from "@/services/api/agent-assistant";

type ContinuationController = Pick<CanvasAssistantController, "historyLoaded" | "streaming" | "sessionBusy" | "awaitingReceipt" | "sessionId" | "canvasId" | "send">;
export function canContinueAssistant(controller: ContinuationController, row: AssistantContinuation) {
    return controller.historyLoaded && !controller.streaming && !controller.sessionBusy && !controller.awaitingReceipt && controller.canvasId === row.canvasId && controller.sessionId === row.sessionId;
}

export async function continueAssistantOnce(row: AssistantContinuation, access: {
    current(): ContinuationController | null;
    claim(id: string): Promise<AssistantContinuation>;
    onDispatch(): void;
}) {
    const before = access.current();
    if (!before || !canContinueAssistant(before, row)) return false;
    const claimed = await access.claim(row.id);
    const after = access.current();
    if (!after || !canContinueAssistant(after, claimed) || claimed.id !== row.id || claimed.state === "done" || claimed.state === "cancelled") return false;
    access.onDispatch();
    // The receipt supplies only this generation's real results. Composer drafts,
    // attachments, skill selections and temporary canvas selection stay untouched.
    await after.send(claimed.message, claimed.nodeIds, [], { continuation: claimed, permissionMode: claimed.permissionMode });
    return true;
}

/** Only an active canvas observes. Go owns the claim; no draft or composer state enters this path. */
export function useCanvasAssistantContinuation(assistant: CanvasAssistantController, nodes: CanvasNodeData[], enabled: boolean) {
    const live = useRef(assistant); live.current = assistant;
    const [rows, setRows] = useState<AssistantContinuation[]>([]);
    const knownRows = useRef(rows); knownRows.current = rows;
    const [notice, setNotice] = useState("");
    const [refresh, setRefresh] = useState(0);
    const sent = useRef(new Set<string>());
    const identity = `${assistant.canvasId}:${assistant.sessionId || ""}`;
    const active = useRef(identity); active.current = identity;
    const checking = useRef(new Set<string>());
    const dirty = useRef(new Set<string>());
    const mounted = useRef(false);
    const activeEnabled = useRef(enabled); activeEnabled.current = enabled;
    const stopped = useRef(false);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    useEffect(() => { if (enabled && !live.current.historyLoaded) void live.current.reloadHistory(); }, [assistant.canvasId, enabled]);
    useEffect(() => { sent.current.clear(); stopped.current = false; setRows([]); setNotice(""); }, [identity]);
    useEffect(() => {
        if (!enabled || !assistant.sessionId || !assistant.historyLoaded) return;
        const scope = captureUserScope();
        const isCurrent = () => mounted.current && activeEnabled.current && userScopeMatches(scope) && active.current === identity && !stopped.current;
        const timer = setTimeout(() => {
            if (!isCurrent()) return;
            if (checking.current.has(identity)) { dirty.current.add(identity); return; }
            checking.current.add(identity);
            void (async () => {
                const results = await listAssistantContinuations(assistant.canvasId, assistant.sessionId!);
                if (!isCurrent()) return;
                setRows(results);
                if (!results.length) setNotice("");
                for (const row of results) {
                    if (sent.current.has(row.id) || !canContinueAssistant(live.current, row)) continue;
                    try {
                        const dispatched = await continueAssistantOnce(row, {
                            current: () => isCurrent() ? live.current : null,
                            claim: claimAssistantContinuation,
                            onDispatch: () => { sent.current.add(row.id); setNotice("正在检查结果并继续原计划"); },
                        });
                        if (dispatched) break;
                    } catch (error) {
                        if (error instanceof ApiError && error.reason === "continuation_waiting") continue;
                        if (isCurrent()) setNotice("暂未自动继续，可手动检查结果或重新读取。");
                    }
                }
            })().catch(() => { if (isCurrent()) setNotice("暂时无法读取继续状态，请重新读取。"); }).finally(() => {
                checking.current.delete(identity);
                // A saved result/task event can be the final event. Preserve it
                // while an older waiting reply is in flight instead of dropping it.
                if (dirty.current.delete(identity) && isCurrent()) setRefresh(value => value + 1);
            });
        }, 250);
        return () => clearTimeout(timer);
    }, [identity, assistant.canvasId, assistant.sessionId, assistant.historyLoaded, assistant.streaming, assistant.sessionBusy, assistant.awaitingReceipt, enabled, nodes, refresh]);
    const taskKey = JSON.stringify([...new Set(rows.flatMap(row => row.taskIds))].sort());
    useEffect(() => subscribeGenerationTasks(JSON.parse(taskKey) as string[], () => setRefresh(value => value + 1)), [taskKey]);
    const stop = useCallback(async () => {
        stopped.current = true;
        const controller = live.current;
        if (!controller.sessionId) return;
        const targets = knownRows.current.filter(row => row.canvasId === controller.canvasId && row.sessionId === controller.sessionId);
        const scope = captureUserScope();
        const stoppedIdentity = active.current;
        try {
            await cancelAssistantContinuations(controller.canvasId, controller.sessionId);
            // Fence each exact continuation request even if another window started
            // it. Never stop an unrelated user turn which became active meanwhile.
            await Promise.all(targets.map(row => cancelAgentChat(row.canvasId, {sessionId: row.sessionId, requestId: row.requestId})));
            if (!userScopeMatches(scope) || active.current !== stoppedIdentity || !mounted.current) return;
            await controller.reloadHistory();
            if (!userScopeMatches(scope) || active.current !== stoppedIdentity || !mounted.current) return;
            setRows([]); setNotice("已停止自动继续，生成任务可在任务中心查看。");
        } catch { if (userScopeMatches(scope) && active.current === stoppedIdentity && mounted.current) setNotice("停止状态未能确认，请重试停止。"); }
    }, []);
    return { pending: rows.length > 0, notice: rows.length ? notice || "生成结果就绪后，会继续检查与剪辑。" : notice, stop, refresh: () => { sent.current.clear(); stopped.current = false; setRefresh(value => value + 1); } };
}
