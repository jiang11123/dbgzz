import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { BunPlugin } from "bun";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;
let fail = false;
let recovered = false;
let requests: string[] = [];
let canonicalCanvas: Record<string, any> | undefined;

const recoveredAsset = {
    id: "asset-original-video", kind: "video", title: "生成视频", coverUrl: "", tags: [],
    createdAt: "2026-10-01", updatedAt: "2026-10-01",
    data: { url: "/api/resources/test-video/file", storageKey: "resource:test-video", width: 320, height: 180, bytes: 1024, mimeType: "video/mp4" },
};

beforeAll(async () => {
    // CI pins Bun 1.3.9, whose build API does not resolve every tsconfig path
    // alias transitively. Resolve the repository's one alias explicitly.
    const plugins: BunPlugin[] = [{ name: "test-source-alias", setup(builder) {
        builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
    } }];
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/video-recovery-harness.tsx"], plugins, target: "browser", define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' } });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    const historyBuild = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/task-history-recovery-harness.tsx"], plugins, target: "browser", define: { "import.meta.env": "{}", "process.env.NODE_ENV": '\"production\"' } });
    if (!historyBuild.success) throw new Error(historyBuild.logs.join("\n"));
    const historyScript = await historyBuild.outputs[0].text();
    server = Bun.serve({ port: 0, async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
        if (path === "/history.js") return new Response(historyScript, { headers: { "Content-Type": "text/javascript" } });
        if (path === "/history") return new Response('<div id="root"></div><script type="module" src="/history.js"></script>', { headers: { "Content-Type": "text/html" } });
        if (path.startsWith("/api/")) {
            requests.push(`${request.method} ${path}`);
            if (path === "/api/assets/asset-original-video") return Response.json({ code: 0, data: { asset: recoveredAsset } });
            if (path === "/api/canvas-projects/canvas-a") {
                if (request.method === "PUT") {
                    const body = await request.json();
                    canonicalCanvas = { ...body.project, revision: (canonicalCanvas?.revision ?? 0) + 1 };
                }
                return Response.json({ code: 0, data: { project: canonicalCanvas } });
            }
            if (path === "/api/ops/canvas.document.commit") {
                const body = await request.json();
                canonicalCanvas = { ...body.params.document, revision: (canonicalCanvas?.revision ?? 0) + 1 };
                return Response.json({ code: 0, data: { op: "canvas.document.commit", opId: body.opId, result: { id: "canvas-a", revision: canonicalCanvas.revision }, revision: canonicalCanvas.revision } });
            }
            if (path === "/api/ops/canvas.task.bind") {
                const body = await request.json();
                if (!canonicalCanvas) return Response.json({ code: 409, msg: "画布尚未保存" }, { status: 409 });
                canonicalCanvas = { ...canonicalCanvas, revision: canonicalCanvas.revision + 1,
                    nodes: canonicalCanvas.nodes.map((node: Record<string, any>) => node.id === body.params.nodeId ? {
                        ...node, metadata: { ...node.metadata, taskId: "original", taskStatus: "succeeded", status: "success", assetId: recoveredAsset.id, ...recoveredAsset.data },
                    } : node),
                };
                return Response.json({ code: 0, data: { op: "canvas.task.bind", opId: body.opId, revision: canonicalCanvas.revision, result: {
                    applied: true, bindingStatus: "bound", canvasId: "canvas-a", nodeId: body.params.nodeId, taskId: "original", outputIndex: 0,
                    mediaType: "video", assetId: recoveredAsset.id, resourceId: "test-video", storageKey: "resource:test-video", revision: canonicalCanvas.revision,
                    canvas: canonicalCanvas, node: canonicalCanvas.nodes.find((node: Record<string, any>) => node.id === body.params.nodeId),
                } } });
            }
            if (path === "/api/tasks/original") return Response.json({ code: 0, data: { id: "original", type: "canvas_video", status: "failed", providerRequestId: "upstream-original", prompt: "test", attempts: 1, createdAt: "2026-10-01", updatedAt: "2026-10-01" } });
            if (/^\/api\/tasks\/[ab](\/logs)?$/.test(path)) {
                const id = path.split("/")[3];
                if (id === "a") await Bun.sleep(700);
                return Response.json({ code: 0, data: path.endsWith("/logs") ? [] : { id, type: "canvas_video", status: "failed", providerRequestId: `provider-${id}`, prompt: `detail ${id}`, attempts: 1, createdAt: "2026-10-01", updatedAt: "2026-10-01" } });
            }
            if (path.endsWith("/query-provider")) {
                await Bun.sleep(300);
                if (fail) return Response.json({ code: 1, msg: "连接中断，请稍后取回" }, { status: 503 });
                if (recovered) return Response.json({ code: 0, data: { recovered: true, providerStatus: "completed", task: { id: "original", status: "succeeded", type: "canvas_video", outputs: [{ outputIndex: 0, mediaType: "video", materializedAssetId: recoveredAsset.id }], resultJson: JSON.stringify({ mode: "video", video: { storageKey: "resource:test-video", url: "/api/resources/test-video/file", mimeType: "video/mp4", width: 320, height: 180 } }) } } });
                return Response.json({ code: 0, data: { recovered: false, providerStatus: "processing", task: { id: "original", status: "failed", type: "canvas_video" } } });
            }
            return Response.json({ code: 0, data: [] });
        }
        return new Response('<div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 30_000);

beforeEach(async () => {
    await page?.close(); fail = false; recovered = false; requests = []; canonicalCanvas = undefined;
    page = await browser.newPage();
    await page.goto(server.url.toString());
    await page.getByRole("button", { name: "取回结果", exact: true }).waitFor();
});
afterAll(async () => { await browser?.close(); server?.stop(true); });

test("canvas recovery explains query-only behavior and prevents duplicate requests", async () => {
    expect(await page.getByText("查询原任务并取回视频，不会重新生成。").count()).toBe(1);
    expect(await page.getByText("视频下载中断，请取回结果").count()).toBe(1);
    await page.getByRole("button", { name: "double retrieve" }).evaluate((button: HTMLButtonElement) => button.click());
    await page.getByText("原任务仍在处理中，请稍后再取回结果").waitFor();
    expect(requests.filter((request) => request.startsWith("POST"))).toEqual(["POST /api/tasks/original/query-provider"]);
});

test("a failed retrieval remains retryable without creating a generation", async () => {
    fail = true;
    await page.getByRole("button", { name: "取回结果", exact: true }).click();
    await page.getByText("连接中断，请稍后取回").waitFor();
    fail = false;
    await page.getByRole("button", { name: "取回结果", exact: true }).click();
    await page.getByText("原任务仍在处理中，请稍后再取回结果").waitFor();
    expect(requests.filter((request) => request.startsWith("POST"))).toEqual(Array(2).fill("POST /api/tasks/original/query-provider"));
});

test("missing provider receipt hides retrieval and switching canvas suppresses stale feedback", async () => {
    await page.getByRole("button", { name: "取回结果", exact: true }).click();
    await page.getByRole("button", { name: "switch project" }).evaluate((button: HTMLButtonElement) => button.click());
    await page.waitForTimeout(700);
    expect(await page.getByText("原任务仍在处理中，请稍后再取回结果").count()).toBe(0);
    await page.reload();
    await page.getByRole("button", { name: "missing receipt" }).evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.getByRole("button", { name: "取回结果", exact: true }).count()).toBe(0);
});

test("desktop history late detail never reopens a closed drawer or replaces another task", async () => {
    await page.goto(new URL("/history", server.url).toString());
    await page.getByRole("button", { name: "task a", exact: true }).click();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.waitForTimeout(900);
    expect(await page.getByRole("dialog").count()).toBe(0);
    await page.getByRole("button", { name: "task a", exact: true }).click();
    await page.getByRole("button", { name: "task b", exact: true }).evaluate((button: HTMLButtonElement) => button.click());
    await page.getByRole("dialog").getByText("detail b", { exact: true }).waitFor();
    await page.waitForTimeout(900);
    expect(await page.getByRole("dialog").getByText("detail a", { exact: true }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "取回结果", exact: true }).count()).toBe(1);
});

test("retrieved original result is applied and persisted onto the canvas", async () => {
    recovered = true;
    await page.getByRole("button", { name: "取回结果", exact: true }).click();
    await page.waitForFunction(() => JSON.parse(document.getElementById("snapshot")!.textContent!).nodes[0]?.metadata?.status === "success", null, { timeout: 10_000 });
    const snapshot = JSON.parse(await page.locator("#snapshot").innerText());
    expect(snapshot.nodes[0].metadata.storageKey).toBe("resource:test-video");
    expect(snapshot.nodes[0].metadata.taskId).toBe("original");
    expect(canonicalCanvas?.nodes[0].metadata.storageKey).toBe("resource:test-video");
    expect(requests.filter((request) => request === "POST /api/ops/canvas.task.bind")).toHaveLength(1);
    expect(requests.filter((request) => request.startsWith("POST /api/tasks"))).toEqual(["POST /api/tasks/original/query-provider"]);
}, 15_000);
