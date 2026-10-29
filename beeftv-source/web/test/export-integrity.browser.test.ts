import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { build } from "vite";

let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
let directory: string;

beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "beeftv-zip-browser-"));
    const dist = join(directory, "dist");
    // Use the application's bundler, including real lazy-editor assets. Bun.build
    // resolved this graph differently between local Bun 1.4 and CI Bun 1.3.9.
    await build({
        configFile: false, root: resolve(import.meta.dir, ".."), publicDir: false,
        cacheDir: join(directory, "cache"), logLevel: "error",
        define: { __BEEFTV_HEAVY_MEDIA_ENABLED__: "true", __APP_VERSION__: '"test"', __APP_CHANGELOG__: '""' },
        resolve: { alias: { "@": resolve(import.meta.dir, "../src") } },
        build: { outDir: dist, emptyOutDir: true, rolldownOptions: { input: resolve(import.meta.dir, "fixtures/export-integrity-harness.html") } },
    });
    server = Bun.serve({ port: 0, async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path.startsWith("/api/")) return Response.json({ code: 0, data: { projects: [], assets: [], folders: [] } });
        const file = path === "/" ? join(dist, "test/fixtures/export-integrity-harness.html") : resolve(dist, "." + path);
        return file.startsWith(dist + sep) && existsSync(file) ? new Response(Bun.file(file)) : new Response("Not found", { status: 404 });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);

afterAll(async () => { await browser?.close(); server?.stop(true); if (directory) rmSync(directory, { recursive: true, force: true }); });

test("the actual library export shows a stalled file, suppresses duplicate clicks and cancels without saving", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let requests = 0;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
        await page.goto(server.url.toString());
        await page.getByRole("button", { name: "测试缺失导出" }).waitFor();
        const project = await page.evaluate(() => (window as any).exportFixture.seedBlockingExport());
        await page.route("**/api/canvas-projects/blocked-export", (route) => route.fulfill({ json: { code: 0, data: { project: { ...project, revision: 1 } } } }));
        await page.route("**/api/resources/blocked-export/file*", async (route) => {
            requests++;
            await gate;
            await route.fulfill({ status: 200, contentType: "audio/wav", body: "late media bytes" });
        });
        await page.getByRole("checkbox", { name: "选择 测试 blocked-export" }).check();
        const downloadStarted = page.waitForRequest((request) => request.url().includes("/resources/blocked-export/file"));
        await page.getByRole("button", { name: "导出", exact: true }).click();
        await page.getByRole("status").filter({ hasText: "正在读取文件 0/1" }).waitFor();
        await downloadStarted;
        await page.getByRole("button", { name: "导出", exact: true }).evaluate((button: HTMLButtonElement) => button.click());
        await page.getByRole("checkbox", { name: "选择 测试 blocked-export" }).uncheck();
        await page.getByRole("status").filter({ hasText: "正在读取文件 0/1" }).waitFor();
        await page.getByRole("button", { name: "取消导出", exact: true }).click();
        await page.getByRole("button", { name: "取消导出", exact: true }).waitFor({ state: "detached" });
        release();
        expect(requests).toBe(1);
        expect((await page.evaluate(() => (window as any).exportFixture.snapshot())).archive).toBe("");
        expect(errors).toEqual([]);
    } finally { release(); await context.close(); }
}, 20_000);

