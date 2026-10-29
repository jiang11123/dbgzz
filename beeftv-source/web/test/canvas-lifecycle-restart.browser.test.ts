import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import { canvasAppearanceForTheme } from "../src/lib/canvas/canvas-appearance";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let release: () => void;
let gate: Promise<void>;
let commits: any[] = [];
let taskReads = 0;
let taskPosts: any[] = [];
let manifests: any[] = [];
const remote = { id: "c1", revision: 111, title: "Restart", createdAt: "2026-10-02", updatedAt: "2026-10-02", nodes: Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, type: "image", title: `Node ${i}`, width: 320, height: 200, position: { x: i * 400, y: 0 }, metadata: {} })), connections: Array.from({ length: 6 }, (_, i) => ({ id: `e${i}`, fromNodeId: `n${i}`, toNodeId: `n${i + 1}` })), chatSessions: [], activeChatId: null, appearance: canvasAppearanceForTheme("dark"), backgroundMode: "grid", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 }, directorScenes: [] };
let backend = structuredClone(remote);

beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/canvas-lifecycle-restart-harness.tsx"], target: "browser", define: { "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"', "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"', "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"', "process.env.NODE_ENV": JSON.stringify(process.env.CANVAS_TEST_REACT_MODE || "production") }, plugins: [{ name: "source", setup(builder) {
        builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
        builder.onLoad({ filter: /\.(css|svg|png|jpe?g|gif|webp|woff2?)$/ }, () => ({ contents: "export default ''", loader: "js" }));
    } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0]!.text();
    const json = (data: unknown) => Response.json({ code: 0, data, msg: "ok" });
    server = Bun.serve({ port: 0, async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "application/javascript" } });
        if (path === "/_manifest") {
            manifests.push(await request.json());
            await new Promise(resolve => setTimeout(resolve, 40));
            return json({});
        }
        if (path === "/api/tasks" && request.method === "POST") {
            const body = await request.json();
            taskPosts.push({ body, saved: structuredClone(backend) });
            return json({ id: "synthetic-image-task", type: "canvas_image", status: "failed", error: "Synthetic terminal task; no model called", attempts: 1, createdAt: "2026-10-18", updatedAt: "2026-10-18" });
        }
        if (path === "/api/tasks/synthetic-image-task") return json({ id: "synthetic-image-task", type: "canvas_image", status: "failed", error: "Synthetic terminal task; no model called", attempts: 1, createdAt: "2026-10-18", updatedAt: "2026-10-18" });
        if (path === "/api/canvas-projects/c1") { await gate; return json({ project: backend }); }
        if (path === "/api/ops/canvas.document.commit") {
            const body = await request.json();
            if (body.params.expectedRevision !== backend.revision) return Response.json({ code: 409, data: null, msg: "Revision conflict", reason: "canvas_revision_conflict" }, { status: 409 });
            commits.push(body);
            backend = { ...body.params.document, revision: backend.revision + 1 };
            return json({ revision: backend.revision, result: { canvasId: "c1", revision: backend.revision, title: backend.title, updatedAt: backend.updatedAt } });
        }
        if (path === "/api/tasks/late-failed") {
            taskReads++;
            return json({ id: "late-failed", type: "canvas_video", status: "failed", error: "测试任务失败", attempts: 1, createdAt: "2026-10-15", updatedAt: "2026-10-15" });
        }
        if (path.startsWith("/api/")) return json([]);
        return new Response('<div id="root"></div>' + (['reopen-stamp', 'startup-stamp', 'missing-chat-sessions'].includes(new URL(request.url).searchParams.get('scenario') || '') ? '<script>window.__reopenProject=' + JSON.stringify(backend).replaceAll('<', '\\u003c') + '</script>' : '') + '<script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); server?.stop(true); });
beforeEach(() => {
    gate = new Promise<void>(resolve => { release = resolve; });
    backend = structuredClone(remote);
    commits = [];
    taskReads = 0;
    taskPosts = [];
    manifests = [];
});

test("first image submission flushes an unobserved preparation state without a false conflict", async () => {
    const page = await browser.newPage();
    const warnings: string[] = [];
    page.on("console", message => { if (message.type() === "warning") warnings.push(message.text()); });
    backend.nodes[0]!.metadata = { model: "synthetic::gpt-image-2.5", size: "9:16", count: "1", quality: "high", prompt: "Short storyboard description", composerContent: "A detailed synthetic image prompt", content: "", status: "idle" };
    release();
    await page.goto(`${server.url}?scenario=image-save`);
    await page.waitForFunction(() => document.querySelector('[data-testid="graph"]')?.textContent === "true:10:6");
    await page.evaluate(() => { void (window as any).__lifecycle.generateImage(); });
    await page.waitForFunction(() => (window as any).__lifecycle.generationSettled, undefined, { timeout: 8_000 });
    expect(manifests).toHaveLength(1);
    expect(warnings.filter(message => message.includes("冲突"))).toEqual([]);
    expect(await page.evaluate(() => (window as any).__lifecycle.held())).toEqual({ paused: false, candidateTitle: null });
    expect(taskPosts).toHaveLength(1);
    expect(taskPosts[0].saved.nodes[0].metadata).toMatchObject({ taskClientOperationId: "proposal:synthetic:n0", generationSubmissionState: "submitting" });
    await page.close();
}, 30_000);

for (const restartLoad of [false, true]) test(`confirmed edges survive cached load and media update (hydration restarts load: ${restartLoad})`, async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(server.url.toString());
    await page.waitForFunction(() => document.querySelector('[data-testid="graph"]')?.textContent === "true:10:0");
    if (restartLoad) {
        // The server projection reaches the store while a render still owns the stale cached graph.
        // Changing hydration and node metadata schedules load and autosave in one passive-effect batch.
        await page.evaluate((graph) => (window as any).__lifecycle.restartLoad(graph), remote);
        await page.waitForTimeout(100);
    }
    release();
    await page.waitForFunction(() => document.querySelector('[data-testid="graph"]')?.textContent === "true:10:6");
    await page.evaluate(() => (window as any).__lifecycle.media());
    await page.waitForTimeout(100);
    const details = await page.evaluate(() => ({ renders: (window as any).__lifecycle.renders, updates: (window as any).__lifecycle.updates }));
    expect(details.updates.filter((u: any) => u.revision === 111).every((u: any) => u.edges === 6)).toBe(true);
    expect(errors).toEqual([]);
    await page.evaluate(() => (window as any).__lifecycle.save());
    expect(backend.connections).toHaveLength(6);
    expect(commits.every(c => c.params.document.connections.length === 6)).toBe(true);
    await page.close();
}, 30000);

