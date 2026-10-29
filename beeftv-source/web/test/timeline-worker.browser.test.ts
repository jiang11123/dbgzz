import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { build } from "vite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

// Opt-in: requires local ffmpeg/ffprobe and Chromium. Production-style Vite assets,
// real browser Worker/core/Canvas2D, real downloads. No encoder/task/API mocks.
// Canvas persistence stops at its explicitly injected onCreateAssembledNode callback.
const enabled = process.env.BEEFTV_BROWSER_WORKER_TEST === "1";
let browser: Browser, server: ReturnType<typeof Bun.serve>, dir: string, base: string;
const run = (args: string[]) => {
    const result = spawnSync("ffmpeg", ["-hide_banner", "-y", ...args], { cwd: dir, maxBuffer: 32 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(result.stderr.toString());
    return result.stdout;
};
beforeAll(async () => {
    if (!enabled) return;
    dir = mkdtempSync(join(tmpdir(), "beeftv-browser-worker-"));
    for (const [index, color] of ["red", "green", "blue"].entries()) run(["-f", "lavfi", "-i", `color=${color}:s=320x180:r=30:d=2`, "-f", "lavfi", "-i", "sine=frequency=220:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", `v${index}.mp4`]);
    for (const [name, frequency] of [["voice", 440], ["bgm", 880]] as const) run(["-f", "lavfi", "-i", `sine=frequency=${frequency}:duration=6`, `${name}.wav`]);
    writeFileSync(join(dir, "broken.mp4"), "deliberately invalid local media");
    const dist = join(dir, "dist");
    await build({ configFile: false, root: resolve(import.meta.dir, ".."), cacheDir: join(dir, "vite-cache"), publicDir: false, logLevel: "error",
        define: { __BEEFTV_HEAVY_MEDIA_ENABLED__: "true", __APP_VERSION__: '"test"', __APP_CHANGELOG__: '""' },
        resolve: { alias: { "@": resolve(import.meta.dir, "../src") } },
        build: { outDir: dist, emptyOutDir: true, rolldownOptions: { input: resolve(import.meta.dir, "fixtures/timeline-worker-harness.html") } },
    });
    const goldenPlan = JSON.parse(readFileSync(resolve(import.meta.dir, "../../fixtures/editing/six-second-mix.plan.json"), "utf8"));
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        const path = new URL(request.url).pathname;
        if (request.method === "POST" && path === "/api/timeline/render-plan") {
            const body = await request.json().catch(() => ({})) as { timeline?: { clips?: { kind?: string; text?: string }[] }; options?: { width?: number; height?: number; fps?: number; burnSubtitles?: boolean } };
            const plan = structuredClone(goldenPlan);
            const sub = body.timeline?.clips?.find((clip) => clip.kind === "subtitle");
            if (sub?.text && plan.subtitles?.[0]) {
                plan.subtitles[0].text = sub.text;
                plan.subtitleSrt = `1\n00:00:00,500 --> 00:00:05,500\n${sub.text}\n\n`;
            }
            if (body.options?.width) plan.output.width = body.options.width;
            if (body.options?.height) plan.output.height = body.options.height;
            if (body.options?.fps) plan.output.fps = body.options.fps;
            if (body.options?.burnSubtitles === false) {
                plan.output.burnSubtitles = false;
                plan.subtitles = [];
                plan.subtitleSrt = "";
            }
            return Response.json({ code: 0, data: plan, msg: "ok" });
        }
        if (/^\/fixtures\/(?:v[012]\.mp4|voice\.wav|bgm\.wav|broken\.mp4)$/.test(path)) return new Response(Bun.file(join(dir, path.split("/").pop()!)));
        const file = path === "/" ? join(dist, "test/fixtures/timeline-worker-harness.html") : resolve(dist, "." + path);
        return file.startsWith(dist + sep) ? new Response(Bun.file(file)) : new Response("Not found", { status: 404 });
    } });
    base = server.url.toString();
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 90_000);
afterAll(async () => { await browser?.close(); server?.stop(true); if (dir) rmSync(dir, { recursive: true, force: true }); });

