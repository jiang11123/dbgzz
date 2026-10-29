import { describe, expect, test } from "bun:test";
import { AgentTurnFailedError, agentAssistantFailureText } from "../src/services/api/agent-assistant";

describe("助手已确认失败与断流未知结果分开", () => {
    test("单轮预算说明可以新发消息继续，而不是终身额度用尽", () => {
        for (const reason of ["turn_request_budget_exhausted", "turn_tool_step_budget_exhausted"]) {
            const text = agentAssistantFailureText(reason);
            expect(text).toContain("发送新消息继续");
            expect(text).toContain("改动会保留");
        }
    });
    test("明确失败的回合使用独立错误类型并保留稳定原因", () => {
        const error = new AgentTurnFailedError("turn_request_budget_exhausted");
        expect(error).toBeInstanceOf(AgentTurnFailedError);
        expect(error.reason).toBe("turn_request_budget_exhausted");
        expect(error.message).toContain("调用上限");
        expect(error.message).not.toContain("结果未知");
    });
    test("未知供应商细节不直接进入用户文案", () => {
        expect(agentAssistantFailureText("private-provider-error", "调用未完成")).toBe("调用未完成");
    });
});