test("ZIP from real browser storage imports through CanvasPage into a fresh browser workspace", async () => {
    const source = await browser.newContext();
    const target = await browser.newContext();
    try {
        const page = await source.newPage();
        await page.goto(server.url.toString());
        await page.getByRole("button", { name: "测试缺失导出" }).waitFor();
        const archive = await page.evaluate(async () => (window as any).exportFixture.export());
        const imported = await target.newPage();
        await imported.goto(server.url.toString());
        await imported.getByRole("button", { name: "测试缺失导出" }).waitFor();
        const before = await imported.evaluate(async () => (window as any).exportFixture.snapshot());
        expect(before.projects).toHaveLength(0);
        expect(before.media).toBeNull();
        await imported.locator('input[type="file"]').setInputFiles({ name: "fixture.zip", mimeType: "application/zip", buffer: Buffer.from(archive, "base64") });
        await imported.getByText("已导入 2 个画布并保存到本地", { exact: true }).waitFor({ timeout: 15_000 });
        const after = await imported.evaluate(async () => (window as any).exportFixture.snapshot());
        expect(after.projects).toHaveLength(2);
        expect(after.media).toBe("unique archive bytes");
        for (const project of after.projects) {
            const media = project.timeline.clips[0].directMedia;
            expect(media.storageKey).toStartWith("audio:guest:");
            expect(media.storageKey).not.toBe("audio:fixture:voice");
            expect(media.url).toStartWith("blob:");
            expect(media.url).not.toBe("blob:expired");
        }
        await imported.reload();
        await imported.getByRole("button", { name: "测试缺失导出" }).waitFor();
        const reloaded = await imported.evaluate(async () => (window as any).exportFixture.snapshot());
        expect(reloaded.projects).toHaveLength(2);
        expect(reloaded.media).toBe("unique archive bytes");
    } finally { await source.close(); await target.close(); }
}, 30_000);

test("empty workspace ZIP restores into a fresh empty browser workspace", async () => {
    const source = await browser.newContext();
    const target = await browser.newContext();
    try {
        const page = await source.newPage();
        await page.goto(server.url.toString());
        await page.getByRole("button", { name: "测试缺失导出" }).waitFor();
        const archive = await page.evaluate(async () => (window as any).exportFixture.exportEmpty());
        const imported = await target.newPage();
        await imported.goto(server.url.toString());
        await imported.getByRole("button", { name: "测试缺失导出" }).waitFor();
        const before = await imported.evaluate(async () => (window as any).exportFixture.snapshot());
        expect(before.projects).toHaveLength(0);
        expect(before.media).toBeNull();
        await imported.locator('input[type="file"]').setInputFiles({ name: "empty.zip", mimeType: "application/zip", buffer: Buffer.from(archive, "base64") });
        await imported.getByText("已导入 0 个画布并保存到本地", { exact: true }).waitFor({ timeout: 15_000 });
        const after = await imported.evaluate(async () => (window as any).exportFixture.snapshot());
        expect(after.projects).toHaveLength(0);
        expect(after.media).toBeNull();
    } finally { await source.close(); await target.close(); }
}, 30_000);

test("corrupt canvas ZIP fails in an empty workspace and writes no media", async () => {
    const context = await browser.newContext();
    try {
        const page = await context.newPage();
        await page.goto(server.url.toString());
        await page.getByRole("button", { name: "测试缺失导出" }).waitFor();
        await page.locator('input[type="file"]').setInputFiles({
            name: "corrupt.zip",
            mimeType: "application/zip",
            buffer: Buffer.from("PK\u0003\u0004not-a-canvas-backup"),
        });
        await page.getByText(/导入失败/).waitFor({ timeout: 15_000 });
        const after = await page.evaluate(async () => (window as any).exportFixture.snapshot());
        expect(after.projects).toHaveLength(0);
        expect(after.media).toBeNull();
    } finally { await context.close(); }
}, 15_000);

test("missing-file error is actually visible and no archive is saved", async () => {
    const context = await browser.newContext();
    try {
        const page = await context.newPage();
        await page.goto(server.url.toString());
        await page.getByRole("button", { name: "测试缺失导出" }).click();
        await page.getByText(/导出未完成：缺少 1 个文件/).waitFor();
        expect(await page.getByText(/导出未完成：缺少 1 个文件/).innerText()).toContain("audio:fixture:voice");
        expect((await page.evaluate(async () => (window as any).exportFixture.snapshot())).archive).toBe("");
    } finally { await context.close(); }
}, 15_000);

