import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import { productCss } from "./fixtures/product-css";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const bundle = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/canvas-prompt-font-harness.tsx"], target: "browser", define: { "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"', "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"', "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"', "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "source", setup(builder) {
        builder.onResolve({ filter: /^@\/components\/model-logo$/ }, () => ({ path: "model-logo", namespace: "test-icons" }));
        builder.onLoad({ filter: /.*/, namespace: "test-icons" }, () => ({ contents: "export function ModelLogo() { return null; }", loader: "js" }));
        builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
    } }] });
    if (!bundle.success) throw new Error(bundle.logs.join("\n"));
    const js = await bundle.outputs.find(output => output.path.endsWith(".js"))!.text();
    // Compile the actual Tailwind utilities and product CSS, including header geometry.
    const css = await productCss();
    server = Bun.serve({ port: 0, fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/harness.js") return new Response(js, { headers: { "Content-Type": "application/javascript" } });
        if (url.pathname === "/harness.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
        if (url.pathname.startsWith("/api/")) return Response.json({ code: 0, data: { items: [], providers: [], total: 0 } });
        return new Response(`<!doctype html><html class="${url.searchParams.get("theme") === "dark" ? "dark" : ""}"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/harness.css"><body class="app-product-overlays"><div id="root"></div><script type="module" src="/harness.js"></script></body></html>`, { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60000);

afterAll(async () => { await browser?.close(); server?.stop(true); }, 30000);

test("没有保存字号时，从放大编辑器首次调整也与节点保持一致", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
        await page.goto(server.url.toString());
        const panel = page.getByTestId("node-panel");
        const compact = panel.getByRole("textbox", { name: "图片提示词" });
        await compact.waitFor();
        const before = await compact.evaluate(element => parseFloat(getComputedStyle(element).fontSize));
        await panel.getByRole("button", { name: "放大编辑提示词" }).click();
        const dialog = page.getByRole("dialog");
        const expanded = dialog.getByRole("textbox", { name: "图片提示词" });
        expect(await expanded.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBe(before);
        await dialog.getByRole("button", { name: "放大提示词字号" }).click();
        expect(await expanded.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBe(before + 2);
        expect(await compact.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBe(before + 2);
    } finally { await context.close(); }
}, 30000);

for (const dark of [false, true]) {
    for (const width of [1440, 390]) {
        test(`提示词字号跨面板同步并在刷新后保留：${dark ? "深色" : "浅色"} / ${width}`, async () => {
            const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: 2 });
            const errors: string[] = [];
            page.on("pageerror", error => errors.push(error.message));
            await page.route("**/*", route => new URL(route.request().url()).origin === server.url.origin ? route.continue() : route.abort());
            try {
                await page.goto(server.url.toString() + (dark ? "?theme=dark" : ""));
                const panel = page.getByTestId("node-panel");
                const editor = panel.getByRole("textbox", { name: "图片提示词" });
                await editor.waitFor();
                const prompt = await page.getByTestId("prompt-value").textContent();
                for (let i = 0; i < 5; i++) await panel.getByRole("button", { name: "放大提示词字号" }).click();
                expect(await editor.evaluate(element => getComputedStyle(element).fontSize)).toBe("24px");
                expect(await page.getByTestId("config-composer").locator("[contenteditable]").evaluate(element => getComputedStyle(element).fontSize)).toBe("24px");
                expect(await page.getByTestId("prompt-value").textContent()).toBe(prompt);
                await panel.getByRole("button", { name: "放大编辑提示词" }).click();
                const dialog = page.getByRole("dialog");
                const expanded = dialog.getByRole("textbox", { name: "图片提示词" });
                await expanded.waitFor();
                expect(await expanded.evaluate(element => getComputedStyle(element).fontSize)).toBe("24px");
                await page.keyboard.press("Escape");
                await dialog.waitFor({ state: "hidden" });
                expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
                if (process.env.BEEFTV_FONT_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.BEEFTV_FONT_SCREENSHOT_DIR}/prompt-font-${dark ? "dark" : "light"}-${width}.png` });
                await page.reload();
                await panel.getByRole("button", { name: "放大提示词字号" }).waitFor();
                expect(await editor.evaluate(element => getComputedStyle(element).fontSize)).toBe("24px");
                for (let i = 0; i < 2; i++) await panel.getByRole("button", { name: "放大提示词字号" }).click();
                expect(await panel.getByRole("button", { name: "放大提示词字号" }).isDisabled()).toBe(true);
                for (let i = 0; i < 8; i++) await panel.getByRole("button", { name: "缩小提示词字号" }).click();
                expect(await panel.getByRole("button", { name: "缩小提示词字号" }).isDisabled()).toBe(true);
                expect(await editor.evaluate(element => getComputedStyle(element).fontSize)).toBe("12px");
                expect(errors).toEqual([]);
            } finally { await page.close(); }
        }, 30000);
    }
}