test("manual deletion after a completed projection is still saved and survives reopening", async () => {
    const page = await browser.newPage();
    release();
    await page.goto(server.url.toString());
    await page.waitForFunction(() => document.querySelector('[data-testid="graph"]')?.textContent === "true:10:6");
    await page.evaluate(() => (window as any).__lifecycle.deleteEdges());
    await page.waitForFunction(() => (window as any).__lifecycle.updates.at(-1)?.edges === 0);
    await page.evaluate(() => (window as any).__lifecycle.save());
    expect(backend.connections).toEqual([]);
    expect(commits.at(-1).params.document.connections).toEqual([]);
    await page.goto(`${server.url}?scenario=reopen-stamp`);
    await page.waitForFunction(() => document.querySelector('[data-testid="graph"]')?.textContent === "true:10:0");
    expect(backend.connections).toEqual([]);
    await page.close();
}, 30000);

for (const scenario of ["missing-cache", "missing-cache-and-journal"]) test(`${scenario} restores the full backend graph without manufacturing deletions`, async () => {
    const page = await browser.newPage();
    release();
    await page.goto(`${server.url}?scenario=${scenario}`);
    await page.waitForFunction(() => document.querySelector('[data-testid="graph"]')?.textContent === "true:10:6");
    await page.evaluate(() => (window as any).__lifecycle.media());
    await page.waitForTimeout(50);
    await page.evaluate(() => (window as any).__lifecycle.save());
    expect(backend.connections).toHaveLength(6);
    expect(commits.every(c => c.params.document.connections.length === 6)).toBe(true);
    await page.close();
}, 30000);

