import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { build } from "vite";

import { INFINITE_CANVAS_OBJECT_STORES } from "../src/lib/localforage-storage";

let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
let directory: string;

beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "beeftv-idb-browser-"));
    const dist = join(directory, "dist");
    await build({
        configFile: false, root: resolve(import.meta.dir, ".."), publicDir: false,
        cacheDir: join(directory, "cache"), logLevel: "error",
        define: { __BEEFTV_HEAVY_MEDIA_ENABLED__: "false", __APP_VERSION__: '"test"', __APP_CHANGELOG__: '""' },
        resolve: { alias: { "@": resolve(import.meta.dir, "../src") } },
        build: { outDir: dist, emptyOutDir: true, rolldownOptions: { input: resolve(import.meta.dir, "fixtures/localforage-idb-harness.html") } },
    });
    server = Bun.serve({ port: 0, async fetch(request) {
        const path = new URL(request.url).pathname;
        const file = path === "/" ? join(dist, "test/fixtures/localforage-idb-harness.html") : resolve(dist, "." + path);
        return file.startsWith(dist + sep) && existsSync(file) ? new Response(Bun.file(file)) : new Response("Not found", { status: 404 });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);

afterAll(async () => { await browser?.close(); server?.stop(true); if (directory) rmSync(directory, { recursive: true, force: true }); });

async function openFixture() {
    const page = await (await browser.newContext()).newPage();
    await page.goto(server.url.toString());
    await page.getByText("ready", { exact: true }).waitFor();
    return page;
}

test("versionchange closes and nulls overlapping IndexedDB handles", async () => {
    const page = await openFixture();
    try {
        const result = await page.evaluate(async () => (window as any).idbFixture.probeVersionchange());
        expect(result.sawVersionchange).toBe(true);
        expect(result.overlappingError).toMatch(/null/i);
        expect(result.stores).toEqual(["app_state", "canvas_folder_pending"]);
    } finally { await page.context().close(); }
}, 15_000);

test("fresh IndexedDB concurrent init of all infinite-canvas stores survives reopen", async () => {
    const context = await browser.newContext();
    try {
        const writer = await context.newPage();
        await writer.goto(server.url.toString());
        await writer.getByText("ready", { exact: true }).waitFor();
        await writer.evaluate(async () => (window as any).idbFixture.wipe());
        const written = await writer.evaluate(async () => (window as any).idbFixture.writeAllConcurrent());
        expect(written.firstErrors).toEqual([]);
        for (const name of INFINITE_CANVAS_OBJECT_STORES) {
            expect(written.written[name]).toEqual({ store: name, token: "fresh-idb-reopen" });
        }
        await writer.close();

        const reader = await context.newPage();
        await reader.goto(server.url.toString());
        await reader.getByText("ready", { exact: true }).waitFor();
        const reopened = await reader.evaluate(async () => (window as any).idbFixture.readAllConcurrent());
        for (const name of INFINITE_CANVAS_OBJECT_STORES) {
            expect(reopened[name]).toEqual({ store: name, token: "fresh-idb-reopen" });
        }
    } finally { await context.close(); }
}, 20_000);
