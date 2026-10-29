import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/h3-middle-frame-harness.tsx"], target: "browser", define: {
        "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"', "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"', "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"', "process.env.NODE_ENV": '"production"',
    }, plugins: [{ name: "source", setup(builder) {
        builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
    } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs.find((output) => output.path.endsWith(".js"))!.text();
    const cssPath = import.meta.dir + "/../src/styles/globals.css";
    const css = (await postcss([tailwind({ base: import.meta.dir + "/.." })]).process(readFileSync(cssPath, "utf8"), { from: cssPath })).css;
    server = Bun.serve({ port: 0, fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/harness.js") return new Response(js, { headers: { "Content-Type": "application/javascript" } });
        if (url.pathname === "/harness.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
        return new Response(`<html class="${url.searchParams.get("theme") === "dark" ? "dark" : ""}"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/harness.css"><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>`, { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60000);

afterAll(async () => { server?.stop(true); await browser?.close(); }, 30000);

test("actual middle-frame menu clears its time and request assembly accepts reference and keyframe modes again", async () => {
    for (const [width, dark] of [[1280, false], [390, true]] as const) {
        const page = await browser.newPage({ viewport: { width, height: 850 } });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        // The test must stay entirely local; no reference image or model request is allowed.
        await page.route("https://**/*", (route) => route.abort());
        try {
            await page.goto(server.url.toString() + (dark ? "?theme=dark" : ""));
            await page.getByTitle("中间帧", { exact: true }).click();
            await page.getByRole("button", { name: "图片 3 · 中间图片", exact: true }).click();
            await page.getByLabel("中间帧时间（秒）").fill("2");
            await page.getByRole("button", { name: "验证请求参数", exact: true }).click();
            expect(JSON.parse((await page.getByTestId("payload").textContent())!).payload.middle_frame_time).toBe(2);
            await page.getByTitle("中间帧", { exact: true }).click();
            await page.getByRole("button", { name: "不指定", exact: true }).click();
            expect(await page.getByLabel("中间帧时间（秒）").inputValue()).toBe("");
            const saved = JSON.parse((await page.getByTestId("metadata").textContent())!);
            expect(saved).toEqual({ videoStartFrameNodeId: "first", videoEndFrameNodeId: "last" });
            await page.getByRole("button", { name: "验证请求参数", exact: true }).click();
            const reference = JSON.parse((await page.getByTestId("payload").textContent())!);
            expect(reference.error).toBeUndefined();
            expect(reference.referenceMode).toBe(true);
            expect(reference.payload.middle_frame_time).toBeUndefined();
            expect(reference.payload.middle_image_url).toBeUndefined();
            await page.getByRole("button", { name: "断开中间图片", exact: true }).click();
            await page.getByRole("button", { name: "验证请求参数", exact: true }).click();
            const keyframe = JSON.parse((await page.getByTestId("payload").textContent())!);
            expect(keyframe).toMatchObject({ referenceMode: false, frameMode: true, payload: { first_frame_url: "https://example.test/first.png", last_frame_url: "https://example.test/last.png" } });
            expect(keyframe.error).toBeUndefined();
            expect(errors).toEqual([]);
            expect(await page.getByTestId("controls").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
            if (process.env.BEEFTV_UI_EVIDENCE_DIR) {
                mkdirSync(process.env.BEEFTV_UI_EVIDENCE_DIR, { recursive: true });
                await page.getByTestId("controls").screenshot({ path: `${process.env.BEEFTV_UI_EVIDENCE_DIR}/h3-middle-cleared-${dark ? "dark-390" : "light-desktop"}.png` });
            }
        } finally { await page.close(); }
    }
}, 30000);
