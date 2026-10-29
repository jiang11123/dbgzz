import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let page: Page;
let script: string;

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/canvas-node-drag-harness.tsx"],
        target: "browser", format: "esm",
        define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' },
        plugins: [{ name: "alias", setup(builder) {
            builder.onLoad({ filter: /src\/components\/model-logo\.tsx$/ }, () => ({ contents: "export function ModelLogo() { return null; }", loader: "js" }));
            builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    script = await build.outputs[0].text();
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ headless: true, executablePath });
    page = await browser.newPage();
    page.on("pageerror", (error) => console.error(error.message));
    await page.route("https://beeftv-title.test/**", (route) => route.fulfill(new URL(route.request().url()).pathname === "/app.js"
        ? { contentType: "text/javascript", body: script }
        : { contentType: "text/html", body: '<div id="root"></div><script type="module">import { mountNodeTitleHarness } from "/app.js"; mountNodeTitleHarness(document.getElementById("root"));</script>' }));
}, 30_000);

afterAll(async () => { await browser?.close(); });

async function mount() {
    await page.goto("https://beeftv-title.test/");
    await page.getByRole("button", { name: "编辑节点名称：原名称", exact: true }).click({ timeout: 2000 });
}

test("clicking canvas background commits a rename even when canvas suppresses native focus", async () => {
    await mount();
    await page.getByRole("textbox", { name: "节点名称", exact: true }).fill("雨夜街景");
    await page.getByTestId("canvas-background").click({ position: { x: 800, y: 500 } });
    expect(await page.getByTestId("saved-title").innerText()).toBe("雨夜街景");
    expect(await page.getByRole("textbox", { name: "节点名称", exact: true }).count()).toBe(0);
    expect(await page.getByTestId("commits").innerText()).toBe("1");
});

test("Escape cancels a rename without saving on the following outside click", async () => {
    await mount();
    const input = page.getByRole("textbox", { name: "节点名称", exact: true });
    await input.fill("不要保存");
    await input.press("Escape");
    await page.getByTestId("canvas-background").click({ position: { x: 800, y: 500 } });
    expect(await page.getByTestId("saved-title").innerText()).toBe("原名称");
    expect(await page.getByTestId("commits").innerText()).toBe("0");
});
