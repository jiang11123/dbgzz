import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { BunPlugin } from "bun";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

import type { EditorAssetIngestCall, EditorAssetIngestDoubles } from "./fixtures/editor-asset-ingest-doubles";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;

type HarnessState = {
    doubles: EditorAssetIngestDoubles;
    assets: { id: string }[];
    projectId: string;
    switchABA: () => void;
    switchProject: () => void;
    remountEditor: () => void;
};

beforeAll(async () => {
    const plugins: BunPlugin[] = [
        {
            name: "test-source-alias",
            setup(builder) {
                builder.onResolve({ filter: /^@\// }, (args) => {
                    if (
                        args.path === "@/lib/media-metadata"
                        || args.path === "@/services/api/resources"
                        || args.path === "@/services/api/projects"
                        || args.path === "@/services/file-storage"
                    ) {
                        return { path: Bun.resolveSync("./fixtures/editor-asset-ingest-doubles.ts", import.meta.dir) };
                    }
                    return { path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) };
                });
                builder.onLoad({ filter: /\.(css|svg|png|jpe?g|gif|webp|woff2?)$/ }, () => ({
                    contents: "export default ''",
                    loader: "js",
                }));
            },
        },
    ];
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/editor-asset-ingest-harness.tsx"],
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
        fetch(request) {
            const path = new URL(request.url).pathname;
            if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
            return new Response(
                '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/harness.js"></script>',
                { headers: { "Content-Type": "text/html" } },
            );
        },
    });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);

beforeEach(async () => {
    await page?.close();
    page = await browser.newPage();
    await page.goto(server.url.toString());
    await page.getByRole("button", { name: "导入媒体" }).waitFor({ timeout: 8_000 });
});

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

async function harnessState() {
    return page.evaluate(() => (window as Window & { __editorAssetIngestHarness?: HarnessState }).__editorAssetIngestHarness);
}

async function hold(step: "probe" | "upload" | "link" | "refresh") {
    await page.evaluate((name) => {
        const harness = (window as Window & { __editorAssetIngestHarness?: HarnessState }).__editorAssetIngestHarness;
        if (!harness) throw new Error("harness missing");
        harness.doubles.hold[name] = true;
    }, step);
}

async function fail(flag: keyof EditorAssetIngestDoubles["fail"]) {
    await page.evaluate((name) => {
        const harness = (window as Window & { __editorAssetIngestHarness?: HarnessState }).__editorAssetIngestHarness;
        if (!harness) throw new Error("harness missing");
        harness.doubles.fail[name] = true;
    }, flag);
}

async function release(step: "probe" | "upload" | "link" | "refresh") {
    await page.evaluate((name) => {
        const harness = (window as Window & { __editorAssetIngestHarness?: HarnessState }).__editorAssetIngestHarness;
        if (!harness) throw new Error("harness missing");
        harness.doubles.release(name);
    }, step);
}

async function switchABA() {
    await page.evaluate(() => {
        const harness = (window as Window & { __editorAssetIngestHarness?: HarnessState }).__editorAssetIngestHarness;
        if (!harness) throw new Error("harness missing");
        harness.switchABA();
    });
}

async function switchProject() {
    await page.evaluate(() => {
        const harness = (window as Window & { __editorAssetIngestHarness?: HarnessState }).__editorAssetIngestHarness;
        if (!harness) throw new Error("harness missing");
        harness.switchProject();
    });
    await page.getByTestId("project-id").filter({ hasText: "project-b" }).waitFor({ timeout: 4_000 });
}

async function remountEditor() {
    await page.evaluate(() => {
        const harness = (window as Window & { __editorAssetIngestHarness?: HarnessState }).__editorAssetIngestHarness;
        if (!harness) throw new Error("harness missing");
        harness.remountEditor();
    });
    await page.getByRole("button", { name: "导入媒体" }).waitFor({ timeout: 4_000 });
}

async function importFiles(names: string[]) {
    await page.locator("input[type=file]").setInputFiles(
        names.map((name) => ({
            name,
            mimeType: name.endsWith(".png") ? "image/png" : name.endsWith(".mp3") ? "audio/mpeg" : "video/mp4",
            buffer: Buffer.from("fixture-media"),
        })),
    );
}

async function waitForCall(step: EditorAssetIngestCall["step"], phase: EditorAssetIngestCall["phase"] = "enter") {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
        const harness = await harnessState();
        if (harness?.doubles.calls.some((call) => call.step === step && call.phase === phase)) return;
        await Bun.sleep(20);
    }
    throw new Error(`timeout waiting for ${step} ${phase}`);
}

async function settle(ms = 400) {
    await Bun.sleep(ms);
}

function writes(harness: HarnessState | undefined, step: EditorAssetIngestCall["step"]) {
    return harness?.doubles.calls.filter((call) => call.step === step && call.phase === "write") ?? [];
}

