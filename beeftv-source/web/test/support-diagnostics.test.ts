import { expect, test } from "bun:test";
import { explainGenerationError, formatGenerationDiagnostics } from "@/lib/generation-error";
import { formatAssistantDiagnostics, recordAssistantInterruption } from "@/services/diagnostics/assistant-diagnostics";
import type { AssistantTurn } from "@/services/api/agent-assistant";
import { getClientDiagnosticEvents, setDiagnosticUserScope } from "@/services/diagnostics/client-diagnostics";

test("generation copy adds real support identities without weakening original-task recovery rules", () => {
    for (const category of ["download_failed", "result_apply_failed", "local_disk_full", "submission_uncertain"] as const) {
        const explanation = explainGenerationError({ code: category, message: category });
        const context = { taskId: "8feebaa8", canvasId: "canvas-1", nodeId: "node-1", clientOperationId: "canvas:operation-1", traceId: "a".repeat(32), createdAt: "2026-10-21T06:00:00Z" };
        const text = formatGenerationDiagnostics(explanation, context);
        expect(text).toContain("排查信息版本：3"); expect(text).toContain("构建提交："); expect(text).toContain("画布 ID：canvas-1");
        expect(text).toContain("Trace ID：" + "a".repeat(32)); expect(text).toContain("任务 ID：8feebaa8");
        expect(explanation.blockManualRetry).toBe(true); expect(explanation.blockAutomaticRetry).toBe(true);
    }
});

test("assistant failure copy has actual session and turn ids, safely identifies missing evidence and omits all model payloads", () => {
    const turn = { turnId: "turn-1", cancelled: true, error: "api_key=canary", errorReason: "assistant_interrupted", createdAt: "2026-10-21T06:00:00Z", toolCalls: [{ tool: "canvas_read", args: { prompt: "private prompt" }, isError: true, error: "https://secret.example/private" }], reply: "private reply", userText: "private user prompt" } as AssistantTurn;
    const text = formatAssistantDiagnostics(turn, { canvasId: "canvas-1", assistantSessionId: "durable:session-1" });
    expect(text).toContain("助手会话 ID：durable:session-1"); expect(text).toContain("助手轮次 ID：turn-1");
    expect(text).toContain("关联证据未记录：Trace ID"); expect(text).toContain("失败数：1");
    expect(text).not.toMatch(/canary|secret\.example|private prompt|private reply|private user/);
});

test("history records an interruption only when the server positively supplies turn_interrupted", () => {
    setDiagnosticUserScope("history-interrupted-evidence");
    const context = { canvasId: "canvas-history", assistantSessionId: "durable:session-history" };
    recordAssistantInterruption({ turnId: "ordinary", errorReason: null } as AssistantTurn, context);
    expect(getClientDiagnosticEvents()).toEqual([]);
    recordAssistantInterruption({ turnId: "interrupted", errorReason: "turn_interrupted", error: "api_key=never-export", reply: "private response" } as AssistantTurn, context);
    expect(getClientDiagnosticEvents()[0]).toMatchObject({ ...context, assistantTurnId: "interrupted", code: "turn_interrupted", reason: "turn_interrupted" });
    expect(JSON.stringify(getClientDiagnosticEvents())).not.toMatch(/never-export|private response/);
});
