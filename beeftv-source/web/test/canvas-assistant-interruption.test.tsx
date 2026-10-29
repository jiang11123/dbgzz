import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CanvasAssistantTurnView, CanvasAssistantUserMessage } from "@/pages/canvas/canvas-assistant-turn";
import { CanvasAssistantComposer } from "@/pages/canvas/canvas-assistant-composer";
import type { AssistantTurn } from "@/services/api/agent-assistant";

const interrupted: AssistantTurn = {
    turnId: "paused", userText: "只创建草案", selectedNodeIds: [],
    reply: "两个草案已创建。", toolCalls: [], proposals: [],
    change: { revisionBefore: 1, revisionAfter: 2, createdNodeIds: ["a", "b"], updatedNodeIds: [], createdEdgeIds: [] },
    error: "raw provider error", errorReason: "turn_timeout", cancelled: false, createdAt: "2026-10-08",
};
function render(turn = interrupted, options: { undone?: boolean; continue?: boolean } = {}) {
    return renderToStaticMarkup(<CanvasAssistantTurnView turn={turn} status={{ undone: options.undone }} handledProposals={new Set()}
        onLocate={() => {}} onUndo={() => {}} onRunProposal={() => {}} onDismissProposal={() => {}}
        onContinue={options.continue === false ? undefined : () => {}} />);
}

describe("自动继续消息只按已确认身份简短展示", () => {
    const internal = "【自动继续】这次生成已结束。不要改动或发送我的未发送草稿。";
    test("运行中与恢复后的回合显示自动标记，保留原始提示词数据", () => {
        const turn: AssistantTurn = { ...interrupted, continuationId: "trusted-receipt", userText: internal };
        const pending = renderToStaticMarkup(<CanvasAssistantUserMessage text={internal} selectedCount={2} continuationId={turn.continuationId} />);
        const recovered = render(JSON.parse(JSON.stringify(turn)));
        for (const html of [pending, recovered]) {
            expect(html).toContain("自动继续");
            expect(html).toContain("生成已结束，继续检查结果和制作。");
            expect(html).not.toContain("未发送草稿");
        }
        expect(turn.userText).toBe(internal);
    });
    test("普通用户发送同样文字仍原样显示，补充消息也不被折叠", () => {
        expect(render({ ...interrupted, userText: internal })).toContain(internal);
        const supplement = render({ ...interrupted, continuationId: "trusted-receipt", userText: internal, supplements: [internal] });
        expect(supplement).toContain(internal);
        expect(supplement).toContain("生成已结束，继续检查结果和制作。");
    });
});

describe("处理未完成仍保留可检查的结果", () => {
    test("超时保留回复、实际改动与撤销，并提供中性状态和继续入口", () => {
        const html = render();
        expect(html).toContain("两个草案已创建");
        expect(html).toContain("新建 2 个节点");
        expect(html).toContain("撤销这一轮");
        expect(html).toContain("尚未完成");
        expect(html).toContain("继续处理");
        expect(html).toContain('class="canvas-assistant-incomplete"');
        expect(html).not.toContain("canvas-assistant-failed");
        expect(html).not.toContain("raw provider error");
    });
    test("已经撤销、旧回合或只读时不展示继续按钮", () => {
        for (const html of [render(interrupted, { undone: true }), render(interrupted, { continue: false })]) {
            expect((html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) || []).some(button => button.includes("继续处理"))).toBe(false);
        }
        expect(render(interrupted, { undone: true })).toContain("画布改动已撤销");
    });
    test("不可继续的配置错误仍明确失败，不冒充已恢复", () => {
        const html = render({ ...interrupted, errorReason: "forbidden" });
        expect(html).toContain("canvas-assistant-failed");
        expect(html).not.toContain("继续处理");
        expect(html).not.toContain("尚未完成");
    });
    test("运行中保留输入和停止，并有明确补充入口，不新增素材附件", () => {
        const html = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><CanvasAssistantComposer value="只改结尾" onChange={() => {}} onSend={() => {}} onStop={() => {}}
            streaming disabled={false} canSupplement supplementBusy={false} references={[]} selectedCount={3} selectionAttached onDetachSelection={() => {}} /></QueryClientProvider>);
        expect(html).toMatch(/补\s*充/);
        expect(html).toContain("停止");
        const input = html.match(/<textarea\b[^>]*>/)?.[0] || html.match(/<div\b[^>]*contentEditable="true"[^>]*>/)?.[0];
        expect(input).toBeDefined();
        expect(input).not.toContain('disabled=""');
        expect(html).not.toContain("已选 3 个节点");
    });
    test("历史中保留已收到的补充要求，不改写原用户消息", () => {
        const html = render({ ...interrupted, supplements: ["结尾改成蛋糕"] });
        expect(html).toContain("只创建草案");
        expect(html).toContain("结尾改成蛋糕");
    });
});