test("ordinary import probes, uploads, links and shows ready for a successful resource", async () => {
    await importFiles(["clip.mp4"]);
    await page.getByText("已导入 1 个媒体").waitFor({ timeout: 8_000 });
    expect(await page.getByRole("button", { name: "导入媒体" }).count()).toBe(1);
    const harness = await harnessState();
    expect(writes(harness, "probe")).toHaveLength(1);
    expect(writes(harness, "upload")).toHaveLength(1);
    expect(writes(harness, "link")).toHaveLength(1);
    expect(writes(harness, "upload")[0]?.expectedScope).toEqual(writes(harness, "upload")[0]?.liveScope);
    expect(writes(harness, "upload")[0]?.durationMs).toBe(1500);
    expect(writes(harness, "link")[0]?.projectId).toBe("project-a");
    expect(await page.getByTestId("asset-ids").textContent()).toBe("res-1");
    expect(await page.getByText("导入失败").count()).toBe(0);
}, 15_000);

test("ordinary upload error does not claim ready", async () => {
    await fail("upload");
    await importFiles(["clip.mp4"]);
    await page.getByText("「clip.mp4」网络中断").waitFor({ timeout: 8_000 });
    expect(await page.getByText("已导入").count()).toBe(0);
    expect(await page.getByRole("button", { name: "导入媒体" }).count()).toBe(1);
    const harness = await harnessState();
    expect(writes(harness, "link")).toHaveLength(0);
    expect(await page.getByTestId("asset-ids").textContent()).toBe("");
}, 15_000);

test("failed resource status does not claim ready", async () => {
    await fail("uploadStatusFailed");
    await importFiles(["clip.mp4"]);
    await page.getByText("「clip.mp4」转码失败").waitFor({ timeout: 8_000 });
    expect(await page.getByText("已导入").count()).toBe(0);
    const harness = await harnessState();
    expect(writes(harness, "link")).toHaveLength(0);
}, 15_000);

test("link retry succeeds after one ordinary failure", async () => {
    await fail("linkOnce");
    await importFiles(["clip.mp4"]);
    await page.getByText("已导入 1 个媒体").waitFor({ timeout: 8_000 });
    const harness = await harnessState();
    expect(harness?.doubles.calls.filter((call) => call.step === "link" && call.phase === "enter")).toHaveLength(2);
    expect(writes(harness, "link")).toHaveLength(1);
}, 15_000);

test("two link failures do not claim ready", async () => {
    await fail("link");
    await importFiles(["clip.mp4"]);
    await page.getByText("「clip.mp4」已上传但挂载到项目失败，请重试").waitFor({ timeout: 8_000 });
    expect(await page.getByText("已导入").count()).toBe(0);
}, 15_000);

test("sequential batch dedupes the same filename and kind", async () => {
    await importFiles(["clip.mp4", "clip.mp4"]);
    await page.getByText("已导入 1 个，跳过 1 个重复文件").waitFor({ timeout: 8_000 });
    const harness = await harnessState();
    expect(writes(harness, "upload")).toHaveLength(1);
    expect(writes(harness, "link")).toHaveLength(1);
}, 15_000);

test("delayed probe after A→B→A does not upload, link, or paint stale status", async () => {
    await hold("probe");
    await importFiles(["clip.mp4"]);
    await waitForCall("probe");
    await switchABA();
    await release("probe");
    await settle();
    const harness = await harnessState();
    expect(writes(harness, "upload")).toHaveLength(0);
    expect(writes(harness, "link")).toHaveLength(0);
    expect(harness?.doubles.writesAfterSwitch).toBe(0);
    expect(await page.getByText("已导入").count()).toBe(0);
    expect(await page.getByText("导入失败").count()).toBe(0);
    expect(await page.getByText("账号已切换").count()).toBe(0);
    expect(await page.getByRole("button", { name: "导入媒体" }).count()).toBe(1);
}, 15_000);

test("delayed upload after A→B→A does not link or paint stale status", async () => {
    await hold("upload");
    await importFiles(["clip.mp4"]);
    await waitForCall("upload");
    await switchABA();
    await release("upload");
    await settle();
    const harness = await harnessState();
    expect(writes(harness, "link")).toHaveLength(0);
    expect(harness?.doubles.writesAfterSwitch).toBe(0);
    expect(await page.getByText("已导入").count()).toBe(0);
    expect(await page.getByText("导入失败").count()).toBe(0);
    expect(await page.getByRole("button", { name: "导入媒体" }).count()).toBe(1);
}, 15_000);

test("delayed link after A→B→A does not write under the replacement identity", async () => {
    await hold("link");
    await importFiles(["clip.mp4"]);
    await waitForCall("link");
    await switchABA();
    await release("link");
    await settle();
    const harness = await harnessState();
    expect(writes(harness, "link")).toHaveLength(0);
    expect(harness?.doubles.writesAfterSwitch).toBe(0);
    expect(harness?.doubles.refreshAfterSwitch).toBe(0);
    expect(await page.getByText("已导入").count()).toBe(0);
    expect(await page.getByText("导入失败").count()).toBe(0);
    expect(await page.getByRole("button", { name: "导入媒体" }).count()).toBe(1);
}, 15_000);