test("dirty cached graph with a stale journal merges into a newer backend graph without overwriting it", async () => {
    const page = await browser.newPage();
    release();
    await page.goto(`${server.url}?scenario=dirty-cache`);
    // The cached draft renders first; opening then rebases the local title edit onto the backend's new edges.
    await page.waitForFunction(() => document.querySelector('[data-testid="graph"]')?.textContent === "true:10:6");
    await page.evaluate(() => (window as any).__lifecycle.save());
    expect(backend.connections).toHaveLength(6);
    expect(backend.nodes[0].title).toBe("Unsaved manual title");
    expect(commits.length).toBeGreaterThan(0);
    expect(commits[0].params.expectedRevision).toBe(111);
    expect(commits.every(c => c.params.document.connections.length === 6)).toBe(true);
    await page.close();
}, 30000);

test("an edit made while the opened backend graph is landing is merged, not replaced by the cached graph", async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(server.url.toString());
    await page.waitForFunction(() => document.querySelector('[data-testid="graph"]')?.textContent === "true:10:0");
    await page.evaluate(() => (window as any).__lifecycle.editWhenBackendProjects());
    release();
    await page.waitForFunction(() => document.querySelector('[data-testid="graph"]')?.textContent === "true:10:6");
    await page.evaluate(() => (window as any).__lifecycle.pulse());
    expect(await page.evaluate(() => (window as any).__lifecycle.title())).toBe("Local unsaved text");
    await page.evaluate(() => (window as any).__lifecycle.save());
    expect(backend.connections).toHaveLength(6);
    expect(backend.nodes[0].title).toBe("Local unsaved text");
    expect(commits.every(c => c.params.document.connections.length === 6)).toBe(true);
    expect(errors).toEqual([]);
    await page.close();
}, 30000);

test("the same node edited locally while the opened backend graph lands is kept, held and never written over the server", async () => {
    backend = { ...backend, nodes: backend.nodes.map((node, i) => i === 0 ? { ...node, title: "Remote title" } : node) };
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(server.url.toString());
    await page.waitForFunction(() => document.querySelector('[data-testid="graph"]')?.textContent === "true:10:0");
    await page.evaluate(() => (window as any).__lifecycle.editWhenBackendProjects());
    release();
    await page.waitForFunction(() => (window as any).__lifecycle.held().paused === true);
    await page.evaluate(() => (window as any).__lifecycle.pulse());
    expect(await page.evaluate(() => (window as any).__lifecycle.title())).toBe("Local unsaved text");
    expect(await page.evaluate(() => (window as any).__lifecycle.held())).toEqual({ paused: true, candidateTitle: "Remote title" });
    const saved = await page.evaluate(() => (window as any).__lifecycle.save().then(() => "saved", (error: Error) => error.name));
    expect(saved).not.toBe("saved");
    expect(commits).toEqual([]);
    expect(backend.revision).toBe(111);
    expect(backend.nodes[0].title).toBe("Remote title");
    expect(errors).toEqual([]);
    await page.close();
}, 30000);

// The backend as it was when the canvas was closed mid-work (scenario "interrupted":
// n2 generating, n3 and n4 uploading), with the six edges.
const closedMidWork = () => ({ ...structuredClone(remote), nodes: remote.nodes.map((node, i) => i === 2 ? { ...node, metadata: { status: "loading", taskId: "task-done" } }
    : i === 3 || i === 4 ? { ...node, metadata: { fileUpload: "uploading", fileUploadProgress: 40 } } : node) });

// Since then the generation finished, the n3 upload finished elsewhere, and three new
// nodes arrived with interrupted work: an upload, a generation with no task, and a live task.
const interruptedBackend = () => ({ ...structuredClone(remote), nodes: [
    ...closedMidWork().nodes.map((node, i) => i === 2 ? { ...node, metadata: { status: "success", taskId: "task-done", content: "https://example.test/n2.png" } }
        : i === 3 ? { ...node, metadata: { content: "https://example.test/n3.png" } } : node),
    { id: "n-upload", type: "image", title: "Uploading photo", width: 320, height: 200, position: { x: 0, y: 400 }, metadata: { fileUpload: "uploading", fileUploadProgress: 60 } },
    { id: "n-orphan", type: "image", title: "New Generation", width: 320, height: 200, position: { x: 400, y: 400 }, metadata: { status: "loading" } },
    { id: "n-active", type: "image", title: "Active generation", width: 320, height: 200, position: { x: 800, y: 400 }, metadata: { status: "loading", taskId: "task-active" } },
] });

