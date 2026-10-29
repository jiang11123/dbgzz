import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

let browser: Browser, server: ReturnType<typeof Bun.serve>, scratch: string;
let delayVoice = false;
let releaseVoice: (() => void) | undefined;
const sourceRoot = process.env.BEEFTV_PREVIEW_SOURCE_ROOT || resolve(import.meta.dir, "..");
const hookRef = process.env.BEEFTV_PREVIEW_HOOK_REF;
let hookSha256 = "";
const snapshot = (page: Page) => page.evaluate(() => (window as any).timelinePlaybackFixture.snapshot());

function wave(frequency: number) {
    const samples = 44100 * 4, result = Buffer.alloc(44 + samples * 2);
    result.write("RIFF"); result.writeUInt32LE(result.length - 8, 4); result.write("WAVEfmt ", 8); result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22); result.writeUInt32LE(44100, 24); result.writeUInt32LE(88200, 28); result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34); result.write("data", 36); result.writeUInt32LE(samples * 2, 40);
    for (let i = 0; i < samples; i++) result.writeInt16LE(Math.round(Math.sin(i * frequency * 2 * Math.PI / 44100) * 7000), 44 + i * 2);
    return result;
}

beforeAll(async () => {
    scratch = mkdtempSync(tmpdir() + "/beeftv-timeline-preview-");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=orange:s=320x180:r=24:d=4", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=44100:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", scratch + "/video.mp4"]);
    const voices = { "/voice.wav": wave(440), "/music.wav": wave(660) };
    const hookPath = "web/src/hooks/use-timeline-preview-playback.ts";
    const hookSource = hookRef ? execFileSync("git", ["show", `${hookRef}:${hookPath}`], { cwd: resolve(sourceRoot, ".."), encoding: "utf8" }) : readFileSync(resolve(sourceRoot, "src/hooks/use-timeline-preview-playback.ts"), "utf8");
    hookSha256 = createHash("sha256").update(hookSource).digest("hex");
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/timeline-preview-playback-harness.tsx"], target: "browser", define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "timeline-preview-source", setup(builder) {
        builder.onResolve({ filter: /^@\/hooks\/use-timeline-preview-playback$/ }, () => ({ path: "timeline-preview-hook-snapshot", namespace: "timeline-hook-snapshot" }));
        builder.onLoad({ filter: /.*/, namespace: "timeline-hook-snapshot" }, () => ({ contents: hookSource, loader: "ts", resolveDir: sourceRoot }));
        builder.onResolve({ filter: /^@\// }, args => {
            return { path: Bun.resolveSync(resolve(sourceRoot, "src", args.path.slice(2)), import.meta.dir) };
        });
    } }] });
    if (!build.success) throw Error(build.logs.join("\n"));
    const script = await build.outputs.find(output => output.path.endsWith(".js"))!.text();
    server = Bun.serve({ port: 0, async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/harness.js") return new Response(script, { headers: { "content-type": "text/javascript" } });
        if (path === "/voice.wav" && delayVoice) await new Promise<void>(resolve => { releaseVoice = resolve; });
        if (path === "/video.mp4" || path in voices) {
            const bytes = path === "/video.mp4" ? readFileSync(scratch + "/video.mp4") : voices[path as keyof typeof voices];
            const range = request.headers.get("range")?.match(/^bytes=(\d+)-(\d*)$/);
            const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(bytes.length - 1, Number(range[2])) : bytes.length - 1;
            const headers: Record<string, string> = { "content-type": path === "/video.mp4" ? "video/mp4" : "audio/wav", "accept-ranges": "bytes" };
            if (range) headers["content-range"] = `bytes ${start}-${end}/${bytes.length}`;
            return new Response(bytes.subarray(start, end + 1), { status: range ? 206 : 200, headers });
        }
        return new Response('<!doctype html><meta charset="utf-8"><style>.relative{position:relative}.absolute{position:absolute}.inset-0{inset:0}.h-full{height:100%}.w-full{width:100%}.object-contain{object-fit:contain}.bg-black{background:#000}.grid{display:grid}.place-items-center{place-items:center}.pointer-events-none{pointer-events:none}</style><div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "content-type": "text/html" } });
    } });
    browser = await chromium.launch({ headless: true, executablePath: [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path))) });
}, 60_000);
afterAll(async () => { await browser?.close(); server?.stop(true); if (scratch) rmSync(scratch, { recursive: true, force: true }); }, 30_000);

