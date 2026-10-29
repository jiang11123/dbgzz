import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;
let stage = "正在取回结果";
let writes: string[] = [];
let releaseCancellation: (() => void) | undefined;
let holdCancellation = false;
let releaseQuery: (() => void) | undefined;
let holdQuery = false;

beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/canvas-delivery-control-harness.tsx"], target: "browser", define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "source-alias", setup(builder) {
        builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
    } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    server = Bun.serve({ port: 0, async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
        if (path.startsWith("/api/tasks/")) {
            if (request.method === "POST") {
                writes.push(path);
                if (path.endsWith("/cancel")) {
                    if (holdCancellation) await new Promise<void>((resolve) => { releaseCancellation = resolve; });
                    stage = "delivery_paused";
                }
                if (path.endsWith("/retry")) stage = "正在取回结果";
            } else if (holdQuery) {
                holdQuery = false;
                await new Promise<void>((resolve) => { releaseQuery = resolve; });
            }
            return Response.json({ code: 0, data: { id: "task-test", type: "canvas_video", status: "succeeded", stage, progress: 100, prompt: "test", attempts: 1, createdAt: new Date().toISOString(), outputs: [{ outputIndex: 0, mediaType: "video", materializationErrorCode: stage === "delivery_paused" ? stage : undefined }] } });
        }
        if (path.startsWith("/api/")) return Response.json({ code: 0, data: [] });
        return new Response('<div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } });
    } });
    browser = await chromium.launch({ headless: true });
}, 30_000);

beforeEach(async () => { await page?.close(); stage = "正在取回结果"; writes = []; holdCancellation = false; releaseCancellation = undefined; holdQuery = false; releaseQuery = undefined; page = await browser.newPage(); });
afterAll(async () => { releaseCancellation?.(); releaseQuery?.(); await browser?.close(); server?.stop(true); });

for (const oldContent of [false, true]) {
    test(`stop and resume original delivery with retained old content=${oldContent}`, async () => {
        await page.goto(server.url + (oldContent ? "?old" : ""));
        await page.getByRole("button", { name: "停止取回结果", exact: true }).click();
        await page.getByRole("dialog").getByRole("button", { name: "停止取回", exact: true }).click();
        await page.getByRole("button", { name: "继续取回", exact: true }).waitFor();
        const paused = JSON.parse(await page.locator("#snapshot").innerText()).nodes[0].metadata;
        expect(paused.status).toBe("error");
        expect(paused.resourceReloadAvailable).toBe(true);
        await page.getByRole("button", { name: "继续取回", exact: true }).click();
        await page.waitForFunction(() => JSON.parse(document.getElementById("snapshot")!.textContent!).nodes[0].metadata.taskStage === "正在取回结果");
        const resumed = JSON.parse(await page.locator("#snapshot").innerText()).nodes[0].metadata;
        expect(resumed.status).toBe("loading");
        expect(resumed.taskId).toBe("task-test");
        expect(writes).toEqual(["/api/tasks/task-test/cancel", "/api/tasks/task-test/retry"]);
    }, 15_000);
}

test("resume delivery yields the node when another request takes it over", async () => {
    await page.goto(server.url.toString());
    await page.getByRole("button", { name: "停止取回结果", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "停止取回", exact: true }).click();
    await page.getByRole("button", { name: "继续取回", exact: true }).waitFor();
    holdQuery = true;
    await page.getByRole("button", { name: "继续取回", exact: true }).click();
    const deadline = Date.now() + 3000;
    while (!releaseQuery && Date.now() < deadline) await Bun.sleep(10);
    expect(releaseQuery).toBeDefined();
    await page.evaluate(() => document.getElementById("take-over")!.click());
    releaseQuery?.();
    // The superseded resume must neither restart delivery nor overwrite the new owner.
    const settle = Date.now() + 1000;
    while (!writes.includes("/api/tasks/task-test/retry") && Date.now() < settle) await Bun.sleep(20);
    expect(writes).toEqual(["/api/tasks/task-test/cancel"]);
    const metadata = JSON.parse(await page.locator("#snapshot").innerText()).nodes[0].metadata;
    expect(metadata.status).toBe("loading");
    expect(metadata.taskStage).toBe("接管");
}, 15_000);

for (const owner of ["canvas", "account"]) {
    for (const afterRequest of [false, true]) {
        test(`discard old cancellation after ${owner} switch, request started=${afterRequest}`, async () => {
            await page.goto(server.url.toString());
            await page.getByRole("button", { name: "停止取回结果", exact: true }).click();
            const confirm = page.getByRole("dialog").getByRole("button", { name: "停止取回", exact: true });
            if (afterRequest) {
                holdCancellation = true;
                await confirm.click();
                const deadline = Date.now() + 3000;
                while (!releaseCancellation && Date.now() < deadline) await Bun.sleep(10);
                expect(writes).toHaveLength(1);
            }
            // Simulate route/account changes while the actual AntD dialog lives.
            await page.evaluate((owner) => document.getElementById(`switch-${owner}`)!.click(), owner);
            if (afterRequest) releaseCancellation?.();
            else await page.getByRole("dialog").getByRole("button", { name: "继续等待", exact: true }).click({ timeout: 5000 }).catch(() => {});
            await page.getByRole("dialog").waitFor({ state: "hidden" });
            expect(writes).toHaveLength(afterRequest ? 1 : 0);
            expect(JSON.parse(await page.locator("#snapshot").innerText()).nodes[0].metadata.status).toBe("loading");
            expect(await page.getByText("已停止取回", { exact: true }).count()).toBe(0);
        }, 15_000);
    }
}
