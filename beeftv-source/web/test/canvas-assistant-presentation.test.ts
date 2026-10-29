import { describe, expect, test } from "bun:test";

import {
    ASSISTANT_STARTER_PROMPTS,
    ASSISTANT_UNAVAILABLE_FALLBACK,
    assistantActionLabel,
    assistantChangeSummary,
    assistantChangedNodeIds,
    assistantLifecycleText,
    assistantTurnCanContinue,
    assistantFailedActionText,
    assistantProposalText,
    assistantProposalProgress,
    appendAssistantDraft,
    assistantStatusNotice,
    assistantUndoFailureText,
} from "@/pages/canvas/canvas-assistant-copy";
import { ASSISTANT_DEFAULT_WIDTH, ASSISTANT_MAX_WIDTH, ASSISTANT_MIN_WIDTH, clampAssistantWidth, dismissedProposalKey, resolveCanvasRightPanel } from "@/pages/canvas/use-canvas-assistant";
import type { AssistantTurnChange } from "@/services/api/agent-assistant";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";
import { removeCanvasNodes } from "@/lib/canvas/canvas-project-domain";
import { generationTaskMetadata } from "@/lib/canvas/canvas-project-generation";
import type { GenerationTask } from "@/services/api/task-center";

describe("助手不可用原因映射成一句用户语加一个出路", () => {
    test("缺模型和协议不支持都指向模型配置", () => {
        for (const reason of ["model_not_configured", "model_protocol_unsupported"]) {
            const notice = assistantStatusNotice(reason);
            expect(notice.text).toBe("还没有可用的助手模型");
            expect(notice.action).toBe("model-settings");
            expect(notice.actionLabel).toBe("去模型配置");
        }
    });

    test("缺凭据指向去连接", () => {
        const notice = assistantStatusNotice("credential_missing");
        expect(notice.text).toBe("BeefTV 还没连接好");
        expect(notice.action).toBe("model-settings");
    });

    test("正在启动只报告进展，没有按钮，并要求更快复查", () => {
        const notice = assistantStatusNotice("host_starting");
        expect(notice.text).toBe("助手正在启动…");
        expect(notice.action).toBeUndefined();
        expect(notice.starting).toBe(true);
    });

    test("启动失败和连不上都给重试", () => {
        for (const reason of ["host_start_failed", "host_unreachable"]) {
            const notice = assistantStatusNotice(reason);
            expect(notice.text).toBe("助手没有启动成功");
            expect(notice.action).toBe("retry");
        }
    });

    test("原因缺失或还不认识时走兜底，不显示原始值", () => {
        for (const reason of [undefined, "", "something_new_from_backend"]) {
            const notice = assistantStatusNotice(reason);
            expect(notice.text).toBe(ASSISTANT_UNAVAILABLE_FALLBACK);
            expect(notice.text).not.toContain("something_new_from_backend");
        }
    });
});

describe("工具调用翻译成做了什么", () => {
    test("已知操作说人话", () => {
        expect(assistantActionLabel("canvas.nodes.create")).toBe("新建节点");
        expect(assistantActionLabel("canvas.node.update")).toBe("修改节点");
        expect(assistantActionLabel("canvas.timeline.update")).toBe("修改时间线");
        expect(assistantActionLabel("canvas.edge.create")).toBe("连线");
        expect(assistantActionLabel("canvas.get")).toBe("读取画布");
        expect(assistantActionLabel("canvas.search")).toBe("读取画布");
        expect(assistantActionLabel("asset.list")).toBe("读取素材");
        expect(assistantActionLabel("asset.get")).toBe("读取素材");
        expect(assistantActionLabel("media.overview")).toBe("浏览素材");
        expect(assistantActionLabel("media.inspect")).toBe("查看和听取素材");
        expect(assistantActionLabel("media.check")).toBe("检查媒体文件");
    });

    test("没见过的操作也不把内部名字露出去", () => {
        expect(assistantActionLabel("canvas.something.new")).toBe("改动画布");
        expect(assistantActionLabel(undefined)).toBe("改动画布");
    });

    test("失败的那一步说清是哪件事没成", () => {
        expect(assistantFailedActionText({ tool: "canvas.edge.create", isError: true })).toBe("连线没有成功");
    });
});