for (const dragging of [false, true]) test(`an edit made while an opened graph with interrupted work lands is kept, and that work is restored as on a normal open (dragging: ${dragging})`, async () => {
    backend = interruptedBackend();
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(`${server.url}?scenario=interrupted`);
    await page.waitForFunction(() => document.querySelector('[data-testid="graph"]')?.textContent === "true:10:0");
    // A drag in progress holds autosave, so the read reaches the editor before the edit is written.
    if (dragging) await page.evaluate(() => (window as any).__lifecycle.pauseHistory(true));
    await page.evaluate(() => (window as any).__lifecycle.editWhenBackendProjects());
    release();
    await page.waitForFunction(() => document.querySelector('[data-testid="graph"]')?.textContent === "true:13:6" || (window as any).__lifecycle.held().paused);
    // The cache is normalized for display and the read is not: that alone must not look like a conflict.
    expect(await page.evaluate(() => (window as any).__lifecycle.held())).toEqual({ paused: false, candidateTitle: null });
    if (dragging) await page.evaluate(() => { (window as any).__lifecycle.pauseHistory(false); (window as any).__lifecycle.media(); });
    await page.evaluate(() => (window as any).__lifecycle.pulse());
    const node = (id: string) => page.evaluate((nodeId) => (window as any).__lifecycle.nodeState(nodeId), id);
    expect(await page.evaluate(() => (window as any).__lifecycle.title())).toBe("Local unsaved text");
    const done = await node("n2");
    expect([done.metadata.status, done.metadata.content, done.metadata.errorDetails]).toEqual(["success", "https://example.test/n2.png", undefined]);
    const uploaded = await node("n3");
    expect([uploaded.metadata.fileUpload, uploaded.metadata.content, uploaded.metadata.errorDetails]).toEqual([undefined, "https://example.test/n3.png", undefined]);
    const upload = await node("n-upload");
    expect([upload.metadata.fileUpload, upload.metadata.fileUploadProgress, upload.metadata.errorDetails]).toEqual(["error", undefined, "上传已中断，请重新选择文件上传"]);
    const orphan = await node("n-orphan");
    expect([orphan.title, orphan.metadata.status, orphan.metadata.taskId, orphan.metadata.errorDetails]).toEqual(["图片", "loading", undefined, "正在从任务中心恢复生成状态..."]);
    const active = await node("n-active");
    expect([active.metadata.status, active.metadata.taskId, active.metadata.errorDetails]).toEqual(["loading", "task-active", "正在从任务中心恢复生成状态..."]);
    await page.evaluate(() => (window as any).__lifecycle.save());
    expect(commits.length).toBeGreaterThan(0);
    expect(commits.every(c => c.params.document.connections.length === 6)).toBe(true);
    expect(backend.nodes).toHaveLength(13);
    expect(backend.nodes[0]!.title).toBe("Local unsaved text");
    const savedActive = backend.nodes.find(item => item.id === "n-active")!.metadata as any;
    expect([savedActive.status, savedActive.taskId]).toEqual(["loading", "task-active"]);
    expect(errors).toEqual([]);
    await page.close();
}, 30000);

test("late recovery runs through the real lifecycle merge while preserving an unsaved edit", async () => {
    backend = { ...structuredClone(remote), nodes: [
        ...remote.nodes,
        { id: "n-orphan", type: "image", title: "orphan", width: 320, height: 200, position: { x: 0, y: 400 }, metadata: { status: "loading" } },
        { id: "n-failed", type: "video", title: "pending", width: 320, height: 200, position: { x: 400, y: 400 }, metadata: { status: "loading", taskId: "late-failed", taskStatus: "running" } },
    ] };
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
        await page.goto(`${server.url}?scenario=late-recovery`);
        await page.waitForFunction(() => document.querySelector('[data-testid="graph"]')?.textContent === "true:10:0");
        await page.evaluate(() => { (window as any).__lifecycle.pauseHistory(true); (window as any).__lifecycle.editWhenBackendProjects(); });
        release();
        await page.waitForFunction(() => (window as any).__lifecycle.nodeState("n-orphan")?.metadata.status === "error"
            && (window as any).__lifecycle.nodeState("n-failed")?.metadata.taskStatus === "failed", { timeout: 8_000 });
        expect(await page.evaluate(() => (window as any).__lifecycle.title())).toBe("Local unsaved text");
        expect(await page.evaluate(() => (window as any).__lifecycle.nodeState("n-orphan").metadata.errorDetails)).toBe("页面刷新后本地生成已中断，请重新生成。");
        expect(await page.evaluate(() => (window as any).__lifecycle.held())).toEqual({ paused: false, candidateTitle: null });
        expect(errors).toEqual([]);
    } finally { await page.close(); }
}, 20_000);

