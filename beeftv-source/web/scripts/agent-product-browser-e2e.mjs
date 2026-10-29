/**
 * 内置创作助手 — 真实浏览器验收（Playwright + 隔离后端）。
 *
 * 全部走真实用户路径，不用替身：
 * - 页面是真实 Vite DEV 下的 React 画布页，对话从真实输入框发出；
 * - 外部写入用真实 `beeftv` CLI（与 MCP 同一操作层）；
 * - 断言同时读后端文档与页面 DOM（节点、提示词编辑器、面板气泡）。
 *
 * 前置：隔离后端 127.0.0.1:18090 已启动，并已显式放行本脚本使用的 DEV Origin
 * （`BEEFTV_ALLOWED_ORIGINS` / `CANVAS_CORS_ORIGINS`，见 restart-isolated-server.sh）。
 * 发行形态是同源打包页面，不需要这条放行。
 *
 * 用法：bun scripts/agent-product-browser-e2e.mjs
 * 产物：结果 JSON 与截图写入 `.local/agent-product/`。
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

// 路径全部从本脚本位置推导，或用环境变量覆盖；默认产物落在 <workspace>/.local/agent-product。
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(SCRIPT_DIR, "..");
const WORKSPACE_ROOT = resolve(process.env.BEEFTV_WORKSPACE || join(WEB_ROOT, ".."));
const AGENT_PRODUCT_DIR = resolve(process.env.BEEFTV_AGENT_PRODUCT_DIR || join(WORKSPACE_ROOT, ".local/agent-product"));
const API = process.env.AGENT_E2E_API || "http://127.0.0.1:18090/api";
const WEB_PORT = Number(process.env.AGENT_E2E_WEB_PORT || 18400);
const SHOTS = join(AGENT_PRODUCT_DIR, "screenshots");
const CLI = process.env.BEEFTV_CLI || join(AGENT_PRODUCT_DIR, "beeftv");
const OWNER = readFileSync(join(AGENT_PRODUCT_DIR, "data/agent_owner_token"), "utf8").trim();
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const RESULT_PATH = process.env.AGENT_E2E_RESULT || join(AGENT_PRODUCT_DIR, "results-react-cross-entry.json");
// 每次运行的原始结果单独落一份（不覆盖），latest 指针只用于方便打开。
const RAW_RESULT_PATH = join(AGENT_PRODUCT_DIR, `results-react-cross-entry-${STAMP}.json`);
const TURN_TIMEOUT_MS = Number(process.env.AGENT_E2E_TURN_TIMEOUT_MS || 300_000);
// 助手输入框在有节点的画布上是富文本编辑器，空画布上是 textarea：用 aria-label 两种都命中。
const COMPOSER = '[aria-label="给助手的消息"]';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
const steps = {};

/**
 * 失败与通过都追加保留：一次运行不能覆盖上一次的真实结果。
 *
 * 返回落盘结果而不是吞掉异常——证据链写入失败必须让本次验收显式失败，
 * 否则会出现「JSON 说通过、attempt 索引其实没写」的假证据。
 */
function appendAttempt(summary) {
    const line = JSON.stringify({
        stamp: summary.stamp,
        ok: summary.ok,
        passed: summary.checks.filter((item) => item.ok).length,
        total: summary.checks.length,
        failed: summary.checks.filter((item) => !item.ok).map((item) => item.name),
        rawResultPath: summary.rawResultPath,
    });
    try {
        appendFileSync(join(AGENT_PRODUCT_DIR, "results-react-cross-entry-attempts.jsonl"), `${line}\n`);
        return { written: true, error: null };
    } catch (error) {
        return { written: false, error: error instanceof Error ? error.message : String(error) };
    }
}


