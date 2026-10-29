// 助手面板里所有用户可见文案的唯一来源：机器可读原因、操作名和改动摘要都在这里
// 翻译成用户语。组件只负责排版，不自己拼文案，避免同一种状态在两处写出两句话。
import type { AgentLifecycleEvent, AgentToolCall, AssistantGenerationProposal, AssistantSkillSelection, AssistantTurnChange, AssistantUndoFailure } from "@/services/api/agent-assistant";
import { seedancePortraitLabel } from "@/lib/seedance-portrait";
import type { CanvasNodeData } from "@/types/canvas";

export type AssistantStatusAction = "model-settings" | "retry";

export type AssistantStatusNotice = {
    text: string;
    actionLabel?: string;
    action?: AssistantStatusAction;
    /** 正在启动时要更频繁地复查状态，其余情况按常规节奏。 */
    starting?: boolean;
};

/** 兜底文案：原因缺失或后端给了我们还不认识的值时用这一句。 */
export const ASSISTANT_UNAVAILABLE_FALLBACK = "助手暂时用不了，请稍后再试";

export function assistantStatusNotice(reason: string | undefined): AssistantStatusNotice {
    switch (reason) {
        case "model_not_configured":
        case "model_protocol_unsupported":
            return { text: "还没有可用的助手模型", actionLabel: "去模型配置", action: "model-settings" };
        case "credential_missing":
            return { text: "BeefTV 还没连接好", actionLabel: "去连接", action: "model-settings" };
        case "host_starting":
            return { text: "助手正在启动…", starting: true };
        case "host_start_failed":
        case "host_unreachable":
            return { text: "助手没有启动成功", actionLabel: "重试", action: "retry" };
        default:
            return { text: ASSISTANT_UNAVAILABLE_FALLBACK, actionLabel: "重试", action: "retry" };
    }
}

/** 工具名是内部标识，用户只该看到「做了什么」。 */
export function assistantActionLabel(tool: string | undefined): string {
    const name = (tool || "").trim();
    if (name.startsWith("asset.")) return "读取素材";
    switch (name) {
        case "media.overview":
        case "media_overview":
            return "浏览素材";
        case "media.inspect":
        case "media_inspect":
            return "查看和听取素材";
        case "media.check":
        case "media_check":
            return "检查媒体文件";
        case "canvas.nodes.create":
            return "新建节点";
        case "canvas.node.update":
            return "修改节点";
        case "canvas.timeline.update":
            return "修改时间线";
        case "canvas.edge.create":
            return "连线";
        case "canvas.get":
        case "canvas.search":
            return "读取画布";
        case "canvas.generation.propose":
            return "准备生成";
        case "canvas.generation.submit":
            return "生成素材";
        case "canvas.project.export":
            return "导出工程";
        default:
            return "改动画布";
    }
}

/** 失败的那一步用一句话说清楚是哪件事没成。 */
export function assistantFailedActionText(call: AgentToolCall): string {
    return `${assistantActionLabel(call.tool)}没有成功`;
}

/**
 * 这一轮改了什么：只数真实落地的对象，不复述用户的选择数量。
 * 没有任何改动时返回 null，卡片整块不出现。
 */
export function assistantChangeSummary(change: AssistantTurnChange | null | undefined): string | null {
    if (!change) return null;
    const parts: string[] = [];
    const changes = change.canvasChanges?.length ? change.canvasChanges : [change];
    if (change.canvasChanges?.length) parts.push(`修改了 ${new Set(change.canvasChanges.map(item => item.canvasId)).size} 个画布`);
    const created = changes.reduce((total, item) => total + (item.createdNodeIds?.length ?? 0), 0);
    const updated = changes.reduce((total, item) => total + (item.updatedNodeIds?.length ?? 0), 0);
    const deleted = changes.reduce((total, item) => total + (item.deletedNodeIds?.length ?? 0), 0);
    const edges = changes.reduce((total, item) => total + (item.createdEdgeIds?.length ?? 0), 0);
    const deletedEdges = changes.reduce((total, item) => total + (item.deletedEdgeIds?.length ?? 0), 0);
    if (created > 0) parts.push(`新建 ${created} 个节点`);
    if (updated > 0) parts.push(`修改 ${updated} 个节点`);
    if (deleted > 0) parts.push(`删除 ${deleted} 个节点`);
    if (edges > 0) parts.push(`连了 ${edges} 条线`);
    if (deletedEdges > 0) parts.push(`删除 ${deletedEdges} 条线`);
    if (changes.some(item => item.timelineUpdated)) parts.push("修改时间线");
    if (changes.some(item => item.documentUpdated)) parts.push("修改画布内容");
    if (!parts.length) return null;
    return parts.join("，");
}

