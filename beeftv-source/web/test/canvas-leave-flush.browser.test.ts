import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { chromium, type Browser } from "playwright";

// Renders the real useCanvasProjectLifecycle through the shared restart harness
// and proves a deletion reaches the backend right after the page is hidden,
// ahead of the 500 ms debounced backend sync.

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let commits: Array<{ at: number; canvasId: string; nodes: Array<{ id: string; title: string }>; connections: unknown[] }> = [];
const remote = { id: "c1", revision: 111, title: "Restart", createdAt: "2026-10-02", updatedAt: "2026-10-02", nodes: Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, type: "image", title: `Node ${i}`, width: 320, height: 200, position: { x: i * 400, y: 0 }, metadata: {} })), connections: Array.from({ length: 6 }, (_, i) => ({ id: `e${i}`, fromNodeId: `n${i}`, toNodeId: `n${i + 1}` })), chatSessions: [], activeChatId: null, backgroundMode: "grid", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 }, directorScenes: [] };
let backend = structuredClone(remote);
let secondBackend = { ...structuredClone(remote), id: "c2", title: "Second canvas", nodes: remote.nodes.slice(0, 2), connections: remote.connections.slice(0, 1) };

beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/canvas-lifecycle-restart-harness.tsx"], target: "browser", define: { "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"', "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"', "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"', "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "source", setup(builder) {
        builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
        // Delay only test persistence, keeping the actual store flush implementation.
        // This exposes the real hook's await boundary without replacing its save API.
        builder.onLoad({ filter: /stores\/canvas\/use-canvas-store\.ts$/ }, args => ({
            loader: "ts",
            contents: readFileSync(args.path, "utf8").replace("export async function flushCanvasStorePersistence()", "async function originalFlushCanvasStorePersistence()") + `
                export async function flushCanvasStorePersistence() {
                    const gate = (window as any).__leavePersistenceGate;
                    if (gate) { (window as any).__leavePersistenceEntered = true; await gate; }
                    return originalFlushCanvasStorePersistence();
                }
            `,
        }));
        builder.onLoad({ filter: /\.(css|svg|png|jpe?g|gif|webp|woff2?)$/ }, () => ({ contents: "export default ''", loader: "js" }));
    } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0]!.text();
    const json = (data: unknown) => Response.json({ code: 0, data, msg: "ok" });
    server = Bun.serve({ port: 0, async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "application/javascript" } });
        if (path === "/api/canvas-projects/c1") return json({ project: backend });
        if (path === "/api/canvas-projects/c2") return json({ project: secondBackend });
        if (path === "/api/ops/canvas.document.commit") {
            const body = await request.json();
            const current = body.params.canvasId === "c2" ? secondBackend : backend;
            if (body.params.expectedRevision !== current.revision) return Response.json({ code: 409, data: null, msg: "Revision conflict", reason: "canvas_revision_conflict" }, { status: 409 });
            commits.push({ at: Date.now(), canvasId: body.params.canvasId, nodes: body.params.document.nodes, connections: body.params.document.connections });
            const saved = { ...body.params.document, revision: current.revision + 1 };
            if (body.params.canvasId === "c2") secondBackend = saved; else backend = saved;
            return json({ revision: saved.revision, result: { canvasId: saved.id, revision: saved.revision, title: saved.title, updatedAt: saved.updatedAt } });
        }
        if (path.startsWith("/api/")) return json([]);
        return new Response('<div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); server?.stop(true); });
beforeEach(() => {
    backend = structuredClone(remote);
    secondBackend = { ...structuredClone(remote), id: "c2", title: "Second canvas", nodes: remote.nodes.slice(0, 2), connections: remote.connections.slice(0, 1) };
    commits = [];
});

for (const trigger of ["pagehide", "visibilitychange"] as const) test(`a deletion is committed right after ${trigger}, before the debounced sync`, async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(server.url.toString());
    await page.waitForFunction(() => document.querySelector('[data-testid="graph"]')?.textContent === "true:10:6");
    await page.evaluate(() => (window as any).__lifecycle.deleteEdges());
    await page.waitForFunction(() => document.querySelector('[data-testid="graph"]')?.textContent === "true:10:0");
    const hiddenAt = Date.now();
    await page.evaluate((kind) => {
        if (kind === "pagehide") {
            window.dispatchEvent(new Event("pagehide"));
            return;
        }
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
    }, trigger);
    const deadline = Date.now() + 2000;
    while (!commits.some(c => c.connections.length === 0) && Date.now() < deadline) await Bun.sleep(10);
    const commit = commits.find(c => c.connections.length === 0);
    expect(commit).toBeDefined();
    // The debounced backend sync waits 500 ms after the edit; the leave flush must not.
    expect(commit!.at - hiddenAt).toBeLessThan(400);
    expect(backend.connections).toEqual([]);
    expect(errors).toEqual([]);
    await page.close();
}, 30000);

