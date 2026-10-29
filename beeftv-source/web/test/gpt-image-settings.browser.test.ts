import { expect, test } from "bun:test";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { chromium } from "playwright";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

test("GPT Image 39档在设置面板均能点击并原值提交，明暗主题与窄屏可用", async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/gpt-image-settings-harness.tsx"], target: "browser", define: {
        "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"', "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"', "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"',
    }, plugins: [{ name: "source", setup(builder) {
        builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
    } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs.find((output) => output.path.endsWith(".js"))!.text();
    const cssPath = import.meta.dir + "/../src/styles/globals.css";
    const css = (await postcss([tailwind({ base: import.meta.dir + "/.." })]).process(readFileSync(cssPath, "utf8"), { from: cssPath })).css
        + readFileSync(import.meta.dir + "/../src/styles/beeftv-local-overrides.css", "utf8")
        + readFileSync(import.meta.dir + "/../src/styles/workspace-product.css", "utf8")
        + (await Promise.all(build.outputs.filter((output) => output.path.endsWith(".css")).map((output) => output.text()))).join("\n");
    const requests: Record<string, unknown>[] = [];
    const server = Bun.serve({ port: 0, async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/harness.js") return new Response(js, { headers: { "Content-Type": "application/javascript" } });
        if (url.pathname === "/harness.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
        if (url.pathname === "/api/tasks") {
            requests.push(await request.json());
            return Response.json({ code: 0, data: { id: `fixture-${requests.length}`, status: "queued", projectId: "fixture-project" } });
        }
        if (url.pathname.startsWith("/api/")) return new Response("Unexpected API request", { status: 500 });
        return new Response(`<html class="${url.searchParams.get("theme") === "dark" ? "dark" : ""}"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/harness.css"><body class="app-product-overlays"><div id="root" class="app-product-workspace"></div><script type="module" src="/harness.js"></script></body></html>`, { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
        for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
            const page = await browser.newPage({ viewport: { width, height: 1000 } });
            const errors: string[] = [];
            page.on("pageerror", (error) => errors.push(error.message));
            await page.route("https://**", (route) => route.abort());
            await page.goto(`${server.url}?theme=${theme}`);
            expect(await page.locator(".image-size-tiers").evaluate((element) => getComputedStyle(element).display)).toBe("grid");
            expect(await page.getByTestId("creation-labels").textContent()).toBe("超高、最高");
            expect(await page.getByRole("button", { name: "自动", exact: true }).count()).toBe(0);
            expect(await page.getByRole("button", { name: "低", exact: true }).getAttribute("aria-pressed")).toBe("true");
            await page.getByRole("button", { name: "校验请求", exact: true }).click();
            await page.waitForFunction(() => Boolean(document.querySelector('[role="status"]')?.textContent));
            expect((requests.at(-1)! as { input: { config: { quality: string } } }).input.config.quality).toBe("low");
            if (process.env.GPT_IMAGE_SETTINGS_SCREENSHOTS) {
                mkdirSync(process.env.GPT_IMAGE_SETTINGS_SCREENSHOTS, { recursive: true });
                await page.screenshot({ path: `${process.env.GPT_IMAGE_SETTINGS_SCREENSHOTS}/image2-default-${theme}-${width}.png`, fullPage: true });
            }
            for (const model of ["gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]) {
                await page.getByRole("combobox", { name: "模型" }).selectOption(`beefapi::${model}`);
                const qualities = model === "gpt-image-2" ? ["low", "medium", "high"] : ["low", "medium", "high", "xhigh", "max"];
                expect(await page.getByRole("button", { name: "最高", exact: true }).count()).toBe(model === "gpt-image-2" ? 0 : 1);
                for (const quality of qualities) {
                    const label = ({ low: "低", medium: "中", high: "高", xhigh: "超高", max: "最高" } as Record<string, string>)[quality]!;
                    await page.getByRole("button", { name: label, exact: true }).click();
                    for (const [tier, size] of [["1K", "1024x1024"], ["2K", "2048x2048"], ["4K", "2880x2880"]]) {
                        await page.getByRole("button", { name: tier, exact: true }).click();
                        expect(JSON.parse((await page.getByTestId("selection").textContent())!)).toEqual({ quality, size });
                        const before = requests.length;
                        await page.getByRole("button", { name: "校验请求", exact: true }).click();
                        await page.waitForFunction(() => Boolean(document.querySelector('[role="status"]')?.textContent));
                        expect(await page.locator('[role="status"]').textContent()).toBe("已校验");
                        expect(requests.length).toBe(before + 1);
                        const body = requests.at(-1)! as { input: { config: Record<string, unknown> } };
                        expect(body.input.config).toMatchObject({ model, quality, size, count: "1" });
                        const box = (await page.getByRole("button", { name: tier, exact: true }).boundingBox())!;
                        expect(box.x + box.width).toBeLessThanOrEqual(width);
                    }
                }
            }
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            expect(errors).toEqual([]);
            if (process.env.GPT_IMAGE_SETTINGS_SCREENSHOTS) {
                mkdirSync(process.env.GPT_IMAGE_SETTINGS_SCREENSHOTS, { recursive: true });
                await page.screenshot({ path: `${process.env.GPT_IMAGE_SETTINGS_SCREENSHOTS}/${theme}-${width}.png`, fullPage: true });
            }
            await page.close();
        }
        expect(requests.length).toBe(80);
    } finally { await browser.close(); server.stop(true); }
}, 90000);
