import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { existsSync } from "node:fs";

test("生成图片拉取失败显示重试，点击后恢复图片，明暗主题和窄屏均可操作", async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/canvas-image-recovery-harness.tsx"], target: "browser",
        define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"', "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"false"', "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"' },
        plugins: [{ name: "assets", setup(builder) {
            builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
            builder.onLoad({ filter: /\.(css|svg|png|jpe?g|gif|webp|woff2?)$/ }, () => ({ contents: "export default ''", loader: "js" }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    let downloads = 0;
    let failureMode = "transport";
    const server = Bun.serve({ port: 0, fetch: (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
        if (path === "/api/resources/preview/file") {
            if (++downloads === 1) return failureMode === "transport" ? new Response("temporarily unavailable", { status: 503 }) : new Response("invalid image bytes", { headers: { "Content-Type": "image/png" } });
            return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>', { headers: { "Content-Type": "image/svg+xml" } });
        }
        if (path.startsWith("/api/")) return Response.json({ code: 0, data: {}, msg: "" });
        return new Response('<style>*{box-sizing:border-box}#root>div>div{height:100%}#root img{width:100%;height:100%}.h-full,.size-full{height:100%}.w-full,.size-full{width:100%}.flex,.inline-flex{display:flex}.flex-col{flex-direction:column}.items-center{align-items:center}.justify-center{justify-content:center}.gap-2{gap:8px}.gap-1\\.5{gap:6px}.text-xs{font-size:12px}.size-7{width:28px;height:28px}.size-4{width:16px;height:16px}.overflow-hidden{overflow:hidden}button{font:inherit}</style><div id=root></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path) => path && existsSync(path));
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
        for (const scenario of [{ theme: "light", mode: "transport", scale: 1 }, { theme: "dark", mode: "decode", scale: 1 }, { theme: "light", mode: "decode", scale: 0.2 }, { theme: "dark", mode: "transport", scale: 0.2 }]) {
            const { theme, mode, scale } = scenario;
            failureMode = mode;
            downloads = 0;
            const context = await browser.newContext({ viewport: { width: 390, height: 500 } });
            const page = await context.newPage();
            page.on("pageerror", (error) => console.error(error.message));
            await page.goto(`${server.url}?theme=${theme}&scale=${scale}`);
            const status = page.getByRole("status", { name: "图片加载失败" });
            await status.waitFor({ timeout: 7000 });
            expect(await status.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
            const button = page.getByRole("button", { name: "重新加载图片" });
            const bounds = (await button.boundingBox())!;
            const parentBounds = (await status.boundingBox())!;
            expect(bounds.width).toBeGreaterThanOrEqual(27);
            expect(bounds.height).toBeGreaterThanOrEqual(scale < 1 ? 27 : 16);
            expect(bounds.x).toBeGreaterThanOrEqual(parentBounds.x);
            expect(bounds.y).toBeGreaterThanOrEqual(parentBounds.y);
            expect(bounds.x + bounds.width).toBeLessThanOrEqual(parentBounds.x + parentBounds.width + 1);
            expect(bounds.y + bounds.height).toBeLessThanOrEqual(parentBounds.y + parentBounds.height + 1);
            const recorded = await page.evaluate(() => (window as unknown as { imageDiagnostics: () => Array<{ code: string; taskId: string; route: string }> }).imageDiagnostics());
            const failure = recorded.find(event => event.code === (mode === "decode" ? "CANVAS_IMAGE_DECODE_FAILED" : "CANVAS_IMAGE_READ_FAILED"));
            expect(failure?.taskId).toBe("original-image-task");
            expect(failure?.route).toBe("/resources/preview/file");
            expect(JSON.stringify(recorded)).not.toContain("DO_NOT_LOG");
            // Click near the painted edge, not only the centre, to verify the
            // inverse-scaled control's real hit target on a zoomed canvas.
            await page.mouse.click(bounds.x + bounds.width - 3, bounds.y + bounds.height / 2);
            await page.waitForFunction(() => Boolean(document.querySelector("img")?.naturalWidth));
            expect(await page.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(16);
            expect(downloads).toBe(2);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            await context.close();
        }
    } finally { await browser.close(); server.stop(true); }
}, 60000);