describe("按轮改动摘要", () => {
    const change = (patch: Partial<AssistantTurnChange>): AssistantTurnChange => ({
        revisionBefore: 1,
        revisionAfter: 2,
        createdNodeIds: [],
        updatedNodeIds: [],
        createdEdgeIds: [],
        ...patch,
    });

    test("只报告真实落地的对象", () => {
        expect(assistantChangeSummary(change({ createdNodeIds: ["a", "b", "c"], createdEdgeIds: ["e1", "e2"] }))).toBe("新建 3 个节点，连了 2 条线");
        expect(assistantChangeSummary(change({ updatedNodeIds: ["a", "b"] }))).toBe("修改 2 个节点");
        expect(assistantChangeSummary(change({ timelineUpdated: true }))).toBe("修改时间线");
        expect(assistantChangeSummary(change({ timelineUpdated: false }))).toBeNull();
    });

    test("没有改动时不出卡片", () => {
        expect(assistantChangeSummary(null)).toBeNull();
        expect(assistantChangeSummary(undefined)).toBeNull();
        expect(assistantChangeSummary(change({}))).toBeNull();
    });

    test("跨画布摘要按全部真实回执计数，定位仍只使用主画布未删除的节点", () => {
        const receipt = change({ createdNodeIds: ["main"], deletedNodeIds: ["gone"], canvasChanges: [
            { ...change({ createdNodeIds: ["main"], deletedNodeIds: ["gone"], deletedEdgeIds: ["edge"] }), canvasId: "c1", operationIds: ["op1"] },
            { ...change({ createdNodeIds: ["other"], updatedNodeIds: ["existing"], timelineUpdated: true }), canvasId: "c2", operationIds: ["op2"] },
        ] });
        expect(assistantChangeSummary(receipt)).toBe("修改了 2 个画布，新建 2 个节点，修改 1 个节点，删除 1 个节点，删除 1 条线，修改时间线");
        expect(assistantChangedNodeIds(receipt)).toEqual(["main"]);
        expect(assistantChangedNodeIds(change({ updatedNodeIds: ["gone", "kept"], deletedNodeIds: ["gone"] }))).toEqual(["kept"]);
        expect(assistantChangeSummary(change({ revisionAfter: 0, canvasChanges: [
            { ...change({ documentUpdated: true }), canvasId: "other", operationIds: ["op3"] },
        ] }))).toBe("修改了 1 个画布，修改画布内容");
    });

    test("定位的对象包含新建和被改过的，且不重复", () => {
        expect(assistantChangedNodeIds(change({ createdNodeIds: ["a"], updatedNodeIds: ["a", "b"] })).sort()).toEqual(["a", "b"]);
        expect(assistantChangedNodeIds(null)).toEqual([]);
    });
});

describe("撤销失败原因映射", () => {
    test("画布又改过之后说明不能直接撤销", () => {
        expect(assistantUndoFailureText("canvas_changed")).toBe("这之后画布又改过，不能直接撤销");
    });

    test("其余原因各有一句话，不出现机器可读值", () => {
        expect(assistantUndoFailureText("already_undone")).toBe("这一轮已经撤销过了");
        expect(assistantUndoFailureText("no_change")).toBe("这一轮没有改动画布");
        expect(assistantUndoFailureText("unknown")).toBe("撤销没有成功，请再试一次");
    });
});

