/**
 * 内置创作助手 — 零模型验收（真实浏览器 + 真实 CLI，不调用任何模型）。
 *
 * 覆盖不需要模型的确定性链路，供每次改动脚本/前端后快速回归：
 * - 脚本路径解析不硬编码个人工作树；
 * - CLI 改目标镜头 → 真实编辑器 composer 显示新值（面板作用域 + 换选节点交叉证明）；
 * - 手工新增 → 撤销不会倒退外部刚写入的字段，也不改动连线。
 *
 * 用法：bun scripts/agent-product-zero-model-check.mjs
 * 产物：.local/agent-product/results-zero-model-<stamp>.json 与截图。
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(SCRIPT_DIR, "..");
const WS = resolve(process.env.BEEFTV_WORKSPACE || join(WEB_ROOT, ".."));
const APD = resolve(process.env.BEEFTV_AGENT_PRODUCT_DIR || join(WS, ".local/agent-product"));
const API = process.env.AGENT_E2E_API || "http://127.0.0.1:18090/api";
const WEB_PORT = Number(process.env.AGENT_E2E_WEB_PORT || 18400);
const OWNER = readFileSync(join(APD, "data/agent_owner_token"), "utf8").trim();
const CLI = process.env.BEEFTV_CLI || join(APD, "beeftv");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 300) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };
async function api(method, path, body) { const res = await fetch(API + path, { method, headers: { "Content-Type": "application/json", "X-Beeftv-Owner": OWNER }, body: body ? JSON.stringify(body) : undefined }); return await res.json().catch(() => null); }

// 1) 路径解析（脚本不硬编码工作树路径）
const scriptSource = readFileSync(join(WEB_ROOT, "scripts/agent-product-browser-e2e.mjs"), "utf8");
const srcSource = readFileSync(fileURLToPath(import.meta.url), "utf8");
check("脚本不含硬编码个人工作树路径", !scriptSource.includes("/Volumes/"), "读取 scripts/agent-product-browser-e2e.mjs");
const srcConfig = srcSource.slice(0, srcSource.indexOf("const sleep ="));
check("零模型脚本同样从自身位置推导路径", srcConfig.includes("fileURLToPath(import.meta.url)") && srcConfig.includes("BEEFTV_WORKSPACE") && !srcConfig.includes("/Volumes/"), "读取 scripts/agent-product-zero-model-check.mjs 的配置段");
check("脚本用 import.meta.url 推导工作区根", scriptSource.includes("fileURLToPath(import.meta.url)") && scriptSource.includes("BEEFTV_WORKSPACE"));
check("工作区根与产物目录推导正确", APD === join(WS, ".local/agent-product"), APD);

const vite = spawn("bunx", ["vite", "--host", "127.0.0.1", "--port", String(WEB_PORT), "--strictPort"], { cwd: WEB_ROOT, env: { ...process.env, VITE_API_PROXY_TARGET: "http://127.0.0.1:18090" }, stdio: "pipe" });
for (let i = 0; i < 90; i++) { try { const r = await fetch(`http://127.0.0.1:${WEB_PORT}/`); if (r.ok) break; } catch {} await sleep(500); }

const s = Date.now(); const A = `hc-${s}`;
const img = (id, title, x, composer) => ({ id, type: "image", title, position: { x, y: 160 }, width: 360, height: 300, metadata: { prompt: composer, composerContent: composer, content: "" } });
await api("PUT", `/canvas-projects/${A}`, { project: { id: A, revision: 0, title: "helper 校验", workspaceProjectId: `ws-${s}`, nodes: [img("n1", "镜头1-开场", 120, "开场草稿"), img("n2", "镜头2-冲突", 560, "冲突草稿"), img("n3", "镜头3-收尾", 1000, "收尾草稿")], connections: [{ id: "e1", fromNodeId: "n1", toNodeId: "n2" }, { id: "e2", fromNodeId: "n2", toNodeId: "n3" }] } });
const before = (await api("GET", `/canvas-projects/${A}`)).data.project;

// 2) CLI 改目标镜头（真实 CLI + 真实服务端，零模型）
const cli = spawnSync(CLI, ["canvas", "node", "update", "--canvas", A, "--node", "n2", "--expected-revision", String(before.revision), "--content", "夜景：雨夜巷口对峙", "--op-id", `hc-cli-${s}`, "--json"], { env: { ...process.env, BEEFTV_BASE_URL: API, BEEFTV_OWNER_TOKEN: OWNER }, encoding: "utf8" });
check("CLI 改目标镜头成功（零模型）", cli.status === 0, `exit=${cli.status}`);

const browser = await chromium.launch({ headless: true, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(`http://127.0.0.1:${WEB_PORT}/canvas/${A}`, { waitUntil: "domcontentloaded" });
await sleep(8000);
await page.getByRole("button", { name: "适合屏幕", exact: true }).first().click().catch(() => {});
await sleep(1500);

async function selectNode(nodeId) {
  const box = await page.evaluate((id) => { const n = document.querySelector(`[data-node-id="${id}"]`); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x + Math.min(60, r.width / 2), y: r.y + Math.min(18, r.height / 2) }; }, nodeId);
  if (!box) return false;
  await page.mouse.click(box.x, box.y); await sleep(2000); return true;
}
async function readComposer() {
  return page.evaluate(() => {
    const composers = Array.from(document.querySelectorAll("textarea")).filter((t) => !t.closest(".canvas-assistant-panel"));
    const composer = composers[0];
    if (!composer) return { value: "", dragHandles: 0, composerCount: 0 };
    let panel = composer;
    for (let d = 0; d < 12 && panel.parentElement; d += 1) { if (panel.querySelector("[data-canvas-node-drag-handle]")) break; panel = panel.parentElement; }
    return { value: composer.value || "", dragHandles: panel.querySelectorAll("[data-canvas-node-drag-handle]").length, composerCount: composers.length };
  });
}

// 3) readPromptInUi 的作用域与交叉校验
let target = { value: "", dragHandles: 0, composerCount: 0 };
for (let i = 0; i < 10; i += 1) { if (await selectNode("n2")) { target = await readComposer(); if (target.value.includes("雨夜巷口对峙")) break; } await sleep(1500); }
check("选中目标节点后 composer 显示 CLI 新值", target.value.includes("雨夜巷口对峙"), JSON.stringify(target));
check("composer 面板唯一（一个拖拽手柄、页面上一个 composer）", target.dragHandles === 1 && target.composerCount === 1, JSON.stringify(target));
await selectNode("n3"); await sleep(1500);
const other = await readComposer();
check("换选另一个镜头读到它自己的值（证明不是全页巧合）", other.value.includes("收尾草稿") && !other.value.includes("雨夜巷口对峙"), JSON.stringify(other));
await page.screenshot({ path: join(APD, "screenshots", `helper-check-${s}.png`) });

// 4) 撤销不倒退外部修改（零模型）
const domCount = async () => (await page.evaluate(() => Array.from(document.querySelectorAll("[data-node-id]")).length));
await page.keyboard.press("Escape");
const beforeAdd = await domCount();
await page.getByRole("button", { name: "添加节点", exact: true }).first().click().catch(() => {});
await sleep(1200);
await page.getByRole("button", { name: "文本", exact: true }).first().click().catch(() => {});
await sleep(2500);
const afterAdd = await domCount();
await page.keyboard.press("Escape"); await sleep(400);
await page.keyboard.press("Meta+z"); await sleep(2500);
const afterUndo = await domCount();
const afterDoc = (await api("GET", `/canvas-projects/${A}`)).data.project;
const t = afterDoc.nodes.find((n) => n.id === "n2");
check("手工新增/撤销节点数正确", afterAdd === beforeAdd + 1 && afterUndo === beforeAdd, `${beforeAdd}->${afterAdd}->${afterUndo}`);
check("撤销未倒退 CLI 写入的目标字段", t?.metadata?.composerContent === "夜景：雨夜巷口对峙", String(t?.metadata?.composerContent));
check("撤销未改动连线", afterDoc.connections.length === 2, String(afterDoc.connections.length));

// 5) Ctrl+Z 历史归属：外部写入不是用户手工编辑，撤销不能倒退外部新值
{
  await page.keyboard.press("Escape");
  await selectNode("n2"); await sleep(1200);
  const baselineCount = await domCount();

  // 用户自己新增一个节点：这是一次真实的手工编辑，应该可撤销
  await page.getByRole("button", { name: "添加节点", exact: true }).first().click().catch(() => {});
  await sleep(1200);
  await page.getByRole("button", { name: "文本", exact: true }).first().click().catch(() => {});
  await sleep(2500);
  const afterManualAdd = await domCount();
  check("用户手工新增节点（撤销用例前置）", afterManualAdd === baselineCount + 1, `${baselineCount} -> ${afterManualAdd}`);

  // 外部（CLI）写入目标字段：这不是用户编辑，不能变成一条可撤销记录
  const current = (await api("GET", `/canvas-projects/${A}`)).data.project;
  const cli2 = spawnSync(CLI, ["canvas", "node", "update", "--canvas", A, "--node", "n2", "--expected-revision", String(current.revision), "--content", "外部第二次写入", "--op-id", `hc-cli2-${s}`, "--json"], { env: { ...process.env, BEEFTV_BASE_URL: API, BEEFTV_OWNER_TOKEN: OWNER }, encoding: "utf8" });
  check("外部第二次写入成功（零模型）", cli2.status === 0, `exit=${cli2.status}`);
  await sleep(6000);

  // 外部写入要么已被界面应用，要么因为存在未确认编辑而保留为冲突候选；两者都不算丢失。
  const backendAfterExternal = (await api("GET", `/canvas-projects/${A}`)).data.project;
  const backendValue = backendAfterExternal.nodes.find((n) => n.id === "n2")?.metadata?.composerContent;
  const conflictNotice = await page.evaluate(() => (document.querySelector("aside")?.innerText || "").includes("画布已在其他入口更新"));
  check("外部写入没有丢失（已应用或保留为冲突候选）", backendValue === "外部第二次写入" || conflictNotice, `backend=${backendValue} conflictNotice=${conflictNotice}`);

  // 第一次撤销：只应撤掉用户自己新增的节点
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+z");
  await sleep(2500);
  const afterFirstUndo = await domCount();
  const backendAfterFirstUndo = (await api("GET", `/canvas-projects/${A}`)).data.project;
  const valueAfterFirstUndo = backendAfterFirstUndo.nodes.find((n) => n.id === "n2")?.metadata?.composerContent;
  check("Ctrl+Z 只撤销用户自己的手工编辑", afterFirstUndo === baselineCount, `${baselineCount} -> ${afterManualAdd} -> ${afterFirstUndo}`);
  check("Ctrl+Z 之后外部新值没有被倒退", valueAfterFirstUndo === "外部第二次写入" || conflictNotice, `composerContent=${valueAfterFirstUndo}`);

  // 第二次撤销：没有本地操作可撤销，外部新值依旧不能被倒退
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+z");
  await sleep(2000);
  const afterSecondUndo = await domCount();
  const backendAfterSecond = (await api("GET", `/canvas-projects/${A}`)).data.project;
  const valueAfterSecondUndo = backendAfterSecond.nodes.find((n) => n.id === "n2")?.metadata?.composerContent;
  check("没有本地操作可撤销时 Ctrl+Z 不倒退外部新值", afterSecondUndo === baselineCount && (valueAfterSecondUndo === "外部第二次写入" || conflictNotice), `count=${afterSecondUndo} composerContent=${valueAfterSecondUndo}`);
  await page.screenshot({ path: join(APD, "screenshots", `zero-model-history-${s}.png`) });
}

// 6) 证据链读回：真实目录做自洽检查；写入/读回用自检文件证明追加路径可用
{
  const latestPath = join(APD, "results-react-cross-entry.json");
  const attemptsPath = join(APD, "results-react-cross-entry-attempts.jsonl");
  const versionedRaw = readdirSync(APD).filter((name) => /^results-react-cross-entry-.*\.json$/.test(name));
  // 版本化原始结果由真实浏览器验收脚本每次运行写一份；这里如实记录当前已有份数，
  // 不把「还没跑过」当成失败，也不用自检冒充真实运行产物。
  let pointerOk = false;
  try {
    const parsed = JSON.parse(readFileSync(latestPath, "utf8"));
    pointerOk = typeof parsed.stamp === "string" && Array.isArray(parsed.checks);
  } catch { pointerOk = false; }
  check("latest 指针存在且可解析", existsSync(latestPath) && pointerOk, `versionedRaw=${versionedRaw.length}`);
  if (existsSync(attemptsPath)) {
    const parsed = readFileSync(attemptsPath, "utf8").split("\n").filter((line) => line.trim())
      .map((line) => { try { return JSON.parse(line); } catch { return null; } });
    check("attempt 索引每行都是合法 JSON 且带标识", parsed.length > 0 && parsed.every((item) => item && (item.stamp || item.attempt)), `${parsed.length} 行`);
  } else {
    check("attempt 索引存在", false, attemptsPath);
  }

  // 版本化写入 + latest 指针 + attempt 追加的自检：与验收脚本同一套命名与写入方式。
  const selftestDir = join(APD, "logs", `evidence-selftest-${s}`);
  mkdirSync(selftestDir, { recursive: true });
  const payload = JSON.stringify({ stamp: `selftest-${s}`, ok: true, checks: [{ name: "self", ok: true, detail: "" }] }, null, 2);
  const versionedPath = join(selftestDir, `results-react-cross-entry-selftest-${s}.json`);
  const pointerPath = join(selftestDir, "results-react-cross-entry.json");
  const indexPath = join(selftestDir, "results-react-cross-entry-attempts.jsonl");
  writeFileSync(versionedPath, payload);
  writeFileSync(pointerPath, payload);
  appendFileSync(indexPath, `${JSON.stringify({ stamp: `selftest-${s}`, ok: true, passed: 1, total: 1, failed: [], rawResultPath: versionedPath })}\n`);
  const pointerRead = JSON.parse(readFileSync(pointerPath, "utf8"));
  const versionedRead = readFileSync(versionedPath, "utf8");
  const indexRead = readFileSync(indexPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  check("版本化原始结果 + latest 指针 + attempt 索引可写入并读回", pointerRead.stamp === `selftest-${s}` && versionedRead === payload && indexRead.length === 1 && indexRead[0].rawResultPath === versionedPath, JSON.stringify(indexRead));
  rmSync(selftestDir, { recursive: true, force: true });
}

const summary = { ok: checks.every((c) => c.ok), checks, script: "web/scripts/agent-product-browser-e2e.mjs", modelCalls: 0 };
const out = join(APD, `results-zero-model-${s}.json`);
(await import("node:fs")).writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(`\n结果写入 ${out}\n零模型校验 ${checks.filter((c) => c.ok).length}/${checks.length} 通过`);
process.exit(summary.ok ? 0 : 1);
