import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { BunPlugin } from "bun";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;
let switched = false;
let failEnsure = false;
let failSave = false;
let unconfirmed = false;
let gateEnsure = false;
let gateSave = false;
let ensureHits = 0;
let saveHits = 0;
let writesAfterSwitch = 0;
let ensureGate: { promise: Promise<void>; resolve: () => void } | undefined;
let saveGate: { promise: Promise<void>; resolve: () => void } | undefined;

function resetGate(kind: "ensure" | "save") {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
        resolve = res;
    });
    if (kind === "ensure") ensureGate = { promise, resolve };
    else saveGate = { promise, resolve };
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
                builder.onLoad({ filter: /\.(css|svg|png|jpe?g|gif|webp|woff2?)$/ }, () => ({
                    contents: "export default ''",
                    loader: "js",
                }));
            },
        },
    ];
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/canvas-upload-settings-scope-harness.tsx"],
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
            if (path === "/harness/release-save" && request.method === "POST") {
                saveGate?.resolve();
                return Response.json({ ok: true });
            }
            if (path === "/api/harness/ensure" && request.method === "POST") {
                ensureHits += 1;
                if (switched) writesAfterSwitch += 1;
                if (gateEnsure && ensureGate) await ensureGate.promise;
                if (failEnsure) return Response.json({ error: "网络中断" });
                return Response.json({ confirmed: !unconfirmed });
            }
            if (path === "/api/harness/save" && request.method === "POST") {
                saveHits += 1;
                if (switched) writesAfterSwitch += 1;
                if (gateSave && saveGate) await saveGate.promise;
                if (failSave) return Response.json({ error: "保存失败：网络中断" });
                return Response.json({ ok: true });
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
    failSave = false;
    unconfirmed = false;
    gateEnsure = false;
    gateSave = false;
    ensureHits = 0;
    saveHits = 0;
    writesAfterSwitch = 0;
    resetGate("ensure");
    resetGate("save");
    page = await browser.newPage();
    await page.goto(server.url.toString());
    await page.getByTestId("persist-state").waitFor({ timeout: 8_000 });
});

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

type HarnessState = { writes: string[]; toasts: string[]; switchABA: () => Promise<void>; switchProject: () => void };

async function switchABA() {
    await page.evaluate(async () => {
        const harness = (window as Window & { __uploadSettingsHarness?: HarnessState }).__uploadSettingsHarness;
        if (!harness) throw new Error("harness missing");
        await harness.switchABA();
    });
}

async function harnessState() {
    return page.evaluate(() => (window as Window & { __uploadSettingsHarness?: HarnessState }).__uploadSettingsHarness);
}

test("delayed ordinary persist error after A→B→A does not write or toast on the replacement generation", async () => {
    failEnsure = true;
    gateEnsure = true;
    await page.getByRole("button", { name: "persist-upload" }).click();
    const deadline = Date.now() + 4_000;
    while (ensureHits < 1 && Date.now() < deadline) await Bun.sleep(20);
    expect(ensureHits).toBeGreaterThanOrEqual(1);
    await switchABA();
    await fetch(new URL("/harness/release-ensure", server.url), { method: "POST" });
    await page.waitForTimeout(800);
    const harness = await harnessState();
    expect(await page.getByTestId("persist-state").textContent()).toBe("idle");
    expect(await page.getByTestId("node-asset").textContent()).toBe("");
    expect(harness?.writes ?? []).toEqual([]);
    expect((harness?.toasts ?? []).join("\n")).not.toContain("网络中断");
    expect((harness?.toasts ?? []).join("\n")).not.toContain("文件已添加到画布");
    expect(writesAfterSwitch).toBe(0);
}, 15_000);

test("unconfirmed persist keeps a recoverable draft and does not claim saved", async () => {
    unconfirmed = true;
    await page.getByRole("button", { name: "persist-upload" }).click();
    await page.getByTestId("persist-state").filter({ hasText: "draft" }).waitFor({ timeout: 8_000 });
    expect(await page.getByTestId("node-asset").textContent()).toBe("asset-1");
    const harness = await harnessState();
    expect(harness?.writes ?? []).toEqual(["setNodes"]);
    expect((harness?.toasts ?? []).join("\n")).not.toContain("文件已添加到画布");
}, 15_000);

test("delayed settings save after project change does not toast the new page", async () => {
    gateSave = true;
    await page.getByRole("button", { name: "save-settings" }).click();
    const deadline = Date.now() + 4_000;
    while (saveHits < 1 && Date.now() < deadline) await Bun.sleep(20);
    expect(saveHits).toBeGreaterThanOrEqual(1);
    await page.getByRole("button", { name: "switch-project" }).click();
    await page.getByTestId("project-id").filter({ hasText: "project-b" }).waitFor({ timeout: 4_000 });
    await fetch(new URL("/harness/release-save", server.url), { method: "POST" });
    await page.waitForTimeout(800);
    const harness = await harnessState();
    expect(await page.getByTestId("settings-state").textContent()).toBe("idle");
    expect(harness?.writes ?? []).toEqual([]);
    expect((harness?.toasts ?? []).join("\n")).not.toContain("项目设置已保存");
}, 15_000);

test("delayed ordinary settings error after A→B→A does not toast the replacement generation", async () => {
    failSave = true;
    gateSave = true;
    await page.getByRole("button", { name: "save-settings" }).click();
    const deadline = Date.now() + 4_000;
    while (saveHits < 1 && Date.now() < deadline) await Bun.sleep(20);
    expect(saveHits).toBeGreaterThanOrEqual(1);
    await switchABA();
    await fetch(new URL("/harness/release-save", server.url), { method: "POST" });
    await page.waitForTimeout(800);
    const harness = await harnessState();
    expect(await page.getByTestId("settings-state").textContent()).toBe("idle");
    expect((harness?.toasts ?? []).join("\n")).not.toContain("保存失败");
    expect((harness?.toasts ?? []).join("\n")).not.toContain("网络中断");
    expect(writesAfterSwitch).toBe(0);
}, 15_000);