describe("付费生成确认", () => {
    test("整片单图显示将要提交的 Seedream 选项", () => {
        const text = assistantProposalText({ proposalId: "p", kind: "image", nodeIds: ["a"], model: "seedream", modelKey: "custom::seedream", production: { targets: [{ nodeId: "a", title: "首帧", kind: "image", modelKey: "custom::seedream", prompt: "花店", parameters: { count: "1", seedreamOutputFormat: "jpeg", seedreamOptimize: "fast", seedreamWatermark: "true" }, referenceNodeIds: [] }] } });
        expect(text).toContain("图片格式：JPEG");
        expect(text).toContain("提示词优化：快速");
        expect(text).toContain("图片水印：开启");
        expect(text).not.toContain("seedreamOptimize");
    });
    test("说清数量、用哪个模型、谁扣款", () => {
        const text = assistantProposalText({ proposalId: "p1", kind: "image", nodeIds: ["a", "b"], model: "seedream-4", modelKey: "ch::seedream-4", note: "" });
        expect(text).toBe("为 2 个节点生成图片 · seedream-4\n确认后开始，按所选渠道计费。");
        // 不能把带渠道前缀的内部值显示出来。
        expect(text).not.toContain("ch::");
    });

    test("视频提议说的是视频", () => {
        const text = assistantProposalText({ proposalId: "p2", kind: "video", nodeIds: ["a"], model: "seedance-1", modelKey: "ch::seedance-1" });
        expect(text).toContain("为 1 个节点生成视频");
    });
    test("已提交或已结束的卡片不再提示确认生成和计费", () => {
        const text = assistantProposalText({ proposalId: "p2", kind: "video", nodeIds: ["a"], model: "image", modelKey: "ch::image" }, ["报价"], false);
        expect(text).not.toContain("确认后开始");
        expect(text).not.toContain("计费");
        expect(text).not.toContain("报价");
    });

    test("旧真人模型提议显示统一名称与当前渠道报价", () => {
        const text = assistantProposalText({ proposalId: "portrait", kind: "video", nodeIds: ["a"], model: "seedance-2.0-portrait", modelKey: "byok::seedance-2.0-portrait" }, ["720p：无视频输入 ¥69，含视频输入 ¥42 / 百万视频 Token"]);
        expect(text).toContain("Seedance 2.0");
        expect(text).not.toContain("Seedance 2.0-真人");
        expect(text).toContain("¥69");
        expect(text).toContain("¥42");
        expect(text).not.toContain("byok::");
    });
});