test("late recovery reconciles a task on the same node whose prompt was edited while the backend graph lands", async () => {
    backend.nodes[0].metadata = { prompt: "Original prompt", status: "loading", taskId: "late-failed", taskStatus: "running" };
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
        await page.goto(`${server.url}?scenario=late-same-node-recovery`);
        await page.waitForFunction(() => document.querySelector('[data-testid="graph"]')?.textContent === "true:10:0");
        await page.evaluate(() => { (window as any).__lifecycle.pauseHistory(true); (window as any).__lifecycle.editPromptWhenBackendProjects(); });
        release();
        await page.waitForFunction(() => (window as any).__lifecycle.nodeState("n0")?.metadata.taskStatus === "failed", undefined, { timeout: 8_000 });
        const metadata = await page.evaluate(() => (window as any).__lifecycle.nodeState("n0").metadata);
        expect(metadata.prompt).toBe("Unsaved local prompt");
        expect(metadata.taskId).toBe("late-failed");
        expect(metadata.status).toBe("error");
        expect(metadata.errorDetails).toContain("测试任务失败");
        expect(taskReads).toBe(1);
        expect(await page.evaluate(() => (window as any).__lifecycle.held())).toEqual({ paused: false, candidateTitle: null });
        expect(errors).toEqual([]);
    } finally { await page.close(); }
}, 20_000);

// Open the closed-mid-work canvas (n3 and n4 show as interrupted uploads), then edit n0
// while a drag holds autosave, so the edit is not written back before the refresh.
async function openMidWorkAndEditUnsaved() {
    backend = closedMidWork();
    release();
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(`${server.url}?scenario=interrupted`);
    await page.waitForFunction(() => document.querySelector('[data-testid="graph"]')?.textContent === "true:10:6");
    const opened = await page.evaluate(() => (window as any).__lifecycle.nodeState("n3"));
    expect([opened.metadata.fileUpload, opened.metadata.errorDetails]).toEqual(["error", "上传已中断，请重新选择文件上传"]);
    await page.evaluate(() => { (window as any).__lifecycle.pauseHistory(true); (window as any).__lifecycle.editTitleNow(); });
    return { page, errors };
}

test("a refresh before the first write-back keeps the local edit and takes finished and still-running remote work as it is", async () => {
    const { page, errors } = await openMidWorkAndEditUnsaved();
    backend = { ...backend, revision: 112, nodes: [
        ...backend.nodes.map((node, i) => i === 2 ? { ...node, metadata: { status: "loading", taskId: "task-done", taskProgress: 50 } }
            : i === 3 ? { ...node, metadata: { content: "https://example.test/n3.png" } }
                : i === 4 ? { ...node, metadata: { fileUpload: "uploading", fileUploadProgress: 70 } } : node),
        { id: "n-new-upload", type: "image", title: "New upload", width: 320, height: 200, position: { x: 0, y: 400 }, metadata: { fileUpload: "uploading", fileUploadProgress: 10 } },
    ] };
    await page.evaluate(() => (window as any).__lifecycle.refresh());
    // Interrupted-upload marks made on open are not local edits, so nothing conflicts.
    expect(await page.evaluate(() => (window as any).__lifecycle.held())).toEqual({ paused: false, candidateTitle: null });
    const node = (id: string) => page.evaluate((nodeId) => (window as any).__lifecycle.nodeState(nodeId), id);
    expect(await page.evaluate(() => (window as any).__lifecycle.title())).toBe("Local unsaved text");
    const finished = await node("n3");
    expect([finished.metadata.fileUpload, finished.metadata.content, finished.metadata.errorDetails]).toEqual([undefined, "https://example.test/n3.png", undefined]);
    // Uploads and tasks still running elsewhere are shown running, not marked interrupted.
    const uploading = await node("n4");
    expect([uploading.metadata.fileUpload, uploading.metadata.fileUploadProgress, uploading.metadata.errorDetails]).toEqual(["uploading", 70, undefined]);
    const added = await node("n-new-upload");
    expect([added.metadata.fileUpload, added.metadata.fileUploadProgress, added.metadata.errorDetails]).toEqual(["uploading", 10, undefined]);
    const task = await node("n2");
    expect([task.metadata.status, task.metadata.taskId, task.metadata.taskProgress]).toEqual(["loading", "task-done", 50]);
    await page.evaluate(() => { (window as any).__lifecycle.pauseHistory(false); (window as any).__lifecycle.media(); });
    await page.evaluate(() => (window as any).__lifecycle.pulse());
    await page.evaluate(() => (window as any).__lifecycle.save());
    expect(commits.length).toBeGreaterThan(0);
    expect(commits[0].params.expectedRevision).toBe(112);
    expect(backend.nodes).toHaveLength(11);
    expect(backend.nodes[0]!.title).toBe("Local unsaved text");
    expect((backend.nodes[3]!.metadata as any).content).toBe("https://example.test/n3.png");
    expect((backend.nodes[4]!.metadata as any).fileUpload).toBe("uploading");
    expect(backend.connections).toHaveLength(6);
    expect(errors).toEqual([]);
    await page.close();
}, 30000);

