import { expect, test } from "bun:test";
import { findRecoveredAssistantTurn } from "../src/pages/canvas/canvas-assistant-recovery";
import type { AssistantHistory, AssistantTurn } from "../src/services/api/agent-assistant";

const turn = (id: string): AssistantTurn => ({ turnId: id, userText: "创建一次", selectedNodeIds: ["a"], reply: "完成", toolCalls: [], change: null, proposals: [], error: null, cancelled: false, createdAt: "2026-09-30" });
const pending = { sessionId: "s1", knownTurnIds: ["old"], text: "创建一次", selectedNodeIds: ["a"] };
const history = (turns: AssistantTurn[], sessionId = "s1"): AssistantHistory => ({ sessionId, turns });

test("lost turn_end settles from one new durable receipt, not an old identical message", () => {
    expect(findRecoveredAssistantTurn(pending, history([turn("old")]))).toBeUndefined();
    expect(findRecoveredAssistantTurn(pending, history([turn("old"), turn("new")]))?.turnId).toBe("new");
});
test("another session, different selection, and ambiguous new turns cannot hide uncertainty", () => {
    expect(findRecoveredAssistantTurn(pending, history([turn("new")], "s2"))).toBeUndefined();
    expect(findRecoveredAssistantTurn(pending, history([{ ...turn("new"), selectedNodeIds: ["b"] }]))).toBeUndefined();
    expect(findRecoveredAssistantTurn(pending, history([turn("new"), turn("other")]))).toBeUndefined();
    expect(findRecoveredAssistantTurn({ ...pending, sessionId: null }, history([turn("new")]))).toBeUndefined();
});
test("a recovered failed receipt retains its business failure", () => {
    const failed = { ...turn("new"), error: "部分完成" };
    expect(findRecoveredAssistantTurn(pending, history([failed]))?.error).toBe("部分完成");
});
