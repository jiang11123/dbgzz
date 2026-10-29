import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { BunPlugin } from "bun";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;
let switched = false;
let failSave = false;
let gatePatch = false;
let patchHits = 0;
let patchGate: { promise: Promise<void>; resolve: () => void } | undefined;
let patches: Array<{ projectId: string; body: Record<string, unknown> }> = [];
const projects = new Map<string, Record<string, unknown>>();

function resetPatchGate() {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
        resolve = res;
    });
    patchGate = { promise, resolve };
}

function makeProject(id: string, status: string) {
    return {
        id,
        userId: "owner-a",
        name: id === "project-a" ? "项目甲" : "项目乙",
        type: "short-drama",
        aspectRatio: "9:16",
        sourceType: "blank",
        description: "",
        stylePresetId: "",
        status,
        revision: 1,
        createdAt: "2026-10-02T00:00:00.000Z",
        updatedAt: "2026-10-02T00:00:00.000Z",
    };
}

function seedProjects() {
    projects.clear();
    projects.set("project-a", makeProject("project-a", "active"));
    projects.set("project-b", makeProject("project-b", "active"));
}

function json(data: unknown, msg = "ok", code = 0) {
    return Response.json({ code, data, msg });
}

function projectIdFromPath(path: string) {
    const match = path.match(/^\/(?:api\/)?projects\/([^/]+)$/);
    return match?.[1] ? decodeURIComponent(match[1]) : "";
}

type HarnessState = {
    toasts: string[];
    refreshCount: number;
    strictSetups: number;
    strictCleanups: number;
    switchABA: () => Promise<void>;
    switchProjectABA: () => void;
};

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
        entrypoints: [import.meta.dir + "/fixtures/project-settings-view-harness.tsx"],
        plugins,
        target: "browser",
        define: {
            "import.meta.env.DEV": "true",
            "import.meta.env.PROD": "false",
            "import.meta.env.MODE": '"development"',
            "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"false"',
            "import.meta.env.VITE_CANVAS_BACKEND_URL": '""',
            "process.env.NODE_ENV": '"development"',
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
            if (path === "/harness/release-patch" && request.method === "POST") {
                patchGate?.resolve();
                return Response.json({ ok: true });
            }
            if (path === "/harness/patches") {
                return Response.json({ patches, patchHits, switched });
            }
            const projectId = projectIdFromPath(path);
            if (projectId && request.method === "GET") {
                const project = projects.get(projectId) || makeProject(projectId, "active");
                return json({ project });
            }
            if (projectId && request.method === "PATCH") {
                const body = await request.json() as Record<string, unknown>;
                patchHits += 1;
                patches.push({ projectId, body });
                if (gatePatch && patchGate) await patchGate.promise;
                if (failSave) return json(null, "保存失败：网络中断", 1);
                const current = projects.get(projectId) || makeProject(projectId, "active");
                const next = { ...current, ...body, id: projectId };
                projects.set(projectId, next);
                return json({ project: next });
            }
            if (path.startsWith("/api/")) return json([]);
            return new Response('<meta name="viewport" content="width=device-width, initial-scale=1"><script>if (!("Bun" in globalThis)) globalThis.Bun = {};</script><div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } });
        },
    });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);

