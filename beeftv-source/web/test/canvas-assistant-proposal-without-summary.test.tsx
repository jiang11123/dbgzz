import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasAssistantTurnView } from "@/pages/canvas/canvas-assistant-turn";
import type { AssistantTurn } from "@/services/api/agent-assistant";

test("a settled tool-only turn keeps its confirmation card after history serialization", () => {
    const turn: AssistantTurn = {
        turnId: "proposal-turn", userText: "准备下一张首帧", selectedNodeIds: [], reply: "",
        toolCalls: [{ tool: "canvas.generation.propose", args: { nodeIds: ["shot"], kind: "image" }, isError: false }],
        change: null, error: null, cancelled: false, createdAt: "2026-10-18",
        proposals: [{ proposalId: "gp-1", kind: "image", nodeIds: ["shot"], model: "fixture-image", modelKey: "fixture::image",
            source: { canvasId: "canvas", canvasRevision: 1, modelConfigRevision: 1 } }],
    };
    let actions = 0;
    for (const current of [turn, JSON.parse(JSON.stringify(turn))]) {
        const html = renderToStaticMarkup(<CanvasAssistantTurnView turn={current} handledProposals={new Set()}
            onLocate={() => actions++} onUndo={() => actions++} onRunProposal={() => actions++} onDismissProposal={() => actions++} />);
        expect(html).toContain("canvas-assistant-card");
        expect(html).toContain("fixture-image");
        expect(html).toContain("生成");
        expect(html).toContain("先不用");
        expect(html).not.toContain("尚未完成");
        expect(html).not.toContain("已开始生成");
        expect(html).not.toContain("disabled");
    }
    expect(actions).toBe(0);
    expect(turn.reply).toBe("");
});