/** 改动卡片要定位的对象：新建的和被改过的都算。 */
export function assistantChangedNodeIds(change: AssistantTurnChange | null | undefined): string[] {
    if (!change) return [];
    const ids = new Set<string>();
    const deleted = new Set(change.deletedNodeIds || []);
    for (const id of change.createdNodeIds || []) if (!deleted.has(id)) ids.add(id);
    for (const id of change.updatedNodeIds || []) if (!deleted.has(id)) ids.add(id);
    return [...ids];
}

export function assistantUndoFailureText(failure: AssistantUndoFailure): string {
    switch (failure) {
        case "canvas_changed":
            return "这之后画布又改过，不能直接撤销";
        case "already_undone":
            return "这一轮已经撤销过了";
        case "no_change":
            return "这一轮没有改动画布";
        default:
            return "撤销没有成功，请再试一次";
    }
}

/** 提议可能来自自建渠道，不能把所有费用都归到 BeefAPI。 */
export function assistantProposalText(proposal: AssistantGenerationProposal, priceLines: string[] = [], awaitingConfirmation = true): string {
    const count = proposal.nodeIds?.length ?? 0;
    if (proposal.production) {
        const targets = proposal.production.targets;
        const images = targets.filter(t => t.kind === "image").length;
        const videos = targets.filter(t => t.kind === "video");
        const audio = targets.filter(t => t.kind === "audio");
        const labels: Record<string,string> = {size:"画幅",quality:"质量",vquality:"分辨率",seconds:"时长（秒）",generateAudio:"生成声音",audioVoice:"音色",audioSpeed:"语速",audioFormat:"音频格式",audioInstructions:"朗读指令",transparentBackground:"透明背景",watermark:"水印",seedreamOutputFormat:"图片格式",seedreamOptimize:"提示词优化",seedreamWatermark:"图片水印"};
        const lines = [`整片制作方案：${images} 张图片、${videos.length} 段视频、${audio.length} 段配音`, ...targets.map(t => {
            const params = Object.entries(t.parameters).filter(([key]) => labels[key]).map(([key,value]) => {
                const display = key === "seedreamOptimize" ? (value === "standard" ? "标准" : value === "fast" ? "快速" : value)
                    : key === "seedreamWatermark" ? (value === "true" ? "开启" : "关闭")
                    : key === "seedreamOutputFormat" ? value.toUpperCase() : value;
                return `${labels[key]}：${display}`;
            }).join(" · ");
            const refs = t.referenceNodeIds.map(id => targets.find(item => item.nodeId === id)?.title || "已有参考素材");
            return `${t.title} · ${t.modelKey.split("::").pop()} · ${t.parameters.count || "1"} 个\n${params}${refs.length ? `\n参考：${refs.join("、")}` : ""}\n${t.kind === "audio" ? "台词" : "提示词"}：${t.prompt}`;
        })];
        return lines.join("\n\n") + (awaitingConfirmation ? "\n\n确认后按此方案生成素材，并自动完成声音、字幕和剪辑。素材按所选渠道计费；失败后确认新方案重新生成也会重新计费，新增或修改生成内容时会重新确认。" : "");
    }
    const target = proposal.kind === "video" ? "视频" : proposal.kind === "audio" ? "音频" : "图片";
    const title = `为 ${count} 个节点生成${target} · ${seedancePortraitLabel(proposal.model) || proposal.model}`;
    return awaitingConfirmation ? `${title}\n${priceLines.length ? priceLines.join("\n") + "\n" : ""}确认后开始，按所选渠道计费。` : title;
}