async function pageFor(query: string) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, acceptDownloads: true });
    page.on("pageerror", (error) => console.error("fixture page error:", error.message));
    page.on("console", (message) => { if (message.type() === "error") console.error("fixture browser error:", message.text()); });
    await page.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    await page.addInitScript(() => {
        const receipt = { started: 0, terminated: 0, exec: 0, probe: 0 };
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
            constructor(url: string | URL, options?: WorkerOptions) { super(url, options); receipt.started++; }
            postMessage(message: any, transfer: any = []) { if (message.type === "EXEC") receipt.exec++; if (message.type === "FFPROBE") receipt.probe++; super.postMessage(message, transfer); }
            terminate() { receipt.terminated++; super.terminate(); }
        };
        Object.assign(window, { workerReceipt: receipt });
    });
    await page.goto(base + query);
    await page.waitForFunction(() => Boolean((window as any).timelineWorker));
    return page;
}
async function receipt(page: Page) { return page.evaluate(() => ({ ...((window as any).workerReceipt), ...((window as any).timelineWorker.receipt) })); }
function verifyOutput(path: string) {
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]);
    expect(Math.abs(Number(probe.stdout.toString()) - 6)).toBeLessThan(0.15);
    const spectrum = (start: number, frequency: number) => {
        const bytes = run(["-ss", String(start), "-i", path, "-t", "0.5", "-vn", "-ac", "1", "-ar", "8000", "-f", "f32le", "pipe:1"]);
        const values = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
        let re = 0, im = 0;
        values.forEach((value, i) => { re += value * Math.cos(2 * Math.PI * frequency * i / 8000); im += value * Math.sin(2 * Math.PI * frequency * i / 8000); });
        return Math.hypot(re, im) / values.length;
    };
    for (const start of [0.2, 1.3, 3.5, 5.2]) { expect(spectrum(start, 220)).toBeGreaterThan(0.03); expect(spectrum(start, 880)).toBeGreaterThan(0.005); }
    expect(spectrum(1.3, 440)).toBeGreaterThan(0.03);
    expect(spectrum(0.2, 440)).toBeLessThan(0.002);
    expect(spectrum(3.5, 440)).toBeLessThan(0.002);
    for (const [index, time] of [0.2, 2.2, 4.2].entries()) {
        const pixel = run(["-ss", String(time), "-i", path, "-frames:v", "1", "-vf", "crop=2:2:0:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
        expect(pixel[index]).toBeGreaterThan(pixel[(index + 1) % 3] + 60);
    }
    for (const time of [0.2, 1.2, 5.7]) {
        const pixels = run(["-ss", String(time), "-i", path, "-frames:v", "1", "-vf", "scale=320:180,crop=320:60:0:120", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"]);
        expect(pixels.some((value) => value > 200)).toBe(time === 1.2);
    }
}

for (const mode of ["editor", "canvas"] as const) test.skipIf(!enabled)(`${mode}: real UI to browser FFmpeg Worker to MP4 download/new-node boundary`, async () => {
    const page = await pageFor(`?mode=${mode}`);
    try {
        const download = page.waitForEvent("download", { timeout: 180_000 });
        const button = page.getByRole("button", { name: mode === "editor" ? "本地导出（ffmpeg.wasm）" : "生成新片段", exact: true });
        await button.evaluate((element) => { (element as HTMLElement).click(); (element as HTMLElement).click(); });
        const failure = page.waitForFunction(() => Array.from(document.querySelectorAll(".ant-message-error, p")).map((node) => node.textContent || "").find((text) => /失败|不足|缺少|无效|过长/.test(text)), undefined, { timeout: 180_000 }).then(async (handle) => { throw new Error(String(await handle.jsonValue())); });
        const result = await Promise.race([download, failure]);
        const path = join(dir, `${mode}-output.mp4`); await result.saveAs(path);
        verifyOutput(path);
        const value = await receipt(page);
        expect(value.started).toBe(1); expect(value.terminated).toBe(1); expect(value.probe).toBe(5); expect(value.exec).toBeGreaterThanOrEqual(6);
        expect(value.created).toBe(mode === "canvas" ? 1 : 0);
    } finally { await page.close(); }
}, 210_000);

test.skipIf(!enabled)("real Worker encoding cancel terminates, suppresses download, and retry succeeds", async () => {
    const page = await pageFor("?mode=runtime"); let downloads = 0; page.on("download", () => downloads++);
    try {
        await page.evaluate(() => { void (window as any).timelineWorker.run(); });
        await page.waitForFunction(() => (window as any).workerReceipt.exec > 0);
        await page.evaluate(() => (window as any).timelineWorker.cancel());
        await page.waitForFunction(() => (window as any).timelineWorker.receipt.error.startsWith("AbortError"));
        expect(downloads).toBe(0); expect((await receipt(page)).terminated).toBe(1);
        const download = page.waitForEvent("download", { timeout: 90_000 });
        await page.evaluate(() => { void (window as any).timelineWorker.run(); });
        await (await download).saveAs(join(dir, "retry.mp4")); verifyOutput(join(dir, "retry.mp4"));
        expect((await receipt(page)).terminated).toBe(2);
    } finally { await page.close(); }
}, 120_000);

for (const mode of ["editor", "canvas"] as const) {
    test.skipIf(!enabled)(`${mode}: cancel button and unmount stop the actual encoding Worker`, async () => {
        const page = await pageFor(`?mode=${mode}`); let downloads = 0; page.on("download", () => downloads++);
        try {
            const name = mode === "editor" ? "本地导出（ffmpeg.wasm）" : "生成新片段";
            await page.getByRole("button", { name, exact: true }).click();
            await page.waitForFunction(() => (window as any).workerReceipt.exec > 0);
            await page.getByRole("button", { name: "取消导出", exact: true }).click();
            await page.getByRole("button", { name: "取消导出", exact: true }).waitFor({ state: "hidden" });
            expect(downloads).toBe(0); expect((await receipt(page)).terminated).toBe(1);
            await page.getByRole("button", { name, exact: true }).click();
            await page.waitForFunction(() => (window as any).workerReceipt.started === 2);
            await page.evaluate(() => (window as any).timelineWorker.unmount());
            await page.waitForFunction(() => (window as any).workerReceipt.terminated === 2);
            expect(downloads).toBe(0); expect((await receipt(page)).created).toBe(0);
        } finally { await page.close(); }
    }, 60_000);

    test.skipIf(!enabled)(`${mode}: real invalid media and subtitle layout failures never download/create`, async () => {
        for (const query of ["broken", "longSubtitle"]) {
            const page = await pageFor(`?mode=${mode}&${query}=1`); let downloads = 0; page.on("download", () => downloads++);
            try {
                await page.getByRole("button", { name: mode === "editor" ? "本地导出（ffmpeg.wasm）" : "生成新片段", exact: true }).click();
                await page.waitForFunction(() => (window as any).workerReceipt.terminated === 1);
                await page.getByText(query === "broken" ? /无法解析素材|素材缺少所需音视频轨/ : /字幕过长，请拆分后导出/).first().waitFor();
                const text = await page.locator("body").innerText();
                expect(text).toMatch(query === "broken" ? /无法解析素材|素材缺少所需音视频轨/ : /字幕过长，请拆分后导出/);
                expect(downloads).toBe(0); expect((await receipt(page)).created).toBe(0);
                expect(text).not.toMatch(/导出完成，已开始下载|已生成新视频片段/);
            } finally { await page.close(); }
        }
    }, 60_000);
}

test.skipIf(!enabled)("actual FFmpeg output failure rejects without download and releases worker", async () => {
    const page = await pageFor("?mode=runtime"); let downloads = 0; page.on("download", () => downloads++);
    try {
        await page.evaluate(() => { void (window as any).timelineWorker.run("missing-directory/export.mp4"); });
        await page.waitForFunction(() => Boolean((window as any).timelineWorker.receipt.error), undefined, { timeout: 90_000 });
        expect((await receipt(page)).error).toContain("字幕烧录失败");
        expect(downloads).toBe(0); expect((await receipt(page)).terminated).toBe(1);
    } finally { await page.close(); }
}, 120_000);
