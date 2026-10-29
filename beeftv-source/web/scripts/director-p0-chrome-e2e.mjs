/**
 * Issue #305 P0 — 真实 Chrome E2E。
 *
 * 无新增依赖：只用 Bun/Node 内置 spawn / fetch / WebSocket / fs。
 * 自己启动 Vite DEV 与 headless Chrome，通过 CDP 驱动 /dev/director-repro。
 * 所有等待都有硬超时；任何断言失败 → exit 1。
 * finally 只终止本脚本记录的 PID，只删除本脚本 mkdtemp 创建的 profile。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";

const CHROME_CANDIDATES = [
    process.env.CHROME_BIN,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter(Boolean);

/** 唯一允许出现的浏览器噪声：精确匹配，其他一律判失败。 */
const ALLOWED_NOISE = ["Warning: [antd: InputNumber] `addonAfter` is deprecated. Please use `Space.Compact` instead.", "Warning: [antd: InputNumber] `addonBefore` is deprecated. Please use `Space.Compact` instead."];

/**
 * 网络与资源失败绝不放行：复现台必须是真正的同源本地确定性场景。
 * 出现 4xx/5xx/ERR_* 一律判失败，由根因修复，而不是扩大 allowlist。
 */

const results = [];
let failures = 0;

function pass(name, detail = "") {
    results.push({ ok: true, name, detail });
    console.log(`PASS  ${name}${detail ? " — " + detail : ""}`);
}

function fail(name, detail = "") {
    results.push({ ok: false, name, detail });
    failures += 1;
    console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`);
}

function assert(condition, name, detail = "") {
    if (condition) pass(name, detail);
    else fail(name, detail);
    return Boolean(condition);
}

function resolveChrome() {
    for (const candidate of CHROME_CANDIDATES) {
        if (candidate && existsSync(candidate)) return candidate;
    }
    throw new Error("No Chrome binary found. Set CHROME_BIN or install google-chrome/chromium. Tried:\n  " + CHROME_CANDIDATES.join("\n  "));
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 启动 Vite DEV，等待 ready 行或 TCP 可连接；超时即抛。 */
async function launchVite(port, apiTarget) {
    const child = spawn("bunx", ["vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
        cwd: process.cwd(),
        env: { ...process.env, VITE_API_PROXY_TARGET: apiTarget },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (d) => {
        log += d.toString();
    });
    child.stderr.on("data", (d) => {
        log += d.toString();
    });

    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Vite exited early (code ${child.exitCode}):\n${log}`);
        try {
            const res = await fetch(`http://127.0.0.1:${port}/dev/director-repro`);
            if (res.ok) return child;
        } catch {
            // not up yet
        }
        await sleep(500);
    }
    throw new Error(`Vite did not become ready within 120s:\n${log}`);
}

async function launchApiFixture() {
    const server = createHttpServer((request, response) => {
        const url = new URL(request.url || "/", "http://127.0.0.1");
        if (request.method === "GET" && url.pathname === "/api/canvas-projects") {
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ code: 0, data: { items: [], total: 0 } }));
            return;
        }
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ code: 404, message: "fixture route not found" }));
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("API fixture did not expose a TCP port");
    return { server, target: `http://127.0.0.1:${address.port}` };
}

async function stopApiFixture(server) {
    if (!server) return;
    await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections?.();
    });
}

