import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { BunPlugin } from "bun";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

// A canvas opens from its cached copy first; the remote copy can arrive later
// while the editor is already loaded. Nodes that only exist in that later copy
// must still be recovered through the same task subscription, and nothing the
// user started in this session may be stopped, failed or subscribed twice.

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;
let requests: string[] = [];
let taskReads = new Map<string, number>();
let slowDone = false;
let canonicalCanvas: Record<string, any> | undefined;

const NOW = "2026-10-15T00:00:00Z";
const assetFor = (taskId: string) => ({
    id: `asset-${taskId}`, kind: "video", title: "生成视频", coverUrl: "", tags: [], createdAt: NOW, updatedAt: NOW,
    data: { url: `/api/resources/${taskId}-video/file`, storageKey: `resource:${taskId}-video`, width: 320, height: 180, bytes: 1024, mimeType: "video/mp4" },
});
const runningTask = (id: string) => ({ id, type: "canvas_video", status: "running", projectId: "canvas-a", prompt: "late", attempts: 1, createdAt: NOW, updatedAt: NOW });
const succeededTask = (id: string) => ({
    ...runningTask(id), status: "succeeded",
    outputs: [{ outputIndex: 0, mediaType: "video", materializedAssetId: `asset-${id}` }],
    resultJson: JSON.stringify({ mode: "video", video: { storageKey: `resource:${id}-video`, url: `/api/resources/${id}-video/file`, mimeType: "video/mp4", width: 320, height: 180 } }),
});
const lateVideoNode = (id: string, taskId: string) => ({ id, type: "video", title: id, position: { x: 0, y: 400 }, width: 320, height: 180, metadata: { status: "loading", taskId, taskStatus: "running", prompt: "late" } });
const lateOrphanNode = (id: string) => ({ id, type: "image", title: id, position: { x: 400, y: 400 }, width: 320, height: 180, metadata: { status: "loading", prompt: "orphan" } });

type Snapshot = { projectId: string; nodes: Array<{ id: string; metadata?: Record<string, any> }>; freshAborted: boolean | null; store: Record<string, Array<{ id: string; metadata?: Record<string, any> }>> };
const snapshot = () => page.evaluate(() => window.lateHarness!.snapshot()) as Promise<Snapshot>;
const nodeIn = (snap: Snapshot, id: string) => snap.nodes.find((node) => node.id === id);
async function waitUntil(label: string, check: () => boolean | Promise<boolean>, timeoutMs = 8_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check()) return;
        await Bun.sleep(50);
    }
    throw new Error(`timed out waiting for: ${label}; ${JSON.stringify({ snapshot: await snapshot(), requests, taskReads: [...taskReads] })}`);
}

