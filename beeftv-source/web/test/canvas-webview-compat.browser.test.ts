import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";

let browser: Browser;
let script: string;

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/canvas-webview-compat-harness.tsx"],
        target: "browser",
        define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' },
        plugins: [{ name: "alias", setup(builder) {
            builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    script = await build.outputs[0].text();
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ headless: true, executablePath });
}, 30_000);

afterAll(async () => { await browser?.close(); });

for (const empty of [true, false]) test(`canvas mounts and searches without Array.toSorted (empty=${empty})`, async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
        await page.addInitScript(() => { Reflect.deleteProperty(Array.prototype, "toSorted"); });
        await page.route("https://beeftv.test/**", (route) => route.fulfill(new URL(route.request().url()).pathname === "/app.js"
            ? { contentType: "text/javascript", body: script }
            : { contentType: "text/html", body: '<div id="root"></div><script type="module" src="/app.js"></script>' }));
        await page.goto(`https://beeftv.test/${empty ? "?empty" : ""}`);
        expect(await page.evaluate(() => typeof Array.prototype.toSorted)).toBe("undefined");
        await page.getByTestId("canvas-ready").waitFor();
        expect(await page.getByRole("dialog").count()).toBe(0);
        expect(JSON.parse(await page.getByTestId("checks").innerText())).toEqual({
            sorted: ["newer", "older"], original: ["older", "newer"], inserted: [0, 1, 2], updated: [0, 2],
            bones: [0, 2], boneUpdated: [2], length: 6, camera: { target: [2, 0, 0], fov: 50 },
            originalKeys: [2, 0], originalBoneKeys: [2],
        });
        await page.getByRole("button", { name: "Search nodes", exact: true }).click();
        await page.getByRole("dialog").waitFor();
        if (!empty) {
            const input = page.getByRole("textbox");
            await input.fill("night scene");
            expect(await page.getByText("Older note", { exact: true }).count()).toBe(1);
            expect(await page.getByText("Newer note", { exact: true }).count()).toBe(0);
            await input.press("Enter");
            expect(await page.getByTestId("focused").innerText()).toBe("older");
        }
        expect(errors).toEqual([]);
    } finally { await page.close(); }
}, 20_000);
