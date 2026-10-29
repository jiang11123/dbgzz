import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
import { chromium, type Browser } from "playwright";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
const output = import.meta.dir + "/../../.local/depth-ui";
beforeAll(async () => {
    mkdirSync(output, { recursive: true });
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/depth-components-harness.tsx"], target: "browser", define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "aliases", setup(builder) { builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) })); } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    const stylesheet = import.meta.dir + "/../src/styles/globals.css";
    const css = (await postcss([tailwindcss({ base: import.meta.dir + "/.." })]).process(await Bun.file(stylesheet).text(), { from: stylesheet })).css;
    server = Bun.serve({ port: 0, fetch: req => {
        const path = new URL(req.url).pathname;
        if (path === "/app.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
        if (path === "/style.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
        return new Response('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script type="module" src="/app.js"></script>', { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); server?.stop(true); }, 30000);

test("first use requires confirmation and dismissing creates no download or task", async () => {
    const page = await browser.newPage();
    try {
        await page.goto(server.url.toString());
        await page.getByText("尚未安装", { exact: true }).waitFor();
        expect(await page.evaluate(() => (window as any).depthHarness.calls.downloads)).toBe(0);
        await page.getByRole("button", { name: "使用深度动作捕捉", exact: true }).click();
        const dialog = page.getByRole("dialog");
        await dialog.getByRole("button", { name: "下载并继续", exact: true }).waitFor();
        await dialog.getByRole("button", { name: "暂不下载", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
        expect(await page.evaluate(() => (window as any).depthHarness.calls)).toMatchObject({ downloads: 0, tasks: 0 });
    } finally { await page.close(); }
}, 30000);

test("confirmed first-use download continues only after installation succeeds", async () => {
    const page = await browser.newPage();
    try {
        await page.goto(server.url.toString());
        await page.getByRole("button", { name: "使用深度动作捕捉", exact: true }).click();
        const dialog = page.getByRole("dialog");
        await dialog.getByRole("button", { name: "下载并继续", exact: true }).click();
        await dialog.getByText("正在下载", { exact: true }).waitFor();
        expect(await page.evaluate(() => (window as any).depthHarness.calls)).toMatchObject({ downloads: 1, tasks: 0 });
        await page.evaluate(() => (window as any).depthHarness.ready());
        await page.getByText("深度任务已创建", { exact: true }).waitFor();
        expect(await dialog.count()).toBe(0);
    } finally { await page.close(); }
}, 30000);

test("settings download pauses and resumes explicitly, failures preserve a retry action", async () => {
    const page = await browser.newPage();
    try {
        await page.goto(server.url.toString());
        await page.getByRole("button", { name: "下载组件", exact: true }).click();
        await page.getByRole("button", { name: "暂停下载", exact: true }).click();
        await page.getByText("下载已暂停", { exact: true }).waitFor();
        await page.getByRole("button", { name: "继续下载", exact: true }).click();
        await page.evaluate(() => (window as any).depthHarness.fail());
        await page.getByText("下载连接中断，已下载文件保留。请重试。", { exact: true }).waitFor();
        expect(await page.getByRole("button", { name: "继续下载", exact: true }).isEnabled()).toBe(true);
        expect(await page.evaluate(() => (window as any).depthHarness.calls)).toMatchObject({ downloads: 2, pauses: 1, tasks: 0 });
    } finally { await page.close(); }
}, 30000);

for (const width of [1440, 390]) for (const dark of [false, true]) test(`component download consent and space check ${width}px dark=${dark}`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 950 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
        await page.goto(server.url + "?low-space" + (dark ? "&dark" : ""));
        await page.getByText("空间不足，请先更换目录或清理磁盘。", { exact: true }).waitFor();
        expect(await page.getByRole("button", { name: "下载组件", exact: true }).isDisabled()).toBe(true);
        await page.screenshot({ path: `${output}/settings-${width}-${dark}.png` });
        await page.getByRole("button", { name: "使用深度动作捕捉", exact: true }).click();
        const dialog = page.getByRole("dialog");
        expect(await dialog.getByRole("button", { name: "下载并继续", exact: true }).isDisabled()).toBe(true);
        await page.screenshot({ path: `${output}/consent-${width}-${dark}.png` });
        const bounds = await dialog.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
        expect(errors).toEqual([]);
    } finally { await page.close(); }
}, 30000);