/** Match the submitted proposal, including fan-out images; old results on the source node are not receipts. */
export function assistantProposalProgress(proposal: AssistantGenerationProposal, nodes: CanvasNodeData[]) {
    const byId = new Map(nodes.map(node => [node.id, node]));
    const outputs = new Map<string, CanvasNodeData>();
    let unknown = false, batchUnverified = false, planned = 0;
    for (const sourceId of new Set(proposal.production?.targets.map(t => t.nodeId) || proposal.nodeIds)) {
        const operationId = `proposal:${proposal.proposalId}:${sourceId}`;
        const matches = (node: CanvasNodeData) => {
            const actual = node.metadata?.taskClientOperationId || "";
            return actual === operationId || (actual.startsWith(`${operationId}:`) && /^\d+$/.test(actual.slice(operationId.length + 1)));
        };
        const matched = nodes.filter(matches);
        if (!matched.length) { if (proposal.production) planned++; else unknown = true; continue; }
        const roots = new Set(matched.flatMap(node => (node.metadata?.isBatchRoot || node.metadata?.generationOutputNodeIds?.includes(node.id)) ? [node.id] : node.metadata?.batchRootId ? [node.metadata.batchRootId] : []));
        if (roots.size) {
            for (const rootId of roots) {
                const root = byId.get(rootId);
                // Layout children and count are editable; only the original submission
                // targets can establish that every output has reached a terminal state.
                const expected = root?.metadata?.generationOutputNodeIds;
                const children = expected?.length ? expected : root?.metadata?.batchChildIds;
                if (!expected?.length) { unknown = true; batchUnverified = true; }
                if (!children?.length) { unknown = true; batchUnverified = true; continue; }
                for (const childId of children) {
                    const child = byId.get(childId);
                    if (!child || !matches(child)) { unknown = true; batchUnverified = true; continue; }
                    outputs.set(child.id, child);
                }
            }
        } else {
            // Indexed submissions without their batch root cannot tell us the expected count.
            if (matched.length !== 1 || matched[0].metadata?.taskClientOperationId !== operationId) unknown = true;
            for (const node of matched) outputs.set(node.id, node);
        }
    }
    let complete = 0, failed = 0, pending = planned, retrieving = 0;
    for (const node of outputs.values()) {
        const meta = node.metadata || {};
        if (meta.taskStatus === "failed" || meta.taskStatus === "cancelled") failed++;
        else if (meta.taskStatus === "succeeded") {
            if (meta.status === "success" && (meta.content || meta.storageKey) && !meta.resourceReloadAvailable) complete++;
            else retrieving++;
        } else if (meta.taskStatus === "queued" || meta.taskStatus === "running" || meta.generationSubmissionState === "submitting") pending++;
        else unknown = true;
    }
    const ready = !unknown && outputs.size > 0 && pending === 0 && retrieving === 0;
    const visibleResults = failed ? `${complete} 个结果已就绪，${failed} 个结果因任务失败或取消而未生成。` : `${complete}/${outputs.size} 个可见结果已就绪。`;
    const text = unknown ? batchUnverified ? `${visibleResults} 无法确认这批结果是否完整。可在画布选择已就绪结果发给助手检查。` : "部分生成状态待确认，请查看任务列表。"
        : pending ? `生成中，${complete}/${outputs.size + planned} 个结果已就绪。`
        : retrieving ? `${complete}/${outputs.size} 个结果已就绪，其余结果还不可用。请查看节点上的取回提示。`
        : failed ? `${complete} 个结果已就绪，${failed} 个结果因任务失败或取消而未生成。`
        : proposal.production ? `${complete} 个素材已保存，后续制作与交付进度见助手消息。` : `${complete} 个结果已就绪，可以请助手检查。`;
    return { ready, text, nodeIds: [...outputs.keys()] };
}

export const ASSISTANT_CHECK_RESULTS_PROMPT = "检查这次生成的结果是否符合对应分镜要求，再继续不需要我确认的步骤。先查看已有产物，保留成功结果；如果有失败，说明原因和调整建议，不要重复提交已开始的生成任务。";

export function appendAssistantDraft(draft: string, prompt: string) {
    if (draft.includes(prompt)) return draft;
    return draft.trim() ? `${draft}\n\n${prompt}` : prompt;
}

export const ASSISTANT_STARTER_PROMPTS = [
    "把剧本拆成分镜草案",
    "给选中的镜头补充景别和情绪",
    "整理画布并按顺序连线",
    "检查哪些镜头还缺参考图",
];