describe("生成结果只使用这项提议的真实回执", () => {
    const proposal = { proposalId: "p1", kind: "image" as const, nodeIds: ["source"], model: "image", modelKey: "channel::image" };
    const node = (id: string, metadata: CanvasNodeMetadata = {}): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata });
    const ready = (id: string, patch: CanvasNodeMetadata = {}) => node(id, { taskClientOperationId: "proposal:p1:source", taskId: "task-1", taskStatus: "succeeded", status: "success", storageKey: "resource:ready", ...patch });

    test("已有结果不冒充本次结果，真正的新目标可供检查", () => {
        expect(assistantProposalProgress(proposal, [ready("source", { taskClientOperationId: "older" })]).ready).toBe(false);
        const progress = assistantProposalProgress(proposal, [ready("source", { taskClientOperationId: "older" }), ready("new-result")]);
        expect(progress.ready).toBe(true);
        expect(progress.nodeIds).toEqual(["new-result"]);
    });
    test("上游成功但还没取回不能检查，失败与取消可以主动分析", () => {
        expect(assistantProposalProgress(proposal, [ready("a", { status: "loading", storageKey: undefined })]).ready).toBe(false);
        expect(assistantProposalProgress(proposal, [ready("a", { resourceReloadAvailable: true })]).ready).toBe(false);
        for (const taskStatus of ["failed", "cancelled"]) expect(assistantProposalProgress(proposal, [ready("a", { taskStatus, status: "error", storageKey: undefined })]).ready).toBe(true);
    });
    test("批量等待原始输出全部终态，缺项与未提交不能被成功结果掩盖", () => {
        const root = node("batch", { isBatchRoot: true, batchChildIds: ["a", "b"], generationOutputNodeIds: ["a", "b"] });
        const a = ready("a", { batchRootId: "batch", taskClientOperationId: "proposal:p1:source:0" });
        const b = ready("b", { batchRootId: "batch", taskClientOperationId: "proposal:p1:source:1" });
        expect(assistantProposalProgress(proposal, [root, a]).ready).toBe(false);
        expect(assistantProposalProgress(proposal, [root, a, node("b", { batchRootId: "batch", status: "loading" })]).ready).toBe(false);
        expect(assistantProposalProgress(proposal, [root, a, { ...b, metadata: { ...b.metadata, taskStatus: "running" } }]).ready).toBe(false);
        expect(assistantProposalProgress(proposal, [root, a, b]).nodeIds).toEqual(["a", "b"]);
        expect(assistantProposalProgress(proposal, [root, a, b]).ready).toBe(true);
        const legacyRoot = { ...root, metadata: { ...root.metadata, generationOutputNodeIds: undefined } };
        expect(assistantProposalProgress(proposal, [legacyRoot, a, b]).ready).toBe(false);
        expect(assistantProposalProgress(proposal, [a, b]).ready).toBe(false);
    });
    test("原生多图根节点不重复计数；部分失败保留成功产物", () => {
        const root = ready("batch", { isBatchRoot: true, batchChildIds: ["a", "b"], generationOutputNodeIds: ["a", "b"] });
        const a = ready("a", { batchRootId: "batch" });
        const b = ready("b", { batchRootId: "batch", taskStatus: "failed", status: "error", storageKey: undefined });
        const progress = assistantProposalProgress(proposal, [root, a, b]);
        expect(progress.ready).toBe(true);
        expect(progress.nodeIds).toEqual(["a", "b"]);
        expect(progress.text).toContain("1 个结果已就绪，1 个结果因任务失败");
    });
    test("Seedream 独立输出保存齐全后可检查，缺图或尚未取回时继续等待", () => {
        const root = ready("source", { isBatchRoot: false, taskOutputIndex: 0, generationOutputNodeIds: ["source", "sibling"] });
        const sibling = ready("sibling", { isBatchRoot: false, taskOutputIndex: 1 });
        const progress = assistantProposalProgress(proposal, [root, sibling]);
        expect(progress.ready).toBe(true);
        expect(progress.nodeIds).toEqual(["source", "sibling"]);
        expect(progress.text).toContain("2 个结果已就绪");
        expect(assistantProposalProgress(proposal, [root]).ready).toBe(false);
        expect(assistantProposalProgress(proposal, [root, ready("sibling", { taskStatus: "running" })]).ready).toBe(false);
        expect(assistantProposalProgress(proposal, [root, ready("sibling", { resourceReloadAvailable: true })]).ready).toBe(false);
        expect(assistantProposalProgress(proposal, [root, ready("sibling", { taskClientOperationId: "older" })]).ready).toBe(false);
        expect(assistantProposalProgress(proposal, removeCanvasNodes([root, sibling], new Set(["sibling"])).nodes).ready).toBe(false);
        expect(assistantProposalProgress(proposal, [ready("source", { generationOutputNodeIds: ["source"], isBatchRoot: false })]).ready).toBe(true);
    });
    test("删除运行子项会缩短当前列表，但不会把尚在运行的原批次说成完成", () => {
        const root = node("batch", { isBatchRoot: true, batchChildIds: ["a", "b"], generationOutputNodeIds: ["a", "b"], count: 2 });
        const a = ready("a", { batchRootId: "batch", count: 2, taskClientOperationId: "proposal:p1:source:0" });
        const b = ready("b", { batchRootId: "batch", count: 2, taskStatus: "running", taskClientOperationId: "proposal:p1:source:1" });
        const after = removeCanvasNodes([root, a, b], new Set(["b"])).nodes;
        expect(after.find(item => item.id === "batch")?.metadata?.batchChildIds).toEqual(["a"]);
        expect(after.find(item => item.id === "batch")?.metadata?.generationOutputNodeIds).toEqual(["a", "b"]);
        expect(assistantProposalProgress(proposal, after).ready).toBe(false);
        const editedCount = after.map(item => ({ ...item, metadata: { ...item.metadata, count: 1 } }));
        expect(assistantProposalProgress(proposal, editedCount).ready).toBe(false);
        expect(assistantProposalProgress(proposal, editedCount).text).toContain("无法确认这批结果是否完整");
    });
    test("一个原生任务的三个失败产物按结果计数，不冒称三个任务", () => {
        const metadata = generationTaskMetadata({ id: "one-native-task", clientOperationId: "proposal:p1:source", status: "failed" } as GenerationTask);
        const root = node("batch", { ...metadata, isBatchRoot: true, batchChildIds: ["a", "b", "c"], generationOutputNodeIds: ["a", "b", "c"], count: 3 });
        const children = ["a", "b", "c"].map(id => node(id, { ...metadata, batchRootId: "batch", count: 3, status: "error" }));
        const progress = assistantProposalProgress(proposal, [root, ...children]);
        expect(progress.ready).toBe(true);
        expect(progress.text).toContain("3 个结果因任务失败");
        expect(progress.text).not.toContain("3 个任务");
    });
    test("不串到相似操作编号，不从遗漏的第二个源节点推断全部完成", () => {
        expect(assistantProposalProgress(proposal, [ready("a", { taskClientOperationId: "proposal:p1:source:other" })]).ready).toBe(false);
        expect(assistantProposalProgress({ ...proposal, nodeIds: ["source", "missing"] }, [ready("a")]).ready).toBe(false);
    });
    test("检查要求保留原草稿，连点不重复追加", () => {
        expect(appendAssistantDraft("保留我的结尾\n", "检查生成结果")).toBe("保留我的结尾\n\n\n检查生成结果");
        expect(appendAssistantDraft("保留我的结尾\n\n检查生成结果", "检查生成结果")).toBe("保留我的结尾\n\n检查生成结果");
    });
});

