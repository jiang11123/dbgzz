import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

/**
 * NDJSON 回合流的确定性边界用例：分片切割、末尾无换行、中途断流。
 * 全部用内存流，不调用模型。
 */

const requests: Array<{ url: string; method: string; body: string }> = [];
let chatResponse: (() => Response | Promise<Response>) | null = null;
let sessionResponse: (() => Response) | null = null;

const { ApiError, http, apiClient, configureApiRuntime } = await import("@/services/api/request");
const requestRuntime = await import("@/services/api/request");
let previousFetch: typeof fetch;
let previousBaseURL: string;
let previousDesktopToken: unknown, previousBootstrapToken: unknown;
let httpGetSpy: ReturnType<typeof spyOn>, httpPostSpy: ReturnType<typeof spyOn>;
const { setActiveUserScope } = await import("@/lib/user-scope");
const {
    AgentChatNotAdmittedError,
    AgentStreamDetachedError,
    AGENT_STREAM_INCOMPLETE_MESSAGE,
    assistantUndoFailure,
    cancelAgentChat,
    confirmAssistantProposalRunnable,
    steerAgentChat,
    ensureAgentUiSession,
    resetAgentUiSession,
    streamAgentChat,
} = await import("@/services/api/agent-assistant");

/** 把整段 NDJSON 按给定分片切开发成流，模拟真实网络分片（可切到单个字节）。 */
function streamOf(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
            controller.close();
        },
    });
}

