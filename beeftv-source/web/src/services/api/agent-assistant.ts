// 内置创作助手：浏览器只与同源 Go 代理通信，宿主/owner/模型凭据都不进入页面。
// 三个端点的真实路径都在 /api/assistant/* 下；写错路径会让面板永远拿不到回复。
import { ApiError, apiBaseURL, http } from "./request";
import { assertUserScope, captureUserScope, userScopeMatches, type CapturedUserScope } from "@/lib/user-scope-guard";

/** 后端给出的不可用原因（穷举，见契约 A1）；未知值一律走兜底文案。 */
export type AssistantUnavailableReason =
    | "model_not_configured"
    | "credential_missing"
    | "model_protocol_unsupported"
    | "host_starting"
    | "host_start_failed"
    | "host_unreachable";

export type AssistantModelInfo = {
    id: string;
    channelId: string;
    channelName: string;
};

export type AssistantPermissionMode = "read-only" | "canvas" | "full-access";

export function assistantPermissionMode(value: unknown): AssistantPermissionMode {
    return value === "read-only" || value === "full-access" ? value : "canvas";
}

export type AgentHostStatus = {
    available: boolean;
    reason?: string;
    model?: AssistantModelInfo;
    url?: string;
    health?: { raw?: string };
};

export type AgentToolCall = {
    toolCallId?: string;
    tool: string;
    args?: Record<string, unknown>;
    isError?: boolean;
    error?: string;
    replayed?: boolean;
    /** Whitelisted successful media result, not model prose or tool arguments. */
    mediaFacts?: AssistantMediaFacts;
    mediaEvidence?: AssistantMediaFacts[];
};

export type AssistantMediaFacts = {
    source: { resourceId: string; version: string; startMs: number; endMs: number; nodeId?: string };
    mode: "frames" | "video" | "audio" | "check";
    durationMs: number;
    hasAudio: boolean;
    silenceIntervals?: { startMs: number; endMs: number }[];
    meanDb?: number;
    peakDb?: number;
};

/** 一个回合真正落到画布上的改动；没写任何东西时后端给 null。 */
export type AssistantTurnChange = {
    revisionBefore: number;
    revisionAfter: number;
    createdNodeIds: string[];
    updatedNodeIds: string[];
    createdEdgeIds: string[];
    timelineUpdated?: boolean;
    deletedNodeIds?: string[];
    deletedEdgeIds?: string[];
    documentUpdated?: boolean;
    canvasChanges?: AssistantCanvasChange[];
};

export type AssistantCanvasChange = Omit<AssistantTurnChange, "canvasChanges"> & { canvasId: string; operationIds: string[] };

/** 付费生成提议：后端只登记，不生成、不扣费，执行发生在画布既有生成链路。 */
export type AssistantGenerationProposal = {
    proposalId: string;
    kind: "image" | "video" | "audio";
    nodeIds: string[];
    model: string;
    modelKey: string;
    note?: string;
    production?: { targets: { nodeId: string; title: string; kind: "image" | "video" | "audio"; modelKey: string; prompt: string; parameters: Record<string,string>; metadata?: Record<string, unknown>; referenceNodeIds: string[] }[] };
    source?: { canvasId: string; canvasRevision: number; modelConfigRevision: number };
};

export async function confirmAssistantProduction(canvasId: string, turnId: string, proposal: AssistantGenerationProposal) {
    return http.post<{ taskIds: string[]; continuationId: string }>(`/assistant/turns/${encodeURIComponent(turnId)}/proposals/${encodeURIComponent(proposal.proposalId)}/production`, {
        canvasId, kind: proposal.kind, nodeIds: proposal.nodeIds, targets: proposal.production?.targets,
    }, await uiSessionConfig());
}

export type AssistantPlan = {
    goal: string;
    items: { id: string; title: string; status: "todo" | "doing" | "done" | "needs_user" | "blocked"; note?: string }[];
    done: number;
    total: number;
    updatedAt: string;
};