describe("右侧栏位互斥", () => {
    test("版本记录占住栏位时助手不渲染", () => {
        expect(resolveCanvasRightPanel(true, true)).toBe("versions");
        expect(resolveCanvasRightPanel(false, true)).toBe("versions");
    });

    test("只开助手时是助手，两个都没开时栏位是空的", () => {
        expect(resolveCanvasRightPanel(true, false)).toBe("assistant");
        expect(resolveCanvasRightPanel(false, false)).toBeNull();
    });
});

describe("官方生命周期进度", () => {
    test("媒体工具显示真实进行中的工作，结束不伪造已成功", () => {
        expect(assistantLifecycleText({ phase: "tool", toolName: "media_overview" })).toBe("正在读取素材概要。");
        expect(assistantLifecycleText({ phase: "tool", toolName: "media_inspect" })).toBe("正在检查选定素材。");
        expect(assistantLifecycleText({ phase: "tool", toolName: "media_check" })).toBe("正在检查黑屏、音轨和文件信息。");
        expect(assistantLifecycleText({ phase: "tool", toolName: "unknown_tool" })).toBeNull();
        expect(assistantLifecycleText({ phase: "tool_end", toolName: "media_check" })).not.toContain("已检查");
        expect(assistantLifecycleText({ phase: "tool_end", toolName: "media_check", success: false })).not.toContain("已检查");
        expect(assistantLifecycleText({ phase: "tool_end", toolName: "media_check", success: true })).toBe("已检查媒体文件信息，正在继续制作。");
    });
    test("制作操作显示进行中和已确认的完成状态，不暴露工具名", () => {
        expect(assistantLifecycleText({ phase: "tool", toolName: "canvas_node_configure" })).toBe("正在配置生成参数。");
        expect(assistantLifecycleText({ phase: "tool_end", toolName: "canvas.node.configure", success: true })).toBe("已配置生成参数，正在继续制作。");
        expect(assistantLifecycleText({ phase: "tool_end", toolName: "canvas_timeline_render", success: true })).toBe("已提交成片合成，正在继续制作。");
        expect(assistantLifecycleText({ phase: "tool_end", toolName: "unknown_tool", success: true })).toBeNull();
    });
    test("压缩和重试各用一句完整的话，结束事件不再显示进度", () => {
        expect(assistantLifecycleText({ phase: "compaction" })).toBe("正在整理对话内容，方便继续。");
        expect(assistantLifecycleText({ phase: "business", stage: "saving", saved: 2, total: 3 })).toBe("生成已有结果，正在保存文件。 2/3 个任务的结果已保存。");
        expect(assistantLifecycleText({ phase: "business", stage: "binding" })).toBe("文件已保存，正在更新画布。");
        expect(assistantLifecycleText({ phase: "business", stage: "exporting" })).toBe("视频已可用，正在导出可编辑工程。");
        expect(assistantLifecycleText({ phase: "business", stage: "observation_unavailable" })).not.toContain("重新生成");
        expect(assistantLifecycleText({ phase: "business", stage: "saving", saved: 9, total: 3 })).not.toContain("9/3");
        expect(assistantLifecycleText({ phase: "retry" })).toBe("模型暂时没响应，正在再试一次。");
        expect(assistantLifecycleText({ phase: "compaction_end" })).toBeNull();
        expect(assistantLifecycleText({ phase: "retry_end" })).toBeNull();
        expect(assistantLifecycleText({ phase: "compaction" })).not.toContain("compaction");
        expect(assistantLifecycleText({ phase: "retry" })).not.toContain("retry");
    });
});