test("delayed ordinary upload error after A→B→A does not paint on the replacement generation", async () => {
    await fail("upload");
    await hold("upload");
    await importFiles(["clip.mp4"]);
    await waitForCall("upload");
    await switchABA();
    await release("upload");
    await settle();
    expect(await page.getByText("网络中断").count()).toBe(0);
    expect(await page.getByText("导入失败").count()).toBe(0);
    expect(await page.getByText("已导入").count()).toBe(0);
    const harness = await harnessState();
    expect(harness?.doubles.writesAfterSwitch).toBe(0);
    expect(await page.getByRole("button", { name: "导入媒体" }).count()).toBe(1);
}, 15_000);

test("delayed ordinary upload error after editor remount does not paint on the new mount", async () => {
    await fail("upload");
    await hold("upload");
    await importFiles(["clip.mp4"]);
    await waitForCall("upload");
    await remountEditor();
    await release("upload");
    await settle();
    expect(await page.getByText("网络中断").count()).toBe(0);
    expect(await page.getByText("导入失败").count()).toBe(0);
    expect(await page.getByText("已导入").count()).toBe(0);
    expect(await page.getByRole("button", { name: "导入媒体" }).count()).toBe(1);
}, 15_000);

test("delayed probe after editor remount does not continue writes or keep importing", async () => {
    await hold("probe");
    await importFiles(["clip.mp4"]);
    await waitForCall("probe");
    await remountEditor();
    await release("probe");
    await settle();
    const harness = await harnessState();
    expect(writes(harness, "upload")).toHaveLength(0);
    expect(writes(harness, "link")).toHaveLength(0);
    expect(await page.getByText("已导入").count()).toBe(0);
    expect(await page.getByRole("button", { name: "导入媒体" }).count()).toBe(1);
}, 15_000);

test("delayed ordinary upload error after project switch does not paint on the new project", async () => {
    await fail("upload");
    await hold("upload");
    await importFiles(["clip.mp4"]);
    await waitForCall("upload");
    await switchProject();
    await release("upload");
    await settle();
    expect(await page.getByTestId("project-id").textContent()).toBe("project-b");
    expect(await page.getByText("网络中断").count()).toBe(0);
    expect(await page.getByText("导入失败").count()).toBe(0);
    expect(await page.getByText("已导入").count()).toBe(0);
    expect(await page.getByRole("button", { name: "导入媒体" }).count()).toBe(1);
}, 15_000);

test("delayed upload after project switch does not link into the new editor", async () => {
    await hold("upload");
    await importFiles(["clip.mp4"]);
    await waitForCall("upload");
    await switchProject();
    await release("upload");
    await settle();
    const harness = await harnessState();
    expect(harness?.projectId).toBe("project-b");
    expect(writes(harness, "link")).toHaveLength(0);
    expect(await page.getByTestId("asset-ids").textContent()).toBe("");
    expect(await page.getByText("已导入").count()).toBe(0);
    expect(await page.getByText("导入失败").count()).toBe(0);
    expect(await page.getByRole("button", { name: "导入媒体" }).count()).toBe(1);
}, 15_000);

test("delayed refresh after A→B→A does not paint ready on the replacement generation", async () => {
    await hold("refresh");
    await importFiles(["clip.mp4"]);
    await waitForCall("refresh");
    await switchABA();
    await release("refresh");
    await settle();
    const harness = await harnessState();
    expect(harness?.doubles.calls.filter((call) => call.step === "refresh" && call.phase === "write")).toHaveLength(0);
    expect(await page.getByText("已导入").count()).toBe(0);
    expect(await page.getByRole("button", { name: "导入媒体" }).count()).toBe(1);
}, 15_000);

test("a new import after A→B→A still succeeds under the live identity", async () => {
    await hold("probe");
    await importFiles(["stale.mp4"]);
    await waitForCall("probe");
    await switchABA();
    await release("probe");
    await settle();
    await page.evaluate(() => {
        const harness = (window as Window & { __editorAssetIngestHarness?: HarnessState }).__editorAssetIngestHarness;
        if (!harness) throw new Error("harness missing");
        harness.doubles.hold.probe = false;
        harness.doubles.resetGate("probe");
        harness.doubles.switched = false;
        harness.doubles.linked = [];
        harness.doubles.calls = [];
    });
    await importFiles(["fresh.mp4"]);
    await page.getByText("已导入 1 个媒体").waitFor({ timeout: 8_000 });
    expect(await page.getByTestId("asset-ids").textContent()).toBe("res-1");
}, 15_000);

test("old import completion cannot clear a new project import busy state", async () => {
    await hold("probe");
    await importFiles(["old.mp4"]);
    await waitForCall("probe");
    await switchProject();
    await page.evaluate(() => {
        const state = (window as Window & { __editorAssetIngestHarness?: HarnessState }).__editorAssetIngestHarness!;
        state.doubles.hold.probe = false;
        state.doubles.hold.upload = true;
    });
    await importFiles(["new.mp4"]);
    await waitForCall("upload");
    await release("probe");
    await settle();
    expect(await page.getByRole("button", { name: "导入中" }).isDisabled()).toBe(true);
    await release("upload");
    await page.getByText("已导入 1 个媒体").waitFor({ timeout: 8_000 });
}, 15_000);