export type AgentTurnEnd = {
    /** Backend projection of the source turn's durable intent fence. */
    proposalsInvalidated?: boolean;
    type: "turn_end";
    turnId?: string;
    /** Go-confirmed generation continuation identity, never inferred from text. */
    continuationId?: string;
    /** 宿主本回合实际使用的会话；旧 JSONL 会话首次发消息会交接给新的 Durable 会话，界面据此更新。 */
    sessionId?: string;
    permissionMode?: AssistantPermissionMode;
    reply: string;
    toolCalls: AgentToolCall[];
    change?: AssistantTurnChange | null;
    proposals?: AssistantGenerationProposal[];
    outputs?: AssistantTurnOutput[];
    plan?: AssistantPlan | null;
    error: string | null;
    errorReason?: string | null;
    cancelled: boolean;
    supplements?: string[];
    attachments?: AssistantAttachment[];
    skills?: AssistantSkillSelection[];
    supplementInputs?: AssistantSupplementInput[];
    persistence?: string;
    metrics?: { firstTokenMs: number | null; totalMs: number };
};

export type AssistantTurn = {
    proposalsInvalidated?: boolean;
    turnId: string;
    continuationId?: string;
    permissionMode?: AssistantPermissionMode;
    userText: string;
    selectedNodeIds: string[];
    reply: string;
    toolCalls: AgentToolCall[];
    change: AssistantTurnChange | null;
    proposals: AssistantGenerationProposal[];
    outputs?: AssistantTurnOutput[];
    plan?: AssistantPlan | null;
    error: string | null;
    errorReason?: string | null;
    cancelled: boolean;
    supplements?: string[];
    attachments?: AssistantAttachment[];
    skills?: AssistantSkillSelection[];
    supplementInputs?: AssistantSupplementInput[];
    createdAt: string;
};

/** Trusted render receipts in creation order; task/resource access still uses owned APIs. */
export type AssistantTurnOutput = { taskId: string; kind: "video"; sourceRevision?: number }
    | { kind: "project"; resourceId: string; fileName: string; sourceRevision?: number };

export type AssistantSessionSummary = {
    sessionId: string;
    title: string;
    updatedAt: string;
    turnCount: number;
};

export type AssistantSessionList = {
    currentSessionId: string | null;
    sessions: AssistantSessionSummary[];
};

export type AssistantHistory = {
    sessionId: string;
    plan?: AssistantPlan | null;
    turns: (AssistantTurn & { undone?: boolean })[];
    active?: { turnId: string; requestId?: string; continuationId?: string; userText: string; selectedNodeIds: string[]; attachments?: AssistantAttachment[]; skills?: AssistantSkillSelection[];
        references?: AgentChatReference[]; supplements?: string[]; supplementInputs?: AssistantSupplementInput[]; permissionMode?: AssistantPermissionMode; createdAt: string; status: "running";
        /** 正在进行的回合此刻的进度（例如模型重试），只用于展示，结束后不再返回。 */
        lifecycle?: AgentLifecycleEvent | null; plan?: AssistantPlan | null; streamed?: string } | null;
};

// UI 会话凭据只保存在内存里：刷新页面即重新签发，不写入 localStorage。
let uiSession: { token: string; expiresAt: number; scope: CapturedUserScope } | null = null;
let uiSessionPending: { promise: Promise<string>; scope: CapturedUserScope } | null = null;
let uiSessionGeneration = 0;

/**
 * 服务端失败原因只用于分支，展示给用户的永远是用户语。
 * 这些 reason 由后端给出（见 handler/agent_proxy.go 与 agent_host_lifecycle.go）。
 */