describe("中断后继续的范围", () => {
    test("阶段中断和模型响应失败提供继续要求入口，永久配置问题不重试", () => {
        for (const reason of ["turn_timeout", "turn_interrupted", "model_request_failed", "turn_request_budget_exhausted", "turn_tool_step_budget_exhausted"]) {
            expect(assistantTurnCanContinue(reason)).toBe(true);
        }
        for (const reason of ["request_budget_exhausted", "request_budget_storage_unavailable", "forbidden", "credential_missing", undefined]) {
            expect(assistantTurnCanContinue(reason)).toBe(false);
        }
    });
});

describe("停靠宽度", () => {
    test("越界宽度被收回可用范围", () => {
        expect(clampAssistantWidth(10)).toBe(ASSISTANT_MIN_WIDTH);
        expect(clampAssistantWidth(9999)).toBe(ASSISTANT_MAX_WIDTH);
        expect(clampAssistantWidth(Number.NaN)).toBe(ASSISTANT_DEFAULT_WIDTH);
        expect(clampAssistantWidth(420)).toBe(420);
    });
});

describe("空态起步提示", () => {
    test("四条都是短剧创作能直接用的一句话", () => {
        expect(ASSISTANT_STARTER_PROMPTS).toHaveLength(4);
        for (const prompt of ASSISTANT_STARTER_PROMPTS) {
            expect(prompt.length).toBeGreaterThan(5);
            expect(prompt.length).toBeLessThan(20);
        }
    });
});

describe("生成提议的两种结果不会互相冒充", () => {
    test("同意与谢绝各记一个键", () => {
        expect(dismissedProposalKey("p1")).toBe("p1:skipped");
        const decided = new Set(["p1", dismissedProposalKey("p2")]);
        expect(decided.has("p1")).toBe(true);
        expect(decided.has(dismissedProposalKey("p1"))).toBe(false);
        expect(decided.has("p2")).toBe(false);
        expect(decided.has(dismissedProposalKey("p2"))).toBe(true);
    });
});

