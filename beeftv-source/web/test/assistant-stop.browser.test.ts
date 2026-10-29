import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";

let browser: Browser, server: ReturnType<typeof Bun.serve>;
let cancelled = false, historyFailure = false, settle = false;
let chatRequests = 0, cancelRequests = 0;
let rejectChat = false;
let scopeTest = false, holdOldHistory = false, configurationBlocked = false, seedHistoricalTurn = false, historyFailureReason = "host_unreachable", historyReads = 0;
let oldHistoryResolve: ((response: Response) => void) | null = null, oldSteerResolve: ((response: Response) => void) | null = null;
const steerUsers: string[] = [];
// observer_error case: the host's official turn keeps running after the observer stream ends.
let observerMode = false, observerChatStarted = false, observerSettled = false, holdObserverHistory = false;
let heldObserverHistory: Array<(response: Response) => void> = [];
// Stop before dispatch: the host is still starting, so the message has not been sent yet.
let hostStarting = false;
// Stop after dispatch but before the assistant got the message: the chat stream stays silent.
let earlyStop = false;
const chatBodies: Array<Record<string, unknown>> = [], cancelBodies: Array<Record<string, unknown>> = [];
const observerActive = { turnId: "t-observer", userText: "只创建草案", selectedNodeIds: [], supplements: [], attachments: [], skills: [], status: "running",
    lifecycle: { type: "lifecycle", phase: "retry", attempt: 1, reason: "timeout" } };