export function agentAssistantFailureText(reason: string | undefined, fallback = "创作助手暂时不可用，请稍后再试") {
    switch (reason) {
        case "skill_instruction_too_large":
            return "所选技能正文过大，请减少所选技能或将部分内容移到参考文件后重试。";
        case "body_too_large":
        case "http_413":
            return "本次消息内容过大，请缩短消息或减少附件后重试。";
        case "turn_timeout":
            return "模型响应时间过长，这一轮尚未完成。已完成的改动会保留，可以继续处理。";
        case "turn_interrupted":
            return "上一轮执行中断，已经落地的改动已保留。请查看画布和改动记录后再继续。";
        case "turn_request_budget_exhausted":
        case "turn_tool_step_budget_exhausted":
            return "这一轮已达到调用上限，已停止继续执行。可以发送新消息继续，已落地的改动会保留。";
        case "request_budget_exhausted":
            return "当前配置的总调用预算已用完，请检查助手运行配置。已落地的改动会保留。";
        case "request_budget_storage_unavailable":
            return "预算记录无法读取或保存，已停止继续调用。请检查磁盘空间和数据目录权限；仍失败时，请从有效备份恢复预算记录后重启助手。";
        case "model_error":
        case "provider_error":
            return "模型没有完成回复。已经完成的操作会保留，请检查结果后再继续。";
        case "model_request_failed":
            return "模型暂时没有完成响应。已完成的改动会保留，可以继续处理。";
        case "host_unreachable":
        case "host_unhealthy":
        case "host_token_missing":
        case "host_command_missing":
        case "host_start_failed":
            return "创作助手还没准备好，请稍后再试";
        case "unauthenticated":
        case "read_only_client":
        case "forbidden":
            return "当前页面无法使用创作助手，请重新打开画布";
        case "session_busy":
            return "上一条消息还在处理中，请等它结束";
        case "session_not_current":
            return "你已经换到别的对话了，请重新发送这条消息";
        case "session_not_running":
            return "这一轮已经结束，请查看最新结果后发送新消息";
        default:
            return fallback;
    }
}

export async function getAgentHostStatus(): Promise<AgentHostStatus> {
    const data = await http.get<AgentHostStatus>("/assistant/status");
    return data;
}

/** UI 会话头由页面内存里的凭据提供；助手的每条路由都走同一套认证。 */
async function uiSessionConfig() {
    const token = await ensureAgentUiSession();
    return { headers: { "X-Beeftv-Ui-Session": token } };
}

/** 重新拉起助手运行环境。失败必须抛出，界面才不会把「没启动」显示成「已就绪」。 */
export async function restartAgentHost(): Promise<void> {
    await http.post<{ restarted: boolean }>("/assistant/host/restart", {}, await uiSessionConfig());
}

/** 读取失败必须与空历史区分，由界面保留原内容并提供重新读取。 */
export async function listAssistantSessions(canvasId: string): Promise<AssistantSessionList> {
    return http.get<AssistantSessionList>(`/assistant/sessions?canvasId=${encodeURIComponent(canvasId)}`, await uiSessionConfig());
}

export async function createAssistantSession(canvasId: string): Promise<string | null> {
    const data = await http.post<{ sessionId: string }>("/assistant/sessions", { canvasId }, await uiSessionConfig());
    if (!data?.sessionId) throw new Error("没能新建对话，请重试");
    return data.sessionId;
}

export async function activateAssistantSession(canvasId: string, sessionId: string): Promise<string | null> {
    const data = await http.post<{ sessionId: string }>("/assistant/sessions/activate", { canvasId, sessionId }, await uiSessionConfig());
    if (!data?.sessionId) throw new Error("没能切换对话，请重试");
    return data.sessionId;
}

export async function getAssistantHistory(canvasId: string, sessionId?: string): Promise<AssistantHistory> {
    const query = new URLSearchParams({ canvasId });
    if (sessionId) query.set("sessionId", sessionId);
    const data = await http.get<AssistantHistory>(`/assistant/history?${query.toString()}`, await uiSessionConfig());
    if (!data || !Array.isArray(data.turns)) throw new Error("没能读取对话，请重试");
    return { sessionId: data.sessionId || sessionId || "", active: data.active, plan: data.plan ?? null, turns: data.turns.map((turn) => ({
        ...turn,
        error: turn.error ? agentAssistantFailureText(turn.errorReason ?? undefined, "这一轮没有全部完成，请核对已经落地的改动。") : null,
    })) };
}

/** 撤销失败的机器可读原因，映射到卡片里的一句话。 */
export type AssistantUndoFailure = "canvas_changed" | "already_undone" | "no_change" | "unknown";

