import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

let browser: Browser, server: ReturnType<typeof Bun.serve>, scratch: string;
let phase = "running", reads = 0, held = false;
let historyEmpty = false;
let taskHold = false, taskResolve: ((response: Response) => void) | null = null;
const queriedStatuses: string[] = [];
let lateResolve: ((response: Response) => void) | null = null;
const mediaReads: { resource: string; token: string | null }[] = [];
beforeEach(() => { phase = "running"; reads = 0; held = false; historyEmpty = false; taskHold = false; taskResolve = null; lateResolve = null; mediaReads.length = 0; queriedStatuses.length = 0; });
beforeAll(async () => {
    scratch = mkdtempSync(tmpdir() + "/beeftv-output-");
    for (const [name, color] of [["first", "red"], ["second", "blue"]]) execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `color=${color}:s=64x48:r=24:d=0.5`, "-c:v", "libx264", "-pix_fmt", "yuv420p", scratch + "/" + name + ".mp4"]);
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/assistant-outputs-harness.tsx"], target: "browser", define: {
        "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"', "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"', "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"', "process.env.NODE_ENV": '"production"',
    }, plugins: [{ name: "source", setup(builder) { builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) })); } }] });
    if (!build.success) throw Error(build.logs.join("\n"));
    const js = await build.outputs.find(output => output.path.endsWith(".js"))!.text();
    const ok = (data: unknown) => Response.json({ code: 0, data });
    server = Bun.serve({ port: 0, async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/harness.js") return new Response(js, { headers: { "content-type": "application/javascript" } });
        if (path === "/") return new Response('<html><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>', { headers: { "content-type": "text/html" } });
        if (path.endsWith("/assistant/status")) return ok({ available: true });
        if (path.endsWith("/assistant/ui-session")) return ok({ token: "synthetic-ui", expiresAt: new Date(Date.now() + 1800000).toISOString() });
        if (path.endsWith("/assistant/sessions")) return ok({ currentSessionId: "outputs-session", sessions: [] });
        if (path.endsWith("/assistant/history")) return ok({ sessionId: "outputs-session", turns: historyEmpty ? [] : [{ turnId: "render-turn", userText: "合成短片", selectedNodeIds: [], reply: "成片已登记", toolCalls: [], change: null, proposals: [], error: null, cancelled: false, outputs: [{ taskId: "first", kind: "video", sourceRevision: 4 }, { taskId: "second", kind: "video", sourceRevision: 5 }] }] });
        if (path.endsWith("/assistant/chat")) return new Response(JSON.stringify({ type: "turn_end", turnId: "stream-render", reply: "完成", toolCalls: [], proposals: [], change: null, error: null, cancelled: false, outputs: [{ taskId: "second", kind: "video", sourceRevision: 6 }] }) + "\n", { headers: { "content-type": "application/x-ndjson" } });
        if (path.startsWith("/api/tasks/")) {
            reads++; const id = path.split("/").at(-1)!;
            const status = id === "first" ? "succeeded" : phase;
            queriedStatuses.push(status);
            if (taskHold && id === "second") return new Promise<Response>(resolve => { taskResolve = resolve; });
            return ok({ id, type: "timeline_render", status, prompt: "", attempts: 0, createdAt: "fixture", updatedAt: "fixture", resultJson: status === "succeeded" ? JSON.stringify({ resourceId: id, video: { url: "https://must-not-fetch.invalid/wrong.mp4" } }) : undefined });
        }
        if (path.startsWith("/api/resources/") && path.endsWith("/file")) {
            const resource = path.split("/")[3]; mediaReads.push({ resource, token: request.headers.get("X-Desktop-Token") });
            if (request.headers.get("X-Desktop-Token") !== "synthetic-output-desktop") return new Response("forbidden", { status: 403 });
            const response = new Response(readFileSync(scratch + "/" + resource + ".mp4"), { headers: { "content-type": "video/mp4" } });
            if (held) return new Promise<Response>(resolve => { lateResolve = () => resolve(response); });
            return response;
        }
        return ok({});
    } });
    browser = await chromium.launch({ headless: true, executablePath: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].find(existsSync) });
});
afterAll(async () => { await browser?.close(); server?.stop(true); if (scratch) rmSync(scratch, { recursive: true, force: true }); });