test("a real same-field conflict in a refresh before the first write-back is still held", async () => {
    const { page, errors } = await openMidWorkAndEditUnsaved();
    backend = { ...backend, revision: 112, nodes: backend.nodes.map((node, i) => i === 0 ? { ...node, title: "Remote title" }
        : i === 3 ? { ...node, metadata: { content: "https://example.test/n3.png" } } : node) };
    await page.evaluate(() => (window as any).__lifecycle.refresh());
    expect(await page.evaluate(() => (window as any).__lifecycle.held())).toEqual({ paused: true, candidateTitle: "Remote title" });
    await page.evaluate(() => { (window as any).__lifecycle.pauseHistory(false); (window as any).__lifecycle.media(); });
    await page.evaluate(() => (window as any).__lifecycle.pulse());
    expect(await page.evaluate(() => (window as any).__lifecycle.title())).toBe("Local unsaved text");
    const saved = await page.evaluate(() => (window as any).__lifecycle.save().then(() => "saved", (error: Error) => error.name));
    expect(saved).not.toBe("saved");
    expect(commits).toEqual([]);
    expect(backend.revision).toBe(112);
    expect(backend.nodes[0]!.title).toBe("Remote title");
    expect(errors).toEqual([]);
    await page.close();
}, 30000);

test("an upload another writer puts in the store before the first write-back is saved as still uploading", async () => {
    backend = closedMidWork();
    release();
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(`${server.url}?scenario=interrupted`);
    await page.waitForFunction(() => document.querySelector('[data-testid="graph"]')?.textContent === "true:10:6");
    await page.evaluate(() => (window as any).__lifecycle.addStoredNode({ id: "n-store-upload", type: "image", title: "Stored upload", width: 320, height: 200, position: { x: 0, y: 400 }, metadata: { fileUpload: "uploading", fileUploadProgress: 30 } }));
    await page.evaluate(() => (window as any).__lifecycle.editTitleNow());
    await page.evaluate(() => (window as any).__lifecycle.pulse());
    expect(await page.evaluate(() => (window as any).__lifecycle.held())).toEqual({ paused: false, candidateTitle: null });
    const stored = await page.evaluate(() => (window as any).__lifecycle.nodeState("n-store-upload"));
    expect([stored.metadata.fileUpload, stored.metadata.fileUploadProgress, stored.metadata.errorDetails]).toEqual(["uploading", 30, undefined]);
    await page.evaluate(() => (window as any).__lifecycle.save());
    expect(backend.nodes[0]!.title).toBe("Local unsaved text");
    expect((backend.nodes.find(item => item.id === "n-store-upload")!.metadata as any).fileUpload).toBe("uploading");
    expect(errors).toEqual([]);
    await page.close();
}, 30000);

