import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import type { CustomerGenerationScenario } from "./fixtures/customer-generation-scenarios";
import { startCustomerScenarioServer } from "./fixtures/customer-generation-server";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let runtime: Awaited<ReturnType<typeof startCustomerScenarioServer>>;
beforeAll(async () => {
    runtime = await startCustomerScenarioServer();
    server = runtime.server;
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60000);
afterAll(async () => { for (const state of runtime.contexts.values()) state.release(); await browser?.close(); runtime?.stop(); });

async function open(scenario: CustomerGenerationScenario, options = "") {
    const { id, state } = runtime.create(scenario);
    if (options.includes("decoy")) state.project.nodes.push({ id: "unrelated-target", type: "video" as any, title: "另一个已选节点", position: { x: 400, y: 300 }, width: 320, height: 180, metadata: { status: "idle", composerContent: "不要修改这个节点" } });
    const context = await browser.newContext();
    await context.addCookies([{ name: "scenario", value: id, url: server.url.toString() }]);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${server.url}?case=${id}&scenario=${scenario}&${options}`);
    await page.getByRole("button", { name: "生成视频", exact: true }).waitFor();
    return { page, state, errors, close: async () => { state.release(); await context.close(); } };
}
async function start(page: Page) { await page.getByRole("button", { name: "生成视频", exact: true }).click(); }
async function until(predicate: () => boolean, timeout = 3500) {
    const deadline = Date.now() + timeout;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    expect(predicate()).toBe(true);
}

for (const scenario of ["five-images", "video-image", "character"] as const) test(`customer ${scenario}: owned references submit while actual blob cache queue is blocked`, async () => {
    const { page, state, errors, close } = await open(scenario, "block-cache");
    try {
        await page.waitForFunction(() => (window as any).__customer.blocked.length === 16);
        await until(() => state.downloads.length >= 4);
        await start(page);
        await until(() => state.posts.length === 1).catch(async error => {
            const detail = await page.evaluate(() => ({ stage: document.querySelector("output")?.textContent, messages: (window as any).__customer.messages, settled: (window as any).__customer.settled, error: (window as any).__customer.error }));
            throw new Error(JSON.stringify(detail), { cause: error });
        });
        const input = state.posts[0].input;
        expect(input.referenceImages.length).toBe(scenario === "five-images" ? 5 : 1);
        expect(input.referenceVideos.length).toBe(scenario === "video-image" ? 1 : 0);
        expect(input.referenceImages.every((image: any) => image.storageKey?.startsWith("resource:") && image.dataUrl === "")).toBe(true);
        expect(state.downloads.filter(name => !name.startsWith("blocker-"))).toEqual([]);
        expect(await page.evaluate(() => (window as any).__customer.nodes.find((node: any) => node.id === "target").metadata.storageKey)).toBe("resource:previous-result");
        expect(errors).toEqual([]);
    } finally { await close(); }
}, 15000);

test("same-origin HTTP/1 held media downloads leave capacity for the task API", async () => {
    const { page, state, errors, close } = await open("five-images", "block-cache&same-origin-hang");
    try {
        // Six is Chrome's HTTP/1 connection limit. Four active media downloads
        // must leave room for saving the target and creating its task.
        await until(() => state.downloads.length >= 4);
        await start(page);
        await until(() => state.posts.length === 1);
        expect(state.downloads.length).toBeLessThanOrEqual(4);
        expect(state.downloads.every(name => name.startsWith("blocker-"))).toBe(true);
        expect(errors).toEqual([]);
    } finally { await close(); }
}, 15000);

test("customer generated audio with zero stored duration is probed by the real browser before task creation", async () => {
    const { page, state, errors, close } = await open("missing-audio-duration");
    try {
        await start(page);
        await until(() => state.posts.length === 1, 7000);
        expect(state.posts[0].input.referenceAudios[0].durationMs).toBe(2500);
        expect(state.downloads.filter(name => name === "audio-1")).toHaveLength(1);
        expect(errors).toEqual([]);
    } finally { await close(); }
}, 15000);

test("customer cancellation during held character preparation creates no task and preserves graph edits and prior output", async () => {
    const { page, state, errors, close } = await open("character");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    await page.route("**/api/projects/synthetic-domain/characters/character-asset", async route => { held = true; await gate; await route.continue(); });
    try {
        await start(page);
        await until(() => held, 3000);
        await page.getByRole("button", { name: "准备期间修改画布" }).click();
        await page.getByRole("button", { name: "取消准备" }).click();
        release();
        await page.waitForFunction(() => (window as any).__customer.settled);
        expect(state.posts).toHaveLength(0);
        const target = await page.evaluate(() => (window as any).__customer.nodes.find((node: any) => node.id === "target"));
        expect(target.title).toBe("准备期间改过的标题");
        expect(target.metadata.composerContent).toBe("准备期间修改的新提示词");
        expect(target.metadata.storageKey).toBe("resource:previous-result");
        expect(errors).toEqual([]);
    } finally { release(); await close(); }
}, 15000);

test("customer edits during preparation stay on canvas while submitted prompt remains frozen", async () => {
    const { page, state, errors, close } = await open("character");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    await page.route("**/api/projects/synthetic-domain/characters/character-asset", async route => { held = true; await gate; await route.continue(); });
    try {
        await start(page);
        await until(() => held);
        await page.getByRole("button", { name: "准备期间修改画布" }).click();
        release();
        await until(() => state.posts.length === 1);
        expect(state.posts[0].prompt).toContain("在画面中缓慢移动");
        expect(state.posts[0].prompt).not.toContain("准备期间修改");
        const target = await page.evaluate(() => (window as any).__customer.nodes.find((node: any) => node.id === "target"));
        expect(target.title).toBe("准备期间改过的标题");
        expect(target.metadata.composerContent).toBe("准备期间修改的新提示词");
        expect(target.metadata.storageKey).toBe("resource:previous-result");
        expect(errors).toEqual([]);
    } finally { release(); await close(); }
}, 15000);

test("a newer video output arriving during preparation remains visible after submission", async () => {
    const { page, state, errors, close } = await open("character");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    await page.route("**/api/projects/synthetic-domain/characters/character-asset", async route => { held = true; await gate; await route.continue(); });
    try {
        await start(page);
        await until(() => held);
        await page.evaluate(() => (window as any).__customer.replaceOutput());
        release();
        await until(() => state.posts.length === 1);
        await page.waitForFunction(() => (window as any).__customer.nodes.find((node: any) => node.id === "target").metadata.taskId === "original-customer-task");
        const target = await page.evaluate(() => (window as any).__customer.nodes.find((node: any) => node.id === "target"));
        expect(target.metadata).toMatchObject({ content: "/api/resources/newer-result/file", storageKey: "resource:newer-result", assetId: "newer-asset", durationMs: 7000, taskStatus: "running" });
        expect(state.posts).toHaveLength(1);
        expect(errors).toEqual([]);
    } finally { release(); await close(); }
}, 15000);

test("customer creation accepted then HTTP response lost refreshes by operation lookup without a second POST", async () => {
    const { page, state, errors, close } = await open("five-images");
    let lostReceipt = false;
    await page.route("**/api/tasks", async route => {
        if (route.request().method() !== "POST") return route.continue();
        await route.fetch(); // Server admits the real request before the client loses its receipt.
        await route.abort("connectionreset");
        lostReceipt = true;
    });
    try {
        await start(page);
        await until(() => state.posts.length === 1);
        await until(() => lostReceipt);
        const operationId = state.posts[0].input.metadata.clientOperationId;
        expect(typeof operationId).toBe("string");
        expect(operationId.length).toBeGreaterThan(8);
        expect(state.project.nodes.find(node => node.id === "target")!.metadata?.taskClientOperationId).toBe(operationId);
        await page.unroute("**/api/tasks");
        // A same-page lookup may already recover the receipt and continue waiting
        // for the supplier. Reload during that wait, then require a fresh lookup.
        state.lookups.length = 0;
        await page.goto(page.url() + "&recover");
        await until(() => state.lookups.length > 0, 7000);
        await page.waitForFunction(() => (window as any).__customer.nodes.find((node: any) => node.id === "target").metadata.taskId === "original-customer-task");
        expect(state.posts).toHaveLength(1);
        expect(errors).toEqual([]);
    } finally { await close(); }
}, 15000);

test("customer default model incompatible with five images reports a visible reason and never switches model", async () => {
    const { page, state, errors, close } = await open("five-images", "incompatible-model");
    try {
        await start(page);
        await page.waitForFunction(() => (window as any).__customer.settled);
        expect(await page.locator(".ant-message").innerText()).toContain("当前模型无法支持");
        expect(state.posts).toHaveLength(0);
        expect(state.downloads).toHaveLength(0);
        expect(errors).toEqual([]);
    } finally { await close(); }
}, 15000);

for (const failure of ["connection-reset", "http-503"] as const) test(`unknown submission ${failure} persists its identity, reloads read-only, and binds the original target`, async () => {
    const { page, state, errors, close } = await open("five-images", "decoy");
    let failedReceipt = false;
    const lookupMethods: string[] = [];
    await page.route("**/api/tasks", async route => {
        if (route.request().method() !== "POST") return route.continue();
        await route.fetch();
        if (failure === "http-503") await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: 503, reason: "temporarily_unavailable", msg: "Synthetic receipt unavailable" }) });
        else await route.abort("connectionreset");
        failedReceipt = true;
    });
    await page.route("**/api/tasks/by-operation/**", route => {
        lookupMethods.push(route.request().method());
        return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: 503, reason: "temporarily_unavailable", msg: "Synthetic lookup unavailable" }) });
    });
    try {
        await start(page);
        await until(() => failedReceipt);
        await page.waitForFunction(() => (window as any).__customer.settled);
        const operationId = state.posts[0].input.metadata.clientOperationId;
        let target = await page.evaluate(() => (window as any).__customer.nodes.find((node: any) => node.id === "target"));
        expect(target.metadata.taskClientOperationId).toBe(operationId);
        expect(target.metadata.generationSubmissionState).toBe("unknown");
        expect(target.metadata.taskStatus).not.toBe("failed");
        expect(target.metadata.taskStage).toContain("提交结果待确认");
        expect(target.metadata.storageKey).toBe("resource:previous-result");
        const saved = state.project.nodes.find(node => node.id === "target")!;
        expect(saved.metadata?.taskClientOperationId).toBe(operationId);
        expect(["submitting", "unknown"]).toContain(saved.metadata?.generationSubmissionState);
        const beforeRepeat = lookupMethods.length;
        await start(page);
        await page.waitForFunction(() => (window as any).__customer.settled);
        expect(lookupMethods.length).toBeGreaterThan(beforeRepeat);
        expect(state.posts).toHaveLength(1);
        await page.goto(page.url() + "&recover");
        await page.waitForFunction(() => (window as any).__customer.nodes.find((node: any) => node.id === "target").metadata.generationSubmissionState === "unknown");
        const beforeReopenedRepeat = lookupMethods.length;
        await start(page);
        await page.waitForFunction(() => (window as any).__customer.settled);
        expect(lookupMethods.length).toBeGreaterThan(beforeReopenedRepeat);
        expect(lookupMethods.every(method => method === "GET")).toBe(true);
        expect(state.posts).toHaveLength(1);
        await page.unroute("**/api/tasks");
        await page.unroute("**/api/tasks/by-operation/**");
        await start(page);
        await page.waitForFunction(() => (window as any).__customer.nodes.find((node: any) => node.id === "target").metadata.taskId === "original-customer-task");
        const nodes = await page.evaluate(() => (window as any).__customer.nodes);
        target = nodes.find((node: any) => node.id === "target");
        expect(target.metadata.taskClientOperationId).toBe(operationId);
        expect(target.metadata.generationSubmissionState).toBe("accepted");
        expect(target.metadata.taskStatus).toBe("running");
        expect(target.metadata.status).toBe("loading");
        expect(nodes.find((node: any) => node.id === "unrelated-target").metadata.taskId).toBeUndefined();
        expect(nodes.find((node: any) => node.id === "unrelated-target").metadata.composerContent).toBe("不要修改这个节点");
        expect(state.posts).toHaveLength(1);
        expect(errors).toEqual([]);
    } finally { await close(); }
}, 20000);

test("reference preparation appears in its video node and closes when the supplier task starts processing", async () => {
    const { page, state, close } = await open("character");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/projects/synthetic-domain/characters/character-asset", async route => { await gate; await route.continue(); });
    try {
        await start(page);
        const progress = page.getByRole("region", { name: "视频节点" }).getByRole("status", { name: "正在准备参考素材", exact: true });
        await progress.waitFor();
        expect(await page.getByText("正在准备参考素材…", { exact: true }).count()).toBe(0);
        release();
        await until(() => state.posts.length === 1);
        await page.waitForFunction(() => document.querySelector("output")?.textContent === "供应商处理中");
        await progress.waitFor({ state: "hidden", timeout: 1500 });
    } finally { release(); await close(); }
}, 15000);