test("real restored hook outputs poll queued/running to ready and play distinct authenticated resources", async () => {
    phase = "queued";
    const page = await browser.newPage(); await page.goto(server.url.href);
    await page.getByText("这是之前已完成的版本；后一次正在合成。").waitFor();
    expect(await page.getByRole("button", { name: "播放成片" }).count()).toBe(1);
    phase = "running";
    for (let i = 0; i < 40 && !queriedStatuses.includes("running"); i++) await new Promise(resolve => setTimeout(resolve, 100));
    expect(queriedStatuses).toContain("running");
    phase = "succeeded";
    await page.getByRole("button", { name: "播放成片" }).nth(1).waitFor();
    await page.getByRole("button", { name: "播放成片" }).nth(0).click();
    await page.waitForFunction(() => { const video = document.querySelector('video'); return video?.currentSrc.startsWith("blob:") && video.videoWidth === 64; });
    const firstURL = await page.locator("video").evaluate((video: HTMLVideoElement) => video.currentSrc);
    await page.getByRole("button", { name: "播放成片" }).nth(1).click();
    await page.waitForFunction(old => { const video = document.querySelector('video'); return video?.currentSrc.startsWith("blob:") && video.currentSrc !== old && video.videoWidth === 64; }, firstURL);
    expect(mediaReads.map(item => item.resource)).toEqual(["first", "second"]);
    expect(mediaReads.every(item => item.token === "synthetic-output-desktop")).toBe(true);
    expect(reads).toBeGreaterThan(2);
    const downloaded = page.waitForEvent("download", { timeout: 4000 }).catch(async error => { throw Error(error.message + " UI=" + await page.locator("body").innerText() + " media=" + JSON.stringify(mediaReads)); });
    await page.getByRole("button", { name: "下载", exact: true }).nth(1).click();
    const file = await downloaded;
    expect(file.suggestedFilename()).toBe("成片2.mp4");
    expect(createHash("sha256").update(readFileSync((await file.path())!)).digest("hex")).toBe(createHash("sha256").update(readFileSync(scratch + "/second.mp4")).digest("hex"));
    await page.reload(); await page.getByText("之前的版本", { exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "播放成片" }).count()).toBe(2);
    await page.close();
}, 15000);
test("later failed rendering preserves ready earlier version without claiming newest success", async () => {
    phase = "failed"; const page = await browser.newPage(); await page.goto(server.url.href);
    await page.getByText("合成未完成", { exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "播放成片" }).count()).toBe(1);
    expect(await page.getByText("这是之前已完成的版本；后一次合成未完成。").count()).toBe(1);
    expect(await page.getByText("已就绪", { exact: true }).count()).toBe(1);
    await page.close();
}, 15000);
test("initial loading and unread latest task do not falsely claim synthesis or latest failure", async () => {
    taskHold = true; phase = "succeeded";
    const page = await browser.newPage(); await page.goto(server.url.href);
    await page.getByText("正在读取状态", { exact: true }).nth(1).waitFor();
    expect(await page.getByText("正在合成", { exact: true }).count()).toBe(0);
    for (let i = 0; i < 30 && !taskResolve; i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(taskResolve).not.toBeNull(); taskResolve!(new Response("unavailable", { status: 403 }));
    await page.getByText("暂时无法读取状态", { exact: true }).waitFor();
    expect(await page.getByText("这是之前已完成的版本；后一次合成结果尚未确认。").count()).toBe(1);
    expect(await page.getByText("合成未完成", { exact: true }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "播放成片" }).count()).toBe(1);
    await page.close();
}, 15000);
test("account switch abandons late authenticated media and never creates an old-owner URL", async () => {
    phase = "succeeded"; held = true; const page = await browser.newPage();
    await page.addInitScript(() => { const original = URL.createObjectURL; Object.assign(window, { createdMediaURLs: [] }); URL.createObjectURL = blob => { const url = original(blob); (window as any).createdMediaURLs.push(url); return url; }; });
    await page.goto(server.url.href);
    await page.getByRole("button", { name: "播放成片" }).nth(0).click();
    await page.waitForTimeout(100); expect(lateResolve).not.toBeNull();
    await page.getByRole("button", { name: "切换账号" }).click(); lateResolve?.(new Response());
    await page.waitForTimeout(250);
    expect(await page.locator("video").count()).toBe(0);
    expect(await page.evaluate(() => (window as any).createdMediaURLs)).toEqual([]);
    await page.close();
}, 15000);
test("real streamed turn_end retains trusted output task without waiting for history", async () => {
    historyEmpty = true; phase = "succeeded";
    const page = await browser.newPage(); await page.goto(server.url.href);
    await page.getByRole("button", { name: "发送合成要求" }).click();
    await page.getByRole("button", { name: "播放成片" }).waitFor();
    expect(await page.getByText("成片1", { exact: true }).count()).toBe(1);
    await page.getByRole("button", { name: "播放成片" }).click();
    await page.waitForFunction(() => document.querySelector('video')?.videoWidth === 64);
    expect(mediaReads.map(item => item.resource)).toEqual(["second"]);
    await page.close();
}, 15000);
