import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let calls: string[] = [];
let fail = false;
let gate: Promise<void> | undefined;
let release: (() => void) | undefined;
let received: (() => void) | undefined;

beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/canvas-delete-confirmation-harness.tsx"], target: "browser",
        define: { "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"', "process.env.NODE_ENV": '"production"' },
        plugins: [{ name: "isolated-workspace", setup(builder) {
            builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
            builder.onLoad({ filter: /workspace-project-repository\.ts$/ }, () => ({ loader: "ts", contents: `export async function deleteWorkspaceCanvasProjects(ids) { for (const id of ids) { const response = await fetch('/delete/' + id, {method:'DELETE'}); if (!response.ok) throw new Error('删除失败，请重试'); } }` }));
            builder.onLoad({ filter: /use-asset-store\.ts$/ }, () => ({ loader: "ts", contents: `export const useAssetStore = select => select({cleanupImages: async () => {}});` }));
            builder.onLoad({ filter: /workspace-mode\.ts$/ }, () => ({ loader: "ts", contents: `export const isLocalWorkspaceMode = () => true;` }));
        } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0]!.text();
    server = Bun.serve({ port: 0, async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "application/javascript" } });
        if (request.method === "DELETE") {
            calls.push(path);
            received?.();
            if (gate) await gate;
            return new Response("", { status: fail ? 500 : 200 });
        }
        return new Response('<div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60000);
afterAll(async () => { release?.(); await browser?.close(); server?.stop(true); });
beforeEach(() => { calls = []; fail = false; gate = undefined; release = undefined; });

for (const action of ["删除单个", "批量删除"]) test(`${action}: opening and cancelling never deletes`, async () => {
    const page = await browser.newPage();
    try {
        await page.goto(server.url.toString());
        await page.getByRole("button", { name: action, exact: true }).click();
        await page.getByRole("dialog").waitFor();
        expect(calls).toEqual([]);
        await page.getByRole("button", { name: "取消", exact: true }).click();
        await page.getByRole("dialog").waitFor({ state: "detached" });
        expect(calls).toEqual([]);
    } finally { await page.close(); }
}, 30000);

test("confirmation reads current targets and rejects repeated clicks while pending", async () => {
    const page = await browser.newPage();
    gate = new Promise(resolve => { release = resolve; });
    const requestReceived = new Promise<void>(resolve => { received = resolve; });
    try {
        await page.goto(server.url.toString());
        await page.getByRole("button", { name: "批量删除", exact: true }).click();
        await page.evaluate(() => (window as any).__deletion.select(["c2"]));
        await page.getByRole("button", { name: "删除", exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
        await requestReceived;
        expect(calls).toEqual(["/delete/c2"]);
        expect(await page.getByRole("button", { name: "取消", exact: true }).isDisabled()).toBe(true);
        release!();
        await page.getByRole("dialog").waitFor({ state: "detached" });
    } finally { received = undefined; release?.(); await page.close(); }
}, 30000);

test("failure stays visible and retry succeeds", async () => {
    const page = await browser.newPage();
    try {
        fail = true;
        await page.goto(server.url.toString());
        await page.getByRole("button", { name: "删除单个", exact: true }).click();
        await page.getByRole("button", { name: "删除", exact: true }).click();
        await page.getByRole("alert").waitFor();
        expect(calls).toEqual(["/delete/c1"]);
        fail = false;
        await page.getByRole("button", { name: "删除", exact: true }).click();
        await page.getByRole("dialog").waitFor({ state: "detached" });
        expect(calls).toEqual(["/delete/c1", "/delete/c1"]);
    } finally { await page.close(); }
}, 30000);

test("A to B to A invalidates an open confirmation", async () => {
    const page = await browser.newPage();
    try {
        await page.goto(server.url.toString());
        await page.getByRole("button", { name: "删除单个", exact: true }).click();
        await page.evaluate(() => { (window as any).__deletion.switchScope("owner-b"); (window as any).__deletion.switchScope("owner-a"); });
        await page.getByRole("button", { name: "删除", exact: true }).click();
        await page.getByRole("alert").waitFor();
        expect(await page.getByRole("alert").textContent()).toContain("账号已切换");
        expect(calls).toEqual([]);
    } finally { await page.close(); }
}, 30000);

test("switching account during deletion does not report success or clear new selection", async () => {
    const page = await browser.newPage();
    gate = new Promise(resolve => { release = resolve; });
    const requestReceived = new Promise<void>(resolve => { received = resolve; });
    try {
        await page.goto(server.url.toString());
        await page.getByRole("button", { name: "删除单个", exact: true }).click();
        await page.getByRole("button", { name: "删除", exact: true }).click();
        await requestReceived;
        await page.evaluate(() => { (window as any).__deletion.switchScope("owner-b"); (window as any).__deletion.select(["b1"]); });
        release!();
        await page.getByRole("alert").waitFor();
        expect(await page.getByRole("alert").textContent()).toContain("账号已切换");
        expect(calls).toEqual(["/delete/c1"]);
        expect(await page.getByRole("dialog").isVisible()).toBe(true);
    } finally { received = undefined; release?.(); await page.close(); }
}, 30000);
