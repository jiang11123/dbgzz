import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { lowerCanonicalPlan } from "../src/lib/timeline/timeline-to-ffmpeg";
import { executeTimelineRenderPlan, type TimelineRenderEngine } from "../src/lib/timeline/timeline-render-service";
import { isSubtitleFontFailure } from "../src/lib/timeline/subtitle-font-failure";
import { rasterizeTimelineSubtitle } from "../src/lib/timeline/timeline-subtitle-image";
import type { CanonicalTimelinePlan } from "../src/lib/timeline/timeline-canonical-plan";
import { loadEditingPlan } from "./helpers/editing-fixtures";

function createNativeEngine(dir: string): TimelineRenderEngine {
    return {
        async writeFile(name, data) {
            writeFileSync(join(dir, name), typeof data === "string" ? data : Buffer.from(data));
        },
        async readFile(name) {
            return readFileSync(join(dir, name));
        },
        async deleteFile(name) {
            try { rmSync(join(dir, name)); } catch { /* owned temp dir */ }
        },
        async exec(args) {
            const result = spawnSync("ffmpeg", ["-hide_banner", "-y", ...args], { cwd: dir, maxBuffer: 16 * 1024 * 1024 });
            return { exitCode: result.status ?? 1, log: result.stderr.toString() };
        },
    };
}

test("native/wasm encoder fixture is opt-in; absent runtime is skipped instead of false-green", () => {
    if (process.env.BEEFTV_NATIVE_FFMPEG_TEST === "1") {
        expect(spawnSync("ffmpeg", ["-version"]).status).toBe(0);
        expect(spawnSync("ffprobe", ["-version"]).status).toBe(0);
    }
});

