import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { BunPlugin } from "bun";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;
let switched = false;
let failEnsure = false;
let unconfirmed = false;
let personalOnly = false;
let gateEnsure = false;
let ensureHits = 0;
let writesAfterSwitch = 0;
let ensureGate: { promise: Promise<void>; resolve: () => void } | undefined;

function resetGate() {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
        resolve = res;
    });
    ensureGate = { promise, resolve };
}

function json(data: unknown) {
    return Response.json({ code: 0, data, msg: "ok" });
}

beforeAll(async () => {
    const plugins: BunPlugin[] = [
        {
            name: "test-source-alias",
            setup(builder) {
                builder.onResolve({ filter: /^@\// }, (args) => ({
                    path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir),
                }));
                builder.onLoad({ filter: /src\/services\/project-asset-sync\.ts$/ }, () => ({
                    contents: `
                        export async function ensureCanvasNodeAsset(options) {
                            const harness = window.__editorHarness;
                            harness && harness.ensureCalls.push({
                                source: options.source,
                                category: options.category,
                                canvasId: options.canvasId,
                                nodeId: options.node && options.node.id,
                                hasExpectedScope: Boolean(options.expectedScope),
                                hasSignal: Boolean(options.signal),
                            });
                            const response = await fetch("/api/harness/ensure", { method: "POST" });
                            const body = await response.json();
                            if (body.error) throw new Error(body.error);
                            return {
                                assetId: body.assetId || "asset-1",
                                created: true,
                                linkedToProject: Boolean(body.linkedToProject),
                                confirmed: Boolean(body.confirmed),
                            };
                        }
                    `,
                    loader: "js",
                }));
                builder.onLoad({ filter: /\.(css|svg|png|jpe?g|gif|webp|woff2?)$/ }, () => ({
                    contents: "export default ''",
                    loader: "js",
                }));
            },
        },
    ];
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/canvas-node-editor-scope-harness.tsx"],
        plugins,
        target: "browser",
        define: {
            "import.meta.env.DEV": "false",
            "import.meta.env.PROD": "true",
            "import.meta.env.MODE": '"production"',
            "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"false"',
            "import.meta.env.VITE_CANVAS_BACKEND_URL": '""',
            "process.env.NODE_ENV": '"production"',
        },
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    server = Bun.serve({
        port: 0,
        async fetch(request) {
            const url = new URL(request.url);
            const path = url.pathname;
            if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
            if (path === "/harness/switch" && request.method === "POST") {
                switched = true;
                return Response.json({ ok: true });
            }
            if (path === "/harness/release-ensure" && request.method === "POST") {
                ensureGate?.resolve();
                return Response.json({ ok: true });
            }
            if (path === "/api/harness/ensure" && request.method === "POST") {
                ensureHits += 1;
                if (switched) writesAfterSwitch += 1;
                if (gateEnsure && ensureGate) await ensureGate.promise;
                if (failEnsure) return Response.json({ error: "网络中断" });
                return Response.json({
                    assetId: "asset-1",
                    confirmed: !unconfirmed,
                    linkedToProject: !unconfirmed && !personalOnly,
                });
            }
            if (path.startsWith("/api/")) return json([]);
            return new Response('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } });
        },
    });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);