test("automatic canvas creation failure leaves the opening screen and shows a retryable library", async () => {
    const context = await browser.newContext();
    try {
        const page = await context.newPage();
        const pageErrors: string[] = [];
        const requests: string[] = [];
        const consoleErrors: string[] = [];
        await page.addInitScript(() => {
            const seen: string[] = [];
            Object.assign(window, { creationMessages: seen });
            new MutationObserver(() => {
                for (const node of document.querySelectorAll(".ant-message-notice-content")) {
                    const text = node.textContent || "";
                    if (text && !seen.includes(text)) seen.push(text);
                }
            }).observe(document, { childList: true, subtree: true });
        });
        page.on("pageerror", (error) => pageErrors.push(error.message));
        page.on("console", (entry) => { if (entry.type() === "error") consoleErrors.push(entry.text()); });
        page.on("request", (request) => { if (request.url().includes("/api/")) requests.push(`${request.method()} ${request.url()}`); });
        await page.route("**/api/ops/**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: 503, msg: "测试保存失败", reason: "storage_unavailable" }) }));
        await page.route("**/api/canvas-projects/*", (route) => route.request().method() === "PUT"
            ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: 503, msg: "测试保存失败", reason: "storage_unavailable" }) })
            : route.continue());
        const url = new URL(server.url);
        url.hostname = "127.0.0.1";
        url.search = "?new=1";
        await page.goto(url.toString());
        await page.getByText("测试保存失败", { exact: true }).waitFor({ timeout: 5000 }).catch(async () => { throw new Error(JSON.stringify({ text: await page.locator("body").innerText(), requests, pageErrors, consoleErrors, messages: await page.evaluate(() => (window as any).creationMessages) })); });
        expect(requests.some((entry) => entry.startsWith("PUT ") && entry.includes("/api/canvas-projects/"))).toBe(true);
        expect(await page.getByText("正在打开画布...", { exact: true }).count()).toBe(0);
        expect(await page.getByRole("button", { name: "开始创作", exact: true }).count()).toBe(1);
        expect(await page.getByTestId("canvas-route").textContent()).toBe("/canvas?mode=new");

        // Retry must also wait for a durable receipt before navigating.
        let acceptSave!: () => void;
        const saveGate = new Promise<void>((resolve) => { acceptSave = resolve; });
        let startedSave!: () => void;
        const saveStarted = new Promise<void>((resolve) => { startedSave = resolve; });
        let savedId = "";
        await page.route("**/api/canvas-projects/*", async (route) => {
            if (route.request().method() !== "PUT") return route.fallback();
            const { project } = route.request().postDataJSON();
            savedId = project.id;
            startedSave();
            await saveGate;
            await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: 0, data: { project: { ...project, revision: 1 } } }) });
        });
        await page.getByRole("button", { name: "开始创作", exact: true }).click();
        await saveStarted;
        expect(await page.getByTestId("canvas-route").textContent()).toBe("/canvas?mode=new");
        acceptSave();
        await page.waitForFunction((id) => document.querySelector('[data-testid="canvas-route"]')?.textContent === `/canvas/${id}?mode=new`, savedId);
        expect(pageErrors).toEqual([]);
    } finally { await context.close(); }
}, 15_000);

test("fresh IndexedDB can initialize app_state and folder pending together", async () => {
    const context = await browser.newContext();
    try {
        const page = await context.newPage();
        await page.goto(server.url.toString());
        await page.getByRole("button", { name: "测试缺失导出" }).waitFor();
        const result = await page.evaluate(async () => (window as any).exportFixture.probeSharedStores());
        expect(result.error).toBeUndefined();
        expect(result.journal).toBe("{\"ok\":true}");
        expect(result.pending).toEqual({ version: 1, intents: {}, highWater: {} });
    } finally { await context.close(); }
}, 15_000);