const ASSISTANT_TOOL_ACTIVITY: Record<string, [string, string]> = {
    media_overview: ["正在读取素材概要。", "已读取素材概要"],
    media_inspect: ["正在检查选定素材。", "已读取选定素材"],
    media_check: ["正在检查黑屏、音轨和文件信息。", "已检查媒体文件信息"],
    canvas_get: ["正在读取画布。", "已读取画布"],
    model_catalog: ["正在查看可用模型和报价。", "已读取模型目录"],
    canvas_nodes_create: ["正在创建画布节点。", "已创建画布节点"],
    canvas_node_configure: ["正在配置生成参数。", "已配置生成参数"],
    canvas_node_update: ["正在更新画布内容。", "已更新画布内容"],
    canvas_edge_create: ["正在连接参考素材。", "已连接参考素材"],
    canvas_script_rows_append: ["正在编排分镜。", "已编排分镜"],
    canvas_script_row_update: ["正在更新分镜。", "已更新分镜"],
    canvas_timeline_update: ["正在安排剪辑时间线。", "已保存剪辑时间线"],
    canvas_timeline_render: ["正在提交成片合成。", "已提交成片合成"],
    canvas_timeline_deliver: ["正在合成视频并保存可编辑工程。", "已完成交付操作"],
    canvas_generation_propose: ["正在准备生成方案。", "已准备生成方案"],
};

/** 只显示官方活动和已核对的操作回执，不把工具完成等同于创作质量验收。 */
export function assistantLifecycleText(event: Pick<AgentLifecycleEvent, "phase" | "toolName" | "success" | "stage" | "saved" | "total"> | string | null | undefined): string | null {
    const phase = typeof event === "string" ? event : event?.phase;
    switch (phase) {
        case "business": {
            if (!event || typeof event === "string") return null;
            const count = Number.isSafeInteger(event.total) && event.total! > 0 && event.total! <= 1000 &&
                Number.isSafeInteger(event.saved) && event.saved! >= 0 && event.saved! <= event.total!
                ? ` ${event.saved}/${event.total} 个任务的结果已保存。` : "";
            switch (event.stage) {
                case "processing": return `正在生成素材。${count}`;
                case "downloading": return `正在取回生成结果。${count}`;
                case "saving": return `生成已有结果，正在保存文件。${count}`;
                case "saved": return "文件已保存，正在继续处理。";
                case "binding": return "文件已保存，正在更新画布。";
                case "rendering": return "正在合成视频。";
                case "exporting": return "视频已可用，正在导出可编辑工程。";
                case "checking": return "正在检查时间线。";
                case "observation_unavailable": return "原任务已保留，进度暂时无法读取。";
                default: return null;
            }
        }
        case "tool": case "tool_end": {
            const tool = typeof event === "string" ? "" : event?.toolName?.replaceAll(".", "_") || "";
            const activity = ASSISTANT_TOOL_ACTIVITY[tool];
            if (!activity) return null;
            if (phase === "tool") return activity[0];
            return typeof event !== "string" && event?.success === true
                ? `${activity[1]}，正在继续制作。` : "正在核对操作结果，继续处理。";
        }
        case "compaction":
            return "正在整理对话内容，方便继续。";
        case "retry":
            return "模型暂时没响应，正在再试一次。";
        default:
            return null;
    }
}

/** 这里只提供继续对话入口，不重发原请求，也不保证后台任务已恢复。 */
export function assistantTurnCanContinue(reason: string | null | undefined): boolean {
    return ["turn_timeout", "turn_interrupted", "turn_request_budget_exhausted", "turn_tool_step_budget_exhausted", "model_request_failed", "model_error", "provider_error"].includes(reason || "");
}

export const ASSISTANT_CONTINUE_PROMPT = "继续完成上一条要求。先检查当前画布和已经完成的操作，保留已有结果；不要重复创建节点或重新提交已开始的生成任务。";
export const ASSISTANT_UNDONE_INCOMPLETE_TEXT = "这一轮未完成，已经产生的画布改动已撤销。";

const REASONING_TAG_PREFIXES = ["</thinking>", "<thinking>", "</think>", "<think>"];

function stripDanglingReasoningTag(text: string) {
    const start = text.lastIndexOf("<");
    return start >= 0 && REASONING_TAG_PREFIXES.some((tag) => tag.startsWith(text.slice(start).toLowerCase()))
        ? text.slice(0, start) : text;
}

/**
 * 官方会话把推理放在独立的 thinking 块里，不进入回复。
 * 有的模型仍把 <thinking> 或 <think> 直接写进正文；那是草稿，不是给用户的话。
 * 代码示例里的同名标记保留。未闭合的思考区块隐藏到正文末尾，不猜测答案起点。
 */
