import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;
let failList = false;
let failDetail = false;
let delayA = false;
let reads: string[] = [];
let browserErrors: string[] = [];
const task = (id: string) => ({
    id, projectId: `unloaded-${id}`, type: "canvas_text", status: id === "a" ? "running" : "failed",
    prompt: id === "a" ? "跨画布运行任务" : "跨画布失败任务", model: "test-model", progress: 40,
    attempts: 1, createdAt: "2026-09-30T10:00:00Z", updatedAt: "2026-09-30T10:01:00Z",
    ...(id === "b" ? { error: "测试生成失败" } : {}),
});

beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/task-discovery-harness.tsx"], target: "browser", define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' },
        // Bun 1.3.9 does not discover src-only tsconfig aliases from test entrypoints.
        plugins: [{ name: "source-alias", setup(build) {
            build.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync(resolve(import.meta.dir, "../src", args.path.slice(2)), import.meta.dir) }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    server = Bun.serve({ port: 0, async fetch(request) {
        const url = new URL(request.url);
        const path = url.pathname;
        if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
        if (path === "/api/tasks") {
            reads.push(url.pathname + url.search);
            if (failList) return Response.json({ code: 1, msg: "test unavailable" }, { status: 503 });
            return Response.json({ code: 0, data: url.searchParams.get("activeOnly") === "true" ? [task("a")] : [task("a"), task("b")] });
        }
        if (path.startsWith("/api/tasks/")) {
            reads.push(path);
            const id = path.split("/")[3];
            if (id === "a" && delayA) await Bun.sleep(900);
            if (failDetail) return Response.json({ code: 1, msg: "test detail unavailable" }, { status: 503 });
            return Response.json({ code: 0, data: path.endsWith("/logs") ? [] : { ...task(id), prompt: `详情-${id}` } });
        }
        if (path.startsWith("/api/")) return Response.json({ code: 0, data: [] });
        return new Response('<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>', { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);

beforeEach(async () => {
    await page?.close();
    failList = false; failDetail = false; delayA = false; reads = []; browserErrors = [];
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on("pageerror", (error) => browserErrors.push(error.message));
    await page.goto(server.url.toString());
    await page.getByRole("button", { name: "跨画布运行任务", exact: true }).waitFor();
});

afterAll(async () => { await browser?.close(); server?.stop(true); });

test("desktop filters discover running and failed tasks without loaded canvases and deduplicate IDs", async () => {
    expect(await page.locator(".task-record-row").count()).toBe(2);
    expect(await page.getByText("未加载或已移除的画布 · unloaded-a", { exact: true }).isVisible()).toBe(true);
    await page.getByRole("radio", { name: /运行中/ }).click();
    await page.getByRole("button", { name: "跨画布失败任务", exact: true }).waitFor({ state: "hidden" });
    expect(await page.locator(".task-record-row").count()).toBe(1);
    expect(await page.getByRole("button", { name: "跨画布运行任务", exact: true }).isVisible()).toBe(true);
    await page.getByRole("radio", { name: /失败\/取消/ }).click();
    await page.getByRole("button", { name: "跨画布运行任务", exact: true }).waitFor({ state: "hidden" });
    expect(await page.locator(".task-record-row").count()).toBe(1);
    expect(await page.getByRole("button", { name: "跨画布失败任务", exact: true }).isVisible()).toBe(true);
    expect(reads.some((path) => path.includes("activeOnly=true"))).toBe(true);
    expect(browserErrors).toEqual([]);
});

test("detail read failure is visible instead of claiming an empty successful log read", async () => {
    failDetail = true;
    await page.getByRole("button", { name: "跨画布失败任务", exact: true }).click();
    await page.getByText("部分详情或日志读取失败", { exact: true }).waitFor();
    expect(await page.getByText("日志未完整读取", { exact: true }).isVisible()).toBe(true);
    expect(reads).toContain("/api/tasks/b");
    expect(reads).toContain("/api/tasks/b/logs");
    expect(browserErrors).toEqual([]);
});

test("late detail responses neither reopen a closed drawer nor replace a quickly selected task", async () => {
    delayA = true;
    await page.getByRole("button", { name: "跨画布运行任务", exact: true }).click();
    await page.getByRole("dialog").waitFor();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "跨画布失败任务", exact: true }).click();
    await page.getByText("详情-b", { exact: true }).waitFor();
    await page.waitForTimeout(1_100);
    expect(await page.getByText("详情-b", { exact: true }).isVisible()).toBe(true);
    expect(await page.getByText("详情-a", { exact: true }).count()).toBe(0);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "跨画布运行任务", exact: true }).click();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.waitForTimeout(1_100);
    expect(await page.getByRole("dialog").count()).toBe(0);
    expect(browserErrors).toEqual([]);
}, 10_000);

test("failed list reads display an unconfirmed state instead of a successful empty history", async () => {
    failList = true;
    await page.reload();
    await page.getByText("暂时无法确认任务状态", { exact: true }).waitFor();
    expect(await page.getByText("任务状态未完整同步", { exact: true }).isVisible()).toBe(true);
    expect(await page.getByText("还没有任务", { exact: true }).count()).toBe(0);
    expect(browserErrors).toEqual([]);
});
