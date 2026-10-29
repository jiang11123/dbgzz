import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser, page: Page, server: ReturnType<typeof Bun.serve>, dir: string;
let writes = 0, videoReads = 0;
let retryReads = 0;
let releaseSlow: (() => void) | undefined;
let slow: Promise<void>;
beforeAll(async () => {
    dir = mkdtempSync(`${tmpdir()}/beeftv-derived-preview-`);
    for (const color of ["red", "blue"]) {
        const result = Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${color}:s=320x180:d=1`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", `${dir}/${color}.mp4`]);
        if (result.exitCode) throw new Error(result.stderr.toString());
    }
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/canvas-derived-preview-harness.tsx"], target: "browser", plugins: [{ name: "alias", setup(builder) {
        builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
        builder.onLoad({ filter: /\.(css|svg|png|jpe?g|gif|webp|woff2?)$/ }, () => ({ contents: "export default ''", loader: "js" }));
    } }], define: { "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"', "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"false"', "import.meta.env.VITE_CANVAS_BACKEND_URL": '""', "process.env.NODE_ENV": '"production"' } });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    server = Bun.serve({ port: 0, async fetch(request) {
        const path = new URL(request.url).pathname;
        if (request.method !== "GET") writes += 1;
        if (path.endsWith(".mp4")) { videoReads += 1; if (path === "/retry.mp4" && ++retryReads === 1) return new Response("unavailable", { status: 404 }); if (path === "/slow.mp4") await slow; return new Response(Bun.file(`${dir}/${path === "/blue.mp4" ? "blue" : "red"}.mp4`), { headers: { "Content-Type": "video/mp4" } }); }
        if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
        if (path === "/poster.svg") return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="green"/></svg>', { headers: { "Content-Type": "image/svg+xml" } });
        if (path.startsWith("/api/")) return Response.json({ code: 0, data: [] });
        return new Response('<div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p): p is string => Boolean(p && existsSync(p)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60000);
beforeEach(async () => { await page?.close(); writes = videoReads = retryReads = 0; slow = new Promise((resolve) => { releaseSlow = resolve; }); page = await browser.newPage(); await page.goto(server.url.toString()); await page.waitForFunction(() => Boolean((window as any).previewHarness)); });
afterAll(async () => { releaseSlow?.(); await browser?.close(); server?.stop(true); rmSync(dir, { recursive: true, force: true }); });
async function enter() { await page.evaluate(() => window.scrollTo(0, 3000)); }
test("failed first decode retries for the next consumer; old release cannot erase success", async () => {
    expect(await page.evaluate(() => (window as any).previewHarness.retry())).toEqual({ failed: null, succeeded: true, sameAfterOldRelease: true });
    expect(retryReads).toBe(2); expect(writes).toBe(0);
    const state = await page.evaluate(() => (window as any).previewHarness.state());
    expect(state.created).toHaveLength(1); expect(state.revoked).toEqual(state.created);
});
async function ready() { await page.waitForFunction(() => { const image = document.querySelector("img"); return image?.src.startsWith("blob:") && image.complete && image.naturalWidth === 320; }); }
async function color() { return page.evaluate(() => { const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1; const ctx = canvas.getContext("2d")!; ctx.drawImage(document.querySelector("img")!, 0, 0, 1, 1); return Array.from(ctx.getImageData(0, 0, 1, 1).data); }); }
test("real near-viewport MP4 poster makes no node or backend writes and releases on unmount", async () => {
    await page.waitForTimeout(350); expect(videoReads).toBe(0);
    await enter(); await ready();
    expect((await color())[0]).toBeGreaterThan(200);
    const state = await page.evaluate(() => (window as any).previewHarness.state());
    expect(state.node.metadata).toEqual({ content: "/red.mp4" }); expect(state.writes).toBe(0); expect(writes).toBe(0); expect(state.created).toHaveLength(1);
    await page.evaluate(() => (window as any).previewHarness.unmount());
    await page.waitForFunction(() => (window as any).previewHarness.state().revoked.length === 1);
});
test("changed source revokes old poster and decodes new bytes", async () => {
    await enter(); await ready(); const old = await page.locator("img").getAttribute("src");
    await page.evaluate(() => (window as any).previewHarness.source("/blue.mp4")); await ready();
    await page.waitForFunction((old) => document.querySelector("img")?.getAttribute("src") !== old, old);
    expect((await color())[2]).toBeGreaterThan(200);
    expect(await page.evaluate(() => (window as any).previewHarness.state().revoked.includes((window as any).previewHarness.state().created[0]))).toBe(true);
    expect(writes).toBe(0);
});
test("A→B→A aborts late old-source completion without displaying it", async () => {
    await page.evaluate(() => (window as any).previewHarness.source("/slow.mp4")); await enter();
    for (let i = 0; i < 40 && !videoReads; i += 1) await page.waitForTimeout(50);
    expect(videoReads).toBeGreaterThan(0);
    await page.evaluate(() => { (window as any).previewHarness.cycle(); (window as any).previewHarness.source("/blue.mp4"); }); releaseSlow?.(); await ready();
    const state = await page.evaluate(() => (window as any).previewHarness.state());
    expect((await color())[2]).toBeGreaterThan(200);
    expect(state.created).toHaveLength(1); expect(state.writes).toBe(0); expect(writes).toBe(0);
});
test("shared leases retain URL until the final consumer releases", async () => {
    expect(await page.evaluate(() => (window as any).previewHarness.shared())).toEqual({ same: true, revokedBeforeLast: false, revokedAfterLast: true });
    expect(writes).toBe(0);
});
test("release during object URL creation revokes a rejected late result", async () => {
    expect(await page.evaluate(() => (window as any).previewHarness.releaseRace())).toBeNull();
    const state = await page.evaluate(() => (window as any).previewHarness.state());
    expect(state.created).toHaveLength(1); expect(state.revoked).toEqual(state.created); expect(writes).toBe(0);
});
test("existing durable poster is retained without rehydrating and cache is bounded", async () => {
    await page.evaluate(() => (window as any).previewHarness.oldPoster()); await enter();
    await page.waitForFunction(() => document.querySelector("img")?.src.endsWith("/poster.svg"));
    expect(videoReads).toBe(0); expect(await page.evaluate(() => (window as any).previewHarness.state().node.metadata.videoPreview.sourceKey)).toBe("/red.mp4");
    expect(await page.evaluate(() => (window as any).previewHarness.capacity())).toEqual({ last: null, recovered: true }); expect(writes).toBe(0);
});
