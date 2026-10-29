import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasAssistantTurnView } from "@/pages/canvas/canvas-assistant-turn";
import { CanvasAssistantPlan } from "@/pages/canvas/canvas-assistant-sidebar";
import type { AssistantTurn } from "@/services/api/agent-assistant";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const source = { resourceId: "resource-1", version: "a".repeat(64), startMs: 5000, endMs: 12000 };
const call = (mode: string, overrides = {}) => ({ tool: mode === "check" ? "media.check" : "media.inspect", isError: false,
    mediaFacts: { source, mode, durationMs: 18000, hasAudio: true, ...overrides } });
function render(calls: unknown[], reply = "", nodes?: CanvasNodeData[]) {
    const turn = JSON.parse(JSON.stringify({ turnId: "turn", userText: "检查现有成片", selectedNodeIds: [], reply, toolCalls: calls, change: null,
        proposals: [], error: null, cancelled: false, createdAt: "2026-10-19" })) as AssistantTurn;
    return renderToStaticMarkup(<CanvasAssistantTurnView turn={turn} nodes={nodes} handledProposals={new Set()} onLocate={() => {}} onUndo={() => {}} onRunProposal={() => {}} onDismissProposal={() => {}} />);
}

test("actual turn displays exact read intervals and full-interval silence independently of assistant prose", () => {
    const html = render([call("video"), call("audio"), call("audio", { source: { ...source, startMs: 12000, endMs: 18000 } }),
        call("check", { source: { ...source, startMs: 0, endMs: 18000 }, silenceIntervals: [{ startMs: 0, endMs: 18000 }], meanDb: -91, peakDb: -91 })], "整片已检查，1280×720");
    expect(html).toContain('aria-label="媒体检查记录"');
    expect(html).toContain("视频片段读取：5–12 秒");
    expect(html).toContain("音频片段读取：12–18 秒");
    expect(html).toContain("客观检测：0–18 秒");
    expect(html).toContain("该检测区间全段静音");
    expect(html).toContain("平均音量：-91 dB");
    expect(html).toContain("全长 18 秒");
    const facts = html.slice(html.indexOf('aria-label="媒体检查记录"'));
    expect(facts).not.toContain("1280");
    expect(facts).not.toContain("质量合格");
    expect(facts).not.toContain("检查失败");
});

test("different resources and versions remain separate; partial silence and frames do not imply a whole review", () => {
    const html = render([call("video"), call("audio", { source: { ...source, version: "b".repeat(64) } }),
        call("check", { source: { ...source, resourceId: "resource-2", startMs: 0, endMs: 18000 }, silenceIntervals: [{ startMs: 5000, endMs: 12000 }] }), call("frames")]);
    expect(html.match(/data-media-fact-group=/g)).toHaveLength(3);
    expect(html).toContain("检查记录 2");
    expect(html).toContain("检查记录 3");
    expect(html).not.toContain("版本 2");
    expect(html).toContain("静音区间：5–12 秒");
    expect(html).toContain("静态抽帧区间：5–12 秒");
    expect(html).not.toContain("全段静音");
});

test("node identity supplies only a readable name, never current media facts", () => {
    const html = render([call("video", { source: { ...source, nodeId: "final" } })], "", [{ id: "final", title: "清晨的面包香", type: CanvasNodeType.Video,
        position: { x: 0, y: 0 }, width: 300, height: 200, metadata: { storageKey: "resource:newer-video", durationMs: 90000 } }]);
    expect(html).toContain("清晨的面包香 · 检查记录 1");
    expect(html).toContain("全长 18 秒");
    expect(html).not.toContain("90 秒");
});

test("failed, unrelated and old tool records never invent checks", () => {
    for (const calls of [[{ ...call("video"), isError: true }], [{ ...call("video"), tool: "canvas.get" }],
        [{ tool: "media.inspect", args: { mode: "video", startMs: 0, endMs: 18000 }, isError: false }]]) {
        expect(render(calls)).not.toContain('aria-label="媒体检查记录"');
    }
});

test("a full plan shows step progress without declaring quality accepted", () => {
    const html = renderToStaticMarkup(<CanvasAssistantPlan plan={{ goal: "有声成片", items: [{ id: "review", title: "检查", status: "done" }], done: 1, total: 1, updatedAt: "now" }} />);
    expect(html).toContain("步骤进度 · 1/1");
    expect(html).not.toContain("制作计划 · 已完成");
});

test("one overview retains every actual evidence item in the same resource group", () => {
    const bundle = { tool: "media.overview", isError: false, mediaEvidence: [call("frames").mediaFacts,
        call("video").mediaFacts, call("audio").mediaFacts, call("check", { meanDb: -18 }).mediaFacts] };
    const html = render([bundle]);
    expect(html.match(/data-media-fact-group=/g)).toHaveLength(1);
    for (const label of ["静态抽帧区间", "视频片段读取", "音频片段读取", "客观检测"]) expect(html).toContain(label);
    expect(html).toContain("平均音量：-18 dB");
    expect(render([{ ...bundle, isError: true }])).not.toContain('aria-label="媒体检查记录"');
});
