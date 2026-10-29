import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "vite";

const enabled = process.env.BEEFTV_BROWSER_WORKER_TEST === "1";
test.skipIf(!enabled)("所有视频入口按需准备预览，失败可重试，可播放原件不转码", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beeftv-video-recovery-"));
    const file = join(dir, "preview.mp4");
    const result = spawnSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x48:r=5:d=0.4", "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
    if (result.status !== 0) throw new Error(result.stderr.toString());
    const dist = join(dir, "dist");
    await build({ configFile: false, root: join(import.meta.dir, ".."), publicDir: false, logLevel: "error",
        define: { __APP_VERSION__: '"test"', __APP_CHANGELOG__: '""', __BEEFTV_HEAVY_MEDIA_ENABLED__: "false", "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"false"', "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"' },
        resolve: { alias: { "@": join(import.meta.dir, "../src") } },
        build: { outDir: dist, emptyOutDir: true, rolldownOptions: { input: join(import.meta.dir, "fixtures/canvas-video-recovery-harness.html") } },
    });
    let mode = "fallback", prepares = 0, status = "none";
    const server = Bun.serve({ port: 0, fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/resources/video/playback") { prepares++; status = mode === "retry" && prepares === 1 ? "failed" : "ready"; }
        if (url.pathname === "/api/resources/video" || url.pathname.endsWith("/playback")) return Response.json({ code: 0, data: { resource: { id: "video", provider: "local", kind: "video", playbackStatus: status } } });
        if (url.pathname === "/api/resources/video/file") {
            const compatible = url.searchParams.get("variant") === "playback" && status === "ready" && (mode !== "missing" || prepares > 0);
            return new Response(mode === "direct" || compatible ? Bun.file(file) : "un-decodable original", { headers: { "Content-Type": "video/mp4", ETag: compatible ? '"video:pb"' : '"video"' } });
        }
        if (url.pathname.startsWith("/api/")) return Response.json({ code: 0, data: {} });
        const asset = url.pathname === "/" ? join(dist, "test/fixtures/canvas-video-recovery-harness.html") : join(dist, url.pathname);
        return existsSync(asset) ? new Response(Bun.file(asset)) : new Response("Not found", { status: 404 });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => p && existsSync(p));
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
        for (const surface of ["canvas", "editor", "attachment", "drawer", "thumbnail"]) {
        for (const scenario of surface === "thumbnail" ? ["fallback", "missing", "direct"] : ["fallback", "missing", "retry", "direct"]) {
            mode = scenario; prepares = 0; status = mode === "missing" ? "ready" : "none";
            const context = await browser.newContext();
            const page = await context.newPage();
            const pageErrors: string[] = [];
            page.on("pageerror", (error) => { pageErrors.push(error.message); console.error(error.stack); });
            await page.goto(`${server.url}?surface=${surface}`);
            if (mode === "retry") {
                const name = surface === "attachment" ? "重读预览" : surface === "drawer" ? /重\s*试/ : "重新加载";
                await page.getByRole("button", { name, exact: true }).waitFor({ timeout: 7000 });
                await page.getByRole("button", { name, exact: true }).click();
            }
            try {
                await page.waitForFunction(() => { const video = document.querySelector("video"); return video && video.readyState >= 2 && video.videoWidth === 64; }, undefined, { timeout: 7000 });
            } catch (error) {
                console.error({ surface, mode, prepares, status, state: await page.evaluate(() => {const v=document.querySelector("video");return {text:document.body.innerText,video:v?.outerHTML,network:v?.networkState,error:v?.error?.code,currentSrc:v?.currentSrc};}) });
                throw error;
            }
            expect(prepares).toBe(mode === "direct" ? 0 : mode === "retry" ? 2 : 1);
            expect(pageErrors).toEqual([]);
            await context.close();
        }
        }
    } finally { await browser.close(); server.stop(true); rmSync(dir, { recursive: true, force: true }); }
}, 120000);