describe("assistantVisibleReply", () => {
    test("去掉闭合与未闭合的思考片段", async () => {
        const { assistantVisibleReply } = await import("@/pages/canvas/canvas-assistant-copy");
        expect(assistantVisibleReply("<think>先想想</think>\n已经建好三个镜头。")).toBe("已经建好三个镜头。");
        expect(assistantVisibleReply("已完成<think>还在写")).toBe("已完成");
        expect(assistantVisibleReply("<think>只有草稿")).toBe("");
    });

    test("正文里的 thinking 标记不显示，代码示例和普通答复保留", async () => {
        const { assistantVisibleReply } = await import("@/pages/canvas/canvas-assistant-copy");
        expect(assistantVisibleReply("<thinking>先核对节点</thinking>\n已为这个节点登记提议。")).toBe("已为这个节点登记提议。");
        expect(assistantVisibleReply("<thinking>English draft.这是一段超过八个字的中文草稿。\n\n另一段中文仍然属于思考。")).toBe("");
        expect(assistantVisibleReply("<thinking>English draft.这是一段超过八个字的中文草稿。</thinking>")).toBe("");
        expect(assistantVisibleReply("我先读取画布。\n<thinking>The node state is unchanged")).toBe("我先读取画布。");
        expect(assistantVisibleReply("<thinking>The node state is unchanged")).toBe("");
        expect(assistantVisibleReply("已改好<thinking")).toBe("已改好");
        expect(assistantVisibleReply("<thinking>已改好三个镜头，可以继续。</thinking>")).toBe("");
        const example = "示例：\n```\n<thinking>keep this</thinking>\n<think>also keep</think>\n```\n正文还在";
        expect(assistantVisibleReply(example)).toBe(example);
        expect(assistantVisibleReply("标签 `<thinking>` 只是示例")).toBe("标签 `<thinking>` 只是示例");
        expect(assistantVisibleReply("准备生成没有成功")).toBe("准备生成没有成功");
        expect(assistantVisibleReply("The canvas is unchanged. 我只读取了画布，没有改动。")).toBe("The canvas is unchanged. 我只读取了画布，没有改动。");
        expect(assistantVisibleReply(assistantVisibleReply("<thinking>draft</thinking>\n已核对。"))).toBe("已核对。");
    });

    test("每个流式前缀都不会漏出标签或未闭合思考", async () => {
        const { assistantVisibleReply } = await import("@/pages/canvas/canvas-assistant-copy");
        for (const tag of ["think", "thinking", "THINKING"]) {
            const hidden = `<${tag}>English draft.中文草稿超过八个字。</${tag}>`;
            for (let length = 1; length <= hidden.length; length += 1) {
                expect(assistantVisibleReply(`正文${hidden.slice(0, length)}`)).toBe("正文");
            }
            expect(assistantVisibleReply(`正文${hidden}Final answer. 最终答复。`)).toBe("正文Final answer. 最终答复。");
        }
        expect(assistantVisibleReply("正文 <thing")).toBe("正文 <thing");
    });

    test("代码示例不改变标签状态，思考中的代码也隐藏", async () => {
        const { assistantVisibleReply } = await import("@/pages/canvas/canvas-assistant-copy");
        for (const code of [
            "`<thinking>示例</thinking>`",
            "``<think>含 ` 单个反引号</think>``",
            "`````\n```xml\n<thinking>嵌套围栏示例</thinking>\n```\n`````",
            "`` 含 ``` 和 <thinking> 的示例 ``",
            "```xml\n<thinking>示例</thinking>\n```",
            "~~~xml\n<think>示例</think>\n~~~",
            "```\n<thinking>未闭合示例",
        ]) {
            expect(assistantVisibleReply(`示例：\n${code}`)).toBe(`示例：\n${code}`);
        }
        const draft = "<thinking>草稿 `</thinking>` 仍是草稿\n```\n<think>代码示例</think>\n```\n继续思考";
        expect(assistantVisibleReply(`前言${draft}`)).toBe("前言");
        expect(assistantVisibleReply(`${draft}</thinking>已完成。`)).toBe("已完成。");
        expect(assistantVisibleReply("<thinking>外层<think>内层</think>仍是草稿</thinking>正文")).toBe("正文");
    });
});