async function open(query = "") {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on("pageerror", error => console.error("fixture page error:", error.message));
    await page.goto(server.url.href + query);
    if (!query) {
        await page.waitForFunction(() => (window as any).timelinePlaybackFixture?.snapshot().audio.length === 2 && (window as any).timelinePlaybackFixture.snapshot().audio.every((audio: any) => audio.readyState >= 1));
        await page.waitForFunction(() => Math.abs((window as any).timelinePlaybackFixture.snapshot().audio[0].currentTime - 1.4) < 0.05, undefined, { timeout: 6000 }).catch(async error => { throw Error(error.message + " STATE=" + JSON.stringify(await snapshot(page))); });
    }
    return page;
}

test("two overlapping real audio clips seek their own source offsets and advance with the video", async () => {
    const page = await open();
    try {
        const paused = await snapshot(page);
        expect(paused.audio.map((audio: any) => audio.paused)).toEqual([true, true]);
        expect(paused.audio[0].currentTime).toBeCloseTo(1.4, 1);
        expect(paused.audio[1].currentTime).toBeCloseTo(0.8, 1);
        expect(paused.audio.map((audio: any) => audio.volume)).toEqual([0.4, 0.6]);
        expect(await page.locator("[data-playback-video]").evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(1.3, 1);
        await page.getByRole("button", { name: "Play", exact: true }).click();
        await page.waitForFunction(() => (window as any).timelinePlaybackFixture.snapshot().audio.every((audio: any) => !audio.paused) && (window as any).timelinePlaybackFixture.snapshot().playhead > 1200);
        expect((await snapshot(page)).audio[0].currentTime).toBeGreaterThan(1.5);
        expect((await snapshot(page)).audio[1].currentTime).toBeGreaterThan(0.9);
        await page.getByRole("button", { name: "Pause", exact: true }).click();
        const stopped = await snapshot(page);
        await page.waitForTimeout(180);
        expect((await snapshot(page)).playhead).toBe(stopped.playhead);
        expect((await snapshot(page)).audio.every((audio: any) => audio.paused)).toBe(true);
    } finally { await page.close(); }
}, 45_000);

test("240ms frames cross the 600ms voice cue and naturally stop without rewinding audio", async () => {
    const page = await open("?slowRaf");
    try {
        await page.waitForFunction(() => { const fixture = (window as any).timelinePlaybackFixture; const video = document.querySelector("video"); return fixture?.snapshot().audio.every((audio: any) => audio.readyState >= 2) && video && video.readyState >= 2; });
        await page.getByRole("button", { name: "Play", exact: true }).click();
        const samples = await page.evaluate(async () => {
            const rows: any[] = [], start = performance.now();
            while (performance.now() - start < 6500) {
                const state = (window as any).timelinePlaybackFixture.snapshot();
                const video = document.querySelector("video") as HTMLVideoElement | null;
                rows.push({ elapsedMs: Math.round(performance.now() - start), ...state, video: video ? { currentTime: video.currentTime, paused: video.paused, readyState: video.readyState } : null });
                if (state.playhead === 2400 && !state.playing) break;
                await new Promise(resolve => setTimeout(resolve, 40));
            }
            return rows;
        });
        const rewinds = samples.slice(1).flatMap((sample, index) => sample.audio.flatMap((audio: any, track: number) => {
            const prior = samples[index].audio[track];
            return prior && !prior.paused && !audio.paused && prior.currentTime - audio.currentTime > 0.12 ? [{ elapsedMs: sample.elapsedMs, track, from: prior.currentTime, to: audio.currentTime }] : [];
        }));
        const last = samples.at(-1)!;
        const receipt: Record<string, unknown> = { hookRef: hookRef || "working-tree", hookSha256, frameMs: 240, voiceCueMs: 600, expectedDurationMs: 2400, sourceOffsetsMs: { video: 1600, voice: 2400 }, naturalStop: last.playhead === 2400 && !last.playing, rewinds, samples };
        if (process.env.BEEFTV_PREVIEW_RECEIPT) writeFileSync(process.env.BEEFTV_PREVIEW_RECEIPT, JSON.stringify(receipt, null, 2));
        console.log(JSON.stringify({ hookRef: receipt.hookRef, hookSha256, naturalStop: receipt.naturalStop, finalPlayhead: last.playhead, rewindCount: rewinds.length }));
        expect(samples.some(sample => sample.playhead > 600)).toBe(true);
        expect(receipt.naturalStop).toBe(true);
        expect(rewinds).toEqual([]);
        expect(last.audio.every((audio: any) => audio.paused)).toBe(true);
        expect(last.video?.paused).toBe(true);
        await page.getByRole("button", { name: "Play", exact: true }).click();
        await page.waitForFunction(() => { const state = (window as any).timelinePlaybackFixture.snapshot(); return state.playhead > 600 && state.playhead < 1400 && !state.audio[0].paused && state.audio[0].currentTime > 2.4 && state.audio[0].currentTime < 3.3; });
        const restarted = await snapshot(page);
        receipt.restarted = restarted;
        if (process.env.BEEFTV_PREVIEW_RECEIPT) writeFileSync(process.env.BEEFTV_PREVIEW_RECEIPT, JSON.stringify(receipt, null, 2));
        expect(restarted.playing).toBe(true);
        expect(restarted.audio[0].currentTime).toBeLessThan(3.3);
        const video = await page.locator("[data-playback-video]").evaluate((element: HTMLVideoElement) => ({ paused: element.paused, ended: element.ended, currentTime: element.currentTime }));
        expect(video.paused).toBe(false);
        expect(video.ended).toBe(false);
        expect(video.currentTime).toBeLessThan(4);
        await page.getByRole("button", { name: "Pause", exact: true }).click();
    } finally { await page.close(); }
}, 45_000);

test("linear fades, track mute and hidden tracks affect both paused seeks and active playback", async () => {
    const page = await open();
    try {
        await page.evaluate(() => (window as any).timelinePlaybackFixture.seek(400));
        await page.waitForFunction(() => Math.abs((window as any).timelinePlaybackFixture.snapshot().audio[0].volume - 0.2) < 0.01);
        expect((await snapshot(page)).audio[0].currentTime).toBeCloseTo(0.8, 1);
        await page.evaluate(() => (window as any).timelinePlaybackFixture.seek(1600));
        await page.waitForFunction(() => Math.abs((window as any).timelinePlaybackFixture.snapshot().audio[0].volume - 0.2) < 0.01);
        await page.evaluate(() => { (window as any).timelinePlaybackFixture.seek(1000); (window as any).timelinePlaybackFixture.mute(true); });
        await page.getByRole("button", { name: "Play", exact: true }).click();
        await page.waitForFunction(() => { const audio = (window as any).timelinePlaybackFixture.snapshot().audio; return audio[0].paused && audio[0].muted && !audio[1].paused; });
        await page.evaluate(() => (window as any).timelinePlaybackFixture.hide(true));
        await page.waitForFunction(() => (window as any).timelinePlaybackFixture.snapshot().audio.every((audio: any) => audio.paused));
    } finally { await page.close(); }
}, 45_000);

test("audio-only and a visual gap use the shared clock and cleanup every owned audio element", async () => {
    for (const mode of ["audioOnly", "gap"]) {
        const page = await open();
        try {
            await page.evaluate(mode => (window as any).timelinePlaybackFixture[mode](), mode);
            await page.getByRole("button", { name: "Play", exact: true }).click();
            await page.waitForFunction(() => { const state = (window as any).timelinePlaybackFixture.snapshot(); return state.playhead > 1200 && state.audio.every((audio: any) => !audio.paused); });
            await page.evaluate(() => (window as any).unmountTimelinePlaybackFixture());
            await page.waitForTimeout(100);
            expect((await snapshot(page)).audio.every((audio: any) => audio.paused && audio.src === null)).toBe(true);
        } finally { await page.close(); }
    }
}, 45_000);

test("a rejected media play pauses all players and reports a URL-free error", async () => {
    const page = await open();
    try {
        await page.evaluate(() => { HTMLMediaElement.prototype.play = () => Promise.reject(Error("secret-resource-url")); });
        await page.getByRole("button", { name: "Play", exact: true }).click();
        await page.getByRole("alert").waitFor();
        expect((await snapshot(page)).playing).toBe(false);
        expect((await snapshot(page)).audio.every((audio: any) => audio.paused)).toBe(true);
        expect(await page.getByRole("alert").innerText()).not.toContain("secret-resource-url");
    } finally { await page.close(); }
}, 45_000);

test("delayed real audio holds the clock at its cue while muted video still plays pictures", async () => {
    delayVoice = true;
    const page = await browser.newPage();
    try {
        await page.goto(server.url.href, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => Boolean((window as any).timelinePlaybackFixture));
        await page.evaluate(() => { (window as any).timelinePlaybackFixture.seek(0); (window as any).timelinePlaybackFixture.muteVideo(true); });
        await page.getByRole("button", { name: "Play", exact: true }).click();
        await page.waitForFunction(() => (window as any).timelinePlaybackFixture.snapshot().playhead === 200);
        await page.waitForTimeout(180);
        expect((await snapshot(page)).playhead).toBe(200);
        delayVoice = false; releaseVoice?.();
        await page.waitForFunction(() => { const state = (window as any).timelinePlaybackFixture.snapshot(); const video = document.querySelector("video"); return state.playhead > 350 && video && !video.paused && video.muted && !state.audio[0].paused; });
    } finally { delayVoice = false; releaseVoice?.(); await page.close(); }
}, 45_000);

test("a failed audio load exits buffering and pauses every player", async () => {
    const page = await browser.newPage();
    try {
        await page.route("**/voice.wav", route => route.fulfill({ status: 404, body: "fixture missing audio" }));
        await page.goto(server.url.href);
        await page.getByRole("button", { name: "Play", exact: true }).click();
        await page.getByRole("alert").waitFor();
        expect((await snapshot(page)).playing).toBe(false);
        expect((await snapshot(page)).audio.every((audio: any) => audio.paused)).toBe(true);
    } finally { await page.close(); }
}, 45_000);

test("a muted track failing after playback starts does not stop other media", async () => {
    const page = await browser.newPage();
    let releaseFailure: (() => void) | undefined;
    try {
        await page.route("**/voice.wav", async route => {
            await new Promise<void>(resolve => { releaseFailure = resolve; });
            await route.fulfill({ status: 404, body: "fixture missing muted audio" });
        });
        await page.goto(server.url.href);
        await page.waitForFunction(() => Boolean((window as any).timelinePlaybackFixture));
        await page.evaluate(() => (window as any).timelinePlaybackFixture.mute(true));
        await page.getByRole("button", { name: "Play", exact: true }).click();
        await page.waitForFunction(() => { const state = (window as any).timelinePlaybackFixture.snapshot(); return state.playhead > 1200 && !state.audio[1].paused; });
        releaseFailure?.();
        await page.waitForFunction(() => Boolean((window as any).timelinePlaybackFixture.snapshot().audio[0].error));
        expect((await snapshot(page)).playing).toBe(true);
        expect((await snapshot(page)).error).toBe("");
        await page.evaluate(() => { (window as any).timelinePlaybackFixture.seek(1000); (window as any).timelinePlaybackFixture.mute(false); });
        await page.getByRole("alert").waitFor();
        expect((await snapshot(page)).playing).toBe(false);
    } finally { releaseFailure?.(); await page.close(); }
}, 45_000);

test("portrait output uses the real export caption PNG with one bottom line, even for a landscape source", async () => {
    const page = await open("?preview");
    try {
        const frame = page.locator("[data-timeline-output-frame]");
        const caption = page.locator("img[data-timeline-subtitle-preview]");
        await caption.waitFor();
        await page.waitForFunction(() => { const image = document.querySelector("img[data-timeline-subtitle-preview]") as HTMLImageElement; return image?.naturalWidth === 480 && image.naturalHeight === 854; });
        const bounds = await caption.evaluate((image: HTMLImageElement) => {
            const canvas = document.createElement("canvas"); canvas.width = 480; canvas.height = 854;
            const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
            const data = context.getImageData(0, 0, 480, 854).data;
            let minX = 480, maxX = 0, minY = 854, maxY = 0;
            for (let y = 0; y < 854; y++) for (let x = 0; x < 480; x++) if (data[(y * 480 + x) * 4 + 3] > 10) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
            return { width: maxX - minX + 1, height: maxY - minY + 1, minY, maxY };
        });
        expect(bounds.width).toBeLessThanOrEqual(480 * 0.9 + 4);
        expect(bounds.height).toBeLessThan(48);
        expect(bounds.minY).toBeGreaterThan(854 * 0.8);
        expect(bounds.maxY).toBeLessThan(854 * 0.95);
        const geometry = await frame.boundingBox();
        expect(geometry!.width / geometry!.height).toBeCloseTo(480 / 854, 1);
        const video = frame.locator("video");
        await page.waitForFunction(() => (document.querySelector("[data-timeline-output-frame] video") as HTMLVideoElement)?.videoWidth === 320);
        expect(await video.evaluate(element => getComputedStyle(element).objectFit)).toBe("contain");
        await page.evaluate(() => (window as any).timelinePlaybackFixture.burn(false));
        await caption.waitFor({ state: "hidden" });
    } finally { await page.close(); }
}, 45_000);
