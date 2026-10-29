import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { build } from "vite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const enabled = process.env.BEEFTV_BROWSER_WORKER_TEST === "1";
let browser: Browser, server: ReturnType<typeof Bun.serve>, dir: string, base: string;

const run = (args: string[]) => {
    const result = spawnSync("ffmpeg", ["-hide_banner", "-y", ...args], { cwd: dir, maxBuffer: 16 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(result.stderr.toString());
    return result.stdout;
};

beforeAll(async () => {
    if (!enabled) return;
    dir = mkdtempSync(join(tmpdir(), "beeftv-canvas-ffmpeg-"));
    for (const [index, color] of ["red", "green"].entries()) {
        run(["-f", "lavfi", "-i", `color=${color}:s=160x90:r=25:d=0.4`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", `v${index}.mp4`]);
    }
    const dist = join(dir, "dist");
    await build({
        configFile: false,
        root: resolve(import.meta.dir, ".."),
        cacheDir: join(dir, "vite-cache"),
        publicDir: false,
        logLevel: "error",
        define: { __BEEFTV_HEAVY_MEDIA_ENABLED__: "true", __APP_VERSION__: '"test"', __APP_CHANGELOG__: '""' },
        resolve: { alias: { "@": resolve(import.meta.dir, "../src") } },
        build: { outDir: dist, emptyOutDir: true, rolldownOptions: { input: resolve(import.meta.dir, "fixtures/canvas-ffmpeg-session-harness.html") } },
    });
    server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
            const path = new URL(request.url).pathname;
            if (/^\/fixtures\/v[01]\.mp4$/.test(path)) return new Response(Bun.file(join(dir, path.split("/").pop()!)));
            const file = path === "/" ? join(dist, "test/fixtures/canvas-ffmpeg-session-harness.html") : resolve(dist, "." + path);
            return file.startsWith(dist + sep) ? new Response(Bun.file(file)) : new Response("Not found", { status: 404 });
        },
    });
    base = server.url.toString();
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 90_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
    if (dir) rmSync(dir, { recursive: true, force: true });
});

async function pageFor() {
    const page = await browser.newPage();
    page.on("pageerror", (error) => console.error("fixture page error:", error.message));
    await page.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    await page.addInitScript(() => {
        const receipt = { started: 0, terminated: 0, exec: 0 };
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
            constructor(url: string | URL, options?: WorkerOptions) { super(url, options); receipt.started += 1; }
            postMessage(message: unknown, transfer: Transferable[] = []) {
                if (message && typeof message === "object" && (message as { type?: string }).type === "EXEC") receipt.exec += 1;
                super.postMessage(message, transfer);
            }
            terminate() { receipt.terminated += 1; super.terminate(); }
        };
        Object.assign(window, { workerReceipt: receipt });
    });
    await page.goto(base);
    await page.waitForFunction(() => Boolean((window as { canvasFfmpeg?: unknown }).canvasFfmpeg));
    return page;
}

async function receipt(page: Page) {
    return page.evaluate(() => ({
        ...(window as unknown as { workerReceipt: { started: number; terminated: number; exec: number } }).workerReceipt,
        ...(window as unknown as { canvasFfmpeg: { receipt: { error: string; done: boolean; bytes: number; queuedAborted: boolean } } }).canvasFfmpeg.receipt,
    }));
}

test.skipIf(!enabled)("real merge worker cancel terminates and retry succeeds", async () => {
    const page = await pageFor();
    try {
        await page.evaluate(() => { void (window as unknown as { canvasFfmpeg: { run: () => Promise<number> } }).canvasFfmpeg.run(); });
        await page.waitForFunction(() => (window as unknown as { workerReceipt: { exec: number } }).workerReceipt.exec > 0);
        await page.evaluate(() => (window as unknown as { canvasFfmpeg: { cancel: () => void } }).canvasFfmpeg.cancel());
        await page.waitForFunction(() => (window as unknown as { canvasFfmpeg: { receipt: { error: string } } }).canvasFfmpeg.receipt.error.startsWith("AbortError"));
        expect((await receipt(page)).terminated).toBeGreaterThanOrEqual(1);
        const retry = page.evaluate(() => (window as unknown as { canvasFfmpeg: { run: () => Promise<number> } }).canvasFfmpeg.run());
        const bytes = await retry;
        expect(bytes).toBeGreaterThan(1000);
        const value = await receipt(page);
        expect(value.done).toBe(true);
        expect(value.terminated).toBeGreaterThanOrEqual(1);
        expect(value.started).toBeGreaterThanOrEqual(2);
    } finally {
        await page.close();
    }
}, 120_000);

test.skipIf(!enabled)("real queued merge cancel leaves the active worker running", async () => {
    const page = await pageFor();
    try {
        const bytes = await page.evaluate(() => (window as unknown as { canvasFfmpeg: { runQueuedCancel: () => Promise<number> } }).canvasFfmpeg.runQueuedCancel());
        expect(bytes).toBeGreaterThan(1000);
        const value = await receipt(page);
        expect(value.queuedAborted).toBe(true);
        expect(value.done).toBe(true);
        expect(value.error).toBe("");
    } finally {
        await page.close();
    }
}, 120_000);
