import { useEffect, useState, type KeyboardEvent } from "react";
import { Check, Send } from "lucide-react";

import type { CanvasTheme } from "@/lib/canvas-theme";
import { isDoubaoVideoModel } from "@/lib/doubao-video-model";
import { doubaoConfirmVideoTask, doubaoPollVideoTask, type DoubaoVideoTaskState } from "@/services/api/doubao-gateway";
import { queryGenerationTask } from "@/services/api/task-center";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const POLL_INTERVAL_MS = 3000;
const CONFIRM_TEXT = "确认，开始生成";
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

/**
 * 后端任务的 providerRequestId 就是网关任务 id；拿到后直接向本地网关取豆包的回复和状态。
 * 后端任务系统只看到 processing，豆包说了什么、是否在等用户，都由这里展示。
 */
function useDoubaoGatewayTask(backendTaskId: string | undefined, active: boolean) {
    const [gatewayTaskId, setGatewayTaskId] = useState<string>();
    const [state, setState] = useState<DoubaoVideoTaskState>();

    useEffect(() => {
        if (!active || !backendTaskId) {
            setGatewayTaskId(undefined);
            setState(undefined);
            return;
        }
        const controller = new AbortController();
        let timer: number | undefined;
        let gateway: string | undefined;
        const tick = async () => {
            let finished = false;
            try {
                if (!gateway) {
                    const task = await queryGenerationTask(backendTaskId, { signal: controller.signal });
                    if (task.providerRequestId) {
                        gateway = task.providerRequestId;
                        setGatewayTaskId(gateway);
                    }
                }
                if (gateway) {
                    const next = await doubaoPollVideoTask(gateway, controller.signal);
                    if (!controller.signal.aborted) setState(next);
                    finished = TERMINAL.has(next.status);
                }
            } catch {
                // 网关或任务暂时读不到时下一轮再试
            }
            if (!controller.signal.aborted && !finished) timer = window.setTimeout(() => void tick(), POLL_INTERVAL_MS);
        };
        void tick();
        return () => {
            controller.abort();
            if (timer !== undefined) window.clearTimeout(timer);
        };
    }, [backendTaskId, active]);

    return { gatewayTaskId, state };
}

type Props = { node: CanvasNodeData; theme: CanvasTheme };

/** 选了豆包视频模型的节点在生成中显示豆包的回复，并允许补充消息或确认生成。 */
export function DoubaoTaskReply({ node, theme }: Props) {
    const backendTaskId = node.metadata?.taskId;
    const active = node.type === CanvasNodeType.Video && isDoubaoVideoModel(node.metadata?.model) && Boolean(backendTaskId);
    const { gatewayTaskId, state } = useDoubaoGatewayTask(backendTaskId, active);
    const [draft, setDraft] = useState("");
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState("");

    if (!active) return null;
    const reply = state?.latest_reply?.trim();
    const needsAttention = state?.status === "needs_attention";
    // 豆包没有回复时不占位，避免只有一个空框
    if (!reply && !needsAttention) return null;

    const send = async (text: string) => {
        const value = text.trim();
        if (!gatewayTaskId || !value || busy) return;
        setBusy(true);
        setNotice("");
        try {
            await doubaoConfirmVideoTask(gatewayTaskId, value);
            setDraft("");
            setNotice("已发送给豆包");
        } catch (error) {
            setNotice(error instanceof Error ? error.message : "发送失败，请稍后重试");
        } finally {
            setBusy(false);
        }
    };
    // 画布快捷键（空格、删除等）不能抢走输入框里的按键
    const stopKeys = (event: KeyboardEvent) => event.stopPropagation();
    const stopPointer = { onMouseDown: (event: { stopPropagation: () => void }) => event.stopPropagation(), onPointerDown: (event: { stopPropagation: () => void }) => event.stopPropagation() };
    const buttonStyle = { background: theme.toolbar.itemHover, color: theme.node.text };

    return (
        <div
            role="region"
            aria-label="豆包回复"
            className="mt-1 flex w-full max-w-[380px] flex-col gap-2 rounded-[var(--r-sm)] border p-2.5 text-left"
            style={{ borderColor: theme.node.stroke, color: theme.node.text }}
            {...stopPointer}
        >
            <div className="flex items-center justify-between gap-2 text-[var(--fs-tiny)]" style={{ color: theme.node.muted }}>
                <span className="font-medium">豆包回复</span>
                {state?.status_text ? <span className="truncate">{state.status_text}</span> : null}
            </div>
            {reply ? <div className="max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-5">{reply}</div> : null}
            {needsAttention ? <div className="text-xs leading-5" style={{ color: theme.node.muted }}>需要先在豆包工作站里完成人机验证，再回到这里继续。</div> : null}
            <div className="flex items-center gap-1.5">
                <input
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                        stopKeys(event);
                        if (event.key === "Enter" && !event.nativeEvent.isComposing) void send(draft);
                    }}
                    onKeyUp={stopKeys}
                    placeholder="回复豆包，例如补充要求"
                    aria-label="回复豆包"
                    className="h-7 min-w-0 flex-1 rounded-[var(--r-sm)] border bg-transparent px-2 text-xs outline-none"
                    style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                />
                <button type="button" aria-label="发送给豆包" disabled={busy || !draft.trim()} onClick={() => void send(draft)} className="inline-flex h-7 shrink-0 items-center gap-1 rounded-[var(--r-sm)] px-2 text-[var(--fs-tiny)] font-medium disabled:opacity-50" style={buttonStyle}>
                    <Send className="size-3" />发送
                </button>
                <button type="button" aria-label="确认生成" disabled={busy} onClick={() => void send(CONFIRM_TEXT)} className="inline-flex h-7 shrink-0 items-center gap-1 rounded-[var(--r-sm)] px-2 text-[var(--fs-tiny)] font-medium disabled:opacity-50" style={buttonStyle}>
                    <Check className="size-3" />确认生成
                </button>
            </div>
            {notice ? <div className="text-[var(--fs-tiny)]" style={{ color: theme.node.muted }}>{notice}</div> : null}
        </div>
    );
}