export function assistantVisibleReply(text: string): string {
    const tokens = /`+|~{3,}|<\/?(?:think|thinking)>/gi;
    const reasoning: string[] = [];
    let output = "";
    let index = 0;
    for (let token = tokens.exec(text); token; token = tokens.exec(text)) {
        if (!reasoning.length) output += text.slice(index, token.index);
        const marker = token[0];
        index = tokens.lastIndex;
        if (marker[0] === "`" || marker[0] === "~") {
            const delimiters = new RegExp(`${marker[0]}+`, "g");
            delimiters.lastIndex = index;
            let end = delimiters.exec(text);
            while (end && (marker.length >= 3 ? end[0].length < marker.length : end[0].length !== marker.length)) {
                end = delimiters.exec(text);
            }
            index = end ? delimiters.lastIndex : text.length;
            if (!reasoning.length) output += text.slice(token.index, index);
            tokens.lastIndex = index;
        } else if (marker[1] !== "/") {
            reasoning.push(marker.slice(1, -1).toLowerCase());
        } else if (reasoning.at(-1) === marker.slice(2, -1).toLowerCase()) {
            reasoning.pop();
        }
    }
    if (!reasoning.length) output += stripDanglingReasoningTag(text.slice(index));
    return output.trim();
}

/** 修改看节点，连线看两端；媒体读取失败会影响审片结论，按同一片段判断是否后来成功。 */
function assistantActionTarget(call: AgentToolCall): string | null {
    const args = call.args || {};
    switch (call.tool) {
        case "media.overview":
        case "media.inspect":
        case "media.check":
        case "media_overview":
        case "media_inspect":
        case "media_check":
            return `media:${JSON.stringify(args)}`;
        case "canvas.node.update":
            return `update:${String(args.nodeId ?? "")}`;
        case "canvas.timeline.update":
            return "timeline";
        case "canvas.edge.create":
            return `edge:${String(args.fromNodeId ?? "")}>${String(args.toNodeId ?? "")}`;
        case "canvas.nodes.create":
            // 模型重试新建时常会调整标题或数量：之后任何一次新建成功都算这一步已完成。
            return "create";
        case "canvas.generation.propose":
            return `propose:${Array.isArray(args.nodeIds) ? args.nodeIds.join("|") : ""}`;
        default:
            return null;
    }
}

/**
 * 这一轮里最后仍没做成的事：失败后又重试成功的步骤不再提示，
 * 同类失败合并成一句，避免把助手的中间重试当成错误摆给用户。
 */
export function assistantUnresolvedFailures(calls: AgentToolCall[] | undefined): string[] {
    const list = calls || [];
    const counts = new Map<string, number>();
    list.forEach((call, index) => {
        if (!call.isError) return;
        const target = assistantActionTarget(call);
        if (!target) return;
        const resolved = list.slice(index + 1).some((later) => {
            if (later.isError || later.tool !== call.tool) return false;
            if (assistantActionTarget(later) === target) return true;
            // 同一节点的 overview 补齐缺失 resourceId 后成功，属于原步骤的重试。
            // 不合并不同素材、片段、版本，也不让 overview 代替 inspect。
            if (!['media.overview', 'media_overview'].includes(call.tool)) return false;
            const before = call.args || {};
            const after = later.args || {};
            if (before.resourceId || !after.resourceId || (!before.nodeId && !before.assetId)) return false;
            const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
            keys.delete('resourceId');
            return [...keys].every(key => JSON.stringify(before[key]) === JSON.stringify(after[key]));
        });
        if (resolved) return;
        const label = call.tool === "canvas.generation.propose" && /^production_seedream_multiple_outputs(?::|$)/.test(call.error || "")
            ? "整片制作暂不支持 Seedream 图层拆分或组图。请先在画布生成图片，再用已有图片继续制作。"
            : call.tool.replace("_", ".") === "media.inspect"
            ? call.args?.mode === "audio" ? "有音频片段听取未完成"
                : call.args?.mode === "video" ? "有视频片段查看未完成"
                    : !call.args?.mode || call.args.mode === "frames" ? "有素材的画面查看未完成" : `${assistantActionLabel(call.tool)}没有成功`
            : `${assistantActionLabel(call.tool)}没有成功`;
        counts.set(label, (counts.get(label) ?? 0) + 1);
    });
    return [...counts.entries()].map(([label, count]) => (count > 1 ? `${label}（${count} 处）` : label));
}

/** 技能标签只显示名称和版本；名称不可识别时说明已移除，不显示内部标识。 */
export function assistantSkillLabel(skill: Pick<AssistantSkillSelection, "skillName" | "version">): string {
    const name = skill.skillName?.trim();
    if (!name) return "技能：已移除的技能";
    const version = skill.version?.trim();
    return version ? `技能：${name} · ${version}` : `技能：${name}`;
}
