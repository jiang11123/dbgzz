import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { BunPlugin } from "bun";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

// A storyboard request that is still waiting for confirmation or submission is a
// live request on the canvas. A later remote copy must not mark it interrupted,
// and a newer request on the same node must stop it without being overwritten.

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;
let requests: string[] = [];

const INTERRUPTED = "页面刷新后本地生成已中断，请重新生成。";
const orphan = (id: string) => ({ id, type: "image", title: id, position: { x: 0, y: 600 }, width: 320, height: 180, metadata: { status: "loading", prompt: "orphan" } });

type Snapshot = { nodes: Array<{ id: string; metadata?: Record<string, any> }>; settled: boolean | undefined | "pending" };
const snapshot = () => page.evaluate(() => window.storyboardHarness!.snapshot()) as Promise<Snapshot>;
const nodeIn = (snap: Snapshot, id: string) => snap.nodes.find((node) => node.id === id);
async function waitUntil(label: string, check: () => boolean | Promise<boolean>, timeoutMs = 8_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check()) return;
        await Bun.sleep(50);
    }
    throw new Error(`timed out waiting for: ${label}`);
}

beforeAll(async () => {
    const plugins: BunPlugin[] = [{ name: "test-source-alias", setup(builder) {
        builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
        builder.onLoad({ filter: /\.(css|svg|png|jpe?g|gif|webp|woff2?)$/ }, () => ({ contents: "export default ''", loader: "js" }));
    } }];
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/canvas-storyboard-live-request-harness.tsx"], plugins, target: "browser", define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' } });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    server = Bun.serve({ port: 0, async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
        if (!path.startsWith("/api/")) return new Response('<div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } });
        requests.push(`${request.method} ${path}`);
        if (request.method === "POST" && (path === "/api/tasks" || path.startsWith("/api/creation-runs"))) return Response.json({ code: 500, msg: "测试服务不接受提交" }, { status: 500 });
        return Response.json({ code: 0, data: [] });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 30_000);

beforeEach(async () => {
    await page?.close();
    requests = [];
    page = await browser.newPage();
    page.on("pageerror", (error) => console.error("pageerror:", error.message));
    await page.goto(server.url.toString());
    await page.waitForFunction(() => Boolean(window.storyboardHarness));
    await page.evaluate(() => window.storyboardHarness!.generate());
    // The storyboard request is in flight: the node shows progress and waits for confirmation.
    await waitUntil("storyboard in flight", async () => nodeIn(await snapshot(), "script")?.metadata?.taskStage === "正在创建任务");
    await page.getByRole("dialog").waitFor();
});
afterAll(async () => { await browser?.close(); server?.stop(true); });

test("an in-flight storyboard is not marked interrupted by a later remote copy", async () => {
    await page.evaluate((nodes) => window.storyboardHarness!.remoteLoad(nodes as never), [orphan("node-orphan")]);
    await waitUntil("late orphan marked", async () => nodeIn(await snapshot(), "node-orphan")?.metadata?.status === "error");
    const snap = await snapshot();
    expect(nodeIn(snap, "node-orphan")?.metadata?.errorDetails).toBe(INTERRUPTED);
    expect(nodeIn(snap, "script")?.metadata?.status).toBe("loading");
    expect(nodeIn(snap, "script")?.metadata?.errorDetails).not.toBe(INTERRUPTED);
    expect(snap.settled).toBe("pending");
}, 15_000);

test("a newer request on the storyboard node stops it and keeps the node", async () => {
    await page.evaluate(() => window.storyboardHarness!.takeOver());
    // Confirming the superseded dialog must not submit and must not touch the node.
    await page.getByRole("dialog").getByRole("button", { name: "确认生成", exact: true }).click();
    await waitUntil("storyboard settled", async () => (await snapshot()).settled !== "pending");
    expect(requests.filter((request) => request.startsWith("POST "))).toEqual([]);
    let script = nodeIn(await snapshot(), "script")!;
    expect(script.metadata?.status).toBe("loading");
    expect(script.metadata?.taskStage).toBe("接管");
    // The newer request is still registered after the storyboard released its own.
    await page.evaluate((nodes) => window.storyboardHarness!.remoteLoad(nodes as never), [orphan("node-orphan-2")]);
    await waitUntil("second orphan marked", async () => nodeIn(await snapshot(), "node-orphan-2")?.metadata?.status === "error");
    script = nodeIn(await snapshot(), "script")!;
    expect(script.metadata?.status).toBe("loading");
    expect(script.metadata?.taskStage).toBe("接管");
    expect(script.metadata?.errorDetails).not.toBe(INTERRUPTED);
}, 15_000);