beforeEach(() => { earlyStop = false; chatBodies.length = 0; cancelBodies.length = 0; hostStarting = false; observerMode = false; observerChatStarted = false; observerSettled = false; holdObserverHistory = false; heldObserverHistory = []; cancelled = false; historyFailure = false; settle = false; chatRequests = 0; cancelRequests = 0; scopeTest = false; holdOldHistory = false; configurationBlocked = false; seedHistoricalTurn = false; historyFailureReason = "host_unreachable"; historyReads = 0; oldHistoryResolve = null; oldSteerResolve = null; steerUsers.length = 0; });
beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/assistant-stop-harness.tsx"], target: "browser", define: {
        "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"',
        "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"', "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"', "process.env.NODE_ENV": '"production"',
    }, plugins: [{ name: "test-source", setup(builder) {
        builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
    } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs.find(output => output.path.endsWith(".js"))!.text();
    const ok = (data: unknown) => Response.json({ code: 0, data });
    server = Bun.serve({ port: 0, async fetch(req) {
        const pathname = new URL(req.url).pathname;
        if (pathname === "/harness.js") return new Response(js, { headers: { "content-type": "application/javascript" } });
        const user = req.headers.get("cookie")?.includes("test-user=B") ? "B" : "A";
        if (scopeTest && pathname.endsWith("/assistant/sessions")) return ok({ currentSessionId: "session-" + user, sessions: [] });
        if (scopeTest && pathname.endsWith("/assistant/history")) {
            if (user === "A" && holdOldHistory) return new Promise<Response>(resolve => { oldHistoryResolve = resolve; });
            return ok({ sessionId: "session-" + user, turns: [{ turnId: "past-" + user, userText: "过去" + user, selectedNodeIds: [], reply: "历史" + user, toolCalls: [], change: null, proposals: [], error: null, cancelled: false }], active: { turnId: "active-" + user, userText: "任务" + user, selectedNodeIds: [], supplements: [], attachments: [], skills: [], status: "running" } });
        }
        if (scopeTest && pathname.endsWith("/assistant/steer")) {
            const body = await req.json(); steerUsers.push(body.sessionId);
            if (user === "A") return new Promise<Response>(resolve => { oldSteerResolve = resolve; });
            return ok({ accepted: true });
        }
        if (pathname.endsWith("/assistant/ui-session")) return ok({ token: "synthetic-only", expiresAt: new Date(Date.now() + 1800000).toISOString() });
        if (pathname.endsWith("/assistant/status") && hostStarting) return ok({ available: false, reason: "host_starting" });
        if (pathname.endsWith("/assistant/status")) return ok(configurationBlocked ? { available: false, reason: "model_not_configured" } : { available: true });
        if (pathname.endsWith("/assistant/sessions")) { if (configurationBlocked) return Response.json({ code: 503, reason: historyFailureReason }, { status: 503 }); return ok({ currentSessionId: "s1", sessions: [] }); }
        if (observerMode && pathname.endsWith("/assistant/history")) {
            historyReads++;
            if (observerSettled) return ok({ sessionId: "s1", active: null, turns: [{ turnId: "t-observer", userText: "只创建草案", selectedNodeIds: [],
                reply: "后台已完成", toolCalls: [], change: null, proposals: [], error: null, cancelled: false, createdAt: "2026-10-15" }] });
            if (!observerChatStarted) return ok({ sessionId: "s1", turns: [], active: null });
            if (holdObserverHistory) return new Promise<Response>(resolve => { heldObserverHistory.push(resolve); });
            return ok({ sessionId: "s1", turns: [], active: observerActive });
        }
        if (observerMode && pathname.endsWith("/assistant/chat")) {
            chatRequests++; observerChatStarted = true;
            return new Response([
                JSON.stringify({ type: "session", sessionId: "s1", turnId: "t-observer" }),
                JSON.stringify({ type: "text_delta", delta: "已开始。" }),
                JSON.stringify({ type: "observer_error", reason: "interrupted" }),
            ].join("\n") + "\n", { headers: { "content-type": "application/x-ndjson" } });
        }
        if (pathname.endsWith("/assistant/history")) {
            historyReads++;
            if (configurationBlocked) return Response.json({ code: 503, reason: historyFailureReason }, { status: 503 });
            if (seedHistoricalTurn) return ok({ sessionId: "s1", turns: [{ turnId: "past", userText: "旧消息", selectedNodeIds: [], reply: "此前保存的回复", toolCalls: [], change: null, proposals: [], error: null, cancelled: false }] });
            if (cancelled && historyFailure) return Response.json({ code: 500, msg: "Synthetic read failure" }, { status: 500 });
            return ok({ sessionId: "s1", turns: cancelled && settle ? [{ turnId: "t1", userText: "只创建草案", selectedNodeIds: [],
                reply: "两个草案已创建。已停止。", toolCalls: [], change: null, proposals: [], error: null, cancelled: true, createdAt: "2026-10-08" }] : [] });
        }
        if (pathname.endsWith("/assistant/cancel")) {
            cancelled = true; cancelRequests++; cancelBodies.push(await req.json());
            return ok(earlyStop ? { accepted: true, state: "pending" } : { accepted: true });
        }
        if (pathname.endsWith("/assistant/chat")) {
            chatRequests++; chatBodies.push(await req.json());
            if (earlyStop) return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "application/x-ndjson" } });
            if (rejectChat) return Response.json({ code: 413, reason: "body_too_large" }, { status: 413, headers: { "X-Beeftv-Turn-Admission": "rejected" } });
            return new Response(new ReadableStream({ start(controller) {
                controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: "text_delta", delta: "两个草案已创建。" }) + "\n"));
            } }), { headers: { "content-type": "application/x-ndjson" } });
        }
        if (pathname.startsWith("/api/")) return ok({});
        return new Response('<html><div id="root"></div><script type="module" src="/harness.js"></script></html>', { headers: { "content-type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); server?.stop(true); });

test("rejected oversized input leaves the real hook able to send another message", async () => {
    const page = await browser.newPage();
    try {
        rejectChat = true;
        await page.goto(server.url.toString());
        await page.getByRole("button", { name: "开始", exact: true }).click();
        await page.getByTestId("error").filter({ hasText: "本次消息内容过大" }).waitFor();
        expect(await page.getByTestId("streaming").innerText()).toBe("false");
        rejectChat = false;
        await page.getByRole("button", { name: "开始", exact: true }).click();
        await page.getByTestId("streamed").filter({ hasText: "两个草案已创建" }).waitFor();
        expect(chatRequests).toBe(2);
    } finally { rejectChat = false; await page.close(); }
});

test("real hook keeps received text after Stop until the matching durable receipt replaces it", async () => {
    const page = await browser.newPage(); await page.goto(server.url.toString());
    await page.getByRole("button", { name: "开始", exact: true }).click();
    await page.getByTestId("streamed").filter({ hasText: "两个草案已创建。" }).waitFor({ timeout: 10000 }).catch(async error => {
        throw new Error(error.message + " Hook UI: " + await page.locator("body").innerText() + " chats=" + chatRequests);
    });
    historyFailure = true;
    await page.getByRole("button", { name: "停止", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="streaming"]')?.textContent === "false");
    await page.getByTestId("history-error").filter({ hasText: "没能读取对话" }).waitFor();
    expect(await page.getByTestId("streamed").innerText()).toBe("两个草案已创建。");
    expect(await page.getByTestId("pending").innerText()).toBe("只创建草案");
    expect(await page.getByTestId("error").innerText()).toBe("");
    historyFailure = false;
    await page.getByRole("button", { name: "重新读取" }).click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="history-error"]')?.textContent);
    expect(await page.getByTestId("streamed").innerText()).toBe("两个草案已创建。");
    expect(await page.getByTestId("pending").innerText()).toBe("只创建草案");
    settle = true;
    await page.getByRole("button", { name: "重新读取" }).click();
    await page.getByTestId("history").filter({ hasText: "已停止" }).waitFor();
    expect(await page.getByTestId("pending").innerText()).toBe("");
    expect(await page.getByTestId("streamed").innerText()).toBe("");
    expect(chatRequests).toBe(1); expect(cancelRequests).toBe(1);
    await page.close();
}, 30000);

test("observer_error switches the real hook to reading the running turn, shows its progress, and never resubmits", async () => {
    observerMode = true; holdObserverHistory = true;
    const page = await browser.newPage();
    try {
        await page.goto(server.url.toString());
        await page.waitForFunction(() => document.querySelector('[data-testid="streaming"]')?.textContent === "false");
        await page.getByRole("button", { name: "开始", exact: true }).click();
        await page.waitForFunction(() => document.querySelector('[data-testid="awaiting"]')?.textContent === "true");
        // Still reading the result: not an unknown-outcome failure.
        expect(await page.getByTestId("error").innerText()).toBe("");
        expect(await page.getByTestId("pending").innerText()).toBe("只创建草案");
        expect(await page.getByTestId("streamed").innerText()).toBe("已开始。");
        for (let count = 0; !heldObserverHistory.length && count < 50; count++) await new Promise(resolve => setTimeout(resolve, 20));
        holdObserverHistory = false;
        for (const resolve of heldObserverHistory.splice(0)) resolve(Response.json({ code: 0, data: { sessionId: "s1", turns: [], active: observerActive } }));
        await page.getByTestId("lifecycle").filter({ hasText: "模型暂时没响应，正在再试一次。" }).waitFor({ timeout: 5000 });
        expect(await page.getByTestId("streaming").innerText()).toBe("true");
        expect(await page.getByTestId("error").innerText()).toBe("");
        observerSettled = true;
        await page.getByTestId("history").filter({ hasText: "后台已完成" }).waitFor({ timeout: 8000 });
        expect(await page.getByTestId("pending").innerText()).toBe("");
        expect(await page.getByTestId("lifecycle").innerText()).toBe("");
        expect(await page.getByTestId("error").innerText()).toBe("");
        expect(chatRequests).toBe(1);
    } finally { await page.close(); }
}, 30000);

test("Stop before the message is sent clears the pending message, says it stopped, and sends nothing", async () => {
    hostStarting = true;
    const page = await browser.newPage();
    try {
        await page.goto(server.url.toString());
        await page.getByRole("button", { name: "开始", exact: true }).click();
        await page.getByTestId("pending").filter({ hasText: "只创建草案" }).waitFor();
        expect(await page.getByTestId("streaming").innerText()).toBe("true");
        await page.getByRole("button", { name: "停止", exact: true }).click();
        await page.waitForFunction(() => document.querySelector('[data-testid="streaming"]')?.textContent === "false");
        expect(await page.getByTestId("pending").innerText()).toBe("");
        expect(await page.getByTestId("error").innerText()).toBe("已停下，这条消息没有发出。");
        expect(await page.getByTestId("awaiting").innerText()).toBe("false");
        expect(await page.getByTestId("history").innerText()).toBe("");
        expect(chatRequests).toBe(0); expect(cancelRequests).toBe(0);
    } finally { await page.close(); }
}, 15000);

test("Stop after sending but before the assistant got the message names that request, ends with a receipt, and stops polling", async () => {
    earlyStop = true;
    const page = await browser.newPage();
    try {
        await page.goto(server.url.toString());
        await page.getByRole("button", { name: "开始", exact: true }).click();
        for (let count = 0; !chatBodies.length && count < 200; count++) await new Promise(resolve => setTimeout(resolve, 20));
        expect(chatBodies).toHaveLength(1);
        await page.getByRole("button", { name: "停止", exact: true }).click();
        await page.getByTestId("error").filter({ hasText: "已停下，这条消息没有被处理。" }).waitFor({ timeout: 5000 });
        expect(cancelBodies).toEqual([{ canvasId: "c1", sessionId: "s1", requestId: chatBodies[0].requestId }]);
        expect(String(chatBodies[0].requestId)).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
        expect(await page.getByTestId("pending").innerText()).toBe("");
        expect(await page.getByTestId("streaming").innerText()).toBe("false");
        expect(await page.getByTestId("awaiting").innerText()).toBe("false");
        expect(await page.getByTestId("can-retry").innerText()).toBe("true");
        // No receipt is pending any more, so nothing keeps polling.
        const reads = historyReads;
        await new Promise(resolve => setTimeout(resolve, 2600));
        expect(historyReads).toBe(reads);
        // Retry is a new request; the stopped one stays stopped.
        earlyStop = false;
        await page.getByRole("button", { name: "重试", exact: true }).click();
        await page.getByTestId("streamed").filter({ hasText: "两个草案已创建。" }).waitFor();
        expect(chatBodies).toHaveLength(2);
        expect(chatBodies[1].requestId).not.toBe(chatBodies[0].requestId);
    } finally { await page.close(); }
}, 20000);

test("same canvas ID cannot carry history, active task, or delayed supplements across account epochs", async () => {
    scopeTest = true;
    const page = await browser.newPage(); await page.goto(server.url.toString() + "?scope-test");
    await page.getByTestId("history").filter({ hasText: "历史A" }).waitFor();
    expect(await page.getByTestId("pending").innerText()).toBe("任务A");
    await page.getByRole("button", { name: "补充", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="supplements"]')?.textContent === "补充A:sending");
    holdOldHistory = true;
    await page.getByRole("button", { name: "重新读取", exact: true }).click();
    for (let count = 0; !oldHistoryResolve && count < 30; count++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(oldHistoryResolve).not.toBeNull();
    await page.getByRole("button", { name: "切换用户", exact: true }).click();
    await page.getByTestId("history").filter({ hasText: "历史B" }).waitFor();
    expect(await page.getByTestId("session").innerText()).toBe("session-B");
    expect(await page.getByTestId("pending").innerText()).toBe("任务B");
    expect(await page.getByTestId("supplements").innerText()).toBe("");
    oldHistoryResolve!(Response.json({ code: 0, data: { sessionId: "session-A", turns: [{ turnId: "late-A", reply: "延迟旧历史A" }] } }));
    oldSteerResolve!(Response.json({ code: 0, data: { accepted: true } }));
    await page.getByRole("button", { name: "补充", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="supplements"]')?.textContent === "补充A:accepted");
    expect(await page.getByTestId("history").innerText()).toBe("历史B");
    expect(await page.getByTestId("pending").innerText()).toBe("任务B");
    expect(steerUsers).toEqual(["session-A", "session-B"]);
    expect(chatRequests).toBe(0); expect(cancelRequests).toBe(0);
    await page.close();
}, 15000);

test("unconfigured empty history waits for configuration, retains later recovered history, and does not hide real read failures", async () => {
    configurationBlocked = true;
    const page = await browser.newPage(); await page.goto(server.url.toString());
    await page.getByTestId("status-reason").filter({ hasText: "model_not_configured" }).waitFor();
    for (let count = 0; !historyReads && count < 30; count++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(historyReads).toBeGreaterThan(0);
    expect(await page.getByTestId("history-error").innerText()).toBe("");
    configurationBlocked = false; seedHistoricalTurn = true;
    await page.getByRole("button", { name: "刷新状态", exact: true }).click();
    await page.getByTestId("history").filter({ hasText: "此前保存的回复" }).waitFor();
    configurationBlocked = true;
    await page.getByRole("button", { name: "刷新状态", exact: true }).click();
    await page.getByTestId("status-reason").filter({ hasText: "model_not_configured" }).waitFor();
    await page.getByRole("button", { name: "重新读取", exact: true }).click();
    await page.getByTestId("history-error").filter({ hasText: "已有内容仍然保留" }).waitFor();
    expect(await page.getByTestId("history").innerText()).toBe("此前保存的回复");
    await page.close();
    historyFailureReason = "read_failed"; seedHistoricalTurn = false;
    const empty = await browser.newPage(); await empty.goto(server.url.toString());
    await empty.getByTestId("history-error").filter({ hasText: "没能读取对话。请重新读取。" }).waitFor();
    expect(await empty.getByTestId("history-error").innerText()).not.toContain("已有内容");
    await empty.close();
}, 15000);