export type AssistantUndoResult = { ok: true; revision: number } | { ok: false; failure: AssistantUndoFailure };

/**
 * 撤销一整回合的改动。后端以新修订号回滚，不倒退历史；
 * 409 的三种原因必须区分，否则用户看不出「能不能再试」。
 */
export async function undoAssistantTurn(turnId: string, canvasId: string): Promise<AssistantUndoResult> {
    try {
        const data = await http.post<{ revision: number }>(`/assistant/turns/${encodeURIComponent(turnId)}/undo`, { canvasId }, await uiSessionConfig());
        return { ok: true, revision: data?.revision ?? 0 };
    } catch (error) {
        return { ok: false, failure: assistantUndoFailure(error) };
    }
}

/** 已撤销的一轮不再开始生成；这是后端给出的唯一判定，界面隐藏按钮只是提示。 */
export const ASSISTANT_PROPOSAL_UNDONE_TEXT = "这一轮已撤销，不会生成。";
export const ASSISTANT_PROPOSAL_INVALIDATED_TEXT = "已失效，请让助手重新提出生成方案。";

/**
 * 开始生成前由后端确认生成建议所属的一轮仍然有效。
 * 返回 null 表示可以继续；否则返回给用户看的一句话，不会提交任何生成。
 */
export async function confirmAssistantProposalRunnable(turnId: string, proposalId: string, canvasId: string): Promise<string | null> {
    try {
        await http.post<{ runnable: boolean }>(`/assistant/turns/${encodeURIComponent(turnId)}/proposals/${encodeURIComponent(proposalId)}/run`, { canvasId }, await uiSessionConfig());
        return null;
    } catch (error) {
        const reason = error instanceof ApiError ? error.reason : undefined;
        if (reason === "turn_undone") return ASSISTANT_PROPOSAL_UNDONE_TEXT;
        if (reason === "continuation_intent_changed") return ASSISTANT_PROPOSAL_INVALIDATED_TEXT;
        if (reason === "turn_not_found") return "找不到这一轮对话，未提交生成。请让助手重新提出方案。";
        return "无法确认这项生成是否还能进行，未提交生成。请检查连接后重试。";
    }
}

export function assistantUndoFailure(error: unknown): AssistantUndoFailure {
    const reason = error instanceof ApiError ? error.reason : undefined;
    switch (reason) {
        case "canvas_changed_since_turn":
            return "canvas_changed";
        case "turn_already_undone":
            return "already_undone";
        case "turn_has_no_change":
            return "no_change";
        default:
            return "unknown";
    }
}

export async function ensureAgentUiSession(): Promise<string> {
    const scope = captureUserScope();
    if (uiSession && userScopeMatches(uiSession.scope, scope) && Date.now() + 30_000 < uiSession.expiresAt) return uiSession.token;
    if (uiSessionPending && userScopeMatches(uiSessionPending.scope, scope)) return uiSessionPending.promise;
    const generation = ++uiSessionGeneration;
    const promise = issueAgentUiSession(scope, generation);
    uiSessionPending = { promise, scope };
    try {
        return await promise;
    } finally {
        if (uiSessionPending?.promise === promise) uiSessionPending = null;
    }
}

async function issueAgentUiSession(scope: CapturedUserScope, generation: number): Promise<string> {
    let data: { token?: string; expiresAt?: string };
    try {
        data = await http.post<{ token: string; expiresAt: string }>("/assistant/ui-session", {});
    } catch (error) {
        const status = error instanceof ApiError ? error.status : undefined;
        if (status === 403) {
            throw new Error(agentAssistantFailureText("forbidden"));
        }
        throw new Error(agentAssistantFailureText(undefined, "创作助手暂时不可用，请稍后再试"));
    }
    if (!data?.token) throw new Error("创作助手暂时不可用，请稍后再试");
    assertUserScope(scope);
    if (generation !== uiSessionGeneration) throw new Error("当前页面会话已更新，请重新发送");
    // Invalid/missing expiry is never cached; the server remains the authority on validity.
    const expiresAt = Date.parse(data.expiresAt ?? "");
    uiSession = Number.isFinite(expiresAt) ? { token: data.token, expiresAt, scope } : null;
    return data.token;
}