test("leave flush awaiting persistence cannot submit after A→B→A", async () => {
    const page = await browser.newPage();
    try {
        await page.goto(server.url.toString());
        await page.waitForFunction(() => document.querySelector('[data-testid="graph"]')?.textContent === "true:10:6");
        const before = commits.length;
        await page.evaluate(() => {
            (window as any).__leavePersistenceGate = new Promise(resolve => { (window as any).__releaseLeavePersistence = resolve; });
            (window as any).__lifecycle.deleteEdges();
        });
        await page.waitForFunction(() => document.querySelector('[data-testid="graph"]')?.textContent === "true:10:0");
        await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
        await page.waitForFunction(() => (window as any).__leavePersistenceEntered === true);
        await page.evaluate(() => {
            (window as any).__lifecycle.scopeCycle();
            delete (window as any).__leavePersistenceGate;
            (window as any).__releaseLeavePersistence();
        });
        await page.waitForTimeout(1100);
        expect(commits.slice(before)).toEqual([]);
        expect(backend.connections).toHaveLength(6);
    } finally { await page.close(); }
}, 30000);

for (const leave of ["unmount", "switchCanvas"] as const) test(`${leave} flushes the old canvas deletion without adopting the next graph`, async () => {
    const page = await browser.newPage();
    try {
        await page.goto(server.url.toString());
        await page.waitForFunction(() => document.querySelector('[data-testid="graph"]')?.textContent === "true:10:6");
        await page.evaluate(() => (window as any).__lifecycle.deleteEdges());
        await page.waitForFunction(() => document.querySelector('[data-testid="graph"]')?.textContent === "true:10:0");
        await page.evaluate(kind => (window as any).__lifecycle[kind]("c2"), leave);
        const deadline = Date.now() + 2000;
        while (backend.connections.length && Date.now() < deadline) await Bun.sleep(10);
        expect(backend.connections).toHaveLength(0);
        expect(backend.nodes).toHaveLength(10);
        expect(secondBackend.nodes).toHaveLength(2);
        expect(secondBackend.connections).toHaveLength(1);
        expect(commits.filter(commit => commit.canvasId === "c1").every(commit => commit.nodes.length === 10)).toBe(true);
        if (leave === "switchCanvas") await page.waitForFunction(() => document.querySelector('[data-testid="graph"]')?.textContent === "true:2:1");
    } finally { await page.close(); }
}, 30000);

test("external deletion conflicting with genuine local text is retained and cannot autosave over remote", async () => {
    const page = await browser.newPage();
    try {
        await page.goto(server.url.toString());
        await page.waitForFunction(() => document.querySelector('[data-testid="graph"]')?.textContent === "true:10:6");
        await page.evaluate(() => (window as any).__lifecycle.editTitle());
        await page.waitForFunction(() => (window as any).__lifecycle.title() === "Local unsaved text");
        const before = commits.length;
        backend = { ...backend, revision: backend.revision + 1, nodes: backend.nodes.filter(node => node.id !== "n0"), connections: backend.connections.filter(edge => edge.fromNodeId !== "n0" && edge.toNodeId !== "n0") };
        await page.evaluate(() => (window as any).__lifecycle.refresh());
        await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
        await page.waitForTimeout(1100);
        expect(await page.evaluate(() => (window as any).__lifecycle.title())).toBe("Local unsaved text");
        expect(commits.slice(before)).toEqual([]);
        expect(backend.nodes.some(node => node.id === "n0")).toBe(false);
    } finally { await page.close(); }
}, 30000);
