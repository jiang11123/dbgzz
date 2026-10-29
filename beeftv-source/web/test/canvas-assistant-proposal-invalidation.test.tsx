import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasAssistantTurnView } from "@/pages/canvas/canvas-assistant-turn";
import type { AssistantTurn } from "@/services/api/agent-assistant";

const turn: AssistantTurn = { turnId: "source", userText: "制作首帧", selectedNodeIds: [], reply: "方案已准备好", toolCalls: [], change: null,
    proposals: [{ proposalId: "p1", kind: "image", nodeIds: ["source"], model: "图片模型" }], error: null, cancelled: false, createdAt: "2026-10-18" };
function render(proposalsInvalidated: boolean, started = false, generationDisabled = false) {
    return renderToStaticMarkup(<CanvasAssistantTurnView turn={{ ...turn, proposalsInvalidated }} handledProposals={new Set(started ? ["p1"] : [])}
        generationDisabled={generationDisabled} onLocate={() => {}} onUndo={() => {}} onRunProposal={() => {}} onDismissProposal={() => {}} />);
}
test("expired unstarted cards cannot generate, while existing outputs remain available", () => {
    const expired = render(true);
    expect(expired).toContain("已失效，请让助手重新提出生成方案。");
    expect(expired).not.toContain("确认后开始，按所选渠道计费");
    expect(expired).not.toMatch(/<button\b[^>]*>[\s\S]*?生成<\/span>/);
    const started = render(true, true);
    expect(started).toContain("已开始生成");
    expect(started).not.toContain("已失效");
});
test("a valid card remains available, and sending only disables its generation action", () => {
    expect(render(false)).not.toContain("已失效");
    const sending = render(false, false, true);
    const buttons = sending.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) || [];
    expect(buttons.find(button => button.includes("生成"))).toContain('disabled=""');
    expect(buttons.find(button => button.includes("先不用"))).not.toContain('disabled=""');
});