test("assistant sessions merged by a refresh are not overwritten by the next editor autosave", async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    release();
    await page.goto(server.url.toString());
    await page.waitForFunction(() => document.querySelector('[data-testid="graph"]')?.textContent === "true:10:6");
    const session = { id: "s-remote", title: "Remote chat", messages: [], createdAt: "2026-10-15", updatedAt: "2026-10-15" };
    backend = { ...backend, revision: 112, chatSessions: [session as never] };
    await page.evaluate(() => (window as any).__lifecycle.refresh());
    await page.evaluate(() => (window as any).__lifecycle.editTitleNow());
    await page.evaluate(() => (window as any).__lifecycle.pulse());
    await page.evaluate(() => (window as any).__lifecycle.save());
    expect(backend.nodes[0].title).toBe("Local unsaved text");
    expect(backend.chatSessions).toEqual([session as never]);
    expect(commits.length).toBeGreaterThan(0);
    expect(commits.every(c => c.params.document.chatSessions.length === 1)).toBe(true);
    // The assistant panel shows the merged sessions too, not only the saved document.
    expect(await page.evaluate(() => (window as any).__lifecycle.chatIds())).toEqual(["s-remote"]);
    expect(errors).toEqual([]);
    await page.close();
}, 30000);

test("completed task acknowledgement prepublished in store is autosaved through CAS and survives reopen", async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    release();
    await page.goto(server.url.toString());
    await page.waitForFunction(() => document.querySelector('[data-testid="graph"]')?.textContent === "true:10:6");
    expect(await page.evaluate(() => (window as any).__lifecycle.dirty())).toBe(false);
    const key = await page.evaluate(() => (window as any).__lifecycle.hydrateCompletedTaskStamp());
    // Do not invoke explicit Save: reproduce the actual consumer/store → editor path.
    await page.evaluate(() => (window as any).__lifecycle.pulse());
    expect(commits).toHaveLength(1);
    expect(commits[0].params.expectedRevision).toBe(111);
    expect(backend.revision).toBe(112);
    expect((backend.nodes[0].metadata as any).generationEffectKeys).toEqual([key]);
    expect(await page.evaluate(() => (window as any).__lifecycle.dirty())).toBe(false);
    await page.goto(`${server.url}?scenario=reopen-stamp`);
    await page.waitForFunction(() => document.querySelector('[data-testid="graph"]')?.textContent === "true:10:6");
    expect(await page.evaluate(() => (window as any).__lifecycle.dirty())).toBe(false);
    expect((backend.nodes[0].metadata as any).generationEffectKeys).toEqual([key]);
    expect(commits).toHaveLength(1);
    expect(errors).toEqual([]);
    await page.close();
}, 30000);


for (const scenario of ["startup-stamp", "missing-chat-sessions"]) test(`already observed task stamps schedule a CAS save on initial load (${scenario})`, async () => {
    const page = await browser.newPage();
    release();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${server.url}?scenario=${scenario}`);
    await page.waitForTimeout(100);
    expect(errors).toEqual([]);
    await page.waitForFunction(() => document.querySelector('[data-testid="graph"]')?.textContent === "true:10:6");
    await page.evaluate(() => (window as any).__lifecycle.pulse());
    expect(commits).toHaveLength(1);
    expect(commits[0].params.expectedRevision).toBe(111);
    expect(backend.revision).toBe(112);
    expect((backend.nodes[0].metadata as any).generationEffectKeys).toEqual(["attach-node:completed-task-receipt:n0:0"]);
    expect(await page.evaluate(() => (window as any).__lifecycle.dirty())).toBe(false);
    await page.evaluate(() => (window as any).__lifecycle.pulse());
    expect(commits).toHaveLength(1);
    if (scenario === "missing-chat-sessions") {
        await page.getByRole("button", { name: "Switch video model" }).click();
        await page.evaluate(() => (window as any).__lifecycle.pulse());
        expect((backend.nodes[0].metadata as any).model).toBe("beefapi::seedance-2.0-mini");
        expect((backend.nodes[0].metadata as any).generationEffectKeys).toEqual(["attach-node:completed-task-receipt:n0:0"]);
        await page.goto(`${server.url}?scenario=reopen-stamp`);
        await page.waitForFunction(() => document.querySelector('[data-testid="graph"]')?.textContent === "true:10:6");
        expect((backend.nodes[0].metadata as any).model).toBe("beefapi::seedance-2.0-mini");
    }
    expect(errors).toEqual([]);
    await page.close();
}, 30000);
