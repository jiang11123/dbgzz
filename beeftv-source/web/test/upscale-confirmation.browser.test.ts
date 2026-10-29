import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;
let creates: Record<string, unknown>[] = [];

beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/upscale-confirmation-harness.tsx"], target: "browser", define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "source-alias", setup(builder) {
        // Bun 1.3.9 needs one explicit file identity when the fixture and the
        // component reach these shared contexts through different import forms.
        builder.onResolve({ filter: /^\.\.?\/.*(?:canvas-node-(?:graph|action)-context|canvas-theme|user-scope)$/ }, args => ({ path: Bun.resolveSync(args.path, args.resolveDir) }));
        builder.onResolve({ filter: /^@\// }, args => {
            // This suite owns the actual component, hook, quote client and AntD
            // dialog. Canvas persistence is covered by repository tests; isolate
            // it here so confirmation cannot depend on a running desktop backend.
            if (args.path === "@/services/local-workspace-sync" || args.path === "@/stores/canvas/use-canvas-store") return { path: args.path, namespace: "upscale-persistence" };
            return { path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) };
        });
        builder.onLoad({ filter: /.*/, namespace: "upscale-persistence" }, () => ({ contents: "export const syncLocalCanvasSnapshot = async () => {}; export const flushCanvasStorePersistence = async () => {}; export const useCanvasStore = { getState: () => ({updateProject: () => {}}) };", loader: "js" }));
    } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    server = Bun.serve({ port: 0, async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
        if (path === "/api/media-upscale/capabilities") return Response.json({ code: 0, data: { cloudProcessing: true, maxVideoDurationMs: 300000, modes: [{ mediaType: "image", mode: "precision", models: ["Standard V2"], scales: [1, 2, 3, 4], outputFormats: ["png", "jpeg"] }] } });
        if (path === "/api/media-upscale/estimate") return Response.json({ code: 0, data: { mediaType: "image", source: { width: 100, height: 100 }, output: { width: 200, height: 200 }, currency: "CNY", reservation: 1.25, generationSubmitted: false, cloudProcessing: true } });
        if (path.startsWith("/api/tasks/by-operation/")) return Response.json({ code: 404, msg: "not found" }, { status: 404 });
        if (path === "/api/media-upscale/tasks") {
            creates.push(await request.json() as Record<string, unknown>);
            return Response.json({ code: 0, data: { id: "original-task", type: "canvas_image", model: "topaz-standard-v2", status: "queued", prompt: "AI 超分", attempts: 1, createdAt: "", updatedAt: "" } });
        }
        if (path.startsWith("/api/")) return Response.json({ code: 0, data: [] });
        return new Response('<div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } });
    } });
    browser = await chromium.launch({ headless: true });
}, 30_000);
beforeEach(async () => { await page?.close(); creates = []; page = await browser.newPage({ viewport: { width: 390, height: 844 } }); });
afterAll(async () => { await browser?.close(); server?.stop(true); });

test("official-only account can cancel CNY confirmation without creating a task", async () => {
    await page.goto(server.url.toString());
    const start = page.getByRole("button", { name: "开始批量超分", exact: true });
    await start.click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("共 1 个素材，预计预留 ¥1.25。完成后按实际费用结算。", { exact: true }).waitFor();
    expect(creates).toHaveLength(0);
    await dialog.getByRole("button", { name: /取\s*消/ }).click();
    await dialog.waitFor({ state: "hidden" });
    expect(creates).toHaveLength(0);
    expect(JSON.parse(await page.locator("#snapshot").innerText()).nodes).toHaveLength(2);
}, 15_000);

test("confirmation submits one official task and repeats only query the original", async () => {
    await page.goto(server.url.toString());
    await page.getByRole("button", { name: "开始批量超分", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "确认超分", exact: true }).click();
    await page.waitForFunction(() => JSON.parse(document.getElementById("snapshot")!.textContent!).observed === "original-task");
    expect(creates).toHaveLength(1);
    expect(creates[0].channelId).toBe("beefapi");
    expect(creates[0].clientOperationId).toBeTruthy();
    await page.getByRole("button", { name: "继续 / 查询批次", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".ant-btn-loading"));
    expect(creates).toHaveLength(1);
    expect(JSON.parse(await page.locator("#snapshot").innerText()).error).toBe("");
}, 15_000);