beforeAll(async () => {
    const plugins: BunPlugin[] = [{ name: "test-source-alias", setup(builder) {
        builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
        builder.onLoad({ filter: /\.(css|svg|png|jpe?g|gif|webp|woff2?)$/ }, () => ({ contents: "export default ''", loader: "js" }));
    } }];
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/canvas-late-generation-recovery-harness.tsx"], plugins, target: "browser", define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' } });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    server = Bun.serve({ port: 0, async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
        if (!path.startsWith("/api/")) return new Response('<div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } });
        requests.push(`${request.method} ${path}`);
        const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(path);
        if (taskMatch && request.method === "GET") {
            const id = decodeURIComponent(taskMatch[1]);
            const reads = (taskReads.get(id) ?? 0) + 1;
            taskReads.set(id, reads);
            if (id === "late-task") return Response.json({ code: 0, data: reads === 1 ? runningTask(id) : succeededTask(id) });
            if (id === "late-done") return Response.json({ code: 0, data: succeededTask(id) });
            if (id === "late-failed" || id === "cont-task") return Response.json({ code: 0, data: { ...runningTask(id), status: "failed", error: "上游生成失败" } });
            if (id.startsWith("slow-task")) return Response.json({ code: 0, data: slowDone ? succeededTask(id) : runningTask(id) });
            return Response.json({ code: 0, data: { ...runningTask(id), type: "canvas_image" } });
        }
        const assetMatch = /^\/api\/assets\/asset-([^/]+)$/.exec(path);
        if (assetMatch) return Response.json({ code: 0, data: { asset: assetFor(assetMatch[1]) } });
        if (path === "/api/ops/canvas.document.commit") {
            const body = await request.json();
            canonicalCanvas = { ...body.params.document, revision: (canonicalCanvas?.revision ?? 0) + 1 };
            return Response.json({ code: 0, data: { op: "canvas.document.commit", opId: body.opId, result: { id: body.params.id ?? "canvas-a", revision: canonicalCanvas.revision }, revision: canonicalCanvas.revision } });
        }
        if (path === "/api/ops/canvas.task.bind") {
            const body = await request.json();
            if (!canonicalCanvas) return Response.json({ code: 409, msg: "画布尚未保存" }, { status: 409 });
            const asset = assetFor(body.params.taskId);
            canonicalCanvas = { ...canonicalCanvas, revision: canonicalCanvas.revision + 1,
                nodes: canonicalCanvas.nodes.map((node: Record<string, any>) => node.id === body.params.nodeId ? {
                    ...node, metadata: { ...node.metadata, taskId: body.params.taskId, taskStatus: "succeeded", status: "success", errorDetails: undefined, assetId: asset.id, ...asset.data },
                } : node),
            };
            return Response.json({ code: 0, data: { op: "canvas.task.bind", opId: body.opId, revision: canonicalCanvas.revision, result: {
                applied: true, bindingStatus: "bound", canvasId: body.params.canvasId, nodeId: body.params.nodeId, taskId: body.params.taskId, outputIndex: 0,
                mediaType: "video", assetId: asset.id, resourceId: `${body.params.taskId}-video`, storageKey: asset.data.storageKey, revision: canonicalCanvas.revision,
                canvas: canonicalCanvas, node: canonicalCanvas.nodes.find((node: Record<string, any>) => node.id === body.params.nodeId),
            } } });
        }
        if (path.startsWith("/api/canvas-projects/")) {
            if (request.method === "PUT") {
                const body = await request.json();
                canonicalCanvas = { ...body.project, revision: (canonicalCanvas?.revision ?? 0) + 1 };
            }
            return Response.json({ code: 0, data: { project: canonicalCanvas } });
        }
        return Response.json({ code: 0, data: [] });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 30_000);

beforeEach(async () => {
    await page?.close();
    requests = []; taskReads = new Map(); slowDone = false; canonicalCanvas = undefined;
    page = await browser.newPage();
    page.on("pageerror", (error) => console.error("pageerror:", error.message));
    await page.goto(server.url.toString());
    await page.waitForFunction(() => Boolean(window.lateHarness));
});
afterAll(async () => { await browser?.close(); server?.stop(true); });

test("a task node that only arrives with the later remote copy is subscribed and its result lands on the canvas", async () => {
    await page.evaluate((nodes) => window.lateHarness!.remoteLoad(nodes as never), [lateVideoNode("node-late-task", "late-task")]);
    await waitUntil("late task result on canvas", async () => nodeIn(await snapshot(), "node-late-task")?.metadata?.status === "success", 10_000);
    const snap = await snapshot();
    const late = nodeIn(snap, "node-late-task")!;
    expect(late.metadata?.taskId).toBe("late-task");
    expect(late.metadata?.storageKey).toBe("resource:late-task-video");
    expect(late.metadata?.errorDetails).toBeUndefined();
    expect(nodeIn(snap, "node-cached")?.metadata?.status).toBe("success");
    expect(requests.filter((request) => request === "POST /api/ops/canvas.task.bind")).toHaveLength(1);
    expect(requests.some((request) => request.startsWith("POST /api/tasks"))).toBe(false);
}, 20_000);

test("a newer request during asset hydration prevents the old result from being bound", async () => {
    let releaseAsset!: () => void;
    const assetGate = new Promise<void>((resolve) => { releaseAsset = resolve; });
    let hydrating = false;
    await page.route("**/api/assets/asset-late-done", async (route) => {
        hydrating = true;
        await assetGate;
        await route.fulfill({ json: { code: 0, data: { asset: assetFor("late-done") } } });
    });
    await page.evaluate((nodes) => window.lateHarness!.remoteLoad(nodes as never), [lateVideoNode("node-hydrating", "late-done")]);
    await waitUntil("old result hydrating", () => hydrating);
    await page.evaluate(() => window.lateHarness!.regenerate("node-hydrating"));
    releaseAsset();
    await Bun.sleep(500);
    expect(requests).not.toContain("POST /api/ops/canvas.task.bind");
    expect(nodeIn(await snapshot(), "node-hydrating")?.metadata?.status).toBe("loading");
}, 15_000);

test("an interrupted node without a task that arrives later becomes a clear error instead of loading forever", async () => {
    await page.evaluate((nodes) => window.lateHarness!.remoteLoad(nodes as never), [lateOrphanNode("node-late-orphan")]);
    await waitUntil("late orphan marked", async () => nodeIn(await snapshot(), "node-late-orphan")?.metadata?.status === "error");
    const orphan = nodeIn(await snapshot(), "node-late-orphan")!;
    expect(orphan.metadata?.errorDetails).toBe("页面刷新后本地生成已中断，请重新生成。");
    expect(requests.filter((request) => request.startsWith("POST "))).toEqual([]);
}, 15_000);

test("a concurrent task receipt preserves another node's queued recovery update", async () => {
    await page.evaluate(() => window.lateHarness!.refreshMerge([{ id: "node-recovered", type: "video", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { status: "success", storageKey: "resource:original", content: "/api/resources/original/file" } }]));
    await page.evaluate(() => window.lateHarness!.queueRecoveryAndBind());
    await waitUntil("receipt and recovery persisted", async () => {
        const snap = await snapshot();
        return nodeIn(snap, "node-cached")?.metadata?.taskId === "receipt-task" && snap.store["canvas-a"].find(node => node.id === "node-recovered")?.metadata?.taskStatus === "failed";
    });
    const snap = await snapshot();
    const recovered = nodeIn(snap, "node-recovered");
    expect(recovered?.metadata?.taskStatus).toBe("failed");
    expect(recovered?.metadata?.errorDetails).toBe("恢复失败");
    expect(nodeIn(snap, "node-cached")?.metadata?.taskStatus).toBe("running");
    expect(snap.store["canvas-a"].find(node => node.id === "node-cached")?.metadata?.taskId).toBe("receipt-task");
    expect(snap.store["canvas-a"].find(node => node.id === "node-cached")?.metadata?.taskStatus).toBe("running");
}, 15_000);

test("late nodes in every recoverable state are reconciled, not only loading ones", async () => {
    await page.evaluate((nodes) => window.lateHarness!.remoteLoad(nodes as never), [
        { id: "node-late-failed", type: "video", title: "failed", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { status: "error", taskId: "late-failed", taskStatus: "running", errorDetails: "旧的错误" } },
        { id: "node-late-empty", type: "video", title: "empty", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { status: "success", taskId: "late-done", taskStatus: "succeeded" } },
        { id: "node-late-continuation", type: "image", title: "continuation", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { status: "success", content: "/api/resources/c/file", storageKey: "resource:c", agentGenerationContinuation: { id: "cont-1", taskId: "cont-task", status: "pending" } } },
        { id: "node-late-legacy", type: "image", title: "legacy", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { status: "error", errorDetails: "页面刷新后生成已中断，请重新生成。" } },
    ]);
    await waitUntil("all late states reconciled", async () => {
        const snap = await snapshot();
        return nodeIn(snap, "node-late-failed")?.metadata?.taskStatus === "failed"
            && nodeIn(snap, "node-late-empty")?.metadata?.storageKey === "resource:late-done-video"
            && nodeIn(snap, "node-late-continuation")?.metadata?.agentGenerationContinuation?.status === "failed"
            && nodeIn(snap, "node-late-legacy")?.metadata?.errorDetails === "页面刷新后本地生成已中断，请重新生成。";
    }, 10_000);
    const snap = await snapshot();
    expect(nodeIn(snap, "node-late-failed")?.metadata?.status).toBe("error");
    expect(nodeIn(snap, "node-late-failed")?.metadata?.errorDetails).not.toBe("旧的错误");
    expect(nodeIn(snap, "node-late-empty")?.metadata?.status).toBe("success");
    expect(nodeIn(snap, "node-late-continuation")?.metadata?.status).toBe("success");
    expect(nodeIn(snap, "node-late-continuation")?.metadata?.storageKey).toBe("resource:c");
    expect(nodeIn(snap, "node-late-legacy")?.metadata?.status).toBe("error");
    expect(taskReads.get("late-failed") ?? 0).toBeGreaterThan(0);
    expect(taskReads.get("cont-task") ?? 0).toBeGreaterThan(0);
}, 20_000);

test("nodes merged by a normal refresh are left alone, even with the restore text in them", async () => {
    const refreshed = [
        { id: "node-refresh-loading", type: "image", title: "a", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { status: "loading", prompt: "agent" } },
        { id: "node-refresh-upload", type: "image", title: "b", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { fileUpload: "uploading", fileUploadProgress: 40 } },
        { id: "node-refresh-marked", type: "image", title: "c", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { status: "loading", errorDetails: "正在从任务中心恢复生成状态..." } },
        { id: "node-refresh-task", type: "video", title: "d", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { status: "loading", taskId: "refresh-task", taskStatus: "running" } },
    ];
    await page.evaluate((nodes) => window.lateHarness!.refreshMerge(nodes as never), refreshed);
    await Bun.sleep(1_500);
    const snap = await snapshot();
    for (const node of refreshed) expect(nodeIn(snap, node.id)?.metadata).toEqual(node.metadata);
    expect(taskReads.get("refresh-task") ?? 0).toBe(0);
    expect(requests.filter((request) => request.startsWith("POST "))).toEqual([]);
}, 15_000);

test("an old task's result never overwrites a newer request or a newer task id on the same node", async () => {
    await page.evaluate((nodes) => window.lateHarness!.remoteLoad(nodes as never), [lateVideoNode("node-slow", "slow-task"), lateVideoNode("node-slow-2", "slow-task-2")]);
    await waitUntil("old tasks subscribed", () => (taskReads.get("slow-task") ?? 0) > 0 && (taskReads.get("slow-task-2") ?? 0) > 0);
    // node-slow: the user regenerates in place (old task id still on the node until the new task binds).
    await page.evaluate(() => window.lateHarness!.regenerate("node-slow"));
    // node-slow-2: a newer copy arrives with a newer task id.
    await page.evaluate((nodes) => window.lateHarness!.remoteLoad(nodes as never), [lateVideoNode("node-slow-2", "newer-task")]);
    await waitUntil("newer task subscribed", () => (taskReads.get("newer-task") ?? 0) > 0);
    slowDone = true;
    await Bun.sleep(4_500);
    const snap = await snapshot();
    expect(requests).not.toContain("POST /api/ops/canvas.task.bind");
    expect(nodeIn(snap, "node-slow")?.metadata?.status).toBe("loading");
    expect(nodeIn(snap, "node-slow")?.metadata?.storageKey).toBeUndefined();
    expect(nodeIn(snap, "node-slow-2")?.metadata?.taskId).toBe("newer-task");
    expect(nodeIn(snap, "node-slow-2")?.metadata?.status).toBe("loading");
    expect(nodeIn(snap, "node-slow-2")?.metadata?.storageKey).toBeUndefined();
}, 25_000);

test("a request the user just started is not failed, stopped or subscribed again when the later copy arrives", async () => {
    await page.evaluate(() => window.lateHarness!.startFreshRequest());
    await page.evaluate(() => window.lateHarness!.bindFreshTask());
    // The remote copy carries the in-flight nodes as loading (already autosaved)
    // plus an unrelated orphan; once the orphan is marked, the late scan has run.
    await page.evaluate((nodes) => window.lateHarness!.remoteLoad(nodes as never), [lateOrphanNode("node-late-orphan")]);
    await waitUntil("late scan ran", async () => nodeIn(await snapshot(), "node-late-orphan")?.metadata?.status === "error");
    await Bun.sleep(300);
    const snap = await snapshot();
    expect(nodeIn(snap, "node-fresh")?.metadata?.status).toBe("loading");
    expect(nodeIn(snap, "node-fresh")?.metadata?.taskId).toBe("fresh-task");
    expect(nodeIn(snap, "config-fresh")?.metadata?.status).toBe("loading");
    expect(snap.freshAborted).toBe(false);
    expect(taskReads.get("fresh-task") ?? 0).toBe(0);
}, 15_000);

test("a batch the user just started keeps its root as is when a later copy is reconciled", async () => {
    await page.evaluate(() => window.lateHarness!.startFreshBatch());
    await page.evaluate((nodes) => window.lateHarness!.remoteLoad(nodes as never), [lateOrphanNode("node-late-orphan")]);
    await waitUntil("late scan ran", async () => nodeIn(await snapshot(), "node-late-orphan")?.metadata?.status === "error");
    await Bun.sleep(300);
    const snap = await snapshot();
    expect(nodeIn(snap, "batch-root")?.metadata?.status).toBe("loading");
    expect(nodeIn(snap, "batch-root")?.metadata?.errorDetails).not.toBe("全部图片生成失败");
    expect(nodeIn(snap, "batch-a")?.metadata?.status).toBe("loading");
    expect(nodeIn(snap, "batch-b")?.metadata?.status).toBe("loading");
}, 15_000);

test("switching canvas aborts a late recovery and never writes the old task back", async () => {
    await page.evaluate((nodes) => window.lateHarness!.remoteLoad(nodes as never), [lateVideoNode("node-slow", "slow-task")]);
    await waitUntil("late task subscribed", () => (taskReads.get("slow-task") ?? 0) > 0);
    await page.evaluate(() => window.lateHarness!.switchProject("canvas-b"));
    await waitUntil("canvas b loaded", async () => (await snapshot()).projectId === "canvas-b");
    const writesBefore = requests.filter((request) => request.startsWith("POST /api/ops/")).length;
    slowDone = true;
    await Bun.sleep(4_500);
    const snap = await snapshot();
    expect(requests.filter((request) => request.startsWith("POST /api/ops/")).length).toBe(writesBefore);
    expect(requests).not.toContain("POST /api/ops/canvas.task.bind");
    expect(snap.nodes.map((node) => node.id)).toEqual(["node-b"]);
    expect(snap.nodes[0].metadata?.status).toBe("success");
    expect(snap.store["canvas-a"]?.find((node) => node.id === "node-slow")?.metadata?.status).not.toBe("success");
    expect(snap.store["canvas-b"]?.some((node) => node.id === "node-slow")).toBe(false);
}, 20_000);

test("unmounting during a late recovery aborts it without writing the result", async () => {
    await page.evaluate((nodes) => window.lateHarness!.remoteLoad(nodes as never), [lateVideoNode("node-slow", "slow-task")]);
    await waitUntil("late task subscribed", () => (taskReads.get("slow-task") ?? 0) > 0);
    await page.evaluate(() => window.lateHarness!.unmount());
    slowDone = true;
    await Bun.sleep(4_500);
    expect(requests.filter((request) => request.startsWith("POST /api/ops/"))).toEqual([]);
    expect((await snapshot()).store["canvas-a"]?.find((node) => node.id === "node-slow")?.metadata?.status).not.toBe("success");
}, 20_000);