describe("停下的回合按实际结果给出下一步", () => {
    const stopped: AssistantTurn = { ...interrupted, turnId: "stopped", error: null, errorReason: null, cancelled: true };
    const continueButtons = (html: string) => (html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) || []).filter(button => button.includes("继续处理"));
    test("停下前已经改动画布：保留改动和撤销，并提供继续入口", () => {
        const html = render(stopped);
        expect(html).toContain("这一条已经停下了");
        expect(html).toContain("新建 2 个节点");
        expect(html).toContain("撤销这一轮");
        expect(continueButtons(html)).toHaveLength(1);
        expect(html).toContain("在输入框里确认或补充要求后发送。");
    });
    test("停下时还没有任何改动：只说明已停下，不提供继续，也不显示为完成", () => {
        const html = render({ ...stopped, reply: "", change: null });
        expect(html).toContain("这一条已经停下了。");
        expect(continueButtons(html)).toHaveLength(0);
        expect(html).not.toContain("canvas-assistant-change");
        expect(html).not.toContain("已完成");
    });
    test("已撤销、旧回合或只读时，停下的回合不提供继续", () => {
        expect(continueButtons(render(stopped, { undone: true }))).toHaveLength(0);
        expect(continueButtons(render(stopped, { continue: false }))).toHaveLength(0);
    });
});

const proposalTurn: AssistantTurn = {
    ...interrupted, turnId: "with-proposal", error: null, errorReason: null,
    proposals: [{ proposalId: "gp-1", kind: "image", nodeIds: ["a"], model: "图片模型", modelKey: "channel::image" }],
};
function buttons(html: string) {
    return (html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) || []).map(button => button.replace(/<[^>]+>/g, "").replace(/\s+/g, ""));
}

describe("撤销后的生成建议不再可用", () => {
    test("未撤销时仍提供生成与先不用", () => {
        const labels = buttons(render(proposalTurn));
        expect(labels).toContain("生成");
        expect(labels).toContain("先不用");
    });
    test("撤销后未开始的建议只说明不会生成，没有按钮", () => {
        const html = render(proposalTurn, { undone: true });
        expect(html).toContain("这一轮已撤销，不会生成。");
        expect(buttons(html)).not.toContain("生成");
        expect(buttons(html)).not.toContain("先不用");
    });
    test("撤销前已经开始的生成仍显示已开始生成", () => {
        const html = renderToStaticMarkup(<CanvasAssistantTurnView turn={proposalTurn} status={{ undone: true }} handledProposals={new Set(["gp-1"])}
            onLocate={() => {}} onUndo={() => {}} onRunProposal={() => {}} onDismissProposal={() => {}} />);
        expect(html).toContain("已开始生成");
        expect(html).not.toContain("这一轮已撤销，不会生成。");
    });
});

describe("技能标签只显示名称", () => {
    const hash = "352590bd".repeat(8);
    test("有名称时显示名称和版本", () => {
        const html = render({ ...interrupted, skills: [{ skillId: "s1", versionId: "cc4bb169", contentHash: hash, skillName: "短剧资产分批流程", version: "1" }] });
        expect(html).toContain("技能：短剧资产分批流程 · 1");
    });
    test("名称不可识别时说明已移除，不显示标识", () => {
        const html = render({ ...interrupted, skills: [{ skillId: "352590bd", versionId: "cc4bb169", contentHash: hash }],
            supplementInputs: [{ message: "补充", skills: [{ skillId: "352590bd", versionId: "cc4bb169", contentHash: hash }] }] });
        expect(html).toContain("技能：已移除的技能");
        expect(html).not.toContain("352590bd");
        expect(html).not.toContain("cc4bb169");
    });
});
