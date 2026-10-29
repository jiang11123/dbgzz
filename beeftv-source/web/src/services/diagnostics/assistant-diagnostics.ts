import type { AssistantTurn } from "@/services/api/agent-assistant";
import { supportDiagnosticIdentity, type SupportDiagnosticContext } from "@/lib/support-diagnostics";
import { recordDiagnosticEvent } from "./client-diagnostics";

export function recordAssistantInterruption(turn: AssistantTurn, context: SupportDiagnosticContext) {
    if (turn.errorReason !== "turn_interrupted") return;
    recordDiagnosticEvent({ ...context, assistantTurnId: turn.turnId, category: "task", level: "warning", code: "turn_interrupted", reason: "turn_interrupted", message: "助手历史确认这轮执行已中断，等待用户继续处理" });
}

/** Model text, tool arguments and raw errors never become copied support evidence. */
export function formatAssistantDiagnostics(turn: AssistantTurn, context: SupportDiagnosticContext) {
    return [
        "排查信息版本：3",
        ...supportDiagnosticIdentity({ ...context, assistantTurnId: turn.turnId }, { kind: "assistant", appVersion: import.meta.env.VITE_APP_VERSION, buildCommit: import.meta.env.VITE_BUILD_COMMIT }),
        `助手状态：${turn.cancelled ? "已停止" : "未完成"}`,
        `原因代码：${turn.errorReason && /^[a-z][a-z0-9_]{0,95}$/.test(turn.errorReason) ? turn.errorReason : "未记录"}`,
        `轮次创建时间：${Number.isFinite(Date.parse(turn.createdAt)) ? new Date(turn.createdAt).toISOString() : "未记录"}`,
        `工具调用数：${turn.toolCalls?.length || 0}；失败数：${turn.toolCalls?.filter(call => call.isError).length || 0}`,
        "请先核对已有改动和生成结果，再继续处理，避免重复生成。",
    ].join("\n");
}
