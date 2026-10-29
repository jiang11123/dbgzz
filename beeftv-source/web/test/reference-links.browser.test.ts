import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/reference-links-harness.tsx"], target: "browser", plugins: [{ name: "alias", setup(builder) {
        builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
    } }], define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' } });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    server = Bun.serve({ port: 0, fetch: (request) => new URL(request.url).pathname === "/app.js" ? new Response(script, { headers: { "Content-Type": "text/javascript" } }) : new Response('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/app.js"></script>', { headers: { "Content-Type": "text/html" } }) });
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
}, 30_000);
afterAll(async () => { await browser?.close(); server?.stop(true); }, 30000);
for (const width of [1280, 390]) for (const dark of [false, true]) test(`links form ${width}px dark=${dark}`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
        await page.goto(server.url + (dark ? "?dark" : ""));
        await page.getByRole("button", { name: "生成", exact: true }).click();
        const submit = page.getByRole("button", { name: "使用链接并生成" });
        await submit.waitFor();
        expect(await page.getByRole("dialog").count()).toBe(1);
        expect(await submit.isDisabled()).toBe(true);
        await page.getByRole("textbox", { name: "参考图片 1" }).fill("http://cdn.example/a.png");
        await page.getByRole("textbox", { name: "参考视频 1" }).fill("https://cdn.example/b.mp4");
        expect(await submit.isDisabled()).toBe(true);
        await page.getByRole("textbox", { name: "参考图片 1" }).fill("https://cdn.example/a.png");
        expect(await submit.isEnabled()).toBe(true);
        const bounds = await page.getByRole("dialog").boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        await page.screenshot({ path: `/tmp/beeftv-reference-links-${width}-${dark}.png` });
        await submit.click();
        await page.getByText("confirmed", { exact: true }).waitFor();
        await page.getByRole("button", { name: "生成", exact: true }).click();
        await page.getByRole("button", { name: /取\s*消/ }).click();
        await page.getByText("cancelled", { exact: true }).waitFor();
        expect(errors).toEqual([]);
    } finally { await page.close(); }
}, 20_000);
