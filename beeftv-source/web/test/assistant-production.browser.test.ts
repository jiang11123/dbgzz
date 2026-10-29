import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";

let browser: Browser, server: ReturnType<typeof Bun.serve>;
let currentSession = "s1", clearPlan = false, clearNextPlan = false;
let liveStream: ReadableStreamDefaultController<Uint8Array> | null = null;
let streamActive = false;
let liveText = "";
let liveLifecycle: Record<string, unknown> | undefined;
let historyToolCalls: unknown[] = [];
let chatStarted: Promise<void>, onChatStarted: () => void;
const chats: Array<{ message: string; selectedNodeIds: string[] }> = [];
const plan = { goal: "完成雨夜相遇的两个镜头", items: [
    { id: "s1", title: "分镜与首帧", status: "done" },
    { id: "s2", title: "检查首帧后制作视频", status: "needs_user", note: "等首帧生成后检查" },
], done: 1, total: 2, updatedAt: "2026-10-18" };
let livePlan = plan;
const turn = { turnId: "t1", userText: "做两个雨夜相遇镜头", selectedNodeIds: [], reply: "分镜和首帧方案已准备好。", toolCalls: [], change: null,
    proposals: [{ proposalId: "p1", kind: "image", nodeIds: ["source"], model: "图片模型", modelKey: "test::image" }], error: null, cancelled: false, createdAt: "2026-10-18" };
beforeEach(() => {
    chats.length = 0; currentSession = "s1"; clearPlan = false; clearNextPlan = false; streamActive = false; liveText = ""; livePlan = plan; historyToolCalls = []; liveLifecycle = undefined;
    chatStarted = new Promise(resolve => { onChatStarted = resolve; });
});

beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/assistant-production-harness.tsx"], target: "browser", define: {
        "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"', "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"',
        "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"', "process.env.NODE_ENV": '"production"',
    }, plugins: [{ name: "test-source", setup(builder) {
        builder.onResolve({ filter: /^@\/components\/model-logo$/ }, () => ({ path: "model-logo", namespace: "test-icons" }));
        builder.onLoad({ filter: /.*/, namespace: "test-icons" }, () => ({ contents: "export function ModelLogo() { return null; }", loader: "js" }));
        builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
    } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs.find(output => output.path.endsWith(".js"))!.text();
    const css = await build.outputs.find(output => output.path.endsWith(".css"))?.text() || "";
    const ok = (data: unknown) => Response.json({ code: 0, data });
    server = Bun.serve({ port: 0, async fetch(req) {
        const pathname = new URL(req.url).pathname;
        if (pathname === "/harness.js") return new Response(js, { headers: { "content-type": "application/javascript" } });
        if (pathname === "/harness.css") return new Response(css, { headers: { "content-type": "text/css" } });
        if (pathname.endsWith("/assistant/ui-session")) return ok({ token: "synthetic-only", expiresAt: new Date(Date.now() + 1800000).toISOString() });
        if (pathname.endsWith("/assistant/status")) return ok({ available: true });
        if (pathname.endsWith("/assistant/sessions") && req.method === "POST") { currentSession = "new"; return ok({ sessionId: currentSession }); }
        if (pathname.endsWith("/assistant/sessions")) return ok({ currentSessionId: currentSession, sessions: [{ sessionId: "s1", title: "雨夜创作" }, { sessionId: "s2", title: "另一条对话" }] });
        if (pathname.endsWith("/assistant/sessions/activate")) { currentSession = (await req.json()).sessionId; return ok({ sessionId: currentSession }); }
        if (pathname.endsWith("/assistant/history")) return ok({ sessionId: currentSession, turns: currentSession === "s1" ? [{ ...turn, toolCalls: historyToolCalls }] : [],
            ...(streamActive ? { active: { turnId: "live-turn", requestId: "live-request", userText: "开始实时制作", selectedNodeIds: [], status: "running", streamed: liveText, lifecycle: liveLifecycle }, plan: livePlan } : currentSession === "s1" && !clearPlan ? { plan } : {}) });
        if (pathname.endsWith("/assistant/chat")) {
            const body = await req.json(); chats.push(body);
            if (body.message === "开始实时制作") {
                streamActive = true;
                return new Response(new ReadableStream<Uint8Array>({ start(controller) { liveStream = controller; onChatStarted(); } }), { headers: { "content-type": "application/x-ndjson" } });
            }
            return new Response(JSON.stringify({ type: "turn_end", ...turn, turnId: `t${chats.length + 1}`, reply: "首帧检查完成", proposals: [], plan: clearNextPlan ? null : { ...plan, goal: "首帧已检查", items: plan.items.map(item => ({ ...item, status: "done" })) } }) + "\n", { headers: { "content-type": "application/x-ndjson" } });
        }
        if (pathname.startsWith("/api/")) return ok({});
        return new Response('<html><meta name="viewport" content="width=device-width"><style>:root{--background:#fff;--foreground:#222;--muted:#f4f4f4;--muted-foreground:#666;--border:#ddd;--card:#fafafa;--fs-body:14px;--radius-lg:12px}*{box-sizing:border-box}body{margin:0}</style><link rel="stylesheet" href="/harness.css"><div id="root"></div><script type="module" src="/harness.js"></script></html>', { headers: { "content-type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((item): item is string => Boolean(item && existsSync(item)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60000);

test("活跃观察流实时显示完整文字与制作计划，刷新从历史恢复而不再发消息", async () => {
    currentSession = "s1"; clearPlan = false; clearNextPlan = false;
    const page = await browser.newPage({ viewport: { width: 700, height: 900 } });
    try {
        await page.goto(server.url.toString().replace("localhost", "127.0.0.1"));
        await page.getByText("完成雨夜相遇的两个镜头", { exact: true }).waitFor();
        await page.locator('.canvas-assistant-composer [contenteditable="true"]').fill("开始实时制作");
        await page.getByRole("button", { name: "发送", exact: true }).click();
        await page.getByRole("button", { name: "停止", exact: true }).waitFor();
        await chatStarted;
        const before = chats.length;
        liveText = "开头、中段和尾部都完整。";
        livePlan = { ...plan, goal: "现在正在执行的计划" };
        const line = (payload: unknown) => new TextEncoder().encode(JSON.stringify(payload) + "\n");
        liveStream!.enqueue(line({ type: "text_snapshot", text: "开头、中段" }));
        liveStream!.enqueue(line({ type: "plan", plan: livePlan }));
        liveStream!.enqueue(line({ type: "text_snapshot", text: liveText }));
        await page.getByText("现在正在执行的计划", { exact: true }).waitFor();
        await page.getByText(liveText, { exact: true }).waitFor();
        liveStream!.enqueue(line({ type: "lifecycle", phase: "tool", toolName: "canvas_node_configure" }));
        await page.getByText("正在配置生成参数。", { exact: true }).waitFor();
        liveStream!.enqueue(line({ type: "lifecycle", phase: "tool_end", toolName: "canvas_node_configure", success: true }));
        await page.getByText("已配置生成参数，正在继续制作。", { exact: true }).waitFor();
        liveStream!.enqueue(line({ type: "lifecycle", phase: "compaction" }));
        await page.getByText("正在整理对话内容，方便继续。", { exact: true }).waitFor();
        liveStream!.enqueue(line({ type: "lifecycle", phase: "compaction_end", success: true }));
        await page.getByText("正在整理对话内容，方便继续。", { exact: true }).waitFor({ state: "hidden" });
        liveLifecycle = { type: "lifecycle", phase: "business", stage: "exporting", toolName: "canvas_timeline_deliver" };
        liveStream!.enqueue(line(liveLifecycle));
        await page.getByText("视频已可用，正在导出可编辑工程。", { exact: true }).waitFor();
        expect(chats.length).toBe(before);
        await page.reload();
        await page.getByText("现在正在执行的计划", { exact: true }).waitFor();
        await page.getByText(liveText, { exact: true }).waitFor();
        await page.getByText("视频已可用，正在导出可编辑工程。", { exact: true }).waitFor();
        expect(chats.length).toBe(before);
    } finally {
        streamActive = false;
        try { liveStream?.close(); } catch { /* Browser detached on reload. */ }
        liveStream = null;
        await page.close();
    }
}, 30000);
afterAll(async () => { await browser?.close(); server?.stop(true); });

test("媒体检查事实经真实历史 hook 显示并在刷新后保留，不发送模型请求", async () => {
    const source = { resourceId: "final-video", version: "a".repeat(64), startMs: 5000, endMs: 12000 };
    historyToolCalls = [
        { tool: "media.inspect", isError: false, mediaFacts: { source, mode: "video", durationMs: 18000, hasAudio: true } },
        { tool: "media.check", isError: false, mediaFacts: { source: { ...source, startMs: 0, endMs: 18000 }, mode: "check", durationMs: 18000, hasAudio: true,
            silenceIntervals: [{ startMs: 0, endMs: 18000 }], meanDb: -91, peakDb: -91 } },
    ];
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    try {
        await page.goto(server.url.toString().replace("localhost", "127.0.0.1"));
        for (let attempt = 0; attempt < 2; attempt++) {
            const facts = page.getByLabel("媒体检查记录");
            await facts.waitFor();
            expect(await facts.textContent()).toContain("视频片段读取：5–12 秒 · 全长 18 秒");
            expect(await facts.textContent()).toContain("该检测区间全段静音");
            expect(await facts.textContent()).not.toContain("合格");
            expect(await page.getByLabel("当前制作计划").textContent()).toContain("步骤进度 · 1/2");
            await page.locator(".canvas-assistant-sidebar").evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            expect(chats).toHaveLength(0);
            if (!attempt) await page.reload();
        }
        if (process.env.BEEFTV_MEDIA_FACTS_SCREENSHOT) {
            await page.getByLabel("媒体检查记录").scrollIntoViewIfNeeded();
            await page.screenshot({ path: process.env.BEEFTV_MEDIA_FACTS_SCREENSHOT, fullPage: true });
        }
        expect(errors).toEqual([]);
    } finally { await page.close(); }
}, 30000);

test("真实侧栏保留草稿与产物引用，由用户发送检查，并更新/清空当前会话计划", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(server.url.toString().replace("localhost", "127.0.0.1"));
    await page.getByText("完成雨夜相遇的两个镜头", { exact: true }).waitFor();
    const check = page.getByRole("button", { name: "检查结果", exact: true });
    expect(await check.isDisabled()).toBe(true);
    await page.evaluate(() => (window as any).productionFixture.finish());
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>("button")].some(button => button.textContent === "检查结果" && !button.disabled));
    expect(await page.getByText("确认后开始，按所选渠道计费。", { exact: false }).count()).toBe(0);
    const input = page.locator('.canvas-assistant-composer [contenteditable="true"]');
    await input.fill("保留我写好的结尾");
    await check.click(); await check.click();
    expect(await input.innerText()).toContain("保留我写好的结尾");
    expect((await input.innerText()).match(/检查这次生成/g)).toHaveLength(1);
    expect(chats).toHaveLength(0);
    expect(await page.getByText("已选 2 个节点", { exact: true }).count()).toBe(1);
    const saved = await page.evaluate(() => (window as any).productionFixture.draft());
    expect(saved.resultSelection).toEqual({ sessionId: "s1", nodeIds: ["result"] });
    await page.evaluate(() => (window as any).productionFixture.show(false));
    await page.waitForFunction(() => !document.querySelector('.canvas-assistant-sidebar'));
    await page.evaluate(() => (window as any).productionFixture.show(true));
    await page.getByText("已选 2 个节点", { exact: true }).waitFor();
    expect(await input.innerText()).toContain("保留我写好的结尾");
    await page.reload();
    await page.getByText("已选 2 个节点", { exact: true }).waitFor();
    expect(await input.innerText()).toContain("检查这次生成");
    await page.getByRole("button", { name: "历史对话", exact: true }).click();
    await page.getByText("另一条对话", { exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[aria-label="当前制作计划"]'));
    expect(await page.getByText("已选 2 个节点", { exact: true }).count()).toBe(0);
    expect(await page.getByText("已选 1 个节点", { exact: true }).count()).toBe(1);
    await page.getByRole("button", { name: "历史对话", exact: true }).click();
    await page.getByText("雨夜创作", { exact: true }).click();
    await page.getByText("已选 2 个节点", { exact: true }).waitFor();
    expect(chats).toHaveLength(0);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.getByText("首帧已检查", { exact: true }).waitFor();
    expect(chats).toHaveLength(1);
    expect(chats[0].selectedNodeIds).toEqual(["original", "result"]);
    expect(chats[0].message).toContain("保留我写好的结尾");
    await page.evaluate(() => (window as any).productionFixture.refresh());
    expect(await page.getByText("首帧已检查", { exact: true }).count()).toBe(1);
    expect(await page.locator("body").evaluate(element => element.scrollWidth <= window.innerWidth)).toBe(true);
    clearNextPlan = true;
    await input.fill("开始一个独立任务");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[aria-label="当前制作计划"]'));
    await page.evaluate(() => (window as any).productionFixture.refresh());
    expect(await page.locator('[aria-label="当前制作计划"]').count()).toBe(0);
    await page.getByRole("button", { name: "历史对话", exact: true }).click();
    await page.getByText("另一条对话", { exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[aria-label="当前制作计划"]'));
    await page.getByRole("button", { name: "历史对话", exact: true }).click();
    await page.getByText("雨夜创作", { exact: true }).click();
    await page.getByText("完成雨夜相遇的两个镜头", { exact: true }).waitFor();
    clearPlan = true;
    await page.evaluate(() => (window as any).productionFixture.refresh());
    await page.waitForFunction(() => !document.querySelector('[aria-label="当前制作计划"]'));
    clearPlan = false;
    await page.evaluate(() => (window as any).productionFixture.refresh());
    await page.getByText("完成雨夜相遇的两个镜头", { exact: true }).waitFor();
    await page.getByRole("button", { name: "新对话", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[aria-label="当前制作计划"]'));
    expect(errors).toEqual([]);
    await page.close();
}, 60000);