describe("assistantUnresolvedFailures", () => {
    test("整片不支持的 Seedream 组合直接显示出路，不依赖助手复述错误", async () => {
        const { assistantUnresolvedFailures } = await import("@/pages/canvas/canvas-assistant-copy");
        const failed = { tool: "canvas.generation.propose", args: { nodeIds: ["image"] }, isError: true, error: "production_seedream_multiple_outputs: server detail must not be shown" };
        expect(assistantUnresolvedFailures([failed])).toEqual(["整片制作暂不支持 Seedream 图层拆分或组图。请先在画布生成图片，再用已有图片继续制作。"]);
        expect(assistantUnresolvedFailures([failed, { ...failed, isError: false }])).toEqual([]);
        expect(assistantUnresolvedFailures([{ ...failed, error: "another_error: private detail" }])).toEqual(["准备生成没有成功"]);
    });
    test("同一素材 overview 补齐资源重试成功不留下误报，其他素材仍报告", async () => {
        const { assistantUnresolvedFailures } = await import("@/pages/canvas/canvas-assistant-copy");
        for (const tool of ["media.overview", "media_overview"]) {
            const failed = { tool, args: { canvasId: "canvas", nodeId: "video" }, isError: true };
            const success = { tool, args: { resourceId: "resource", nodeId: "video", canvasId: "canvas" }, isError: false };
            expect(assistantUnresolvedFailures([failed, success])).toEqual([]);
            expect(assistantUnresolvedFailures([failed, { ...success, args: { ...success.args, nodeId: "other" } }])).toEqual(["浏览素材没有成功"]);
            expect(assistantUnresolvedFailures([failed, { ...success, args: { ...success.args, startMs: 1000 } }])).toEqual(["浏览素材没有成功"]);
            expect(assistantUnresolvedFailures([failed, { ...success, tool: "media_inspect" }])).toEqual(["浏览素材没有成功"]);
            expect(assistantUnresolvedFailures([{ ...failed, args: { ...failed.args, resourceId: "old" } }, success])).toEqual(["浏览素材没有成功"]);
        }
    });
    test("媒体工具仍未成功时如实报告，后来成功则不留下旧失败", async () => {
        const { assistantUnresolvedFailures } = await import("@/pages/canvas/canvas-assistant-copy");
        const failed = { tool: "media.inspect", args: { nodeId: "a", start: 2, end: 4 }, isError: true };
        expect(assistantUnresolvedFailures([failed])).toEqual(["有素材的画面查看未完成"]);
        expect(assistantUnresolvedFailures([failed, { ...failed, isError: false }])).toEqual([]);
    });
    test("图片 inspect 失败不冒充另两个素材的原生视频和音频失败，overview 不清掉失败", async () => {
        const { assistantUnresolvedFailures } = await import("@/pages/canvas/canvas-assistant-copy");
        const failed = { tool: "media.inspect", args: { assetId: "image", mode: "frames" }, isError: true, error: "media_version_required" };
        const calls = [
            failed,
            { tool: "media.overview", args: { assetId: "image" }, isError: false },
            { tool: "media.inspect", args: { assetId: "video", mode: "video", startMs: 0, endMs: 3000, expectedVersion: "video-version" }, isError: false },
            { tool: "media.inspect", args: { assetId: "audio", mode: "audio", startMs: 0, endMs: 6611, expectedVersion: "audio-version" }, isError: false },
        ];
        expect(assistantUnresolvedFailures(calls)).toEqual(["有素材的画面查看未完成"]);
        expect(calls[0]).toEqual(failed);
        expect(assistantUnresolvedFailures(calls.map(call => ({ ...call, tool: call.tool.replace(".", "_") })))).toEqual(["有素材的画面查看未完成"]);
    });
    test("失败媒体按实际模式提示，并保留其它素材、区间及版本的失败", async () => {
        const { assistantUnresolvedFailures } = await import("@/pages/canvas/canvas-assistant-copy");
        const failed = { tool: "media.inspect", args: { assetId: "video", mode: "video", startMs: 0, endMs: 3000, expectedVersion: "v1" }, isError: true };
        for (const args of [{ ...failed.args, assetId: "other" }, { ...failed.args, endMs: 6000 }, { ...failed.args, expectedVersion: "v2" }]) {
            expect(assistantUnresolvedFailures([failed, { ...failed, args, isError: false }])).toEqual(["有视频片段查看未完成"]);
        }
        expect(assistantUnresolvedFailures([failed, { ...failed, isError: false }])).toEqual([]);
        expect(assistantUnresolvedFailures([{ tool: "media_inspect", args: { mode: "audio" }, isError: true }])).toEqual(["有音频片段听取未完成"]);
    });
    test("重试成功的步骤不提示，仍失败的同类合并计数", async () => {
        const { assistantUnresolvedFailures } = await import("@/pages/canvas/canvas-assistant-copy");
        const calls = [
            { tool: "canvas.node.update", args: { nodeId: "a" }, isError: true },
            { tool: "canvas.node.update", args: { nodeId: "b" }, isError: true },
            { tool: "canvas.node.update", args: { nodeId: "a" }, isError: false },
            { tool: "canvas.edge.create", args: { fromNodeId: "a", toNodeId: "c" }, isError: true },
            { tool: "canvas.edge.create", args: { fromNodeId: "b", toNodeId: "c" }, isError: true },
            { tool: "canvas.get", args: {}, isError: true },
        ];
        expect(assistantUnresolvedFailures(calls)).toEqual(["修改节点没有成功", "连线没有成功（2 处）"]);
        expect(assistantUnresolvedFailures([])).toEqual([]);
    });
});