beforeEach(async () => {
    await page?.close();
    switched = false;
    failSave = false;
    gatePatch = false;
    patchHits = 0;
    patches = [];
    seedProjects();
    resetPatchGate();
    page = await browser.newPage();
    page.on("pageerror", (error) => {
        console.error("project-settings-view pageerror", error.message);
    });
    await page.goto(server.url.toString());
    await page.getByTestId("project-id").waitFor({ timeout: 8_000 });
}, 20_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

async function harnessState() {
    return page.evaluate(() => (window as Window & { __projectSettingsHarness?: HarnessState }).__projectSettingsHarness);
}

async function waitForPatchHits(min: number) {
    const deadline = Date.now() + 4_000;
    while (patchHits < min && Date.now() < deadline) await Bun.sleep(20);
    expect(patchHits).toBeGreaterThanOrEqual(min);
}

async function toastText() {
    return (await harnessState())?.toasts.join("\n") ?? "";
}

test("archive then restore on the same mounted project writes archived then active", async () => {
    await page.getByRole("button", { name: "归档项目" }).click();
    await page.getByRole("button", { name: "确认归档" }).click();
    await page.getByRole("button", { name: "恢复项目" }).waitFor({ timeout: 8_000 });
    expect(await toastText()).toContain("项目已归档");
    expect(await page.getByTestId("project-status").textContent()).toBe("archived");

    await page.getByRole("button", { name: "恢复项目" }).click();
    await page.getByRole("button", { name: "确认恢复" }).click();
    await page.getByRole("button", { name: "归档项目" }).waitFor({ timeout: 8_000 });
    expect(await toastText()).toContain("项目已恢复");
    expect(patches.map((entry) => entry.body.status)).toEqual(["archived", "active"]);
    expect(patches.every((entry) => entry.projectId === "project-a")).toBe(true);
}, 15_000);

test("StrictMode remount still applies a valid settings save", async () => {
    const harness = await harnessState();
    expect(harness?.strictSetups ?? 0).toBeGreaterThanOrEqual(2);
    await page.getByLabel("项目名称").fill("项目甲已改");
    await page.getByRole("button", { name: "保存设置" }).click();
    await page.waitForFunction(() => {
        const state = (window as Window & { __projectSettingsHarness?: HarnessState }).__projectSettingsHarness;
        return (state?.toasts ?? []).some((text) => text.includes("项目设置已保存"));
    }, { timeout: 8_000 });
    expect(await toastText()).toContain("项目设置已保存");
    expect((await harnessState())?.refreshCount ?? 0).toBeGreaterThanOrEqual(1);
    expect(patches.some((entry) => entry.projectId === "project-a" && entry.body.name === "项目甲已改")).toBe(true);
}, 15_000);

test("delayed ordinary save success after project ABA does not toast the replacement session", async () => {
    gatePatch = true;
    await page.getByLabel("项目名称").fill("项目甲已改");
    await page.getByRole("button", { name: "保存设置" }).click();
    await waitForPatchHits(1);
    await page.evaluate(() => {
        const harness = (window as Window & { __projectSettingsHarness?: HarnessState }).__projectSettingsHarness;
        if (!harness) throw new Error("harness missing");
        harness.switchProjectABA();
    });
    await page.getByTestId("project-id").filter({ hasText: "project-a" }).waitFor({ timeout: 4_000 });
    await fetch(new URL("/harness/release-patch", server.url), { method: "POST" });
    await page.waitForTimeout(800);
    expect(await toastText()).not.toContain("项目设置已保存");
    expect((await harnessState())?.refreshCount ?? 0).toBe(0);
}, 15_000);

test("delayed ordinary save error after project ABA does not toast the replacement session", async () => {
    failSave = true;
    gatePatch = true;
    await page.getByLabel("项目名称").fill("项目甲已改");
    await page.getByRole("button", { name: "保存设置" }).click();
    await waitForPatchHits(1);
    await page.evaluate(() => {
        const harness = (window as Window & { __projectSettingsHarness?: HarnessState }).__projectSettingsHarness;
        if (!harness) throw new Error("harness missing");
        harness.switchProjectABA();
    });
    await fetch(new URL("/harness/release-patch", server.url), { method: "POST" });
    await page.waitForTimeout(800);
    expect(await toastText()).not.toContain("保存失败");
    expect(await toastText()).not.toContain("网络中断");
    expect((await harnessState())?.refreshCount ?? 0).toBe(0);
}, 15_000);

test("delayed ordinary save success after scope ABA does not toast the replacement generation", async () => {
    gatePatch = true;
    await page.getByLabel("项目名称").fill("项目甲已改");
    await page.getByRole("button", { name: "保存设置" }).click();
    await waitForPatchHits(1);
    await page.evaluate(async () => {
        const harness = (window as Window & { __projectSettingsHarness?: HarnessState }).__projectSettingsHarness;
        if (!harness) throw new Error("harness missing");
        await harness.switchABA();
    });
    await fetch(new URL("/harness/release-patch", server.url), { method: "POST" });
    await page.waitForTimeout(800);
    expect(await toastText()).not.toContain("项目设置已保存");
    expect((await harnessState())?.refreshCount ?? 0).toBe(0);
}, 15_000);

test("delayed ordinary save error after scope ABA does not toast the replacement generation", async () => {
    failSave = true;
    gatePatch = true;
    await page.getByLabel("项目名称").fill("项目甲已改");
    await page.getByRole("button", { name: "保存设置" }).click();
    await waitForPatchHits(1);
    await page.evaluate(async () => {
        const harness = (window as Window & { __projectSettingsHarness?: HarnessState }).__projectSettingsHarness;
        if (!harness) throw new Error("harness missing");
        await harness.switchABA();
    });
    await fetch(new URL("/harness/release-patch", server.url), { method: "POST" });
    await page.waitForTimeout(800);
    expect(await toastText()).not.toContain("保存失败");
    expect(await toastText()).not.toContain("网络中断");
    expect((await harnessState())?.refreshCount ?? 0).toBe(0);
}, 15_000);