/** 启动 headless Chrome 并等待 CDP /json/version；超时即抛。 */
async function launchChrome(chromePath, cdpPort, profileDir) {
    const args = [
        "--headless=new",
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1440,1000",
        // 保留 WebGL：不要 --disable-gpu。SwiftShader 提供确定性软件渲染。
        "--enable-unsafe-swiftshader",
        "--use-angle=swiftshader",
    ];
    if (process.platform === "linux" || process.env.CI) args.push("--no-sandbox", "--disable-dev-shm-usage");
    args.push("about:blank");

    const child = spawn(chromePath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    child.stdout.on("data", (d) => {
        log += d.toString();
    });
    child.stderr.on("data", (d) => {
        log += d.toString();
    });

    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Chrome exited early (code ${child.exitCode}):\n${log}`);
        try {
            const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
            if (res.ok) return child;
        } catch {
            // not up yet
        }
        await sleep(400);
    }
    throw new Error(`Chrome CDP did not become ready within 60s:\n${log}`);
}

/**
 * CDP 客户端：id/pending map + 事件收集。
 * 只放行 ALLOWED_NOISE 精确匹配，其他异常/console error/网络失败全部记入 problems。
 */
async function connectCdp(cdpPort) {
    const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    const target = list.find((t) => t.type === "page");
    if (!target) throw new Error("No CDP page target found");

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("CDP websocket open timeout")), 20000);
        ws.addEventListener(
            "open",
            () => {
                clearTimeout(timer);
                resolve();
            },
            { once: true },
        );
        ws.addEventListener(
            "error",
            (e) => {
                clearTimeout(timer);
                reject(new Error("CDP websocket error: " + String(e?.message || e)));
            },
            { once: true },
        );
    });

    const pending = new Map();
    let nextId = 0;
    const problems = [];
    const record = (kind, text) => {
        const clean = String(text ?? "").trim();
        if (!clean) return;
        if (ALLOWED_NOISE.includes(clean)) return;
        problems.push({ kind, text: clean });
    };

    ws.addEventListener("message", (ev) => {
        let msg;
        try {
            msg = JSON.parse(ev.data);
        } catch {
            return;
        }

        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) reject(new Error(`CDP error: ${JSON.stringify(msg.error)}`));
            else resolve(msg.result);
            return;
        }

        const p = msg.params;
        switch (msg.method) {
            case "Runtime.exceptionThrown":
                record("exception", p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text);
                break;
            case "Log.entryAdded":
                if (p?.entry?.level === "error") record("log.error", p.entry.text);
                break;
            case "Runtime.consoleAPICalled":
                if (p?.type === "error") record("console.error", (p.args || []).map((a) => a.value ?? a.description ?? "").join(" "));
                break;
            case "Network.loadingFailed":
                record("network.failed", `${p?.type || "?"} ${p?.errorText || "?"}`);
                break;
            case "Network.responseReceived":
                if (typeof p?.response?.status === "number" && p.response.status >= 400) {
                    record("network.status", `${p.response.status} ${p.response.url}`);
                }
                break;
            default:
                break;
        }
    });

    const send = (method, params = {}) => {
        const id = ++nextId;
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => {
                if (pending.has(id)) {
                    pending.delete(id);
                    reject(new Error(`CDP timeout: ${method}`));
                }
            }, 30000);
        });
    };

    await send("Runtime.enable");
    await send("Page.enable");
    await send("Log.enable");
    await send("Network.enable");

    const evaluate = async (expression) => {
        const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) {
            throw new Error("evaluate threw: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
        }
        return r.result.value;
    };

    const poll = async (expression, label, timeout = 15000, interval = 250) => {
        const deadline = Date.now() + timeout;
        let last;
        while (Date.now() < deadline) {
            last = await evaluate(expression);
            if (last) return true;
            await sleep(interval);
        }
        console.log(`      (poll timed out after ${timeout}ms: ${label}, last=${JSON.stringify(last)})`);
        return false;
    };

    /**
     * 真实鼠标点击：等待目标中心稳定且位于最上层，再派发 Input.dispatchMouseEvent。
     * 不用 el.click()，因为那是 untrusted 合成事件，拿不到真实 user gesture。
     */
    const clickPoint = async (locatorExpression, label, button = "left") => {
        const readInteractiveBox = () =>
            evaluate(`(() => {
            const el = ${locatorExpression};
            if (!(el instanceof HTMLElement)) return null;
            el.scrollIntoView({ block: "center", inline: "center" });
            // A temporarily stable center is not enough while an ancestor modal
            // is entering: compositor hit testing can still use the previous frame.
            for (let ancestor = el; ancestor; ancestor = ancestor.parentElement) {
                if (ancestor.getAnimations().some((animation) => animation.playState === "running" || animation.pending)) return null;
            }
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            if (rect.width <= 0 || rect.height <= 0 || style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none" || Number(style.opacity) <= 0 || el.matches(":disabled") || el.getAttribute("aria-disabled") === "true") return null;
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
            const hit = document.elementFromPoint(x, y);
            if (!hit || (hit !== el && !el.contains(hit))) return null;
            return { x: Math.round(x), y: Math.round(y) };
        })()`);
        const deadline = Date.now() + 5000;
        let previous = null;
        let box = null;
        while (Date.now() < deadline) {
            const next = await readInteractiveBox();
            if (next && previous && next.x === previous.x && next.y === previous.y) {
                await evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
                const painted = await readInteractiveBox();
                if (painted && painted.x === next.x && painted.y === next.y) {
                    box = painted;
                    break;
                }
                previous = painted;
                await sleep(100);
                continue;
            }
            previous = next;
            await sleep(100);
        }
        if (!box) {
            console.log(`      (click target not interactable: ${label})`);
            return false;
        }
        const point = { x: box.x, y: box.y, button };
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point, buttons: 0 });
        await send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, buttons: button === "right" ? 2 : 1, clickCount: 1 });
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, buttons: 0, clickCount: 1 });
        return true;
    };

    const click = (selector) => clickPoint(`document.querySelector(${JSON.stringify(selector)})`, selector);
    const contextClick = (selector) => clickPoint(`document.querySelector(${JSON.stringify(selector)})`, selector, "right");

    const clickText = (text, tag = "button") =>
        clickPoint(`[...document.querySelectorAll(${JSON.stringify(tag)})].find((element) => (element.textContent || "").trim() === ${JSON.stringify(text)} && element.getClientRects().length > 0)`, `${tag}:text-is(${text})`);

    /** 每个场景都从干净页面开始：诊断缓冲区与 store 都重置。 */
    const navigateFresh = async (url) => {
        // 必须在导航前清空：导航后再清会吞掉 bootstrap 阶段的真实异常。
        problems.length = 0;
        await send("Page.navigate", { url });
        const ok = await poll(`!!document.querySelector('[data-testid="inject-local-model"]')`, "lab mounted", 60000);
        if (!ok) throw new Error("Repro lab did not mount within 60s");
        return true;
    };

    return { send, evaluate, poll, click, contextClick, clickText, navigateFresh, problems, close: () => ws.close() };
}

/**
 * 只终止本脚本记录的子进程：先 SIGTERM，有界等待后才对同一 PID SIGKILL。
 *
 * 被信号杀死的 Node 子进程 exitCode 仍为 null，只有 signalCode 有值，
 * 因此「已停止」必须同时看两者，否则会误判成还在运行并一路等到硬截止。
 */
async function stopExact(child, name) {
    if (!child) return;
    const stopped = () => child.exitCode !== null || child.signalCode !== null;
    if (stopped()) return;

    try {
        child.kill("SIGTERM");
    } catch {
        /* already gone */
    }
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !stopped()) await sleep(200);

    if (!stopped()) {
        try {
            child.kill("SIGKILL");
        } catch {
            /* already gone */
        }
        const hard = Date.now() + 4000;
        while (Date.now() < hard && !stopped()) await sleep(200);
    }

    if (!stopped()) {
        throw new Error(`Failed to stop ${name} (pid=${child.pid}) after SIGTERM and SIGKILL`);
    }
    console.log(`      stopped ${name} (pid=${child.pid}, exit=${child.exitCode}, signal=${child.signalCode})`);
}

/** 场景 A：复现台 + 工作台基础集成链路（AutoKey 默认、新增、Undo）。 */
async function smokeWorkbench(cdp, baseUrl) {
    console.log("\n=== A. workbench smoke ===");
    await cdp.navigateFresh(`${baseUrl}/dev/director-repro`);

    const initial = await cdp.evaluate(`(() => {
        const headings = [...document.querySelectorAll('h2')].map((h) => h.textContent || "");
        return {
            snapshot: headings.some((t) => t.includes('环境快照')),
            matrix15: headings.some((t) => t.includes('P0 手工复现矩阵（15）')),
            injectLocal: !!document.querySelector('[data-testid="inject-local-model"]'),
            injectMissing: !!document.querySelector('[data-testid="inject-missing-model"]'),
            shellCount: document.querySelectorAll('.director-viewport-shell').length,
        };
    })()`);
    assert(initial.snapshot, "A1 环境快照 rendered");
    assert(initial.matrix15, "A2 P0 手工复现矩阵（15）rendered");
    assert(initial.injectLocal && initial.injectMissing, "A3 both inject buttons present");
    assert(initial.shellCount === 0, "A4 workbench closed initially", `shellCount=${initial.shellCount}`);

    const opened = await cdp.click('[data-testid="toggle-workbench"]');
    if (!opened) throw new Error("A: toggle-workbench not clickable");
    const hasCanvas = await cdp.poll(`(() => { const c = document.querySelector('.director-viewport-shell canvas'); return !!c && c.clientWidth > 0; })()`, "canvas", 40000);
    assert(hasCanvas, "A5 real canvas present in viewport shell");

    // P1-A 起 AutoKey/时间轴归属动画模式：默认摆场模式下它们必须不存在。
    const layoutGating = await cdp.evaluate(`(() => ({
        mode: document.querySelector('[data-director-mode]')?.getAttribute('data-director-mode') ?? null,
        sequencer: document.querySelectorAll('.director-sequencer').length,
        autoKey: document.querySelectorAll('button[aria-label="自动帧"]').length,
    }))()`);
    assert(layoutGating.mode === "layout", "A6 默认进入摆场模式", `got ${JSON.stringify(layoutGating.mode)}`);
    assert(layoutGating.sequencer === 0 && layoutGating.autoKey === 0, "A7 摆场模式不显示时间轴与 AutoKey", JSON.stringify(layoutGating));

    // 原 A6 的断言意图（AutoKey 默认不开启）在它真正存在的模式里继续守住。
    const switched = await cdp.click('[aria-label="动画时间轴"]');
    if (!switched) throw new Error("A: 动画时间轴按钮 not clickable");
    const sequencerShown = await cdp.poll(`document.querySelectorAll('.director-sequencer').length === 1`, "sequencer in animate mode", 20000);
    assert(sequencerShown, "A8 动画模式显示时间轴");

    const autoKey = await cdp.evaluate(`document.querySelector('button[aria-label="自动帧"]')?.getAttribute('aria-pressed') ?? null`);
    assert(autoKey === "false", "A9 AutoKey defaults to aria-pressed=false", `got ${JSON.stringify(autoKey)}`);

    const addedCube = await addCube(cdp);
    if (!addedCube) throw new Error("A: 添加立方体 button not clickable");
    const cubeAppeared = await cdp.poll(`!!document.querySelector('[data-director-row-label="立方体"]')`, "cube row", 20000);
    assert(cubeAppeared, "A10 added cube appears in object list");

    const undone = await undo(cdp);
    if (!undone) throw new Error("A: 撤销 button not clickable");
    const cubeGone = await cdp.poll(`!document.querySelector('[data-director-row-label="立方体"]')`, "cube removed by undo", 20000);
    assert(cubeGone, "A11 Undo removes the added cube");

    // 场景结束前必须真实关闭：下一个场景要重新导航，不能靠忽略 beforeunload 绕过未保存态。
    const closed = await cdp.click('[aria-label="关闭导演台"]');
    if (!closed) throw new Error("A: 关闭导演台 button not clickable");
    const shellGone = await cdp.poll(`document.querySelectorAll('.director-viewport-shell').length === 0`, "workbench closed", 30000);
    assert(shellGone, "A12 workbench closed cleanly before leaving scenario A");

    assert(cdp.problems.length === 0, "A13 no browser problems in scenario A", JSON.stringify(cdp.problems));
}

/**
 * 场景 B：本地 triangle glTF。
 * 判据是集成层面的稳定窗口：5s 内不出现任何失败态且 canvas 持续可用。
 * 名称出现只证明对象在场景里，不等于 loader ready，因此不作为 ready 断言。
 */
async function localModel(cdp, baseUrl) {
    console.log("\n=== B. local triangle model ===");
    await cdp.navigateFresh(`${baseUrl}/dev/director-repro`);

    const injected = await cdp.click('[data-testid="inject-local-model"]');
    if (!injected) throw new Error("B: inject-local-model not clickable");
    const counted = await cdp.poll(`(document.querySelector('[data-testid="object-count"]')?.textContent || "").includes('4')`, "object count 4", 15000);
    assert(counted, "B1 local model injected into scene");

    const opened = await cdp.click('[data-testid="toggle-workbench"]');
    if (!opened) throw new Error("B: toggle-workbench not clickable");

    await cdp.click('[aria-label="场景"]');
    const rowReady = await cdp.poll(`!!document.querySelector('[data-director-row-label="本地模型 repro triangle"]')`, "model row", 30000);
    assert(rowReady, "B2 local model row present in object list");
    const hasCanvas = await cdp.poll(`(() => { const c = document.querySelector('.director-viewport-shell canvas'); return !!c && c.clientWidth > 0; })()`, "canvas", 40000);
    assert(hasCanvas, "B3 real canvas present");

    await sleep(5000);

    const stable = await cdp.evaluate(`(() => {
        const t = document.body.innerText || "";
        const c = document.querySelector('.director-viewport-shell canvas');
        return {
            modelFailed: t.includes('个 3D 模型加载失败'),
            retryLoad: [...document.querySelectorAll('.director-viewport-notice button')].some((b) => (b.textContent || "").includes('重试加载') && b.getClientRects().length > 0),
            renderFailed: t.includes('3D 视口渲染失败'),
            contextLost: t.includes('3D 显示上下文已丢失'),
            canvasUsable: !!c && c.clientWidth > 0 && c.clientHeight > 0,
        };
    })()`);
    assert(!stable.modelFailed, "B4 no model-load-failed notice", JSON.stringify(stable));
    assert(!stable.retryLoad, "B5 no retry-load affordance");
    assert(!stable.renderFailed, "B6 no viewport render failure");
    assert(!stable.contextLost, "B7 no WebGL context-lost notice");
    assert(stable.canvasUsable, "B8 5s 稳定窗口内无失败且 canvas 持续可用");

    assert(cdp.problems.length === 0, "B9 no browser problems in scenario B", JSON.stringify(cdp.problems));
}

/**
 * 场景 C：缺失模型失败 → 用户重试 → 第二轮失败。
 * 通过「提示消失再重新出现」证明重试真的重跑了加载，而不是命中陈旧提示。
 */
async function missingRetry(cdp, baseUrl) {
    console.log("\n=== C. missing model failure and retry ===");
    await cdp.navigateFresh(`${baseUrl}/dev/director-repro`);

    const injected = await cdp.click('[data-testid="inject-missing-model"]');
    if (!injected) throw new Error("C: inject-missing-model not clickable");
    const counted = await cdp.poll(`(document.querySelector('[data-testid="object-count"]')?.textContent || "").includes('4')`, "object count 4", 15000);
    assert(counted, "C1 missing model injected into scene");

    const opened = await cdp.click('[data-testid="toggle-workbench"]');
    if (!opened) throw new Error("C: toggle-workbench not clickable");

    const failed = await cdp.poll(`/个 3D 模型加载失败/.test(document.body.innerText || "")`, "load-failed notice", 40000);
    assert(failed, "C2 model-load-failed notice appears");
    const retryVisible = await cdp.poll(`[...document.querySelectorAll('button')].some((b) => (b.textContent || "").includes('重试加载'))`, "retry affordance", 20000);
    assert(retryVisible, "C3 actionable 重试加载 affordance present");

    const clickedRetry = await cdp.clickText("重试加载");
    if (!clickedRetry) throw new Error("C: 重试加载 button not clickable");

    const noticeCleared = await cdp.poll(`!/个 3D 模型加载失败/.test(document.body.innerText || "")`, "notice cleared after retry", 20000);
    assert(noticeCleared, "C4 notice clears when retry restarts the load");
    const failedAgain = await cdp.poll(`/个 3D 模型加载失败/.test(document.body.innerText || "")`, "second-round failure", 40000);
    assert(failedAgain, "C5 second-round failure after retry");

    const closed = await cdp.click('[aria-label="关闭导演台"]');
    if (!closed) throw new Error("C: 关闭导演台 button not clickable");
    const shellGone = await cdp.poll(`document.querySelectorAll('.director-viewport-shell').length === 0`, "workbench closed", 20000);
    assert(shellGone, "C6 workbench closed cleanly");

    const refreshed = await cdp.click('[data-testid="refresh-events"]');
    if (!refreshed) throw new Error("C: refresh-events not clickable");

    const hasRetryCode = await cdp.poll(`(document.body.innerText || "").includes('DIRECTOR_MODEL_LOAD_RETRY')`, "retry diagnostic", 20000);
    assert(hasRetryCode, "C7 DIRECTOR_MODEL_LOAD_RETRY recorded");
    const twoFailures = await cdp.poll(`((document.body.innerText || "").match(/DIRECTOR_MODEL_LOAD_FAILED/g) || []).length >= 2`, "two load failures", 20000);
    const failCount = await cdp.evaluate(`((document.body.innerText || "").match(/DIRECTOR_MODEL_LOAD_FAILED/g) || []).length`);
    assert(twoFailures, "C8 DIRECTOR_MODEL_LOAD_FAILED recorded at least twice", `count=${failCount}`);

    assert(cdp.problems.length === 0, "C9 no browser problems in scenario C", JSON.stringify(cdp.problems));
}

/**
 * 场景 D：加载中删除。
 * 用真实网络节流把 GLB 拉长到仍在飞行中，再立刻删除对象；
 * 恢复网络后必须没有晚到回流，也不能为已删除对象记任何失败诊断。
 */
async function deleteWhileLoading(cdp, baseUrl) {
    console.log("\n=== D. delete while loading (throttled) ===");
    await cdp.navigateFresh(`${baseUrl}/dev/director-repro`);

    try {
        await cdp.send("Network.emulateNetworkConditions", {
            offline: false,
            latency: 3000,
            downloadThroughput: 20000,
            uploadThroughput: 20000,
            connectionType: "cellular3g",
        });

        const injected = await cdp.click('[data-testid="inject-local-model"]');
        if (!injected) throw new Error("D: inject-local-model not clickable");
        const opened = await cdp.click('[data-testid="toggle-workbench"]');
        if (!opened) throw new Error("D: toggle-workbench not clickable");

        await cdp.click('[aria-label="场景"]');
        const rowReady = await cdp.poll(`!!document.querySelector('[data-director-row-label="本地模型 repro triangle"]')`, "model row", 30000);
        assert(rowReady, "D1 model row present while load still in flight");

        const deleted = await deleteSceneRow(cdp, "本地模型 repro triangle");
        if (!deleted) throw new Error("D: delete button not clickable");
        const gone = await cdp.poll(`!(document.body.innerText || "").includes('本地模型 repro triangle')`, "name removed", 20000);
        assert(gone, "D2 object removed while its load was in flight");
    } finally {
        await cdp.send("Network.emulateNetworkConditions", {
            offline: false,
            latency: 0,
            downloadThroughput: -1,
            uploadThroughput: -1,
        });
    }

    await sleep(5000);

    const settled = await cdp.evaluate(`(() => {
        const t = document.body.innerText || "";
        const c = document.querySelector('.director-viewport-shell canvas');
        return {
            nameBack: t.includes('本地模型 repro triangle'),
            modelFailed: t.includes('个 3D 模型加载失败'),
            retryLoad: [...document.querySelectorAll('.director-viewport-notice button')].some((b) => (b.textContent || "").includes('重试加载') && b.getClientRects().length > 0),
            renderFailed: t.includes('3D 视口渲染失败'),
            contextLost: t.includes('3D 显示上下文已丢失'),
            canvasUsable: !!c && c.clientWidth > 0 && c.clientHeight > 0,
        };
    })()`);
    assert(!settled.nameBack, "D3 no late-arriving reflow of the deleted object", JSON.stringify(settled));
    assert(!settled.modelFailed && !settled.retryLoad, "D4 no failure/retry surfaced for deleted object");
    assert(!settled.renderFailed && !settled.contextLost, "D5 viewport stayed healthy");
    assert(settled.canvasUsable, "D6 canvas still usable after in-flight delete");

    const closed = await cdp.click('[aria-label="关闭导演台"]');
    if (!closed) throw new Error("D: 关闭导演台 button not clickable");
    const shellGone = await cdp.poll(`document.querySelectorAll('.director-viewport-shell').length === 0`, "workbench closed", 20000);
    assert(shellGone, "D7 workbench closed cleanly");

    const refreshed = await cdp.click('[data-testid="refresh-events"]');
    if (!refreshed) throw new Error("D: refresh-events not clickable");
    await sleep(600);

    const localDiag = await cdp.evaluate(`(() => [...document.querySelectorAll('.ant-table-tbody tr.ant-table-row')]
        .map((r) => [...r.querySelectorAll('td')].map((td) => td.innerText).join(" "))
        .filter((row) => row.includes('repro-model-local') && (row.includes('DIRECTOR_MODEL_LOAD_FAILED') || row.includes('DIRECTOR_MODEL_ADOPT_FAILED'))))()`);
    assert(localDiag.length === 0, "D8 no LOAD_FAILED/ADOPT_FAILED for the deleted object", JSON.stringify(localDiag));

    assert(cdp.problems.length === 0, "D9 no browser problems in scenario D", JSON.stringify(cdp.problems));
}

/**
 * 场景 E：真实 WebGL 上下文丢失与恢复。
 * 用 WEBGL_lose_context 扩展驱动真实 GPU 事件，不伪造 DOM 状态。
 */
async function webglLossRestore(cdp, baseUrl) {
    console.log("\n=== E. WebGL context lost and restored ===");
    await cdp.navigateFresh(`${baseUrl}/dev/director-repro`);

    const opened = await cdp.click('[data-testid="toggle-workbench"]');
    if (!opened) throw new Error("E: toggle-workbench not clickable");
    const hasCanvas = await cdp.poll(`(() => { const c = document.querySelector('.director-viewport-shell canvas'); return !!c && c.clientWidth > 0; })()`, "canvas", 40000);
    assert(hasCanvas, "E1 real canvas present before context loss");

    // 真实就绪门：capture context 已登记且未 lost，说明监听器已安装。
    // 早于此触发 loseContext 会让事件落在监听器安装之前。
    const rendererReady = await cdp.poll(`document.querySelector('.director-viewport-shell')?.getAttribute('data-renderer-ready') === 'true'`, "renderer ready", 30000);
    assert(rendererReady, "E2 capture renderer registered before context loss");

    const prepared = await cdp.evaluate(`(() => {
        const canvas = document.querySelector('.director-viewport-shell canvas');
        if (!canvas) return false;
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        if (!gl) return false;
        const ext = gl.getExtension('WEBGL_lose_context');
        if (!ext || typeof ext.loseContext !== 'function' || typeof ext.restoreContext !== 'function') return false;
        window.__directorE2ELoseContext = ext;
        return true;
    })()`);
    if (!prepared) throw new Error("E: WEBGL_lose_context extension unavailable — cannot drive a real context loss");
    assert(prepared, "E3 WEBGL_lose_context extension acquired from live context");

    await cdp.evaluate(`(() => { window.__directorE2ELoseContext.loseContext(); return true; })()`);
    const lostNotice = await cdp.poll(`(document.body.innerText || "").includes('3D 显示上下文已丢失')`, "context-lost notice", 30000);
    assert(lostNotice, "E4 context-lost notice surfaced in DOM");

    await cdp.evaluate(`(() => { window.__directorE2ELoseContext.restoreContext(); return true; })()`);
    const restored = await cdp.poll(`!(document.body.innerText || "").includes('3D 显示上下文已丢失')`, "context-lost notice cleared", 30000);
    assert(restored, "E5 context-lost notice cleared after restore");
    const canvasUsable = await cdp.poll(`(() => { const c = document.querySelector('.director-viewport-shell canvas'); return !!c && c.clientWidth > 0 && c.clientHeight > 0; })()`, "canvas usable after restore", 20000);
    assert(canvasUsable, "E6 canvas remains usable after restore");

    const closed = await cdp.click('[aria-label="关闭导演台"]');
    if (!closed) throw new Error("E: 关闭导演台 button not clickable");
    const shellGone = await cdp.poll(`document.querySelectorAll('.director-viewport-shell').length === 0`, "workbench closed", 20000);
    assert(shellGone, "E7 workbench closed cleanly");

    const refreshed = await cdp.click('[data-testid="refresh-events"]');
    if (!refreshed) throw new Error("E: refresh-events not clickable");
    const hasLost = await cdp.poll(`(document.body.innerText || "").includes('DIRECTOR_VIEWPORT_CONTEXT_LOST')`, "lost diagnostic", 20000);
    assert(hasLost, "E8 DIRECTOR_VIEWPORT_CONTEXT_LOST recorded");
    const hasRestored = await cdp.poll(`(document.body.innerText || "").includes('DIRECTOR_VIEWPORT_CONTEXT_RESTORED')`, "restored diagnostic", 20000);
    assert(hasRestored, "E9 DIRECTOR_VIEWPORT_CONTEXT_RESTORED recorded");

    assert(cdp.problems.length === 0, "E10 no browser problems in scenario E", JSON.stringify(cdp.problems));
}

/**
 * 场景 F：强制保存失败 → 头部错误态与重试入口 → 关闭走确认保护。
 * 选择「留在导演台」后 workbench 必须仍然存在（onClose 不得被调用）。
 */
async function saveFailureCloseGuard(cdp, baseUrl) {
    console.log("\n=== F. save failure and close guard ===");
    await cdp.navigateFresh(`${baseUrl}/dev/director-repro`);

    const toggledFailure = await cdp.click('[data-testid="force-save-failure"]');
    if (!toggledFailure) throw new Error("F: force-save-failure switch not clickable");
    const failureOn = await cdp.poll(`document.querySelector('[data-testid="force-save-failure"]')?.getAttribute('aria-checked') === 'true'`, "failure switch on", 15000);
    assert(failureOn, "F1 forced save failure enabled");

    const opened = await cdp.click('[data-testid="toggle-workbench"]');
    if (!opened) throw new Error("F: toggle-workbench not clickable");
    const hasCanvas = await cdp.poll(`(() => { const c = document.querySelector('.director-viewport-shell canvas'); return !!c && c.clientWidth > 0; })()`, "canvas", 40000);
    assert(hasCanvas, "F2 workbench open with real canvas");

    // canonical 改动：dock 新增立方体会走 commit → coordinator.edit → flush（被强制失败）。
    const addedCube = await addCube(cdp);
    if (!addedCube) throw new Error("F: 添加立方体 button not clickable");

    const errorState = await cdp.poll(`(document.body.innerText || "").includes('保存失败')`, "save failure header", 40000);
    assert(errorState, "F3 header surfaces 保存失败 after forced flush failure");
    await cdp.contextClick('.director-viewport-dock button[aria-haspopup="menu"]');
    const retryVisible = await cdp.poll(`[...document.querySelectorAll('[role="menuitem"]')].some((b) => b.getClientRects().length > 0 && (b.textContent || "").includes('重试保存') && b.getAttribute('aria-disabled') !== 'true')`, "retry save affordance", 20000);
    assert(retryVisible, "F4 actionable 重试保存 affordance present");
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });

    const closeClicked = await cdp.click('[aria-label="关闭导演台"]');
    if (!closeClicked) throw new Error("F: 关闭导演台 button not clickable");

    const modalShown = await cdp.poll(`!!document.querySelector('.ant-modal-confirm') && (document.body.innerText || "").includes('留在导演台')`, "close confirm modal", 40000);
    assert(modalShown, "F5 close is guarded by a confirm dialog, not silent exit");

    await cdp.evaluate(`(() => {
        window.__directorCancelEvents = [];
        for (const type of ['pointerdown', 'pointerup', 'click']) document.addEventListener(type, (event) => {
            const button = event.target instanceof Element ? event.target.closest('button') : null;
            window.__directorCancelEvents.push({ type, trusted: event.isTrusted, button: (button?.textContent || '').trim(), target: event.target instanceof Element ? event.target.tagName : '', x: event.clientX, y: event.clientY });
        }, true);
        return true;
    })()`);
    const stayClicked = await cdp.click(".ant-modal-confirm .ant-modal-confirm-btns button:first-child");
    if (!stayClicked) throw new Error("F: 留在导演台 button not clickable");
    const cancelEvents = await cdp.evaluate(`window.__directorCancelEvents`);
    assert(
        cancelEvents.some((event) => event.type === "click" && event.trusted && event.button === "留在导演台"),
        "F6a trusted click reaches stay button",
        JSON.stringify(cancelEvents),
    );
    const modalGone = await cdp.poll(
        `![...document.querySelectorAll('.ant-modal-confirm')].some((modal) => {
            const rect = modal.getBoundingClientRect();
            const style = getComputedStyle(modal);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
        })`,
        "modal dismissed",
        20000,
    );
    const remainingModals = modalGone
        ? []
        : await cdp.evaluate(`({ events: window.__directorCancelEvents, modals: [
        ...document.querySelectorAll('.ant-modal-confirm')
    ].map((modal) => ({ text: (modal.innerText || '').slice(0, 300), className: modal.className, opacity: getComputedStyle(modal).opacity })) })`);
    assert(modalGone, "F6 confirm dialog dismissed after choosing 留在导演台", JSON.stringify(remainingModals));

    await sleep(1000);
    const stillOpen = await cdp.evaluate(`document.querySelectorAll('.director-viewport-shell').length`);
    assert(stillOpen === 1, "F7 workbench remains open after choosing 留在导演台", `shellCount=${stillOpen}`);

    assert(cdp.problems.length === 0, "F8 no browser problems in scenario F", JSON.stringify(cdp.problems));
}

/** A delayed image decode exercises the real upload and screenshot callbacks after unmount. */
async function delayedMediaAfterClose(cdp, baseUrl) {
    console.log("\n=== G. delayed media must not overwrite a reopened scene ===");
    for (const kind of ["panorama", "screenshot", "reference"]) {
        await cdp.navigateFresh(`${baseUrl}/dev/director-repro`);
        await cdp.click('[data-testid="toggle-workbench"]');
        await cdp.poll(`document.querySelector('.director-viewport-shell')?.dataset.rendererReady === 'true'`, "renderer ready", 40000);
        await cdp.evaluate(`(() => {
            const Original = window.Image;
            const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
            window.__delayedMedia = [];
            window.__restoreMedia = () => { window.Image = Original; };
            window.Image = function(...args) {
                const image = new Original(...args);
                Object.defineProperty(image, 'src', {
                    get() { return descriptor.get.call(image); },
                    set(url) { window.__delayedMedia.push(() => descriptor.set.call(image, url)); }
                });
                return image;
            };
        })()`);
        if (kind === "screenshot") await cdp.click('[aria-label="截图"]');
        else await cdp.evaluate(`(() => {
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8;
            canvas.toBlob((blob) => {
                const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'delayed.png', {type:'image/png'}));
                const input = document.querySelector(${JSON.stringify(kind === "reference" ? '[data-testid="director-reference-input"]' : 'input[accept="image/*"]')});
                input.files = transfer.files; input.dispatchEvent(new Event('change', {bubbles:true}));
            });
        })()`);
        assert(await cdp.poll(`window.__delayedMedia.length === 1`, "upload waiting", 10000), `G ${kind}: upload is in flight`);
        await cdp.click('[aria-label="关闭导演台"]');
        await cdp.poll(`!document.querySelector('.director-viewport-shell')`, "closed", 15000);
        await cdp.click('[data-testid="toggle-workbench"]');
        await cdp.poll(`document.querySelector('.director-viewport-shell')?.dataset.rendererReady === 'true'`, "reopened", 40000);
        await addCube(cdp);
        const count = `document.querySelector('[data-testid="object-count"]')?.textContent.replace(/\\s/g,'')`;
        assert(await cdp.poll(`${count} === '对象数4'`, "new edit", 10000), `G ${kind}: reopened scene has new edit`);
        await cdp.evaluate(`window.__restoreMedia(); window.__delayedMedia.forEach(release => release());`);
        await sleep(1500);
        assert(await cdp.evaluate(`${count} === '对象数4'`), `G ${kind}: late completion preserves canonical scene`);
        assert(cdp.problems.length === 0, `G ${kind}: no browser problems`, JSON.stringify(cdp.problems));
    }
}

async function addCube(cdp) {
    if (!await cdp.click('[aria-label="场景"]')) return false;
    if (!await cdp.click('[aria-label="添加场景对象"]')) return false;
    return cdp.clickText("立方体", '[role="menuitem"]');
}

async function multiScaleGesture(cdp, baseUrl) {
    console.log("\n=== H. multi-scale gesture uses one baseline ===");
    await cdp.navigateFresh(`${baseUrl}/dev/director-repro`);
    await cdp.click('[data-testid="toggle-workbench"]');
    await cdp.click('[aria-label="场景"]');
    await cdp.click('[data-director-row-label="立方体 A"] > button');
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Shift", code: "ShiftLeft", modifiers: 8 });
    // Multi-selection belongs to the row's click handler; pass the held modifier to the pointer events.
    const box = await cdp.evaluate(`(() => { const r = document.querySelector('[data-director-row-label="球体 B"] > button').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...box, button: "left", buttons: 1, clickCount: 1, modifiers: 8 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...box, button: "left", buttons: 0, clickCount: 1, modifiers: 8 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft" });
    assert(await cdp.poll(`!!document.querySelector('[aria-label="多选统一缩放滑杆"]')`, "multi inspector"), "H1 two objects selected");
    const setScale = (value) => cdp.evaluate(`(() => { const input = document.querySelector('[aria-label="多选统一缩放滑杆"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input, ${value}); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await setScale(1.1);
    await setScale(1.2);
    assert(await cdp.evaluate(`Number(document.querySelector('[aria-label="多选统一缩放滑杆"]').value) === 1.2`), "H2 consecutive input 1.1 -> 1.2 does not compound");
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
    await cdp.click('[data-director-row-label="球体 B"] > button');
    assert(await cdp.poll(`Number(document.querySelector('[aria-label="统一缩放滑杆"]')?.value) === 1`, "cancelled scale"), "H3 Escape cancels entire scale gesture");
    assert(cdp.problems.length === 0, "H4 no browser problems", JSON.stringify(cdp.problems));
}

async function legacyCoverRecovery(cdp, baseUrl) {
    console.log("\n=== I. legacy preview storage survives reload ===");
    await cdp.navigateFresh(`${baseUrl}/dev/director-repro`);
    await cdp.evaluate(`(async () => {
        const {setImageBlob} = await import('/src/services/image-storage.ts');
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8;
        const blob = await new Promise(resolve => canvas.toBlob(resolve));
        await setImageBlob('image:director-e2e-legacy-cover', blob);
    })()`);
    await cdp.navigateFresh(`${baseUrl}/dev/director-repro`);
    await cdp.evaluate(`(async () => {
        const {default: React} = await import('/node_modules/.vite/deps/react.js');
        const {default: {createRoot}} = await import('/node_modules/.vite/deps/react-dom_client.js');
        const {CanvasDirectorNodePanel} = await import('/src/components/canvas/director/canvas-director-node-panel.tsx');
        const {createDirectorReproScene} = await import('/src/lib/canvas/director/director-repro-fixture.ts');
        const host = document.createElement('div'); host.id = 'legacy-cover-fixture'; document.body.append(host);
        const scene = createDirectorReproScene(); scene.shots[0].previewNodeId = 'legacy-image';
        createRoot(host).render(React.createElement(CanvasDirectorNodePanel, {
            node: {id:'legacy-director',type:'director',title:'旧导演台',position:{x:0,y:0},width:640,height:640,metadata:{directorSceneId:scene.id}},
            scene, readNodeContent:()=>undefined, readNodeStorageKey:(id)=>id==='legacy-image'?'image:director-e2e-legacy-cover':undefined, onOpen:()=>{}
        }));
    })()`);
    assert(await cdp.poll(`document.querySelector('#legacy-cover-fixture img')?.naturalWidth === 8`, "durable legacy cover"), "I1 legacy shot preview resolves durable blob after reload");
    assert(cdp.problems.length === 0, "I2 no browser problems", JSON.stringify(cdp.problems));
}

async function recordingSessionCleanup(cdp, baseUrl) {
    console.log("\n=== J. closing an export returns playback ownership ===");
    await cdp.navigateFresh(`${baseUrl}/dev/director-repro`);
    await cdp.click('[data-testid="toggle-workbench"]');
    await cdp.poll(`document.querySelector('.director-viewport-shell')?.dataset.rendererReady === 'true'`, "renderer ready", 40000);
    await cdp.evaluate(`(async () => {
        window.__playback = (await import('/src/stores/canvas/use-director-workbench-store.ts')).useDirectorWorkbenchStore;
        window.__playback.getState().setPlayhead(1.5);
        window.__playback.getState().setPlaying(false);
        window.__playback.getState().setViewMode('free');
    })()`);
    await cdp.contextClick('.director-viewport-dock button[aria-haspopup="menu"]');
    assert(await cdp.clickText("导出白膜视频", '[role="menuitem"]'), "J1 starts export from real menu");
    assert(await cdp.poll(`window.__playback.getState().playing === true`, "recording started", 20000), "J2 recording takes playback control");
    await cdp.click('[aria-label="关闭导演台"]');
    assert(await cdp.poll(`!document.querySelector('.director-viewport-shell')`, "closed export"), "J3 closes while recording");
    assert(await cdp.evaluate(`(() => { const s = window.__playback.getState(); return !s.playing && s.playhead === 1.5 && s.viewMode === 'free'; })()`), "J4 abort immediately restores pre-export playback");
    await cdp.click('[data-testid="toggle-workbench"]');
    await cdp.poll(`document.querySelector('.director-viewport-shell')?.dataset.rendererReady === 'true'`, "reopened", 40000);
    await cdp.evaluate(`window.__playback.getState().setPlayhead(2.5)`);
    await sleep(6500);
    assert(await cdp.evaluate(`window.__playback.getState().playhead === 2.5 && !window.__playback.getState().playing`), "J5 late export completion preserves the new session playhead");
    assert(cdp.problems.length === 0, "J6 no browser problems", JSON.stringify(cdp.problems));
}

async function undo(cdp) {
    const modifiers = await cdp.evaluate('navigator.platform.includes("Mac") ? 4 : 2');
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "z", code: "KeyZ", modifiers });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "z", code: "KeyZ", modifiers });
    return true;
}

async function deleteSceneRow(cdp, label) {
    if (!await cdp.click(`[data-director-row-label="${label}"] > button`)) return false;
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
    return true;
}

async function main() {
    const chromePath = resolveChrome();
    console.log(`Chrome binary: ${chromePath}`);

    const vitePort = await freePort();
    const cdpPort = await freePort();
    const baseUrl = `http://127.0.0.1:${vitePort}`;
    const profileDir = mkdtempSync(join(tmpdir(), "director-p0-e2e-"));

    let vite = null;
    let chrome = null;
    let cdp = null;
    let apiFixture = null;

    try {
        apiFixture = await launchApiFixture();
        console.log(`API fixture listening on ${apiFixture.target}`);
        console.log(`Starting Vite on ${baseUrl} ...`);
        vite = await launchVite(vitePort, apiFixture.target);
        console.log(`      vite pid=${vite.pid}`);

        console.log(`Starting Chrome with CDP on 127.0.0.1:${cdpPort} ...`);
        chrome = await launchChrome(chromePath, cdpPort, profileDir);
        console.log(`      chrome pid=${chrome.pid}, profile=${profileDir}`);

        cdp = await connectCdp(cdpPort);
        console.log("      CDP connected (Runtime, Page, Log, Network enabled)");

        const scenarios = [smokeWorkbench, localModel, missingRetry, deleteWhileLoading, webglLossRestore, delayedMediaAfterClose, multiScaleGesture, legacyCoverRecovery, recordingSessionCleanup, saveFailureCloseGuard];
        const selected = process.env.DIRECTOR_E2E_SCENARIO;
        if (selected && !scenarios.some((scenario) => scenario.name === selected)) throw new Error(`Unknown scenario: ${selected}`);
        for (const scenario of scenarios.filter((scenario) => !selected || scenario.name === selected)) {
            try {
                await scenario(cdp, baseUrl);
            } catch (error) {
                fail(`${scenario.name} threw`, String(error?.message || error));
            }
        }
    } finally {
        try {
            cdp?.close();
        } catch {
            /* socket already closed */
        }
        // 三个清理步骤互不阻塞：任一失败都记为断言失败（最终 exit 1），但不吞掉其余清理。
        try {
            await stopExact(chrome, "chrome");
        } catch (error) {
            fail("cleanup: stop chrome", String(error?.message || error));
        }
        try {
            await stopExact(vite, "vite");
        } catch (error) {
            fail("cleanup: stop vite", String(error?.message || error));
        }
        try {
            await stopApiFixture(apiFixture?.server);
        } catch (error) {
            fail("cleanup: stop API fixture", String(error?.message || error));
        }
        try {
            rmSync(profileDir, { recursive: true, force: true });
            console.log(`      removed profile ${profileDir}`);
        } catch (error) {
            fail("cleanup: remove profile", `${profileDir}: ${String(error?.message || error)}`);
        }
    }

    const passed = results.filter((r) => r.ok).length;
    console.log("\n================ SUMMARY ================");
    console.log(`assertions: ${passed} passed, ${failures} failed, ${results.length} total`);
    for (const r of results.filter((x) => !x.ok)) console.log(`  FAILED: ${r.name}${r.detail ? " — " + r.detail : ""}`);
    console.log("=========================================");

    if (failures > 0) {
        console.error(`\nDirector P0 Chrome E2E FAILED (${failures} assertion(s)).`);
        process.exit(1);
    }
    console.log("\nDirector P0 Chrome E2E PASSED.");
}

main().catch((error) => {
    console.error("\nDirector P0 Chrome E2E crashed:", error?.stack || error);
    process.exit(1);
});
