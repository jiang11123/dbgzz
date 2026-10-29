import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { BunPlugin } from "bun";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;
let switched = false;
let failConfirm = false;
let gateConfirm = false;
let confirmHits = 0;
let videoFixture = false;
let localVideoFixture = false;
let writesAfterSwitch = 0;
let confirmGate: { promise: Promise<void>; resolve: () => void } | undefined;

function resetConfirmGate() {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
        resolve = res;
    });
    confirmGate = { promise, resolve };
}

function libraryAsset(title: string) {
    const id = title === "A-PRIVATE-SECRET" ? "asset-secret" : "asset-replacement";
    if (videoFixture) return {
        id, kind: "video", title, coverUrl: "", tags: [], status: "confirmed", category: "material",
        createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z",
        data: { url: localVideoFixture ? "blob:expired-previous-page" : `/api/resources/${id}/file`, storageKey: localVideoFixture ? "video:owner-a:local-fixture" : `resource:${id}`, width: 64, height: 64, bytes: 8, mimeType: "video/mp4" },
    };
    return {
        id,
        kind: "image",
        title,
        coverUrl: "data:image/png;base64,iVBORw0KGgo=",
        tags: [],
        createdAt: "2026-10-02T00:00:00.000Z",
        updatedAt: "2026-10-02T00:00:00.000Z",
        status: "confirmed",
        category: "material",
        data: {
            dataUrl: "data:image/png;base64,iVBORw0KGgo=",
            storageKey: `resource:${id}`,
            width: 64,
            height: 64,
            bytes: 32,
            mimeType: "image/png",
        },
    };
}

function assetsPayload(title: string) {
    return {
        assets: [libraryAsset(title)],
        kindCounts: { [videoFixture ? "video" : "image"]: 1, all: 1 },
        categoryCounts: { material: 1 },
        folderCounts: {},
        favoriteTotal: 0,
        recentTotal: 1,
        projectCounts: {},
        generatedTotal: 0,
        generatedKindCounts: {},
        page: 1,
        pageSize: 40,
        total: 1,
        hasMore: false,
    };
}

function json(data: unknown, status = 200) {
    return Response.json({ code: status === 200 ? 0 : 1, data, msg: status === 200 ? "ok" : "确认失败：网络中断" }, { status: status === 200 ? 200 : 200 });
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
        entrypoints: [import.meta.dir + "/fixtures/asset-view-scope-harness.tsx"],
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
            if (path === "/harness/release-confirm" && request.method === "POST") {
                confirmGate?.resolve();
                return Response.json({ ok: true });
            }
            if (path === "/api/harness/confirm" && request.method === "POST") {
                confirmHits += 1;
                if (switched) writesAfterSwitch += 1;
                if (gateConfirm && confirmGate) await confirmGate.promise;
                if (failConfirm) return json({}, 1);
                return json({ ok: true });
            }
            if (path === "/api/assets") {
                if (url.searchParams.get("status") === "archived") {
                    return json({ ...assetsPayload("REPLACEMENT-VISIBLE"), assets: [], total: 0, kindCounts: {}, categoryCounts: {} });
                }
                return json(assetsPayload(switched ? "REPLACEMENT-VISIBLE" : "A-PRIVATE-SECRET"));
            }
            if (path === "/api/asset-folders") return json({ folders: [] });
            if (/^\/api\/resources\/[^/]+(?:\/playback)?$/.test(path)) return json({ resource: {
                id: path.split("/")[3], kind: "video", provider: "local", playbackStatus: "ready",
            } });
            if (/^\/api\/resources\/[^/]+\/file$/.test(path)) return new Response(new Uint8Array(8), { headers: { "Content-Type": "video/mp4" } });
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
    videoFixture = false;
    localVideoFixture = false;
    failConfirm = false;
    gateConfirm = false;
    confirmHits = 0;
    writesAfterSwitch = 0;
    resetConfirmGate();
    page = await browser.newPage();
    await page.goto(server.url.toString());
});