// Opt-in real local encoder test, not browser E2E. No network or paid media.
test.skipIf(process.env.BEEFTV_NATIVE_FFMPEG_TEST !== "1")("native FFmpeg: shared six-second-mix plan, original audio, voice, BGM and Chinese subtitles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beeftv-timeline-fixture-"));
    const run = (args: string[]) => {
        const result = spawnSync("ffmpeg", ["-hide_banner", "-y", ...args], { cwd: dir, maxBuffer: 16 * 1024 * 1024 });
        if (result.status !== 0) throw new Error(result.stderr.toString());
        return result;
    };
    try {
        for (const [index, color] of ["red", "green", "blue"].entries()) {
            run(["-f", "lavfi", "-i", `color=${color}:s=320x180:r=30:d=2`, "-f", "lavfi", "-i", "sine=frequency=220:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", `v${index}.mp4`]);
        }
        for (const [name, frequency] of [["voice", 440], ["bgm", 880]] as const) run(["-f", "lavfi", "-i", `sine=frequency=${frequency}:duration=6`, `${name}.wav`]);
        const canonical = loadEditingPlan("six-second-mix.plan.json");
        const sources = [
            { nodeId: "v0", fileName: "v0.mp4", durationMs: 2000, hasAudio: true },
            { nodeId: "v1", fileName: "v1.mp4", durationMs: 2000, hasAudio: true },
            { nodeId: "v2", fileName: "v2.mp4", durationMs: 2000, hasAudio: true },
            { nodeId: "voice", fileName: "voice.wav", durationMs: 6000, hasAudio: true },
            { nodeId: "bgm", fileName: "bgm.wav", durationMs: 6000, hasAudio: true },
        ];
        const render = async (name: string, planSource: CanonicalTimelinePlan, subtitleImages?: string[]) => {
            const plan = lowerCanonicalPlan(planSource, sources, { width: 320, height: 180, fps: 30, outputName: name, subtitleImages });
            expect(plan.request.audioClipIds).toContain("voice");
            expect(plan.request.subtitleClipIds.length).toBeGreaterThan(0);
            const result = await executeTimelineRenderPlan({ plan, engine: createNativeEngine(dir) });
            expect(result.subtitleBurned).toBe(true);
            expect(result.mixedAudio).toBe(true);
        };
        const spectrum = (name: string, start: number, frequency: number) => {
            const result = run(["-ss", String(start), "-i", name, "-t", "0.5", "-vn", "-ac", "1", "-ar", "8000", "-f", "f32le", "pipe:1"]);
            const values = new Float32Array(result.stdout.buffer.slice(result.stdout.byteOffset, result.stdout.byteOffset + result.stdout.length));
            let re = 0, im = 0;
            for (let i = 0; i < values.length; i++) { re += values[i] * Math.cos(2 * Math.PI * frequency * i / 8000); im += values[i] * Math.sin(2 * Math.PI * frequency * i / 8000); }
            return Math.hypot(re, im) / values.length;
        };
        await render("out.mp4", canonical);
        const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", "out.mp4"], { cwd: dir });
        expect(Math.abs(Number(probe.stdout.toString()) - 6)).toBeLessThan(0.1);
        for (const [index, start] of [0.2, 2.2, 4.2].entries()) {
            const pixel = run(["-ss", String(start), "-i", "out.mp4", "-frames:v", "1", "-vf", "crop=2:2:0:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]).stdout;
            expect(pixel[index]).toBeGreaterThan(pixel[(index + 1) % 3] + 60);
        }
        for (const start of [0.2, 1.3, 3.5, 5.2]) {
            expect(spectrum("out.mp4", start, 220)).toBeGreaterThan(0.03);
            expect(spectrum("out.mp4", start, 880)).toBeGreaterThan(0.005);
        }
        expect(spectrum("out.mp4", 1.3, 440)).toBeGreaterThan(0.03);
        expect(spectrum("out.mp4", 0.2, 440)).toBeLessThan(0.002);
        expect(spectrum("out.mp4", 3.5, 440)).toBeLessThan(0.002);
        const frame = (name: string) => run(["-ss", "1", "-i", name, "-frames:v", "1", "-vf", "crop=320:60:0:120", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"]).stdout;
        const withText = frame("out.mp4"), withoutText = frame("timeline-mixed.mp4");
        expect(withText.some((value, index) => Math.abs(value - withoutText[index]) > 80)).toBe(true);
        const { chromium } = await import("playwright");
        const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
        const browser = await chromium.launch({ executablePath, headless: true });
        try {
            const page = await browser.newPage();
            await page.addScriptTag({ content: `window.rasterize = ${rasterizeTimelineSubtitle.toString()}` });
            const png = await page.evaluate(async () => Array.from(await (window as any).rasterize("中文字幕完整性验证", 320, 180)));
            writeFileSync(join(dir, "subtitle.png"), Buffer.from(png as number[]));
            const glyphs = await page.evaluate(async () => [Array.from(await (window as any).rasterize("中文", 320, 180)), Array.from(await (window as any).rasterize("测试", 320, 180))]);
            expect(glyphs[0]).not.toEqual(glyphs[1]);
            const bounds = await page.evaluate(async () => {
                const bytes = new Uint8Array(await (window as any).rasterize("新的一天，从一口热面包开始。", 720, 1280));
                const picture = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
                const canvas = document.createElement("canvas"); canvas.width = 720; canvas.height = 1280;
                const ctx = canvas.getContext("2d")!; ctx.drawImage(picture, 0, 0); picture.close();
                const pixels = ctx.getImageData(0, 0, 720, 1280).data;
                let minX = 720, maxX = 0, minY = 1280, maxY = 0, count = 0;
                for (let y = 0; y < 1280; y++) for (let x = 0; x < 720; x++) {
                    const i = (y * 720 + x) * 4;
                    if (pixels[i] > 180 && pixels[i + 1] > 180 && pixels[i + 2] > 180 && pixels[i + 3] > 180) {
                        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
                        minY = Math.min(minY, y); maxY = Math.max(maxY, y); count++;
                    }
                }
                return { minX, maxX, minY, maxY, count };
            });
            expect(bounds.count).toBeGreaterThan(100);
            expect(bounds.minX).toBeGreaterThanOrEqual(36);
            expect(bounds.maxX).toBeLessThan(684);
            expect(bounds.minY).toBeGreaterThan(640);
            expect(bounds.maxY).toBeLessThan(1244);
        } finally { await browser.close(); }
        await render("browser-fonts.mp4", canonical, ["subtitle.png"]);
        expect(frame("browser-fonts.mp4").some((value, index) => Math.abs(value - withoutText[index]) > 80)).toBe(true);
        const outside = (name: string, time: string) => run(["-ss", time, "-i", name, "-frames:v", "1", "-vf", "crop=320:60:0:120", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"]).stdout;
        for (const time of ["0.2", "5.7"]) {
            const actual = outside("browser-fonts.mp4", time), baseline = outside("timeline-mixed.mp4", time);
            expect(actual.some((value, index) => Math.abs(value - baseline[index]) > 80)).toBe(false);
        }
        const globals = globalThis as any;
        const previousSelf = globals.self, previousImportScripts = globals.importScripts;
        globals.self = { location: { href: "file:///tmp/ffmpeg-core.js" } };
        globals.importScripts = () => undefined;
        try {
            const coreUrl = new URL("../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js", import.meta.url);
            const { default: createCore } = await import(coreUrl.href);
            const core = await createCore({ wasmBinary: readFileSync(new URL("ffmpeg-core.wasm", coreUrl)) });
            const plan = lowerCanonicalPlan(canonical, sources, { width: 320, height: 180, outputName: "wasm.mp4", subtitleImages: ["subtitle.png"] });
            for (const name of [...sources.map((item) => item.fileName), "subtitle.png", "timeline.srt", "concat.txt"]) core.FS.writeFile(name, readFileSync(join(dir, name)));
            let log = "";
            core.setLogger(({ message }: { message: string }) => { log = (log + "\n" + message).slice(-4000); });
            for (const source of sources) {
                core.reset();
                core.FS.writeFile("probe.json", new Uint8Array());
                core.ffprobe("-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", source.fileName, "-o", "probe.json");
                expect([0, -1]).toContain(core.ret);
                const probeJson = JSON.parse(new TextDecoder().decode(core.FS.readFile("probe.json")));
                expect(Number(probeJson.format.duration)).toBeGreaterThanOrEqual(2);
                expect(probeJson.streams.some((stream: { codec_type: string }) => stream.codec_type === "audio")).toBe(true);
            }
            for (const step of plan.steps) if (step.args.length) {
                core.reset();
                core.exec(...step.args);
                if (core.ret !== 0 || (step.kind === "burn" && isSubtitleFontFailure(log))) throw new Error(`wasm ${step.description}: ${log}`);
            }
            writeFileSync(join(dir, "wasm.mp4"), core.FS.readFile("wasm.mp4"));
            expect(spectrum("wasm.mp4", 1.3, 220)).toBeGreaterThan(0.03);
            expect(spectrum("wasm.mp4", 1.3, 440)).toBeGreaterThan(0.03);
            expect(spectrum("wasm.mp4", 1.3, 880)).toBeGreaterThan(0.005);
            expect(spectrum("wasm.mp4", 3.5, 440)).toBeLessThan(0.002);
            expect(frame("wasm.mp4").some((value, index) => Math.abs(value - withoutText[index]) > 80)).toBe(true);
        } finally { globals.self = previousSelf; globals.importScripts = previousImportScripts; }
        const muted = structuredClone(canonical);
        muted.audio.find((clip) => clip.clipId === "voice")!.volume = 0;
        muted.audio.find((clip) => clip.clipId === "bgm")!.muted = true;
        await render("muted.mp4", muted);
        expect(spectrum("muted.mp4", 1.3, 220)).toBeGreaterThan(0.03);
        expect(spectrum("muted.mp4", 1.3, 440)).toBeLessThan(0.002);
        expect(spectrum("muted.mp4", 1.3, 880)).toBeLessThan(0.002);
    } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120000);

test.skipIf(process.env.BEEFTV_NATIVE_FFMPEG_TEST !== "1")("native FFmpeg: shared gap-silent-fade plan, offsets, silent video, fades, subtitle frame", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beeftv-gap-silent-"));
    const run = (args: string[]) => {
        const result = spawnSync("ffmpeg", ["-hide_banner", "-y", ...args], { cwd: dir, maxBuffer: 16 * 1024 * 1024 });
        if (result.status !== 0) throw new Error(result.stderr.toString());
        return result;
    };
    try {
        run(["-f", "lavfi", "-i", "color=red:s=320x180:r=30:d=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "tone.mp4"]);
        run(["-f", "lavfi", "-i", "color=green:s=320x180:r=30:d=1", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "silent.mp4"]);
        run(["-f", "lavfi", "-i", "sine=frequency=880:duration=2", "voice.wav"]);
        const canonical = loadEditingPlan("gap-silent-fade.plan.json");
        const sources = [
            { nodeId: "tone", fileName: "tone.mp4", durationMs: 1000, hasAudio: true },
            { nodeId: "silent", fileName: "silent.mp4", durationMs: 1000, hasAudio: false },
            { nodeId: "voice", fileName: "voice.wav", durationMs: 2000, hasAudio: true },
        ];
        const plan = lowerCanonicalPlan(canonical, sources, { width: 320, height: 180, fps: 30, outputName: "out.mp4" });
        expect(plan.concatEntries.some((name) => name.startsWith("gap-"))).toBe(true);
        expect(plan.steps.find((step) => step.kind === "mix")!.args.join(" ")).toContain("afade=t=in");
        await executeTimelineRenderPlan({ plan, engine: createNativeEngine(dir) });
        const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", "out.mp4"], { cwd: dir });
        expect(Math.abs(Number(probe.stdout.toString()) - 3)).toBeLessThan(0.1);
        const pcm = run(["-i", "out.mp4", "-vn", "-ac", "1", "-ar", "44100", "-f", "f32le", "pipe:1"]).stdout;
        const values = new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length));
        const amp = (start: number) => {
            const offset = Math.floor(start * 44100);
            let sum = 0;
            for (let i = 0; i < 4000; i++) sum += Math.abs(values[offset + i] || 0);
            return sum / 4000;
        };
        expect(amp(0.02)).toBeLessThan(amp(0.7));
        expect(amp(1.2)).toBeLessThan(0.002);
        expect(amp(2.2)).toBeLessThan(0.002);
        const pixel = run(["-ss", "1.2", "-i", "out.mp4", "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]).stdout;
        expect(pixel[0]).toBeLessThan(40);
        expect(pixel[1]).toBeLessThan(40);
        expect(pixel[2]).toBeLessThan(40);
        const withText = run(["-ss", "0.5", "-i", "out.mp4", "-frames:v", "1", "-vf", "crop=320:60:0:120", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"]).stdout;
        const withoutText = run(["-ss", "0.5", "-i", "timeline-mixed.mp4", "-frames:v", "1", "-vf", "crop=320:60:0:120", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"]).stdout;
        expect(withText.some((value, index) => Math.abs(value - withoutText[index]) > 80)).toBe(true);
        const streams = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", "out.mp4"], { cwd: dir });
        expect(streams.stdout.toString()).toContain("audio");
    } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120000);

test.skipIf(process.env.BEEFTV_NATIVE_FFMPEG_TEST !== "1")("native FFmpeg: image+gap+subtitle terminates with bounded duration and mixed audio", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beeftv-image-gap-"));
    const run = (args: string[], timeout = 20_000) => {
        const result = spawnSync("ffmpeg", ["-hide_banner", "-y", ...args], { cwd: dir, maxBuffer: 16 * 1024 * 1024, timeout, killSignal: "SIGKILL" });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(result.stderr.toString());
        return result;
    };
    try {
        run(["-f", "lavfi", "-i", "color=c=blue:s=320x180", "-frames:v", "1", "still.png"]);
        run(["-f", "lavfi", "-i", "sine=frequency=440:duration=2", "voice.wav"]);
        const canonical = loadEditingPlan("image-gap-sub.plan.json");
        const sources = [
            { nodeId: "still", fileName: "still.png", durationMs: 0, hasAudio: false },
            { nodeId: "voice", fileName: "voice.wav", durationMs: 2000, hasAudio: true },
        ];
        const plan = lowerCanonicalPlan(canonical, sources, { outputName: "out.mp4" });
        const image = plan.steps.find((step) => step.kind === "trim")!;
        expect(image.args.lastIndexOf("-t")).toBeGreaterThan(image.args.lastIndexOf("-i"));
        expect(plan.steps.find((step) => step.kind === "mix")!.args.join(" ")).not.toContain("alimiter");
        const engine = createNativeEngine(dir);
        const started = Date.now();
        await executeTimelineRenderPlan({ plan, engine });
        expect(Date.now() - started).toBeLessThan(20_000);
        const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", "out.mp4"], { cwd: dir });
        expect(Math.abs(Number(probe.stdout.toString()) - 3)).toBeLessThan(0.12);
        const pcm = run(["-i", "out.mp4", "-vn", "-ac", "1", "-ar", "44100", "-f", "f32le", "pipe:1"]).stdout;
        const values = new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length));
        const amp = (start: number) => {
            const offset = Math.floor(start * 44100);
            let sum = 0;
            for (let i = 0; i < 4000; i++) sum += Math.abs(values[offset + i] || 0);
            return sum / 4000;
        };
        expect(amp(0.5)).toBeGreaterThan(0.01);
        expect(amp(2.3)).toBeLessThan(0.002);
        const pixel = run(["-ss", "2.3", "-i", "out.mp4", "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]).stdout;
        expect(pixel[0]).toBeLessThan(40);
        expect(pixel[1]).toBeLessThan(40);
        expect(pixel[2]).toBeLessThan(40);
    } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30000);