function check(name, ok, detail = "") {
    checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 600) });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ""}`);
    return Boolean(ok);
}

async function api(method, path, body) {
    const response = await fetch(API + path, {
        method,
        headers: { "Content-Type": "application/json", "X-Beeftv-Owner": OWNER },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: response.status, body: parsed, text: text.slice(0, 300) };
}

async function readCanvas(id) {
    const response = await api("GET", `/canvas-projects/${encodeURIComponent(id)}`);
    return response.body?.data?.project;
}

function runCli(args) {
    const result = spawnSync(CLI, args, {
        env: { ...process.env, BEEFTV_BASE_URL: API, BEEFTV_OWNER_TOKEN: OWNER },
        encoding: "utf8",
    });
    let parsed = null;
    try { parsed = JSON.parse(result.stdout.trim()); } catch { /* 非 JSON 输出 */ }
    return { exit: result.status, stdout: (result.stdout || "").trim().slice(0, 400), stderr: (result.stderr || "").trim().slice(0, 300), json: parsed };
}

async function panelMessages(page) {
    return page.evaluate(() => {
        const panel = document.querySelector(".canvas-assistant-panel");
        if (!panel) return { user: [], assistant: [], notices: [] };
        return {
            user: Array.from(panel.querySelectorAll(".canvas-assistant-user")).map((n) => n.textContent || ""),
            assistant: Array.from(panel.querySelectorAll(".canvas-assistant-reply")).map((n) => n.textContent || ""),
            notices: Array.from(panel.querySelectorAll(".canvas-assistant-card, .canvas-assistant-notice")).map((n) => n.textContent || ""),
        };
    });
}

async function waitForAssistantReply(page, expectedCount = 1, timeoutMs = TURN_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    let last = { ready: false };
    while (Date.now() < deadline) {
        const messages = await panelMessages(page);
        last = { ready: messages.assistant.length >= expectedCount, ...messages };
        if (last.ready && !(await page.locator(".canvas-assistant-panel").getByRole("button", { name: "停止" }).count())) return last;
        await sleep(1500);
    }
    return last;
}

async function domNodeIds(page) {
    return page.evaluate(() => Array.from(document.querySelectorAll("[data-node-id]")).map((n) => n.getAttribute("data-node-id")));
}

async function domNodeTitles(page) {
    return page.evaluate(() => Array.from(document.querySelectorAll('button[aria-label^="拖动节点："]')).map((n) => (n.getAttribute("aria-label") || "").replace("拖动节点：", "")));
}

async function clickByLabel(page, label) {
    const button = page.getByRole("button", { name: label, exact: true }).first();
    if (await button.count()) { await button.click(); await sleep(1200); return true; }
    return false;
}

async function openCanvasMenu(page) {
    const trigger = page.locator("button", { hasText: /^画布 \d+$/ }).first();
    if (!(await trigger.count())) return false;
    await trigger.click();
    await sleep(900);
    return true;
}

async function switchCanvas(page, label) {
    if (!(await openCanvasMenu(page))) return false;
    const item = page.locator(".canvas-topbar-canvas-menu-select", { hasText: label }).first();
    if (!(await item.count())) return false;
    await item.click();
    await sleep(2500);
    return true;
}

/**
 * 切到菜单里另一个画布。
 *
 * 菜单标签是「画布 N」按排序序号生成的，新建画布后会重排，记录旧标签再回点并不可靠；
 * 打开菜单时自己一定是当前画布，因此点非当前行就是切到另一个画布。
 */
async function switchToOtherCanvas(page) {
    if (!(await openCanvasMenu(page))) return "";
    const row = page.locator(".canvas-topbar-canvas-menu-row:not(.is-current) .canvas-topbar-canvas-menu-select").first();
    if (!(await row.count())) return "";
    const label = (await row.innerText()).trim();
    await row.click();
    await sleep(2500);
    const match = page.url().match(/\/canvas\/([^/?#]+)/);
    return label && match ? match[1] : "";
}

async function createCanvasFromUi(page) {
    if (!(await openCanvasMenu(page))) return null;
    const add = page.getByRole("button", { name: "新建画布" }).first();
    if (!(await add.count())) return null;
    await add.click();
    await sleep(3500);
    const match = page.url().match(/\/canvas\/([^/?#]+)/);
    return match ? match[1] : null;
}

/** 选中节点：点击节点标题区，节点配置面板随之出现。 */
async function selectNode(page, nodeId) {
    const box = await page.evaluate((id) => {
        const node = document.querySelector(`[data-node-id="${id}"]`);
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return { x: rect.x + Math.min(60, rect.width / 2), y: rect.y + Math.min(18, rect.height / 2) };
    }, nodeId);
    if (!box) return false;
    await page.mouse.click(box.x, box.y);
    await sleep(2000);
    return true;
}

/**
 * 从 UI 读回**选中节点**的提示词。
 *
 * 节点只渲染 metadata.content；提示词显示在选中节点的 composer 面板里。为了证明读到的是
 * 目标节点：面板取「composer 向上最近一个含拖拽手柄的容器」，要求它恰好只有一个手柄、
 * 且页面上只有一个 composer；标题不在面板内，因此调用方还会换选另一个节点做交叉验证。
 */
async function readPromptInUi(page, nodeId, expected, timeoutMs = 45_000) {
    const deadline = Date.now() + timeoutMs;
    let evidence = { value: "", dragHandles: 0, composerCount: 0 };
    while (Date.now() < deadline) {
        if (await selectNode(page, nodeId)) {
            evidence = await page.evaluate(() => {
                const composers = Array.from(document.querySelectorAll("textarea"))
                    .filter((node) => !node.closest(".canvas-assistant-panel"));
                const composer = composers[0];
                if (!composer) return { value: "", dragHandles: 0, composerCount: 0 };
                let panel = composer;
                for (let depth = 0; depth < 12 && panel.parentElement; depth += 1) {
                    if (panel.querySelector("[data-canvas-node-drag-handle]")) break;
                    panel = panel.parentElement;
                }
                return {
                    value: composer.value || "",
                    dragHandles: panel.querySelectorAll("[data-canvas-node-drag-handle]").length,
                    composerCount: composers.length,
                };
            }, "用自然语言描述创作需求…");
            if (!expected || evidence.value.includes(expected)) return evidence;
        }
        await sleep(2000);
    }
    return evidence;
}

const consoleErrors = [];
const failedRequests = [];
const cancelledRequests = [];
/** 每个对话请求的原始 NDJSON 事件摘要：用来区分「模型只做了一步」与「前端截断」。 */
const chatResponses = [];
const stopClicks = { count: 0 };

async function main() {
    mkdirSync(SHOTS, { recursive: true });

    const status = await api("GET", "/assistant/status");
    if (!status.body?.data?.available) {
        check("内置助手宿主可用", false, JSON.stringify(status.body?.data || status.text));
        return;
    }
    check("内置助手宿主可用", true, JSON.stringify(status.body.data.health).slice(0, 200));

    const stamp = Date.now();
    const canvasA = `ui-A-${stamp}`;
    // 画布外壳由后端预置（本用例考察对话与刷新，不是新建画布流程）；
    // 刻意不写 chatSessions，与外部写入产生的文档形状一致。
    const created = await api("PUT", `/canvas-projects/${canvasA}`, {
        project: {
            id: canvasA, revision: 0, title: "验收画布A", workspaceProjectId: `ws-${stamp}`,
            nodes: [{ id: "side1", type: "text", title: "旁支-不可动", position: { x: 60, y: 660 }, width: 320, height: 180, metadata: { prompt: "旁支提示词", content: "旁支内容" } }],
            connections: [],
        },
    });
    if (created.status !== 200) { check("预置画布 A", false, created.text); return; }

    const vite = spawn("bunx", ["vite", "--host", "127.0.0.1", "--port", String(WEB_PORT), "--strictPort"], {
        cwd: WEB_ROOT,
        env: { ...process.env, VITE_API_PROXY_TARGET: "http://127.0.0.1:18090" },
        stdio: "pipe",
    });
    const stopVite = () => { try { vite.kill("SIGTERM"); } catch { /* 已退出 */ } };
    let webReady = false;
    for (let i = 0; i < 90; i += 1) {
        try { const response = await fetch(`http://127.0.0.1:${WEB_PORT}/`); if (response.ok) { webReady = true; break; } } catch { /* 还没起来 */ }
        await sleep(500);
    }
    check("Vite DEV 就绪", webReady, `http://127.0.0.1:${WEB_PORT}`);
    if (!webReady) { stopVite(); return; }

    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"].find((path) => path && existsSync(path));
    const browser = await chromium.launch({ headless: true, executablePath });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const chatBodies = [];
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text().slice(0, 400)); });
    page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`.slice(0, 400)));
    // 画布 SSE 在路由切换/画布切换时会被主动关闭，net::ERR_ABORTED 是预期行为，不是失败。
    page.on("requestfailed", (request) => {
        const aborted = request.failure()?.errorText === "net::ERR_ABORTED";
        // 画布 SSE 在路由/画布切换时被主动关闭，对话流在用户点「停止」时被主动取消：
        // 两者都是预期取消，单独记录；其余网络失败一律算失败。
        if (aborted && request.url().includes("/events")) { cancelledRequests.push(`events ${request.url().slice(-40)}`); return; }
        if (aborted && request.url().includes("/api/assistant/chat")) { cancelledRequests.push("assistant/chat stop"); return; }
        if (!aborted) failedRequests.push(`${request.method()} ${request.url().slice(0, 120)} ${request.failure()?.errorText || ""}`);
    });
    page.on("response", async (response) => {
        if (!response.url().includes("/api/assistant/chat")) return;
        try {
            const text = await response.text();
            const events = text.split("\n").map((line) => line.trim()).filter(Boolean)
                .map((line) => { try { return JSON.parse(line); } catch { return null; } })
                .filter(Boolean);
            const turns = events.filter((event) => event.type === "turn_end");
            chatResponses.push({
                status: response.status(),
                textDeltas: events.filter((event) => event.type === "text_delta").length,
                turnEnds: turns.length,
                reply: (turns[turns.length - 1]?.reply || "").slice(0, 400),
                tools: (turns[turns.length - 1]?.toolCalls || []).map((call) => call.tool),
                error: turns[turns.length - 1]?.error || null,
            });
        } catch { /* 流被取消，无完整响应体 */ }
    });
    page.on("request", (request) => { if (request.url().includes("/api/assistant/chat")) chatBodies.push(request.postData() || ""); });

    try {
        await page.goto(`http://127.0.0.1:${WEB_PORT}/canvas/${canvasA}`, { waitUntil: "domcontentloaded" });
        await page.locator(COMPOSER).waitFor({ timeout: 60_000 });
        await sleep(4000);
        check("画布页与助手面板加载", await page.locator(".canvas-assistant-panel").count() > 0, await page.title());

        // ---- 1. UI 对话建三镜头并连成链 ----
        await page.locator(COMPOSER).fill("在当前画布创建三个 image 节点：镜头1-开场、镜头2-冲突、镜头3-收尾，并连成一条链；不要改动已有的旁支节点。");
        await page.locator("aside").getByRole("button", { name: "发送" }).click();
        const reply = await waitForAssistantReply(page, 1);
        const afterTurn = await readCanvas(canvasA);
        const titles = (afterTurn?.nodes || []).map((node) => node.title);
        check("UI 对话后助手给出回复", reply.ready, (reply.assistant?.[0] || reply.reason || "").slice(0, 160));
        check("对话创建了三个镜头", ["镜头1-开场", "镜头2-冲突", "镜头3-收尾"].every((title) => titles.includes(title)), titles.join(","));
        check("三个镜头连成一条链", (afterTurn?.connections || []).length === 2, String((afterTurn?.connections || []).length));
        await clickByLabel(page, "适合屏幕");
        await sleep(1500);
        const domTitles = await domNodeTitles(page);
        check("新镜头出现在真实画布 DOM", ["镜头1-开场", "镜头2-冲突", "镜头3-收尾"].every((title) => domTitles.includes(title)), domTitles.join(","));
        await page.screenshot({ path: join(SHOTS, `01-ui-dialogue-created-shots-${STAMP}.png`) });

        const target = (afterTurn?.nodes || []).find((node) => node.title === "镜头2-冲突");
        const revisionAfterTurn = afterTurn.revision;

        // ---- 2. CLI 改目标镜头 prompt → UI 看到新值 ----
        // --content 是描述符对生成类节点声明的可编辑提示词路径（metadata.composerContent），
        // 也就是画布编辑器读的那个字段；--prompt 写的是已提交提示词，编辑器不显示它。
        const cliUpdate = runCli(["canvas", "node", "update", "--canvas", canvasA, "--node", target.id, "--expected-revision", String(revisionAfterTurn), "--content", "夜景：雨夜巷口对峙", "--op-id", `e2e-cli-${stamp}`, "--json"]);
        steps.cliUpdate = cliUpdate;
        check("CLI 改目标镜头成功", cliUpdate.exit === 0, `exit=${cliUpdate.exit} ${cliUpdate.stdout.slice(0, 160)}`);

        const promptInUi = await readPromptInUi(page, target.id, "夜景：雨夜巷口对峙");
        const afterCli = await readCanvas(canvasA);
        const targetAfterCli = (afterCli?.nodes || []).find((node) => node.id === target.id);
        steps.cliChangeVisible = {
            promptInUi: promptInUi.value.slice(0, 200),
            promptReadEvidence: { dragHandles: promptInUi.dragHandles, composerCount: promptInUi.composerCount },
            backendComposerContent: targetAfterCli?.metadata?.composerContent,
            backendPrompt: targetAfterCli?.metadata?.prompt,
            backendContent: targetAfterCli?.metadata?.content,
            revision: afterCli?.revision,
        };
        check(
            "UI 提示词编辑器显示 CLI 写入的新值",
            promptInUi.value.includes("夜景：雨夜巷口对峙") && promptInUi.dragHandles === 1 && promptInUi.composerCount === 1,
            `ui=${promptInUi.value.slice(0, 80)} dragHandles=${promptInUi.dragHandles} composers=${promptInUi.composerCount} backend=${targetAfterCli?.metadata?.composerContent}`,
        );
        // 交叉验证：换选另一个镜头，composer 必须跟随选择（不再显示目标节点的值）；
        // 若那个镜头本身有草稿，还要求读到它自己的值。这证明上一条读到的确实是目标节点的字段。
        const crossNode = (afterCli?.nodes || []).find((node) => node.id !== target.id && node.type === "image");
        const crossExpected = String(crossNode?.metadata?.composerContent || "");
        const crossRead = crossNode ? await readPromptInUi(page, crossNode.id, crossExpected, 20_000) : { value: "" };
        steps.promptCrossCheck = { nodeId: crossNode?.id, expected: crossExpected, read: crossRead.value.slice(0, 80) };
        check(
            "composer 跟随选中节点（换选后不再显示目标节点的值）",
            Boolean(crossNode) && !crossRead.value.includes("雨夜巷口对峙") && (!crossExpected || crossRead.value.includes(crossExpected)),
            JSON.stringify(steps.promptCrossCheck),
        );
        check("CLI 写入没有覆盖生成节点的媒体结果槽位", targetAfterCli?.metadata?.content === "", `content=${String(targetAfterCli?.metadata?.content).slice(0, 60)}`);
        await page.screenshot({ path: join(SHOTS, `02-ui-sees-cli-change-${STAMP}.png`) });

        // ---- 3. 陈旧 revision 提交被拒且不覆盖用户值 ----
        const stale = runCli(["canvas", "node", "update", "--canvas", canvasA, "--node", target.id, "--expected-revision", String(revisionAfterTurn), "--content", "不应写入的陈旧值", "--op-id", `e2e-stale-${stamp}`, "--json"]);
        const afterStale = await readCanvas(canvasA);
        const stalePrompt = (afterStale?.nodes || []).find((node) => node.id === target.id)?.metadata?.composerContent;
        steps.staleWrite = { exit: stale.exit, reason: stale.json?.reason, stdout: stale.stdout };
        check("陈旧 revision 提交被服务端拒绝", stale.exit !== 0 && stale.json?.reason === "stale_revision", `exit=${stale.exit} reason=${stale.json?.reason}`);
        check("陈旧提交没有覆盖当前值", stalePrompt === "夜景：雨夜巷口对峙", String(stalePrompt));
        const staleInUi = await readPromptInUi(page, target.id, "夜景：雨夜巷口对峙", 20_000);
        check("陈旧提交后编辑器仍是用户当前值", staleInUi.value.includes("夜景：雨夜巷口对峙") && staleInUi.dragHandles === 1, `ui=${staleInUi.value.slice(0, 80)}`);

        // ---- 4. 旁支节点完好 + 手工新增/撤销路径保留 ----
        const sideNode = (afterStale?.nodes || []).find((node) => node.id === "side1");
        check("旁支节点内容未被改动", sideNode?.metadata?.prompt === "旁支提示词", `prompt=${sideNode?.metadata?.prompt}`);

        await page.keyboard.press("Escape");
        const beforeAdd = (await domNodeIds(page)).length;
        let afterAdd = beforeAdd;
        if (await clickByLabel(page, "添加节点")) {
            const textItem = page.getByRole("button", { name: "文本", exact: true }).first();
            if (await textItem.count()) { await textItem.click(); await sleep(2500); afterAdd = (await domNodeIds(page)).length; }
        }
        await page.keyboard.press("Escape");
        await sleep(500);
        await page.keyboard.press("Meta+z");
        await sleep(2500);
        const afterUndo = (await domNodeIds(page)).length;
        // 撤销只能回退这次手工新增：外部刚写入的目标字段、旁支内容与连线都不能被旧快照倒退。
        const afterUndoDoc = await readCanvas(canvasA);
        const afterUndoNodes = afterUndoDoc?.nodes || [];
        const afterUndoTarget = afterUndoNodes.find((node) => node.id === target.id);
        const afterUndoSide = afterUndoNodes.find((node) => node.id === "side1");
        const afterUndoTitles = await domNodeTitles(page);
        steps.manualPath = {
            beforeAdd,
            afterAdd,
            afterUndo,
            targetComposerContent: afterUndoTarget?.metadata?.composerContent,
            sideContent: afterUndoSide?.metadata?.content,
            connections: (afterUndoDoc?.connections || []).length,
            domTitles: afterUndoTitles,
        };
        check("手工新增节点仍然可用", afterAdd === beforeAdd + 1, JSON.stringify({ beforeAdd, afterAdd }));
        check("手工撤销仍然可用", afterUndo === beforeAdd, JSON.stringify({ beforeAdd, afterUndo }));
        check("撤销没有倒退 CLI 刚写入的目标字段", afterUndoTarget?.metadata?.composerContent === "夜景：雨夜巷口对峙", `composerContent=${String(afterUndoTarget?.metadata?.composerContent).slice(0, 60)}`);
        check("撤销没有改动旁支节点", afterUndoSide?.metadata?.content === "旁支内容" && afterUndoTitles.includes("旁支-不可动"), `content=${String(afterUndoSide?.metadata?.content).slice(0, 40)} titles=${afterUndoTitles.join(",")}`);
        check("撤销没有改动三镜头链条", (afterUndoDoc?.connections || []).length === 2, String((afterUndoDoc?.connections || []).length));

        // ---- 5. 收起面板再打开：会话不中断、历史正确 ----
        const beforeCollapse = await panelMessages(page);
        await page.locator('button[aria-label="关闭助手"]').click();
        await sleep(1300);
        const collapsed = await page.locator(".canvas-assistant-panel").count() === 0;
        await page.locator('button[aria-label="助手"]').first().click();
        await sleep(1500);
        const afterExpand = await panelMessages(page);
        steps.collapse = { collapsed, before: beforeCollapse.assistant.length, after: afterExpand.assistant.length };
        check("关闭后助手面板消失", collapsed, String(collapsed));
        check("重新打开后历史完整保留", JSON.stringify(beforeCollapse) === JSON.stringify(afterExpand), JSON.stringify(steps.collapse));
        await page.screenshot({ path: join(SHOTS, `03-collapse-reopen-history-${STAMP}.png`) });

        // ---- 6. 发送时冻结 selectedNodeIds ----
        const ids = (await domNodeIds(page)).filter((id) => id !== "side1");
        const first = ids[0];
        const second = ids[1];
        const selectedAtSend = [];
        if (first && await selectNode(page, first)) selectedAtSend.push(first);
        chatBodies.length = 0;
        await page.locator(COMPOSER).fill("请只回复：收到。");
        await page.locator("aside").getByRole("button", { name: "发送" }).click();
        await sleep(900);
        if (second) await selectNode(page, second);
        const freezeReply = await waitForAssistantReply(page, 2);
        const body = chatBodies[0] ? JSON.parse(chatBodies[0]) : null;
        const sentIds = (body?.selectedNodeIds || []).slice().sort();
        steps.selectedSnapshot = { selectedAtSend, sentSelectedNodeIds: body?.selectedNodeIds };
        check("发送时冻结选中对象，后续选择不改变请求", Boolean(body) && JSON.stringify(sentIds) === JSON.stringify(selectedAtSend.slice().sort()), JSON.stringify(body?.selectedNodeIds));
        check("冻结用例的回合正常结束", freezeReply.ready, (freezeReply.assistant?.[1] || "").slice(0, 120));
        await page.screenshot({ path: join(SHOTS, `04-selected-snapshot-${STAMP}.png`) });

        // ---- 7. A 请求进行中切到 B ----
        const assistantBefore = (await panelMessages(page)).assistant.length;
        await page.locator(COMPOSER).fill("请用一句话介绍你为这部短剧安排的三个镜头，不要改动画布。");
        await page.locator("aside").getByRole("button", { name: "发送" }).click();
        await sleep(2000);
        const aStopVisible = await page.locator("aside").getByRole("button", { name: "停止" }).count() > 0;
        const canvasB = await createCanvasFromUi(page);
        check("在 A 请求进行中切到 B", Boolean(canvasB) && page.url().includes(canvasB), `${canvasB} ${page.url()}`);
        await sleep(2500);
        const bPanel = await panelMessages(page);
        check("B 画布面板独立（没有 A 的对话）", bPanel.user.length === 0 && bPanel.assistant.length === 0, JSON.stringify(bPanel.user).slice(0, 160));

        await page.locator(COMPOSER).fill("请只回复：B 画布已就绪。");
        await page.locator("aside").getByRole("button", { name: "发送" }).click();
        await sleep(2500);
        const stopB = page.locator("aside").getByRole("button", { name: "停止" }).first();
        const hasStopB = await stopB.count() > 0;
        if (hasStopB) { stopClicks.count += 1; await stopB.click(); await sleep(2000); }
        const bAfterStop = await panelMessages(page);
        steps.abIsolation = { aStopVisible, hasStopB, bNotices: bAfterStop.notices };
        check("B 可以独立发起对话并停止", hasStopB, JSON.stringify(steps.abIsolation));

        const switchedBackTo = await switchToOtherCanvas(page);
        const backToA = Boolean(switchedBackTo) && switchedBackTo === canvasA;
        const aReply = await waitForAssistantReply(page, assistantBefore + 1, 150_000);
        const aMessages = await panelMessages(page);
        const aCancelled = aMessages.notices.some((text) => /取消|停止|已中断/.test(text));
        steps.abIsolation.aAssistant = aMessages.assistant.map((text) => text.slice(0, 120));
        steps.abIsolation.aNotices = aMessages.notices;
        check("切回 A 后 A 的新 assistant 回复完整可见", backToA && aMessages.user.some((text) => text.includes("三个镜头")) && aMessages.assistant.length === assistantBefore + 1, JSON.stringify(aMessages.assistant.map((text) => text.slice(0, 60))));
        check("停止 B 只影响 B 的 run", aReply.ready && !aCancelled, `cancelled=${aCancelled} notices=${JSON.stringify(aMessages.notices).slice(0, 160)}`);
        await page.screenshot({ path: join(SHOTS, `05-ab-isolation-back-to-A-${STAMP}.png`) });

        // ---- 8. 脏草稿保护（真实页面编辑未被服务端确认期间，外部写入不能静默覆盖本地） ----
        await page.keyboard.press("Escape");
        const canvasBeforeDirty = await readCanvas(canvasA);
        const revisionBeforeDirty = canvasBeforeDirty.revision;
        const nodesBeforeDirty = (await domNodeIds(page)).length;

        // 把画布 PUT 挂起：本地编辑照常进 store，但服务端拿不到，形成真实的「未确认编辑」窗口。
        let heldPut = null;
        await page.route("**/api/canvas-projects/*", async (route) => {
            const request = route.request();
            if (request.method() === "PUT" && !request.url().includes("/generated-assets")) {
                heldPut = route;
                return;    // 故意不 continue：保持未确认
            }
            await route.continue();
        });

        if (await clickByLabel(page, "添加节点")) {
            const textItem = page.getByRole("button", { name: "文本", exact: true }).first();
            if (await textItem.count()) { await textItem.click(); await sleep(2500); }
        }
        await page.keyboard.press("Escape");
        const localOnlyNodes = (await domNodeIds(page)).length;
        const serverWhileLocalDirty = await readCanvas(canvasA);

        // 外部（CLI，另一条入口）在同一画布上写目标字段。
        const externalWhileLocalDirty = runCli(["canvas", "node", "update", "--canvas", canvasA, "--node", target.id, "--expected-revision", String(serverWhileLocalDirty.revision), "--content", "外部在本地未确认期间写入", "--op-id", `e2e-dirty-${stamp}`, "--json"]);
        // 等应用自己发现外部写入（轮询/SSE），看它是否保留本地编辑并给出冲突出口。
        let dirtyNoticeSeen = false;
        let acceptButtonSeen = false;
        const dirtyDeadline = Date.now() + 30_000;
        while (Date.now() < dirtyDeadline) {
            dirtyNoticeSeen = await page.evaluate(() => (document.querySelector("aside")?.innerText || "").includes("画布已在其他入口更新"));
            acceptButtonSeen = await page.getByRole("button", { name: "使用最新版本" }).count() > 0;
            if (dirtyNoticeSeen && acceptButtonSeen) break;
            await sleep(1500);
        }
        const nodesAfterExternal = (await domNodeIds(page)).length;
        const uiTargetAfterExternal = await readPromptInUi(page, target.id, "夜景：雨夜巷口对峙", 20_000);

        steps.dirtyDraft = {
            revisionBeforeDirty,
            nodesBeforeDirty,
            localOnlyNodes,
            serverRevisionWhileHeld: serverWhileLocalDirty.revision,
            externalExit: externalWhileLocalDirty.exit,
            externalReason: externalWhileLocalDirty.json?.reason,
            dirtyNoticeSeen,
            acceptButtonSeen,
            nodesAfterExternal,
            uiTargetValue: uiTargetAfterExternal.value.slice(0, 120),
            uiTargetPanelScoped: uiTargetAfterExternal.dragHandles === 1,
        };
        check("本地未确认编辑期间服务端确实没有拿到这次编辑", serverWhileLocalDirty.revision === revisionBeforeDirty && (serverWhileLocalDirty.nodes || []).length === nodesBeforeDirty - 0, `serverRevision=${serverWhileLocalDirty.revision} localNodes=${localOnlyNodes}`);
        check("外部写入成功进入服务端", externalWhileLocalDirty.exit === 0, `exit=${externalWhileLocalDirty.exit} ${externalWhileLocalDirty.stdout.slice(0, 120)}`);
        check("本地草稿未被外部写入覆盖（节点数保持）", nodesAfterExternal === localOnlyNodes, `${localOnlyNodes} -> ${nodesAfterExternal}`);
        check("界面给出冲突提示与「使用最新版本」出口", dirtyNoticeSeen && acceptButtonSeen, JSON.stringify({ dirtyNoticeSeen, acceptButtonSeen }));
        check("编辑器仍显示本地保留的目标值", uiTargetAfterExternal.value.includes("夜景：雨夜巷口对峙") && uiTargetAfterExternal.dragHandles === 1, uiTargetAfterExternal.value.slice(0, 80));
        await page.screenshot({ path: join(SHOTS, `06-dirty-draft-conflict-${STAMP}.png`) });

        // 放开被挂起的提交：服务端会按 revision 拒绝这次陈旧提交，本地内容必须仍在。
        if (heldPut) { try { await heldPut.continue(); } catch { /* 路由已失效 */ } }
        heldPut = null;
        await sleep(4000);
        const nodesAfterRelease = (await domNodeIds(page)).length;
        const uiAfterRelease = await readPromptInUi(page, target.id, "夜景：雨夜巷口对峙", 20_000);
        steps.dirtyDraft.afterRelease = { nodes: nodesAfterRelease, targetValue: uiAfterRelease.value.slice(0, 120) };
        check("陈旧提交被拒后本地内容仍保留", nodesAfterRelease >= localOnlyNodes && uiAfterRelease.value.includes("夜景：雨夜巷口对峙"), JSON.stringify(steps.dirtyDraft.afterRelease));
        await page.unroute("**/api/canvas-projects/*");

        steps.consoleErrors = consoleErrors;
        steps.failedRequests = failedRequests;
        // 脏草稿场景故意挂起画布 PUT：客户端 4s 超时并记录一条持久化失败是这段测试造成的预期噪声，
        // 单独归类保留，不算产品的非预期运行时报错。
        const expectedDuringDirtyHold = consoleErrors.filter((text) => /画布后端持久化失败/.test(text));
        steps.expectedDuringDirtyHold = expectedDuringDirtyHold;
        const unexpected = consoleErrors.filter((text) => !/antd:|deprecated/i.test(text) && !/画布后端持久化失败/.test(text));
        check("页面没有非预期运行时报错", unexpected.length === 0, unexpected.slice(0, 3).join(" | "));
        check("没有失败的网络请求", failedRequests.length === 0, failedRequests.slice(0, 3).join(" | "));
    } finally {
        steps.canvasA = canvasA;
        await browser.close().catch(() => {});
        stopVite();
    }
}