export function resetAgentUiSession() {
    uiSession = null;
    uiSessionPending = null;
    uiSessionGeneration += 1;
}

export type AgentLifecycleEvent = {
    type: "lifecycle";
    phase: "compaction" | "compaction_end" | "retry" | "retry_end" | "tool" | "tool_end" | "business";
    stage?: "processing" | "downloading" | "saving" | "saved" | "binding" | "rendering" | "exporting" | "checking" | "observation_unavailable";
    saved?: number;
    total?: number;
    toolName?: string;
    reason?: string;
    aborted?: boolean;
    willRetry?: boolean;
    attempt?: number;
    maxAttempts?: number;
    success?: boolean;
};

export type StreamHandlers = {
    onSession?: (sessionId: string) => void;
    onDelta?: (delta: string) => void;
    onText?: (text: string) => void;
    onPlan?: (plan: AssistantPlan | null) => void;
    onTurnEnd?: (end: AgentTurnEnd) => void;
    onLifecycle?: (event: AgentLifecycleEvent) => void;
};

/**
 * 流式结束但本次回合没有结算事件时的用户可见错误。
 *
 * 宿主对每一次对话都恰好发一条 `turn_end`；收到它才算这一回合真的结束。
 * 把「流断了」当成正常结束会让面板停在一段半截回复上，必须显式失败。
 */
export const AGENT_STREAM_INCOMPLETE_MESSAGE = "创作助手的回复没有完整结束，请再试一次";

/**
 * 界面明确引用、且后端会再校验归属的额外资源。
 * 内置助手默认能读当前画布与画布关联的素材/任务；额外画布只读，素材只读。
 */
export type AgentChatReference = {
    kind: "asset" | "canvas";
    id: string;
};

export type AssistantAttachmentPurpose = "analysis" | "character" | "scene" | "style" | "motion" | "first-frame" | "last-frame" | "rhythm" | "sound";
export type AssistantAttachment = {
    resourceId: string;
    kind: "image" | "video" | "audio";
    name: string;
    mimeType: string;
    bytes: number;
    purpose: AssistantAttachmentPurpose;
    start?: number;
    end?: number;
    durationMs?: number;
    nodeId?: string;
    assetId?: string;
};
/** Only persisted resource descriptors cross HTTP; never copy local preview/File data. */
function attachmentRequestValue({ resourceId, kind, name, mimeType, bytes, purpose, start, end, durationMs, nodeId, assetId }: AssistantAttachment): AssistantAttachment {
    return { resourceId, kind, name, mimeType, bytes, purpose, start, end, durationMs, nodeId, assetId };
}
/** skillName/version 是后端在选定时记下的显示名；缺失表示技能已不可识别，界面不得退回显示标识。 */
export type AssistantSkillSelection = { skillId: string; versionId: string; contentHash: string; skillName?: string; version?: string };
export type AssistantSupplementInput = { message: string; attachments?: AssistantAttachment[]; skills?: AssistantSkillSelection[] };

export type AgentChatRequest = {
    continuationId?: string;
    permissionMode?: AssistantPermissionMode;
    signal?: AbortSignal;
    selectedNodeIds?: string[];
    /** 当前消息里 @ 引用到的资源；后端逐项校验归属，任何一项非法都整轮拒绝。 */
    references?: AgentChatReference[];
    /** 只发当前会话；后端发现它已不是该画布的当前会话会整回合拒绝。 */
    sessionId?: string;
    /** 这次发送自己的标识：停止只指向它；同一标识重发不会再执行一次。 */
    requestId?: string;
    attachments?: AssistantAttachment[];
    skills?: AssistantSkillSelection[];
};

/** 已收到回合终态的业务失败，不等同于断流后的「执行结果未知」。 */
export class AgentTurnFailedError extends Error {
    constructor(readonly reason?: string | null) {
        super(agentAssistantFailureText(reason ?? undefined, "这一回合没有完成，请再试一次"));
        this.name = "AgentTurnFailedError";
    }
}

