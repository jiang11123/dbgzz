import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let generationRequests = 0;
beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/external-video-settings-harness.tsx"], target: "browser", define: {
        "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"', "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"', "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"', "process.env.NODE_ENV": '"production"',
    }, plugins: [{ name: "source", setup(builder) {
        builder.onResolve({ filter: /^@\/components\/model-logo$/ }, () => ({ path: "model-logo", namespace: "test-icons" }));
        builder.onLoad({ filter: /.*/, namespace: "test-icons" }, () => ({ contents: "export function ModelLogo() { return null; }", loader: "js" }));
        builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
    } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs.find((output) => output.path.endsWith(".js"))!.text();
    const cssPath = import.meta.dir + "/../src/styles/globals.css";
    const css = (await postcss([tailwind({ base: import.meta.dir + "/.." })]).process(readFileSync(cssPath, "utf8"), { from: cssPath })).css
        + readFileSync(import.meta.dir + "/../src/styles/beeftv-local-overrides.css", "utf8")
        + readFileSync(import.meta.dir + "/../src/styles/workspace-product.css", "utf8")
        + await build.outputs.find((output) => output.path.endsWith(".css"))!.text();
    const providers = [
        { id: "newapi", name: "OpenAI Videos / Sora", create: "POST /v1/videos", poll: "GET /v1/videos/{task_id}", contentType: "multipart/form-data" },
        { id: "video-generations-json", name: "视频生成 JSON · ratio / duration", create: "POST /v1/video/generations", poll: "GET /v1/video/generations/{task_id}", contentType: "application/json" },
    ].map((provider) => ({ ...provider, version: "1.0.0", vendor: "BeefTV", categories: ["video"], scopes: ["user.custom-channel"], enabled: true }));
    server = Bun.serve({ port: 0, fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/harness.js") return new Response(js, { headers: { "Content-Type": "application/javascript" } });
        if (url.pathname === "/harness.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
        if (url.pathname === "/api/plugins/catalog") return Response.json({ code: 0, data: { providers }, msg: "ok" });
        if (url.pathname.startsWith("/api/")) { generationRequests++; return Response.json({ code: 0, data: {}, msg: "ok" }); }
        const dark = url.searchParams.get("theme") === "dark";
        return new Response(`<html class="${dark ? "dark" : ""}"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/harness.css"><body class="app-product-overlays"><div id="root" class="app-product-workspace"></div><script type="module" src="/harness.js"></script></body></html>`, { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60000);
afterAll(async () => { server?.stop(true); await browser?.close(); }, 30000);

test("an unconfigured model displays, tests and saves its explicitly selected channel protocol", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
        await page.goto(server.url.toString() + "?inherited=1");
        await page.getByRole("button", { name: "高级模型设置与测试", exact: true }).click();
        await page.getByText("POST /v1/video/generations", { exact: true }).waitFor();
        await page.getByRole("button", { name: "配置使用", exact: true }).click();
        expect(await page.locator('input[type="radio"][value="video-generations-json"]').isChecked()).toBe(true);
        expect(await page.getByRole("button", { name: "生成测试", exact: true }).isEnabled()).toBe(true);
        expect(await page.getByTestId("saved-profile").textContent()).toBe("unsaved");
        await page.getByRole("button", { name: /^完\s*成$/ }).click();
        await page.getByRole("button", { name: "保存并使用", exact: true }).click();
        await page.waitForFunction(() => document.querySelector('[data-testid="saved-profile"]')?.textContent === "video-generations-json");
        expect(generationRequests).toBe(0);
    } finally { await page.close(); }
}, 60000);

for (const [width, dark] of [[1280, false], [390, true]] as const) {
    test(`external video requires a chosen protocol and saves it (${width}, dark=${dark})`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
            await page.goto(server.url.toString() + (dark ? "?theme=dark" : ""));
            await page.getByRole("textbox", { name: "模型 ID", exact: true }).fill("seedance-2.5");
            await page.getByRole("combobox", { name: "模型类型", exact: true }).click();
            await page.locator('.ant-select-item-option[title="视频"]').click();
            await page.getByRole("button", { name: /^添\s*加$/ }).click();
            await page.getByRole("button", { name: "保存并使用", exact: true }).click();
            await page.getByText("seedance-2.5 还需要选择请求协议，请打开高级模型设置", { exact: true }).waitFor();
            expect(await page.getByTestId("saved-profile").textContent()).toBe("unsaved");
            await page.getByRole("button", { name: "配置使用", exact: true }).click();
            expect(await page.getByRole("button", { name: "生成测试", exact: true }).isDisabled()).toBe(true);
            expect(await page.locator('.choice-browser input[type="radio"]:checked').count()).toBe(0);
            await page.locator('input[type="radio"][value="video-generations-json"]').check();
            await page.getByText("application/json", { exact: true }).waitFor();
            await page.getByText("异步轮询", { exact: true }).waitFor();
            expect(await page.getByRole("button", { name: "生成测试", exact: true }).isEnabled()).toBe(true);
            const dialog = page.getByRole("dialog").last();
            const box = (await dialog.boundingBox())!;
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
            expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
            const output = process.env.BEEFTV_TEST_SCREENSHOT_DIR;
            if (output) { mkdirSync(output, { recursive: true }); await page.screenshot({ path: `${output}/external-video-${width}.png`, fullPage: true, animations: "disabled" }); }
            await page.getByRole("button", { name: /^完\s*成$/ }).click();
            await page.getByRole("button", { name: "保存并使用", exact: true }).click();
            await page.waitForFunction(() => document.querySelector('[data-testid="saved-profile"]')?.textContent === "video-generations-json");
            expect(errors).toEqual([]);
            expect(generationRequests).toBe(0);
        } finally { await page.close(); }
    }, 60000);
}
