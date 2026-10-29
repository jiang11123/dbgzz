import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import type { BunPlugin } from "bun";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let page: Page;
let cancels: string[];
let details: string[];
let playbackRequests = 0;
let aborted = 0;
let releases: (() => void)[] = [];
let errors: string[];
let diagnosticInputs: any[];

beforeAll(async () => {
    const plugin: BunPlugin = { name: "repair-harness", setup(builder) {
        builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
        builder.onLoad({ filter: /src\/components\/model-logo\.tsx$/ }, () => ({ contents: "export function ModelLogo() { return null; }", loader: "js" }));
        builder.onLoad({ filter: /src\/lib\/canvas\/canvas-export\.ts$/ }, () => ({ loader: "js", contents: `export async function exportCanvasProjects(projects, title, options) { window.__repairHarness.downloads.push({projects, title, options}); return "saved"; }` }));
        builder.onLoad({ filter: /\.(svg|png|jpe?g|gif|webp|woff2?)$/ }, () => ({ contents: "export default ''", loader: "js" }));
    } };
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/canvas-pr108-repair-harness.tsx"], plugins: [plugin], target: "browser",
        define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"',
            "import.meta.env.VITE_APP_VERSION": '"test"', "import.meta.env.VITE_BUILD_COMMIT": '"test"',
            "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"false"', "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"' } });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs.find(output => output.path.endsWith(".js"))!.text();
    const css = await build.outputs.find(output => output.path.endsWith(".css"))?.text() || "";
    const json = (data: unknown) => Response.json({ code: 0, data, msg: "ok" });
    server = Bun.serve({ port: 0, async fetch(request) {
        const url = new URL(request.url), path = url.pathname;
        if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
        if (path === "/harness.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
        if (path === "/api/diagnostics/preview") {
            diagnosticInputs.push(await request.json());
            return json({ clientEventLimit: 100, taskCount: 1, taskLogCount: 1, apiCallCount: 0, estimatedBytes: 100, willTruncate: false });
        }
        if (path.endsWith("/cancel")) { const id = path.split("/")[3]!; cancels.push(id); return json({ id, status: "cancelled" }); }
        if (path.startsWith("/api/tasks/video-")) {
            const id = path.split("/")[3]!; details.push(id);
            return json({ id, projectId: "canvas-a", type: "canvas_video", status: "succeeded", prompt: id, createdAt: "2026-10-10", updatedAt: "2026-10-10", resultJson: JSON.stringify({ mode: "video", video: { storageKey: "resource:" + id } }) });
        }
        if (path.startsWith("/api/resources/video-")) {
            if (!path.endsWith("/file")) return json({ resource: { id: path.split("/")[3], playbackStatus: "ready", kind: "video" } });
            playbackRequests++;
            await new Promise<void>(resolve => { releases.push(resolve); request.signal.addEventListener("abort", () => { aborted++; resolve(); }, { once: true }); });
            return new Response("bytes", { headers: { "Content-Type": "video/mp4", ETag: '"video:pb"' } });
        }
        if (path.endsWith("/history")) return json({ snapshots: [], currentRevision: 2 });
        if (path.startsWith("/api/")) return json({});
        return new Response('<meta name="viewport" content="width=device-width"><style>:root{--background:white;--foreground:black;--accent:#eee;--border:#ccc;--radius-lg:8px}body{margin:0}*,*::before,*::after{box-sizing:border-box}</style><link rel="stylesheet" href="/harness.css"><div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60000);
beforeEach(async () => {
    await page?.close();
    releases.splice(0).forEach(release => release());
    cancels = []; details = []; playbackRequests = 0; aborted = 0; errors = []; diagnosticInputs = [];
    page = await browser.newPage();
    page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
});
afterAll(async () => { releases.splice(0).forEach(release => release()); await browser?.close(); server?.stop(true); });
async function run(action: string) { await page.evaluate(async name => { await (window as any).__repairHarness[name](); }, action); }
async function confirm() { await page.evaluate(async () => { await (window as any).__repairHarness.confirmation.onOk(); }); }
async function waitFor(predicate: () => boolean) {
    const deadline = Date.now() + 4000;
    while (!predicate() && Date.now() < deadline) await Bun.sleep(20);
    expect(predicate()).toBe(true);
}

test("pending deletion cannot delete another canvas, including A→B→A with copied node IDs", async () => {
    await page.goto(server.url.toString());
    await page.getByRole("button", { name: "delete-node", exact: true }).click();
    await run("switchCanvas");
    await page.getByTestId("canvas").filter({ hasText: "canvas-b" }).waitFor();
    await confirm();
    expect(cancels).toEqual([]);
    expect(await page.getByTestId("nodes").textContent()).toBe("task-b");
    await run("switchCanvas");
    await page.getByTestId("canvas").filter({ hasText: "canvas-a" }).waitFor();
    await confirm();
    expect(cancels).toEqual([]);
    expect(await page.evaluate(() => (window as any).__repairHarness.deleted)).toEqual([]);
    expect(await page.evaluate(() => (window as any).__repairHarness.destroyed)).toBe(1);
    expect(errors).toEqual([]);
}, 15000);
test("account A→B→A and unmount dismiss pending deletion without cancellation", async () => {
    for (const action of ["switchScope", "unmountEditor"]) {
        await page.goto(server.url.toString());
        await page.getByRole("button", { name: "delete-node", exact: true }).click();
        await run(action);
        if (action === "unmountEditor") await page.getByText("unmounted", { exact: true }).waitFor();
        await confirm();
        expect(cancels).toEqual([]);
        expect(await page.evaluate(() => (window as any).__repairHarness.deleted)).toEqual([]);
        expect(await page.evaluate(() => (window as any).__repairHarness.destroyed)).toBe(1);
    }
    expect(errors).toEqual([]);
}, 15000);
test("owned confirmation cancels its task and deletes only its canvas", async () => {
    await page.goto(server.url.toString());
    await page.getByRole("button", { name: "delete-node", exact: true }).click();
    await confirm();
    expect(cancels).toEqual(["task-a"]);
    expect(await page.getByTestId("nodes").textContent()).toBe("");
    expect(await page.evaluate(() => (window as any).__repairHarness.deleted)).toEqual([{ projectId: "canvas-a", tasks: ["task-a"] }]);
    expect(errors).toEqual([]);
}, 15000);
test("100 history videos start no detail or playback requests until hover; leaving and closing abort download", async () => {
    await page.goto(`${server.url}?mode=videos`);
    const cards = page.locator("article");
    await cards.first().waitFor();
    expect(await cards.count()).toBe(100);
    await page.waitForTimeout(200);
    expect(details).toEqual([]);
    expect(playbackRequests).toBe(0);
    await cards.first().hover();
    await waitFor(() => playbackRequests === 1);
    await page.mouse.move(500, 500);
    await waitFor(() => aborted === 1);
    await cards.first().focus();
    await waitFor(() => playbackRequests === 2);
    await run("closeHistory");
    await waitFor(() => aborted === 2);
    expect(details).toEqual(["video-0", "video-0"]);
    expect(errors).toEqual([]);
}, 15000);
test("persisted drafts survive reload and can be previewed and downloaded without restoring the canvas", async () => {
    await page.setViewportSize({ width: 390, height: 700 });
    await page.goto(`${server.url}?mode=versions`);
    await page.getByRole("button", { name: "open-versions" }).waitFor();
    await run("seedDraft");
    await page.reload();
    await page.getByRole("button", { name: "open-versions" }).click();
    await page.getByRole("tab", { name: /本机草稿 1/ }).click();
    await page.getByRole("button", { name: /本机备份/ }).click();
    await page.getByRole("button", { name: "下载草稿" }).click();
    const state = await page.evaluate(() => (window as any).__repairHarness);
    expect(state.downloads[0].projects[0].nodes[0].title).toBe("old-draft");
    expect(state.downloads[0].options.includeLocalDrawings).toBe(false);
    expect(state.restored).toEqual([]);
    expect(await page.getByRole("button", { name: "恢复此版本" }).count()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
}, 15000);

test("the task diagnostic URL opens a scoped modal and closes back to model settings", async () => {
    await page.setViewportSize({ width: 390, height: 700 });
    await page.goto(`${server.url}?mode=diagnostics&section=diagnostics&taskId=task-1&projectId=canvas-1`);
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "导出诊断包" }).waitFor();
    await waitFor(() => diagnosticInputs.length > 0);
    expect(diagnosticInputs[0]).toMatchObject({ taskId: "task-1", projectId: "canvas-1" });
    await dialog.getByRole("button", { name: "关闭问题诊断" }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByText("本地模型渠道", { exact: true }).waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
}, 15000);