/** 宿主明确说明只是这条观察流断开（observer_error），回合仍由宿主持有：应改为读取结果，而不是报失败。 */
export class AgentStreamDetachedError extends Error {
    constructor(readonly reason: string) {
        super(AGENT_STREAM_INCOMPLETE_MESSAGE);
        this.name = "AgentStreamDetachedError";
    }
}

/** The chat was not sent, or Go explicitly rejected it before beginning a turn. */
export class AgentChatNotAdmittedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AgentChatNotAdmittedError";
    }
}

// NDJSON 流式对话：http 客户端只做信封解包，流式必须用原生 fetch（同源）。
export async function streamAgentChat(
    canvasId: string,
    message: string,
    handlers: StreamHandlers,
    request: AgentChatRequest = {},
): Promise<void> {
    const { signal, selectedNodeIds = [], references = [], sessionId, requestId, attachments = [], skills = [] } = request;
    const scope = captureUserScope();
    let token: string;
    try {
        token = await ensureAgentUiSession();
        assertUserScope(scope);
    } catch (error) {
        throw new AgentChatNotAdmittedError(error instanceof Error ? error.message : "消息未发送，请重试");
    }
    signal?.throwIfAborted();
    const body: Record<string, unknown> = { canvasId, message, selectedNodeIds, permissionMode: assistantPermissionMode(request.permissionMode) };
    if (references.length) body.references = references;
    if (sessionId) body.sessionId = sessionId;
    if (requestId) body.requestId = requestId;
    if (request.continuationId) body.continuationId = request.continuationId;
    if (attachments.length) body.attachments = attachments.map(attachmentRequestValue);
    if (skills.length) body.skills = skills.map(({ skillId, versionId, contentHash }) => ({ skillId, versionId, contentHash }));
    const response = await fetch(`${apiBaseURL}/assistant/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Beeftv-Ui-Session": token },
        body: JSON.stringify(body),
        signal,
    });
    if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        let reason = `http_${response.status}`;
        try { reason = JSON.parse(text)?.reason || reason; } catch { /* 非 JSON */ }
        if (response.status === 403 && uiSession?.token === token) resetAgentUiSession();
        const message = agentAssistantFailureText(reason);
        if (response.headers.get("X-Beeftv-Turn-Admission") === "rejected") {
            throw new AgentChatNotAdmittedError(message);
        }
        throw new Error(message);
    }
    const result = await readAgentTurnStream(response.body, handlers, signal);
    if (!result.settled) throw result.detached !== null ? new AgentStreamDetachedError(result.detached) : new Error(AGENT_STREAM_INCOMPLETE_MESSAGE);
    if (result.turnEnd && !result.turnEnd.cancelled && result.turnEnd.error) {
        // 上游错误可能包含请求细节，控制台同样不记录原文。
        console.error("创作助手回合失败", { canvasId });
        throw new AgentTurnFailedError(result.turnEnd.errorReason);
    }
}

/**
 * 逐行解析 NDJSON 回合流。
 *
 * 三处必须显式处理，否则会把截断当成成功：
 * 1. 流结束时先 flush 解码器，再处理没有换行符结尾的最后一行；
 * 2. 任何一行 JSON 损坏都按协议破损处理，不能 continue 吞掉；
 * 3. 必须见到 `turn_end` 才认为本次回合已结算。
 */
async function readAgentTurnStream(
    body: ReadableStream<Uint8Array>,
    handlers: StreamHandlers,
    signal?: AbortSignal,
): Promise<{ settled: boolean; turnEnd: AgentTurnEnd | null; malformedLine: string | null; detached: string | null }> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let settled = false;
    let turnEnd: AgentTurnEnd | null = null;
    let malformedLine: string | null = null;
    let detached: string | null = null;

    const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let payload: Record<string, unknown>;
        try {
            payload = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
            malformedLine = trimmed.slice(0, 200);
            return;
        }
        if (payload.type === "session" && typeof payload.sessionId === "string" && payload.sessionId) {
            handlers.onSession?.(payload.sessionId);
            return;
        }
        if (payload.type === "text_delta" && typeof payload.delta === "string") {
            handlers.onDelta?.(payload.delta);
            return;
        }
        if (payload.type === "text_snapshot" && typeof payload.text === "string") {
            handlers.onText?.(payload.text);
            return;
        }
        if (payload.type === "plan") {
            handlers.onPlan?.(payload.plan as AssistantPlan | null);
            return;
        }
        if (payload.type === "lifecycle") {
            handlers.onLifecycle?.(payload as unknown as AgentLifecycleEvent);
            return;
        }
        if (payload.type === "agent_end") {
            return;
        }
        if (payload.type === "observer_error") {
            detached = typeof payload.reason === "string" && payload.reason ? payload.reason : "interrupted";
            return;
        }
        if (payload.type === "turn_end") {
            settled = true;
            turnEnd = payload as unknown as AgentTurnEnd;
            handlers.onTurnEnd?.(turnEnd);
        }
    };

    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) {
                buffer += decoder.decode();
                if (buffer.trim()) handleLine(buffer);
                buffer = "";
                break;
            }
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) handleLine(line);
        }
    } finally {
        reader.releaseLock();
    }
    if (malformedLine !== null) throw new Error(AGENT_STREAM_INCOMPLETE_MESSAGE);
    if (signal?.aborted && !settled) throw new DOMException("请求已取消", "AbortError");
    return { settled, turnEnd, malformedLine, detached };
}

/**
 * 停止的结果：stopped 正在执行，已停下；finished 已经结束；
 * pending 助手还没开始处理它，之后到达也不会执行。
 */
export type AgentCancelState = "stopped" | "finished" | "pending";

/**
 * 请求停止一次发送；不带 target 时停止当前画布正在进行的回合。
 *
 * 停止失败必须如实抛出：只 await fetch 会把 404/5xx 当成「已停止」，
 * 让界面显示与真实运行状态不一致。
 */
export async function cancelAgentChat(canvasId: string, target?: { sessionId: string; requestId: string }): Promise<AgentCancelState | undefined> {
    const token = await ensureAgentUiSession();
    const response = await fetch(`${apiBaseURL}/assistant/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Beeftv-Ui-Session": token },
        body: JSON.stringify(target ? { canvasId, sessionId: target.sessionId, requestId: target.requestId } : { canvasId }),
    });
    const text = await response.text().catch(() => "");
    type CancelPayload = { code?: number; reason?: string; data?: { state?: AgentCancelState } };
    let payload: CancelPayload | null = null;
    try { payload = JSON.parse(text) as CancelPayload; } catch { payload = null; }
    if (response.status === 403 && uiSession?.token === token) resetAgentUiSession();
    const businessFailed = payload !== null && typeof payload.code === "number" && payload.code !== 0;
    if (!response.ok || businessFailed) {
        throw new Error(agentAssistantFailureText(payload?.reason, "停止失败，请再试一次"));
    }
    return payload?.data?.state;
}

/** 补充已有回合，新增素材仍由后端校验授权，不创建新生成请求。 */
export async function steerAgentChat(canvasId: string, sessionId: string, message: string, input: Pick<AgentChatRequest, "attachments" | "references" | "skills"> = {}): Promise<void> {
    const token = await ensureAgentUiSession();
    const response = await fetch(`${apiBaseURL}/assistant/steer`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Beeftv-Ui-Session": token },
        body: JSON.stringify({ canvasId, sessionId, message, ...(input.references?.length ? { references: input.references } : {}), ...(input.attachments?.length ? { attachments: input.attachments.map(attachmentRequestValue) } : {}), ...(input.skills?.length ? { skills: input.skills.map(({ skillId, versionId, contentHash }) => ({ skillId, versionId, contentHash })) } : {}) }),
    });
    let payload: { code?: number; reason?: string; data?: { accepted?: boolean } } | null = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (response.status === 403 && uiSession?.token === token) resetAgentUiSession();
    if (!response.ok || payload?.code !== 0 || payload?.data?.accepted !== true) {
        throw new Error(agentAssistantFailureText(payload?.reason, "未能确认助手收到补充要求，原任务仍会保留。请查看最新回复后再决定是否发送。"));
    }
}