await main();

const summary = {
    ok: checks.every((item) => item.ok),
    stamp: STAMP,
    api: API,
    webPort: WEB_PORT,
    workspaceRoot: WORKSPACE_ROOT,
    gitHead: spawnSync("git", ["rev-parse", "HEAD"], { cwd: WORKSPACE_ROOT, encoding: "utf8" }).stdout?.trim() || null,
    evidence: { chatResponses, cancelledRequests, consoleErrors, failedRequests, stopClicks: stopClicks.count, expectedDuringDirtyHold: steps.expectedDuringDirtyHold || [] },
    checks,
    steps,
};
summary.rawResultPath = RAW_RESULT_PATH;
const attemptLog = appendAttempt(summary);
summary.attemptLog = attemptLog;
if (!attemptLog.written) {
    // 证据链写入失败必须显式失败：不能让「通过」建立在没落盘的记录上。
    checks.push({ name: "尝试记录落盘", ok: false, detail: attemptLog.error });
    summary.ok = false;
}
const serialized = JSON.stringify(summary, null, 2);
writeFileSync(RAW_RESULT_PATH, serialized);
writeFileSync(RESULT_PATH, serialized);
console.log(`\n本次原始结果 ${RAW_RESULT_PATH}`);
console.log(`结果已写入 ${RESULT_PATH}`);
console.log(`尝试记录 ${attemptLog.written ? "已追加" : `写入失败：${attemptLog.error}`}`);
console.log(`总计 ${checks.filter((item) => item.ok).length}/${checks.length} 通过`);
process.exit(summary.ok ? 0 : 1);