test("asset detail resolves owned video for native playback instead of loading the protected resource URL", async () => {
    videoFixture = true;
    await page.reload();
    await page.getByRole("dialog").waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "查看素材：A-PRIVATE-SECRET", exact: true }).click({ timeout: 5000 });
    await page.waitForFunction(() => document.querySelector<HTMLVideoElement>(".asset-archive-preview video")?.getAttribute("src")?.startsWith("blob:"));
    expect(await page.locator(".asset-archive-preview video").getAttribute("src")).toStartWith("blob:");
}, 15_000);

test("local video detail restores persisted bytes after a page reload", async () => {
    videoFixture = true;
    localVideoFixture = true;
    await page.evaluate(() => (window as Window & { __assetViewHarness: { seedLocalVideo: () => Promise<string> } }).__assetViewHarness.seedLocalVideo());
    await page.reload();
    await page.getByRole("dialog").waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "查看素材：A-PRIVATE-SECRET", exact: true }).click({ timeout: 5000 });
    await page.waitForFunction(() => {
        const src = document.querySelector<HTMLVideoElement>(".asset-archive-preview video")?.getAttribute("src");
        return src?.startsWith("blob:") && src !== "blob:expired-previous-page";
    });
    expect(await page.locator(".asset-archive-preview video").evaluate(async (video) => (await fetch((video as HTMLVideoElement).src)).text())).toBe("persisted-local-video");
}, 15_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

type HarnessState = { writes: string[]; toasts: string[]; switchABA: () => Promise<void> };

async function waitForTitle(title: string) {
    await page.getByRole("button", { name: `查看素材：${title}` }).waitFor({ timeout: 8_000 });
    await page.getByTitle(title).first().waitFor({ timeout: 8_000 });
}

async function switchABA() {
    await page.evaluate(async () => {
        const harness = (window as Window & { __assetViewHarness?: HarnessState }).__assetViewHarness;
        if (!harness) throw new Error("harness missing");
        await harness.switchABA();
    });
}

async function harnessState() {
    return page.evaluate(() => (window as Window & { __assetViewHarness?: HarnessState }).__assetViewHarness);
}

test("same-mounted A→B→A clears library and picker of the previous generation", async () => {
    await waitForTitle("A-PRIVATE-SECRET");
    expect(await page.getByRole("button", { name: "查看素材：A-PRIVATE-SECRET" }).count()).toBeGreaterThan(0);
    await switchABA();
    await waitForTitle("REPLACEMENT-VISIBLE");
    expect(await page.getByRole("button", { name: "查看素材：A-PRIVATE-SECRET" }).count()).toBe(0);
    expect(await page.getByTitle("A-PRIVATE-SECRET").count()).toBe(0);
    expect(await page.getByRole("button", { name: "查看素材：REPLACEMENT-VISIBLE" }).count()).toBeGreaterThan(0);
    expect(await page.getByTitle("REPLACEMENT-VISIBLE").count()).toBeGreaterThan(0);
}, 15_000);

test("delayed ordinary confirm error after A→B→A does not toast or write on the replacement account", async () => {
    failConfirm = true;
    gateConfirm = true;
    await waitForTitle("A-PRIVATE-SECRET");
    await page.getByTitle("A-PRIVATE-SECRET").last().click();
    await page.getByRole("button", { name: "确认选用" }).click();
    const deadline = Date.now() + 4_000;
    while (confirmHits < 1 && Date.now() < deadline) await Bun.sleep(20);
    expect(confirmHits).toBeGreaterThanOrEqual(1);
    await switchABA();
    await waitForTitle("REPLACEMENT-VISIBLE");
    await fetch(new URL("/harness/release-confirm", server.url), { method: "POST" });
    await page.waitForTimeout(800);
    const harness = await harnessState();
    expect(harness?.writes ?? []).toEqual([]);
    expect((harness?.toasts ?? []).join("\n")).not.toContain("确认失败");
    expect((harness?.toasts ?? []).join("\n")).not.toContain("网络中断");
    expect((harness?.toasts ?? []).join("\n")).not.toContain("已加入项目");
    expect(await page.getByRole("alert").filter({ hasText: "确认失败" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "查看素材：A-PRIVATE-SECRET" }).count()).toBe(0);
    expect(writesAfterSwitch).toBe(0);
}, 15_000);