beforeEach(async () => {
    await page?.close();
    switched = false;
    failEnsure = false;
    unconfirmed = false;
    personalOnly = false;
    gateEnsure = false;
    ensureHits = 0;
    writesAfterSwitch = 0;
    resetGate();
    page = await browser.newPage();
    await page.goto(server.url.toString());
    await page.getByTestId("canvas-id").waitFor({ timeout: 8_000 });
}, 15_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

type HarnessState = {
    writes: string[];
    toasts: string[];
    ensureCalls: Array<{ source?: string; category?: string; hasExpectedScope: boolean; hasSignal: boolean }>;
    switchABA: () => Promise<void>;
    switchCanvas: () => void;
};

async function switchABA() {
    await page.evaluate(async () => {
        const harness = (window as Window & { __editorHarness?: HarnessState }).__editorHarness;
        if (!harness) throw new Error("harness missing");
        await harness.switchABA();
    });
}

async function harnessState() {
    return page.evaluate(() => (window as Window & { __editorHarness?: HarnessState }).__editorHarness);
}

async function waitForEnsureHit() {
    const deadline = Date.now() + 4_000;
    while (ensureHits < 1 && Date.now() < deadline) await Bun.sleep(20);
    expect(ensureHits).toBeGreaterThanOrEqual(1);
}

test("delayed category success after A→B→A does not write assetId or toast the replacement generation", async () => {
    gateEnsure = true;
    await page.getByRole("button", { name: "set-category" }).click();
    await waitForEnsureHit();
    await switchABA();
    await fetch(new URL("/harness/release-ensure", server.url), { method: "POST" });
    await page.waitForTimeout(800);
    const harness = await harnessState();
    expect(await page.getByTestId("node-category").textContent()).toBe("character");
    expect(await page.getByTestId("node-asset").textContent()).toBe("none");
    expect((harness?.writes ?? []).filter((item) => item === "invalidate")).toEqual([]);
    expect((harness?.toasts ?? []).join("\n")).not.toContain("资产分类已更新");
    expect((harness?.toasts ?? []).join("\n")).not.toContain("文件目前只在这台设备上");
    expect(writesAfterSwitch).toBe(0);
}, 15_000);

test("delayed ordinary category error after A→B→A does not toast the replacement generation", async () => {
    failEnsure = true;
    gateEnsure = true;
    await page.getByRole("button", { name: "set-category" }).click();
    await waitForEnsureHit();
    await switchABA();
    await fetch(new URL("/harness/release-ensure", server.url), { method: "POST" });
    await page.waitForTimeout(800);
    const harness = await harnessState();
    expect(await page.getByTestId("node-asset").textContent()).toBe("none");
    expect((harness?.toasts ?? []).join("\n")).not.toContain("网络中断");
    expect((harness?.toasts ?? []).join("\n")).not.toContain("资产分类更新失败");
    expect(writesAfterSwitch).toBe(0);
}, 15_000);

test("delayed save success after A→B→A does not overlay live nodes or claim saved", async () => {
    gateEnsure = true;
    await page.getByRole("button", { name: "save-asset" }).click();
    await waitForEnsureHit();
    await switchABA();
    await fetch(new URL("/harness/release-ensure", server.url), { method: "POST" });
    await page.waitForTimeout(800);
    const harness = await harnessState();
    expect(await page.getByTestId("node-asset").textContent()).toBe("none");
    expect((harness?.writes ?? []).filter((item) => item === "invalidate")).toEqual([]);
    expect((harness?.toasts ?? []).join("\n")).not.toContain("已加入项目资产");
    expect((harness?.toasts ?? []).join("\n")).not.toContain("已加入我的素材");
    expect(writesAfterSwitch).toBe(0);
}, 15_000);

test("delayed ordinary save error after A→B→A does not toast the replacement generation", async () => {
    failEnsure = true;
    gateEnsure = true;
    await page.getByRole("button", { name: "save-asset" }).click();
    await waitForEnsureHit();
    await switchABA();
    await fetch(new URL("/harness/release-ensure", server.url), { method: "POST" });
    await page.waitForTimeout(800);
    const harness = await harnessState();
    expect(await page.getByTestId("node-asset").textContent()).toBe("none");
    expect((harness?.toasts ?? []).join("\n")).not.toContain("网络中断");
    expect((harness?.toasts ?? []).join("\n")).not.toContain("素材保存失败");
    expect(writesAfterSwitch).toBe(0);
}, 15_000);

test("unconfirmed save keeps a recoverable draft and does not claim saved", async () => {
    unconfirmed = true;
    await page.getByRole("button", { name: "save-asset" }).click();
    await page.getByTestId("node-asset").filter({ hasText: "asset-1" }).waitFor({ timeout: 8_000 });
    const harness = await harnessState();
    expect((harness?.writes ?? []).filter((item) => item === "invalidate")).toEqual([]);
    expect((harness?.toasts ?? []).join("\n")).toContain("文件目前只在这台设备上");
    expect((harness?.toasts ?? []).join("\n")).not.toContain("已加入项目资产");
    expect((harness?.toasts ?? []).join("\n")).not.toContain("已加入我的素材");
}, 15_000);

test("owned category update writes assetId and keeps current valid copy", async () => {
    await page.getByRole("button", { name: "set-category" }).click();
    await page.getByTestId("node-asset").filter({ hasText: "asset-1" }).waitFor({ timeout: 8_000 });
    const harness = await harnessState();
    expect(await page.getByTestId("node-category").textContent()).toBe("character");
    expect((harness?.toasts ?? []).join("\n")).toContain("资产分类已更新");
    expect(harness?.ensureCalls[0]).toMatchObject({
        source: "canvas-manual",
        category: "character",
        hasExpectedScope: true,
        hasSignal: true,
    });
    expect((harness?.writes ?? []).filter((item) => item === "invalidate")).toEqual(["invalidate"]);
}, 15_000);

test("owned save success toasts 已加入项目资产", async () => {
    await page.getByRole("button", { name: "save-asset" }).click();
    await page.getByTestId("node-asset").filter({ hasText: "asset-1" }).waitFor({ timeout: 8_000 });
    expect((await harnessState())?.toasts.join("\n") ?? "").toContain("已加入项目资产");
}, 15_000);

test("owned personal save success toasts 已加入我的素材", async () => {
    personalOnly = true;
    await page.getByRole("button", { name: "save-asset" }).click();
    await page.getByTestId("node-asset").filter({ hasText: "asset-1" }).waitFor({ timeout: 8_000 });
    expect((await harnessState())?.toasts.join("\n") ?? "").toContain("已加入我的素材");
}, 15_000);

test("owned ordinary save error still toasts the current canvas", async () => {
    failEnsure = true;
    await page.getByRole("button", { name: "save-asset" }).click();
    await page.waitForTimeout(800);
    const harness = await harnessState();
    expect(await page.getByTestId("node-asset").textContent()).toBe("none");
    expect((harness?.toasts ?? []).join("\n")).toContain("网络中断");
}, 15_000);

test("delayed save success after canvas switch does not overlay the live canvas", async () => {
    gateEnsure = true;
    await page.getByRole("button", { name: "save-asset" }).click();
    await waitForEnsureHit();
    await page.getByRole("button", { name: "switch-canvas" }).click();
    await page.getByTestId("canvas-id").filter({ hasText: "canvas-b" }).waitFor({ timeout: 4_000 });
    await fetch(new URL("/harness/release-ensure", server.url), { method: "POST" });
    await page.waitForTimeout(800);
    const harness = await harnessState();
    expect(await page.getByTestId("node-asset").textContent()).toBe("none");
    expect((harness?.toasts ?? []).join("\n")).not.toContain("已加入项目资产");
    expect((harness?.writes ?? []).filter((item) => item === "invalidate")).toEqual([]);
}, 15_000);
