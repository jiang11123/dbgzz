import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { chromium, type Browser } from "playwright";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
const version = readFileSync(new URL("../../VERSION", import.meta.url), "utf8").trim();

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/workspace-polish-harness.tsx"],
        target: "browser",
        define: { __APP_VERSION__: JSON.stringify(version), "process.env.NODE_ENV": '"production"' },
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs.find((output) => output.path.endsWith(".js"))!.text();
    const css = await build.outputs.find((output) => output.path.endsWith(".css"))?.text() || "";
    server = Bun.serve({ port: 0, fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/harness.js") return new Response(js, { headers: { "Content-Type": "application/javascript" } });
        if (path === "/harness.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
        return new Response('<html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/harness.css"><div id="root"></div><script type="module" src="/harness.js"></script></html>', { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60000);

afterAll(async () => { await browser?.close(); server?.stop(true); });

test("focused search survives pointer movement and closes on blur in both themes", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
        await page.goto(server.url.toString());
        for (let i = 0; i < 2; i++) {
            await page.getByRole("button", { name: /搜索项目/ }).click();
            const input = page.getByRole("textbox", { name: "搜索项目" });
            await input.fill("coffee");
            await page.mouse.move(385, 650);
            await input.press("End");
            await input.press("s");
            expect(await input.inputValue()).toBe("coffees");
            expect(await input.evaluate((element) => document.activeElement === element)).toBe(true);
            await page.getByRole("button", { name: "切换主题" }).click();
            await input.waitFor({ state: "hidden" });
            expect(await page.locator("output").textContent()).toBe("coffees");
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        }
        expect(errors).toEqual([]);
    } finally { await page.close(); }
}, 30000);

test("installed version displays release notes instead of a publication placeholder", async () => {
    const page = await browser.newPage();
    try {
        await page.goto(server.url.toString());
        await page.getByRole("button", { name: "更新日志", exact: true }).click();
        const dialog = page.getByRole("dialog");
        await dialog.waitFor();
        expect(await dialog.innerText()).toContain(version);
        expect(await dialog.locator("details[open] li").count()).toBeGreaterThan(0);
        expect(await dialog.innerText()).not.toContain("当前版本的更新内容将在发布后提供");
    } finally { await page.close(); }
}, 30000);