function chatResponseOf(chunks: string[]): Response {
    return new Response(streamOf(chunks), { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
}

function installFetch() {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        requests.push({ url, method: init?.method || "GET", body: String(init?.body || "") });
        if (url.includes("/api/assistant/chat")) return chatResponse ? chatResponse() : new Response(null, { status: 500 });
        if (url.includes("/api/assistant/cancel")) return cancelResponse();
        if (url.includes("/api/assistant/steer")) return steerResponse();
        if (url.includes("/api/assistant/ui-session")) return new Response(JSON.stringify({ code: 0, data: { token: "ui-token" } }), { status: 200 });
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
}

let cancelResponse: () => Response = () => new Response(JSON.stringify({ code: 0, accepted: true }), { status: 202 });
let steerResponse = () => new Response(JSON.stringify({ code: 0, data: { accepted: true } }), { status: 200 });

beforeEach(() => {
    previousFetch = globalThis.fetch;
    previousBaseURL = requestRuntime.apiBaseURL;
    previousDesktopToken = apiClient.defaults.headers.common["X-Desktop-Token"];
    previousBootstrapToken = apiClient.defaults.headers.common["X-Beeftv-UI-Bootstrap"];
    configureApiRuntime("http://127.0.0.1:54321/api", "");
    httpGetSpy = spyOn(http, "get").mockImplementation(async () => ({ available: true }) as never);
    httpPostSpy = spyOn(http, "post").mockImplementation(async () => {
        const response = sessionResponse ? sessionResponse() : new Response(JSON.stringify({ code: 0, data: { token: "ui-token" } }), { status: 200, headers: { "Content-Type": "application/json" } });
        if (!response.ok) throw new ApiError("session failed", { status: response.status });
        const payload = await response.json();
        return payload.data;
    });
    requests.length = 0;
    chatResponse = null;
    sessionResponse = null;
    cancelResponse = () => new Response(JSON.stringify({ code: 0, accepted: true }), { status: 202 });
    resetAgentUiSession();
    steerResponse = () => new Response(JSON.stringify({ code: 0, data: { accepted: true } }), { status: 200 });
    installFetch();
});

afterEach(() => {
    resetAgentUiSession();
    globalThis.fetch = previousFetch;
    httpGetSpy.mockRestore();
    httpPostSpy.mockRestore();
    configureApiRuntime(previousBaseURL, String(previousDesktopToken || ""), previousBootstrapToken ? String(previousBootstrapToken) : undefined);
    if (previousDesktopToken === undefined) delete apiClient.defaults.headers.common["X-Desktop-Token"];
});

const TURN_END = JSON.stringify({ type: "turn_end", reply: "完成", toolCalls: [], error: null, cancelled: false });

describe("创作助手回合流边界", () => {
    test("已失效的生成确认返回明确提示，普通可用提案不受影响", async () => {
        // Establish the UI session before replacing the proposal endpoint response.
        sessionResponse = () => new Response(JSON.stringify({ data: { token: "ui-token", expiresAt: new Date(Date.now() + 1_800_000).toISOString() } }));
        await ensureAgentUiSession();
        httpPostSpy.mockRejectedValueOnce(new ApiError("internal detail", { status: 409, reason: "continuation_intent_changed" }));
        expect(await confirmAssistantProposalRunnable("old", "gp-old", "canvas")).toBe("已失效，请让助手重新提出生成方案。");
        httpPostSpy.mockResolvedValueOnce({ runnable: true } as never);
        expect(await confirmAssistantProposalRunnable("current", "gp-current", "canvas")).toBeNull();
    });
    test("交接会话身份在 observer_error 和断流前交给界面，不能冒充回合完成", async () => {
        let sessionId = "legacy-session";
        let ended = false;
        chatResponse = () => chatResponseOf([
            JSON.stringify({ type: "session", sessionId: "durable:successor" }) + "\n",
            JSON.stringify({ type: "observer_error", reason: "interrupted" }) + "\n",
        ]);
        await expect(streamAgentChat("c1", "继续", {
            onSession: value => { sessionId = value; },
            onTurnEnd: () => { ended = true; },
        })).rejects.toThrow(AGENT_STREAM_INCOMPLETE_MESSAGE);
        expect(sessionId).toBe("durable:successor");
        expect(ended).toBe(false);
    });
    test("observer_error 说明只是观察断开，界面据此改为读取结果，而不是当成断流失败", async () => {
        chatResponse = () => chatResponseOf([
            JSON.stringify({ type: "session", sessionId: "durable:s1" }) + "\n",
            JSON.stringify({ type: "text_delta", delta: "已开始" }) + "\n",
            JSON.stringify({ type: "observer_error", reason: "interrupted" }) + "\n",
        ]);
        const error = await streamAgentChat("c1", "继续", {}).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(AgentStreamDetachedError);
        expect((error as InstanceType<typeof AgentStreamDetachedError>).reason).toBe("interrupted");
        expect((error as Error).message).toBe(AGENT_STREAM_INCOMPLETE_MESSAGE);
        chatResponse = () => chatResponseOf([JSON.stringify({ type: "text_delta", delta: "半截" }) + "\n"]);
        const cut = await streamAgentChat("c1", "继续", {}).catch((caught: unknown) => caught);
        expect(cut).toBeInstanceOf(Error);
        expect(cut).not.toBeInstanceOf(AgentStreamDetachedError);
    });
    test("运行中补充只发文字和当前会话，不创建新回合或附加素材", async () => {
        await steerAgentChat("c1", "s1", "结尾换成蛋糕");
        const calls = requests.filter(item => item.url.includes("/assistant/steer"));
        expect(calls).toHaveLength(1);
        expect(JSON.parse(calls[0]!.body)).toEqual({ canvasId: "c1", sessionId: "s1", message: "结尾换成蛋糕" });
        expect(requests.some(item => item.url.includes("/assistant/chat"))).toBe(false);
    });
    test("附件和技能只发送保存后的描述，chat 与 steer 不携带本地预览或内容", async () => {
        const attachment = { resourceId: "r1", assetId: "a1", kind: "image" as const, name: "参考.png", mimeType: "image/png", bytes: 100, purpose: "style" as const, dataUrl: "data:image/png;base64,DO_NOT_SEND", file: "local-file" };
        const skill = { skillId: "s1", versionId: "v1", contentHash: "a".repeat(64), skillName: "分镜", version: "1" };
        chatResponse = () => chatResponseOf([`${TURN_END}\n`]);
        await streamAgentChat("c1", "", {}, { attachments: [attachment], skills: [skill], references: [{ kind: "asset", id: "a1" }] });
        const body = JSON.parse(requests.find(item => item.url.includes("/assistant/chat"))!.body);
        expect(body.message).toBe(""); expect(body.attachments[0].dataUrl).toBeUndefined(); expect(body.attachments[0].file).toBeUndefined();
        expect(body.skills).toEqual([{ skillId: "s1", versionId: "v1", contentHash: "a".repeat(64) }]);
        await steerAgentChat("c1", "current", "", { attachments: [attachment], skills: [skill], references: [{ kind: "asset", id: "a1" }] });
        const supplement = JSON.parse(requests.find(item => item.url.includes("/assistant/steer"))!.body);
        expect(supplement.attachments).toEqual(body.attachments); expect(supplement.skills).toEqual(body.skills); expect(supplement.references).toEqual(body.references);
    });

    test("补充要求只有明确收到才报告成功，拒绝或断线不自动重发", async () => {
        for (const response of [
            () => new Response(JSON.stringify({ code: 409, reason: "session_not_running" }), { status: 409 }),
            () => new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 }),
            () => new Response("not JSON", { status: 200 }),
        ]) {
            requests.length = 0;
            steerResponse = response;
            await expect(steerAgentChat("c1", "s1", "只改结尾")).rejects.toThrow();
            expect(requests.filter(item => item.url.includes("/assistant/steer"))).toHaveLength(1);
        }
    });
    test("身份切换后不会复用凭据，旧签发也不能跨身份回写", async () => {
        let issued = 0;
        sessionResponse = () => new Response(JSON.stringify({ data: { token: `token-${++issued}`, expiresAt: new Date(Date.now() + 1_800_000).toISOString() } }));
        try {
            setActiveUserScope("a");
            expect(await ensureAgentUiSession()).toBe("token-1");
            setActiveUserScope("b");
            const stale = ensureAgentUiSession().catch((error: Error) => error);
            setActiveUserScope("a");
            expect(await ensureAgentUiSession()).toBe("token-3");
            expect(await stale).toBeInstanceOf(Error);
            expect((await stale as Error).message).toContain("账号已切换");
            expect(await ensureAgentUiSession()).toBe("token-3");
        } finally { setActiveUserScope(null); }
    });

    test("临近30分钟过期前续签，并发调用共用一次签发", async () => {
        let now = Date.parse("2026-10-02T00:00:00Z");
        const clock = spyOn(Date, "now").mockImplementation(() => now);
        let issued = 0;
        sessionResponse = () => new Response(JSON.stringify({ data: { token: `token-${++issued}`, expiresAt: new Date(now + 30 * 60_000).toISOString() } }));
        try {
            expect(await Promise.all([ensureAgentUiSession(), ensureAgentUiSession()])).toEqual(["token-1", "token-1"]);
            now += 29 * 60_000;
            expect(await ensureAgentUiSession()).toBe("token-1");
            now += 30_000;
            expect(await ensureAgentUiSession()).toBe("token-2");
            expect(issued).toBe(2);
        } finally { clock.mockRestore(); }
    });

    test("reset 后旧签发不能回写或返回旧凭据", async () => {
        let issued = 0;
        sessionResponse = () => new Response(JSON.stringify({ data: { token: `token-${++issued}`, expiresAt: new Date(Date.now() + 1_800_000).toISOString() } }));
        const stale = ensureAgentUiSession().catch((error: Error) => error);
        resetAgentUiSession();
        expect(await ensureAgentUiSession()).toBe("token-2");
        expect(await stale).toBeInstanceOf(Error);
        expect((await stale as Error).message).toContain("当前页面会话已更新");
        expect(await ensureAgentUiSession()).toBe("token-2");
    });

    test("明确的403接纳拒绝清除旧凭据但绝不自动重放消息", async () => {
        let issued = 0;
        sessionResponse = () => new Response(JSON.stringify({ data: { token: `token-${++issued}`, expiresAt: new Date(Date.now() + 1_800_000).toISOString() } }));
        chatResponse = () => new Response(JSON.stringify({ reason: "unauthenticated" }), { status: 403, headers: { "X-Beeftv-Turn-Admission": "rejected" } });
        await expect(streamAgentChat("c1", "hi", {})).rejects.toBeInstanceOf(AgentChatNotAdmittedError);
        expect(requests.filter((r) => r.url.endsWith("/chat"))).toHaveLength(1);
        expect(await ensureAgentUiSession()).toBe("token-2");
    });

    test("签发失败没有发送chat，按未接纳处理", async () => {
        sessionResponse = () => new Response("", { status: 403 });
        await expect(streamAgentChat("c1", "hi", {})).rejects.toBeInstanceOf(AgentChatNotAdmittedError);
        expect(requests).toHaveLength(0);
    });

    test("旧请求延迟返回403不会清除已经续签的新凭据", async () => {
        let issued = 0;
        sessionResponse = () => new Response(JSON.stringify({ data: { token: `token-${++issued}`, expiresAt: new Date(Date.now() + 1_800_000).toISOString() } }));
        let rejectResponse!: (response: Response) => void;
        let sent!: () => void;
        const dispatched = new Promise<void>((resolve) => { sent = resolve; });
        chatResponse = () => {
            sent();
            return new Promise<Response>((resolve) => { rejectResponse = resolve; });
        };
        const oldRequest = streamAgentChat("c1", "hi", {}).catch((error: Error) => error);
        await dispatched;
        resetAgentUiSession();
        expect(await ensureAgentUiSession()).toBe("token-2");
        rejectResponse(new Response(JSON.stringify({ reason: "unauthenticated" }), { status: 403, headers: { "X-Beeftv-Turn-Admission": "rejected" } }));
        expect(await oldRequest).toBeInstanceOf(AgentChatNotAdmittedError);
        expect(await ensureAgentUiSession()).toBe("token-2");
        expect(issued).toBe(2);
    });

    test("没有明确拒绝标记的HTTP错误和已接纳断流继续视为结果未知", async () => {
        for (const admission of [null, "unknown", "admitted"]) {
            chatResponse = () => new Response(JSON.stringify({ reason: "host_unreachable" }), { status: 503, headers: admission ? { "X-Beeftv-Turn-Admission": admission } : {} });
            const error = await streamAgentChat("c1", "hi", {}).catch((e: unknown) => e);
            expect(error).toBeInstanceOf(Error);
            expect(error).not.toBeInstanceOf(AgentChatNotAdmittedError);
        }
        chatResponse = () => chatResponseOf([`{"type":"text_delta","delta":"半截"}\n`]);
        const error = await streamAgentChat("c1", "hi", {}).catch((e: unknown) => e);
        expect(error).not.toBeInstanceOf(AgentChatNotAdmittedError);
        expect(requests.filter((r) => r.url.endsWith("/chat"))).toHaveLength(4);
    });
	 test("对话和取消连接当前桌面运行时地址", async () => {
		chatResponse = () => chatResponseOf([TURN_END + "\n"]);
		await streamAgentChat("canvas-1", "test", {});
		await cancelAgentChat("canvas-1");
		expect(requests.map((request) => request.url)).toEqual([
			"http://127.0.0.1:54321/api/assistant/chat",
			"http://127.0.0.1:54321/api/assistant/cancel",
		]);
	 });
    test("分片切割（含跨行与多字节中文）仍能完整取回增量与最终回合", async () => {
        const line = JSON.stringify({ type: "text_delta", delta: "雨夜巷口" }) + "\n";
        const bytes = new TextEncoder().encode(line + TURN_END + "\n");
        // 在每个字节边界切一刀：任何依赖「一次读到整行」的实现都会露馅，
        // 同时覆盖中文被切断在多字节序列中间的情况。
        const chunks: Uint8Array[] = [];
        for (let index = 0; index < bytes.length; index += 1) chunks.push(bytes.slice(index, index + 1));
        chatResponse = () => new Response(streamOf(chunks), { status: 200 });

        const deltas: string[] = [];
        let ended = 0;
        await streamAgentChat("c1", "hi", { onDelta: (delta) => deltas.push(delta), onTurnEnd: () => { ended += 1; } });

        expect(deltas.join("")).toBe("雨夜巷口");
        expect(ended).toBe(1);
    });

    test("最后一行没有换行符也要处理（不能丢尾部）", async () => {
        chatResponse = () => chatResponseOf([`${JSON.stringify({ type: "text_delta", delta: "尾" })}\n`, TURN_END]);

        const deltas: string[] = [];
        let reply = "";
        await streamAgentChat("c1", "hi", { onDelta: (delta) => deltas.push(delta), onTurnEnd: (end) => { reply = end.reply; } });

        expect(deltas.join("")).toBe("尾");
        expect(reply).toBe("完成");
    });

    test("文字快照替换旧片段，计划在 turn_end 前立即交付且可清空", async () => {
        const plan = { goal: "生成并检查首帧", items: [{ id: "s1", title: "首帧", status: "doing" }], done: 0, total: 1, updatedAt: "now" };
        chatResponse = () => chatResponseOf([
            JSON.stringify({ type: "text_snapshot", text: "开头中段" }) + "\n",
            JSON.stringify({ type: "plan", plan }) + "\n",
            JSON.stringify({ type: "text_snapshot", text: "开头中段尾部" }) + "\n",
            JSON.stringify({ type: "plan", plan: null }) + "\n", TURN_END,
        ]);
        const observed: unknown[] = [];
        let text = "";
        await streamAgentChat("c1", "hi", {
            onText: value => { text = value; },
            onPlan: value => observed.push(value),
            onTurnEnd: () => observed.push("end"),
        });
        expect(text).toBe("开头中段尾部");
        expect(observed).toEqual([plan, null, "end"]);
    });

    test("流结束但没有最终回合事件 → 显式未完成错误，不当成功", async () => {
        chatResponse = () => chatResponseOf([`${JSON.stringify({ type: "text_delta", delta: "半截" })}\n`]);

        await expect(streamAgentChat("c1", "hi", { onDelta: () => {} })).rejects.toThrow(AGENT_STREAM_INCOMPLETE_MESSAGE);
    });

    test("损坏的 JSON 行 → 显式未完成错误，不再被 continue 吞掉", async () => {
        chatResponse = () => chatResponseOf(["{ this is not json }\n", `${TURN_END}\n`]);

        await expect(streamAgentChat("c1", "hi", {})).rejects.toThrow(AGENT_STREAM_INCOMPLETE_MESSAGE);
    });

    test("中途断流（reader 抛错）向上抛出，不当作正常结束", async () => {
        const encoder = new TextEncoder();
        chatResponse = () => new Response(new ReadableStream({
            start(controller) {
                controller.enqueue(encoder.encode(`${JSON.stringify({ type: "text_delta", delta: "半" })}\n`));
                controller.error(new Error("network down"));
            },
        }), { status: 200 });

        await expect(streamAgentChat("c1", "hi", {})).rejects.toThrow("network down");
    });

    test("宿主返回 error 的回合 → 用户可见失败，且不泄露实现者术语", async () => {
        chatResponse = () => chatResponseOf([`${JSON.stringify({ type: "turn_end", reply: "", toolCalls: [], error: "TypeError: x is not a function", cancelled: false })}\n`]);

        await expect(streamAgentChat("c1", "hi", {})).rejects.toThrow("这一回合没有完成，请再试一次");
    });

    test("lifecycle 事件不会把回合当成结束，agent_end 也不结算", async () => {
        const lifecycle = JSON.stringify({ type: "lifecycle", phase: "compaction", reason: "threshold" });
        const agentEnd = JSON.stringify({ type: "agent_end", willRetry: false, messages: [] });
        chatResponse = () => chatResponseOf([`${lifecycle}\n`, `${agentEnd}\n`]);
        const phases: string[] = [];
        await expect(streamAgentChat("c1", "hi", {
            onLifecycle: (event) => { phases.push(event.phase); },
        })).rejects.toThrow(AGENT_STREAM_INCOMPLETE_MESSAGE);
        expect(phases).toEqual(["compaction"]);
    });

    test("cancelled 回合按正常结束处理", async () => {
        chatResponse = () => chatResponseOf([`${JSON.stringify({ type: "turn_end", reply: "已停止", toolCalls: [], error: null, cancelled: true })}\n`]);

        let cancelled = false;
        await streamAgentChat("c1", "hi", { onTurnEnd: (end) => { cancelled = end.cancelled; } });

        expect(cancelled).toBe(true);
    });

    test("停止失败（404 会话不存在）必须抛出，不能当成已停止", async () => {
        cancelResponse = () => new Response(JSON.stringify({ code: 404, reason: "session_not_found" }), { status: 404 });

        await expect(cancelAgentChat("c1")).rejects.toThrow();
    });

    test("停止返回业务失败（HTTP 202 但 code 非 0）也要抛出", async () => {
        cancelResponse = () => new Response(JSON.stringify({ code: 500, reason: "internal_error" }), { status: 202 });

        await expect(cancelAgentChat("c1")).rejects.toThrow();
    });

    test("停止成功时不抛错", async () => {
        await expect(cancelAgentChat("c1")).resolves.toBeUndefined();
    });

    test("停止指向这一次发送：带上会话和请求标识，并读回这条请求的停止结果", async () => {
        cancelResponse = () => new Response(JSON.stringify({ code: 0, data: { accepted: true, state: "pending" } }), { status: 200 });
        await expect(cancelAgentChat("c1", { sessionId: "durable:s1", requestId: "req-1" })).resolves.toBe("pending");
        expect(JSON.parse(requests.at(-1)!.body)).toEqual({ canvasId: "c1", sessionId: "durable:s1", requestId: "req-1" });
    });

    test("每次发送都带上自己的请求标识", async () => {
        chatResponse = () => chatResponseOf([TURN_END + "\n"]);
        await streamAgentChat("c1", "hi", {}, { requestId: "req-2" });
        expect(JSON.parse(requests.find((request) => request.url.endsWith("/chat"))!.body).requestId).toBe("req-2");
    });

    test("最终回合带回 turnId、改动清单与生成提议", async () => {
        const end = {
            type: "turn_end",
            turnId: "turn-7",
            reply: "已经建好三个镜头",
            toolCalls: [{ toolCallId: "t1", tool: "canvas.nodes.create" }],
            change: { revisionBefore: 4, revisionAfter: 5, createdNodeIds: ["n1", "n2", "n3"], updatedNodeIds: [], createdEdgeIds: ["e1", "e2"] },
            proposals: [{ proposalId: "p1", kind: "image", nodeIds: ["n1"], model: "seedream-4", modelKey: "ch::seedream-4" }],
            error: null,
            cancelled: false,
        };
        chatResponse = () => chatResponseOf([`${JSON.stringify(end)}\n`]);

        let received: Record<string, unknown> | null = null;
        await streamAgentChat("c1", "hi", { onTurnEnd: (value) => { received = value as unknown as Record<string, unknown>; } });

        expect(received).not.toBeNull();
        expect(received!.turnId).toBe("turn-7");
        expect(received!.change).toEqual(end.change);
        expect(received!.proposals).toEqual(end.proposals);
    });

    test("旧格式（没有 turnId / change / proposals）仍然按成功结束", async () => {
        chatResponse = () => chatResponseOf([`${TURN_END}\n`]);
        let received: Record<string, unknown> | null = null;
        await streamAgentChat("c1", "hi", { onTurnEnd: (value) => { received = value as unknown as Record<string, unknown>; } });
        expect(received!.turnId).toBeUndefined();
        expect(received!.change).toBeUndefined();
    });

    test("会话不是当前会话时给出可操作的一句话", async () => {
        chatResponse = () => new Response(JSON.stringify({ code: 409, reason: "session_not_current" }), { status: 409 });
        await expect(streamAgentChat("c1", "hi", {}, { sessionId: "stale" })).rejects.toThrow("你已经换到别的对话了，请重新发送这条消息");
    });

    test("指定会话时才把 sessionId 放进请求体", async () => {
        chatResponse = () => chatResponseOf([`${TURN_END}\n`]);
        await streamAgentChat("c1", "hi", {}, { sessionId: "s-1", selectedNodeIds: ["n1"] });
        const chat = requests.find((item) => item.url.includes("/assistant/chat"));
        expect(JSON.parse(chat!.body)).toEqual({ canvasId: "c1", message: "hi", selectedNodeIds: ["n1"], sessionId: "s-1", permissionMode: "canvas" });

        requests.length = 0;
        await streamAgentChat("c1", "hi", {});
        const plain = requests.find((item) => item.url.includes("/assistant/chat"));
        expect(JSON.parse(plain!.body)).toEqual({ canvasId: "c1", message: "hi", selectedNodeIds: [], permissionMode: "canvas" });
    });

    test("每次新回合冻结明确权限，补充不能发送更改权限字段", async () => {
        chatResponse = () => chatResponseOf([`${TURN_END}\n`]);
        for (const permissionMode of ["read-only", "canvas", "full-access"] as const) {
            await streamAgentChat("c1", "hi", {}, { permissionMode });
            expect(JSON.parse(requests.filter(item => item.url.includes("/assistant/chat")).at(-1)!.body).permissionMode).toBe(permissionMode);
        }
        await steerAgentChat("c1", "s1", "补充", { permissionMode: "full-access" } as any);
        expect(JSON.parse(requests.find(item => item.url.includes("/assistant/steer"))!.body)).toEqual({ canvasId: "c1", sessionId: "s1", message: "补充" });
    });
});

describe("撤销失败原因", () => {
    test("三种 409 各自可分辨，未知原因归到 unknown", () => {
        // 必须用同一个 ApiError 类，instanceof 才会命中（这里复用真实 API 错误类）。
        const failure = (reason?: string) => new ApiError("failed", { status: 409, reason });
        expect(assistantUndoFailure(failure("canvas_changed_since_turn"))).toBe("canvas_changed");
        expect(assistantUndoFailure(failure("turn_already_undone"))).toBe("already_undone");
        expect(assistantUndoFailure(failure("turn_has_no_change"))).toBe("no_change");
        expect(assistantUndoFailure(failure("brand_new_reason"))).toBe("unknown");
        expect(assistantUndoFailure(new Error("boom"))).toBe("unknown");
    });
});
