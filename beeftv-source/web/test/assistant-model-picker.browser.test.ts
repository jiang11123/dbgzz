import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import { createModelChannel, defaultConfig } from "@/stores/use-config-store";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
const ids = ["gpt-6-astra", "claude-opus-5-5", "deepseek-v4.1-flash", "glm-5.3", "qwen3.8-flash", "wand-vega-vl-1.0-flash"];
const initial = { ...defaultConfig, assistantModel: "beefapi::claude-opus-5-5", channels: [createModelChannel({ id: "beefapi", pinned: true, enabled: true, models: ids, modelProfiles: ids.map(model => ({ model, capability: "text", protocol: "chat-completion" })) })] };
let saved = structuredClone(initial);
let writes = 0;
let submitted: string[] = [];
let failSave = false;
let release: (() => void) | undefined;
let holdSave = false;
let connectionState = "disconnected";
let disconnectCalls = 0;
let catalogReadFailures = 0;
beforeEach(() => { saved = structuredClone(initial); writes = 0; submitted = []; failSave = false; holdSave = false; release = undefined; });
beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/assistant-model-picker-harness.tsx"], target: "browser", define: { "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"', "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"', "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"', "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "source", setup(builder) {
        // Vite owns icon glob expansion; this Bun harness covers selection and persistence.
        builder.onResolve({ filter: /^@\/components\/model-logo$/ }, () => ({ path: "model-logo", namespace: "test-icons" }));
        builder.onLoad({ filter: /.*/, namespace: "test-icons" }, () => ({ contents: "export function ModelLogo() { return null; }", loader: "js" }));
        builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
    } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs.find(o => o.path.endsWith(".js"))!.text();
    const css = await build.outputs.find(o => o.path.endsWith(".css"))?.text() || "";
    const ok = (data: unknown) => Response.json({ code: 0, data });
    server = Bun.serve({ port: 0, async fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/harness.js") return new Response(js, { headers: { "Content-Type": "application/javascript" } });
        if (path === "/harness.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
        if (path.includes("model-config")) {
            if (req.method === "GET" && catalogReadFailures > 0) { catalogReadFailures--; return Response.json({ code: 500, msg: "Synthetic catalog read failure" }, { status: 500 }); }
            if (req.method === "GET") return ok({ config: saved, revision: writes });
            writes++;
            if (holdSave) await new Promise<void>(resolve => { release = resolve; });
            if (failSave) return Response.json({ code: 500, msg: "Synthetic save failure" }, { status: 500 });
            const body = await req.json(); saved = body.config;
            return ok({ saved: true, revision: writes });
        }
        if (path.endsWith("/beefapi/connection/start")) { connectionState = "connected"; saved.assistantModel = "beefapi::gpt-6-astra"; catalogReadFailures = 1; return ok({ state: connectionState }); }
        if (path.endsWith("/beefapi/connection/disconnect")) { disconnectCalls++; connectionState = "disconnected"; return ok({ state: connectionState }); }
        if (path.endsWith("/beefapi/connection")) return ok({ state: connectionState });
        if (path.endsWith("/assistant/ui-session")) return ok({ token: "synthetic-only", expiresAt: new Date(Date.now() + 1800000).toISOString() });
        if (path.endsWith("/assistant/status")) return ok({ available: true, model: { id: saved.assistantModel.split("::")[1], channelId: "beefapi" } });
        if (path.endsWith("/assistant/history")) return ok({ sessionId: "s1", turns: [] });
        if (path.endsWith("/assistant/sessions")) return ok({ sessionId: "s1", sessions: [] });
        if (path.endsWith("/assistant/chat")) { submitted.push(saved.assistantModel); return new Response(JSON.stringify({ type: "turn_end", turnId: "t1", reply: "synthetic", toolCalls: [], proposals: [] }) + "\n"); }
        if (path.startsWith("/api/")) return ok({});
        return new Response('<html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/harness.css"><div id="root"></div><script type="module" src="/harness.js"></script></html>', { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p): p is string => Boolean(p && existsSync(p)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60000);
afterAll(async () => { release?.(); await browser?.close(); server?.stop(true); });

test("default multimodal selection and explicit off persist without changing the main model", async () => {
    connectionState = "connected"; catalogReadFailures = 0;
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    page.setDefaultTimeout(6000);
    page.on("pageerror", error => console.error("multimodal picker page error:", error.message));
    try {
        await page.goto(new URL("/defaults", server.url).toString());
        const row = page.locator('section[aria-labelledby="default-multimodal-title"]');
        const picker = row.getByRole("combobox", { name: "默认多模态模型" });
        await picker.click();
        await page.locator('.ant-select-item-option-content').filter({ hasText: /^wand-vega-vl-1.0-flash/ }).click();
        await page.waitForTimeout(100);
        expect(saved.mediaReviewModel).toBe("beefapi::wand-vega-vl-1.0-flash");
        expect(saved.assistantModel).toBe("beefapi::claude-opus-5-5");
        await page.reload();
        expect(await row.innerText()).toContain("wand-vega-vl-1.0-flash");
        await picker.click();
        await page.locator('.ant-select-item-option-content').filter({ hasText: /^不使用独立多模态模型$/ }).click();
        await page.waitForTimeout(100);
        expect(saved.mediaReviewModel).toBe("");
        await page.reload();
        expect(await row.innerText()).toContain("不使用独立多模态模型");
    } catch (error) {
        console.error("multimodal picker body:", (await page.locator("body").innerText()).slice(0, 1500));
        throw error;
    } finally { await page.close(); }
}, 30000);

test("connected account can disconnect and expose the authorization action again", async () => {
    connectionState = "connected"; catalogReadFailures = 0; disconnectCalls = 0;
    const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
    try {
        await page.goto(new URL("/settings", server.url).toString());
        await page.getByRole("button", { name: "断开连接", exact: true }).click();
        const connect = page.locator("button:not(.ant-btn-loading)").filter({ hasText: /^连接 BeefTV$/ });
        await connect.waitFor({ timeout: 5000 });
        expect(disconnectCalls).toBe(1);
        expect(connectionState).toBe("disconnected");
        expect(await connect.isEnabled()).toBe(true);
    } finally { await page.close(); }
}, 30000);

test("settings retries failed connected catalog read and retains authorization default intent", async () => {
    connectionState = "disconnected"; catalogReadFailures = 0;
    const page = await browser.newPage(); await page.goto(new URL("/settings", server.url).toString());
    await page.getByRole("button", { name: "连接 BeefTV", exact: true }).click();
    const retry = page.getByRole("button", { name: "重试更新模型列表" });
    await retry.waitFor(); await retry.click();
    await retry.waitFor({ state: "hidden" });
    await page.getByRole("combobox", { name: "助手模型" }).click();
    expect(await page.locator('.ant-select-item-option-selected').innerText()).toContain("gpt-6-astra");
    await page.close();
}, 30000);

test("picker keyboard selection persists, respects busy and fits both themes at 390px", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
    await page.goto(server.url.toString());
    const picker = page.getByRole("combobox", { name: "助手模型" });
    await picker.focus(); await picker.press("ArrowDown");
    expect(await page.locator('.ant-select-item-option-content').allTextContents()).toEqual(["gpt-6-astra", "claude-opus-5-5", "deepseek-v4.1-flash", "glm-5.3"]);
    await picker.press("ArrowUp"); await picker.press("Enter");
    await page.waitForTimeout(100);
    expect(saved.assistantModel).toBe("beefapi::gpt-6-astra");
    await page.reload(); await page.getByRole("button", { name: "切换忙碌" }).click();
    expect(await picker.isDisabled()).toBe(true);
    for (let i = 0; i < 2; i++) {
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.getByRole("button", { name: "切换主题" }).click();
    }
    await page.close();
}, 30000);

test("models-only local default is selectable and survives reload", async () => {
    saved = { ...defaultConfig, assistantModel: "", textModel: "newapi-local::deepseek-v4-flash:free", channels: [createModelChannel({ id: "newapi-local", models: ["deepseek-v4-flash:free"], apiFormat: "openai" })] };
    const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
    await page.goto(server.url.toString());
    const picker = page.getByRole("combobox", { name: "助手模型" });
    for (let i = 0; i < 2; i++) {
        await picker.click();
        expect(await picker.isDisabled()).toBe(false);
        const option = page.locator('.ant-select-item-option-content');
        expect(await option.allTextContents()).toEqual(["deepseek-v4-flash:free"]);
        await option.click();
        await page.waitForFunction(() => !document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)'));
        await page.getByRole("button", { name: "切换主题" }).click();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.reload();
    }
    expect(saved.assistantModel).toBe("");
    expect(saved.textModel).toBe("newapi-local::deepseek-v4-flash:free");
    await page.close();
}, 30000);

test("next turn waits for saved selection; failed save cannot dispatch", async () => {
    const page = await browser.newPage(); await page.goto(server.url.toString());
    holdSave = true;
    await page.getByRole("combobox", { name: "助手模型" }).click();
    await page.locator('.ant-select-item-option-content').filter({ hasText: /^glm-5.3$/ }).click();
    await page.getByRole("button", { name: "发送测试消息" }).click();
    await page.waitForTimeout(100); expect(submitted).toEqual([]);
    expect(await page.getByRole("combobox", { name: "助手模型" }).isDisabled()).toBe(true);
    holdSave = false; release?.();
    await page.waitForTimeout(500); expect({ submitted, error: await page.locator('output').textContent(), saved: saved.assistantModel }).toEqual({ submitted: ["beefapi::glm-5.3"], error: "", saved: "beefapi::glm-5.3" });
    failSave = true;
    await page.getByRole("combobox", { name: "助手模型" }).click();
    await page.locator('.ant-select-item-option-content').filter({ hasText: /^gpt-6-astra$/ }).click();
    await page.getByRole("button", { name: "发送测试消息" }).click();
    await page.waitForFunction(() => document.querySelector('output')?.textContent?.includes('没保存成功'));
    expect(submitted).toHaveLength(1); await page.close();
}, 30000);
