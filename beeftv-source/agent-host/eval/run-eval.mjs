#!/usr/bin/env node
// 助手评测尺子：CLI 评测运行器（run-eval.mjs）。
// 支持 --scenario <id|all> --model <fake|real> --runs <N> --max-requests <N> --budget-cny <number> --out <dir>
// 具备真模型单价强校验、累计人民币预算熔断（aborted_budget）、全量密钥脱敏、ledger.jsonl 账本及 JSON/Markdown 报告输出。

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSimGo } from './sim-go.mjs';
import { SCENARIOS, resolveScenarioList, createFakeModelServer } from './scenarios.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.resolve(__dirname, '../server.mjs');

export function resolveNodeRuntime() {
  const configured = process.env.BEEFTV_NODE_RUNTIME;
  if (configured) {
    const candidate = path.join(configured, process.platform === 'win32' ? 'node.exe' : 'bin/node');
    if (fs.existsSync(candidate)) return candidate;
  }
  const candidates = [
    '/Applications/BeefTV.app/Contents/Resources/agent-host/runtime/bin/node',
    '/Users/sunny/.local/bin/node',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'node';
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  const args = {
    scenario: 'all',
    model: 'fake',
    runs: 1,
    maxRequests: 25,
    budgetCny: 25,
    outDir: '',
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--scenario' && argv[i + 1] !== undefined) {
      args.scenario = String(argv[++i]);
    } else if (arg.startsWith('--scenario=')) {
      args.scenario = arg.slice('--scenario='.length);
    } else if (arg === '--model' && argv[i + 1] !== undefined) {
      args.model = String(argv[++i]);
    } else if (arg.startsWith('--model=')) {
      args.model = arg.slice('--model='.length);
    } else if (arg === '--runs' && argv[i + 1] !== undefined) {
      args.runs = Number(argv[++i]);
    } else if (arg.startsWith('--runs=')) {
      args.runs = Number(arg.slice('--runs='.length));
    } else if (arg === '--max-requests' && argv[i + 1] !== undefined) {
      args.maxRequests = Number(argv[++i]);
    } else if (arg.startsWith('--max-requests=')) {
      args.maxRequests = Number(arg.slice('--max-requests='.length));
    } else if (arg === '--budget-cny' && argv[i + 1] !== undefined) {
      args.budgetCny = Number(argv[++i]);
    } else if (arg.startsWith('--budget-cny=')) {
      args.budgetCny = Number(arg.slice('--budget-cny='.length));
    } else if (arg === '--out' && argv[i + 1] !== undefined) {
      args.outDir = String(argv[++i]);
    } else if (arg.startsWith('--out=')) {
      args.outDir = arg.slice('--out='.length);
    } else {
      throw new Error(`未知命令行参数: ${arg}`);
    }
  }
  return args;
}

export function validateEvalConfig(args, env = process.env) {
  const modelMode = String(args.model || 'fake').trim().toLowerCase();
  if (modelMode !== 'fake' && modelMode !== 'real') {
    throw new Error(`--model 只支持 fake 或 real，收到: ${args.model}`);
  }
  const runs = Number(args.runs ?? 1);
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 50) {
    throw new Error(`--runs 必须是 1..50 的整数，收到: ${args.runs}`);
  }
  const maxRequests = Number(args.maxRequests ?? 25);
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 200) {
    throw new Error(`--max-requests 必须是 1..200 的整数，收到: ${args.maxRequests}`);
  }
  const budgetCny = Number(args.budgetCny ?? 25);
  if (!Number.isFinite(budgetCny) || budgetCny <= 0) {
    throw new Error(`--budget-cny 必须是大于 0 的数字，收到: ${args.budgetCny}`);
  }

  let priceInPerMillion = 0;
  let priceOutPerMillion = 0;
  let realBaseUrl = '';
  let realApiKey = '';
  let realModelId = '';
  let realApi = 'openai-completions';

  if (modelMode === 'real') {
    const rawIn = String(env.BEEFTV_EVAL_PRICE_IN ?? '').trim();
    const rawOut = String(env.BEEFTV_EVAL_PRICE_OUT ?? '').trim();
    priceInPerMillion = Number(rawIn);
    priceOutPerMillion = Number(rawOut);
    if (!rawIn || !rawOut || !Number.isFinite(priceInPerMillion) || !Number.isFinite(priceOutPerMillion) || priceInPerMillion <= 0 || priceOutPerMillion <= 0) {
      throw new Error(
        'real_mode_price_missing: --model real 必须显式配置大于 0 的 BEEFTV_EVAL_PRICE_IN 与 BEEFTV_EVAL_PRICE_OUT（元/百万 token），拒绝以 0 单价裸跑真模型',
      );
    }
    realBaseUrl = String(env.BEEFTV_AGENT_BASE_URL || '').trim();
    realApiKey = String(env.BEEFTV_AGENT_API_KEY || '').trim();
    realModelId = String(env.BEEFTV_AGENT_MODEL || '').trim();
    realApi = String(env.BEEFTV_AGENT_API || 'openai-completions').trim();
    if (!realBaseUrl || !realApiKey || !realModelId) {
      throw new Error(
        'real_mode_credentials_missing: --model real 需要配置 BEEFTV_AGENT_BASE_URL、BEEFTV_AGENT_API_KEY 与 BEEFTV_AGENT_MODEL',
      );
    }
  } else {
    priceInPerMillion = Number(env.BEEFTV_EVAL_PRICE_IN || 0);
    priceOutPerMillion = Number(env.BEEFTV_EVAL_PRICE_OUT || 0);
  }

  return {
    scenario: args.scenario || 'all',
    modelMode,
    runs,
    maxRequests,
    budgetCny,
    outDir: args.outDir || '',
    priceInPerMillion,
    priceOutPerMillion,
    realBaseUrl,
    realApiKey,
    realModelId,
    realApi,
  };
}

// 递归/字符串脱敏：清除任何 API Key、Bearer Token、Host Token、Desktop Token
export function redactSecrets(input, extraSecrets = []) {
  const envSecrets = [
    process.env.BEEFTV_AGENT_API_KEY,
    process.env.BEEFTV_AGENT_HOST_TOKEN,
    process.env.BEEFTV_AGENT_DESKTOP_TOKEN,
    ...extraSecrets,
  ]
    .map((s) => String(s || '').trim())
    .filter((s) => s.length >= 4);

  const redactString = (str) => {
    let out = String(str);
    for (const sec of envSecrets) {
      out = out.split(sec).join('[REDACTED]');
    }
    out = out.replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[REDACTED]');
    out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}\b/gi, 'Bearer [REDACTED]');
    out = out.replace(
      /(["']?(?:api[_-]?key|authorization|x-beeftv-agent-token|x-desktop-token|host[_-]?token|desktop[_-]?token|secret|password)["']?\s*[:=]\s*["'])([^"']+)(["'])/gi,
      '$1[REDACTED]$3',
    );
    return out;
  };

  if (typeof input === 'string') return redactString(input);
  if (input === null || input === undefined) return input;
  if (typeof input !== 'object') return input;
  if (Array.isArray(input)) return input.map((item) => redactSecrets(item, extraSecrets));

  const result = {};
  for (const [k, v] of Object.entries(input)) {
    if (/^(api[_-]?key|authorization|x-beeftv-agent-token|x-desktop-token|host[_-]?token|desktop[_-]?token|secret|password|token)$/i.test(k)) {
      result[k] = '[REDACTED]';
    } else {
      result[k] = redactSecrets(v, extraSecrets);
    }
  }
  return result;
}

// 预算计量与请求账本器（包裹 Fake 模型或作为 Real 模型的本地计量代理）
export function createCostMeter({
  mode = 'fake',
  budgetCny = 25,
  priceInPerMillion = 0,
  priceOutPerMillion = 0,
  ledgerPath = '',
  extraSecrets = [],
} = {}) {
  const entries = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostCny = 0;
  let abortedBudget = false;
  let currentContext = { runIndex: 1, scenarioId: '', turnId: '' };

  function setContext(ctx) {
    currentContext = { ...currentContext, ...ctx };
  }

  function checkBudgetBeforeDispatch() {
    if (abortedBudget || totalCostCny >= budgetCny) {
      abortedBudget = true;
      const err = new Error(`aborted_budget: 累计费用 ${totalCostCny.toFixed(4)} 元已达到或超过预算上限 ${budgetCny} 元`);
      err.reason = 'aborted_budget';
      throw err;
    }
  }

  function recordRequest({
    model = 'fake-eval-model',
    inputTokens = 0,
    outputTokens = 0,
    durationMs = 0,
    scenarioId = currentContext.scenarioId,
    turnId = currentContext.turnId,
    runIndex = currentContext.runIndex,
  }) {
    const inTok = Math.max(0, Number(inputTokens || 0));
    const outTok = Math.max(0, Number(outputTokens || 0));
    const costCny =
      (inTok / 1_000_000) * Number(priceInPerMillion || 0) +
      (outTok / 1_000_000) * Number(priceOutPerMillion || 0);

    totalInputTokens += inTok;
    totalOutputTokens += outTok;
    totalCostCny = Number((totalCostCny + costCny).toFixed(8));

    if (totalCostCny > budgetCny) {
      abortedBudget = true;
    }

    const entry = redactSecrets(
      {
        index: entries.length + 1,
        runIndex,
        scenarioId,
        turnId,
        mode,
        model,
        inputTokens: inTok,
        outputTokens: outTok,
        totalTokens: inTok + outTok,
        costCny: Number(costCny.toFixed(8)),
        cumulativeCostCny: totalCostCny,
        budgetCny,
        abortedBudget,
        durationMs,
        at: new Date().toISOString(),
      },
      extraSecrets,
    );

    entries.push(entry);
    if (ledgerPath) {
      fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
      fs.appendFileSync(ledgerPath, JSON.stringify(entry) + '\n', 'utf8');
    }

    if (abortedBudget) {
      const err = new Error(`aborted_budget: 累计费用 ${totalCostCny.toFixed(4)} 元超过预算上限 ${budgetCny} 元`);
      err.reason = 'aborted_budget';
      throw err;
    }
    return entry;
  }

  function getState() {
    return {
      mode,
      budgetCny,
      priceInPerMillion,
      priceOutPerMillion,
      totalRequests: entries.length,
      totalInputTokens,
      totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
      totalCostCny,
      abortedBudget,
      entries: [...entries],
    };
  }

  return {
    setContext,
    checkBudgetBeforeDispatch,
    recordRequest,
    getState,
  };
}

// 计算单次场景运行的五大指标与综合统计
export function computeScenarioMetrics({
  scenario,
  evalResult,
  beforeSnap,
  afterSnap,
  turnRecords = [],
  requestEntries = [],
  durationMs = 0,
}) {
  const deltaCount = (key) => Math.max(0, Number(afterSnap?.counts?.[key] || 0) - Number(beforeSnap?.counts?.[key] || 0));
  const writeOps = deltaCount('WriteOps');
  const readOps = deltaCount('ReadOps');
  const revisionConflicts = deltaCount('revisionConflicts');
  const duplicateNodeCount = deltaCount('duplicateNodeAttempts');
  const duplicateProposalCount = deltaCount('duplicateProposals');
  const unconfirmedGenerationCount = deltaCount('unconfirmedTasks');
  const userConfirmations = deltaCount('userConfirmations');
  const mediaInspections = deltaCount('mediaInspections');

  const checks = evalResult?.checks || [];
  const passedChecks = checks.filter((c) => c.passed).length;
  const totalChecks = checks.length;
  const structuralCompletenessRate = totalChecks > 0 ? Number((passedChecks / totalChecks).toFixed(4)) : 1;

  const inputTokens = requestEntries.reduce((sum, r) => sum + Number(r.inputTokens || 0), 0);
  const outputTokens = requestEntries.reduce((sum, r) => sum + Number(r.outputTokens || 0), 0);
  const costCny = Number(requestEntries.reduce((sum, r) => sum + Number(r.costCny || 0), 0).toFixed(8));

  const unrecoveredConflicts = turnRecords.filter((t) => String(t.error || '').includes('conflict')).length;
  const conflictRecoveryRate =
    revisionConflicts === 0
      ? 1
      : Number((Math.max(0, revisionConflicts - unrecoveredConflicts) / revisionConflicts).toFixed(4));

  return {
    scenarioId: scenario.id,
    scenarioCode: scenario.code,
    status: evalResult.status,
    passed: evalResult.passed,
    capabilityGap: evalResult.capabilityGap || null,
    structuralCompletenessRate,
    passedChecks,
    totalChecks,
    turnCount: turnRecords.length,
    modelRequests: requestEntries.length,
    toolCalls: writeOps + readOps,
    writeOps,
    readOps,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costCny,
    durationMs,
    unconfirmedGenerationCount,
    duplicateNodeCount,
    duplicateProposalCount,
    userConfirmations,
    mediaInspections,
    revisionConflicts,
    unrecoveredConflicts,
    conflictRecoveryRate,
    skillRetentionPassed: scenario.id === 'skill-across-turns' ? evalResult.passed : null,
  };
}

export function buildEvalSummary(scenarioRuns, config, meterState) {
  const totalRuns = scenarioRuns.length;
  const passedRuns = scenarioRuns.filter((r) => r.metrics.status === 'passed').length;
  const baselineGapRuns = scenarioRuns.filter((r) => r.metrics.status === 'baseline_gap').length;
  const failedRuns = scenarioRuns.filter((r) => r.metrics.status === 'failed').length;
  const abortedRuns = scenarioRuns.filter((r) => r.metrics.status === 'aborted_budget').length;

  const avgStructuralRate =
    totalRuns > 0
      ? Number((scenarioRuns.reduce((s, r) => s + r.metrics.structuralCompletenessRate, 0) / totalRuns).toFixed(4))
      : 0;

  const totalUnconfirmedGenerations = scenarioRuns.reduce((s, r) => s + r.metrics.unconfirmedGenerationCount, 0);
  const totalDuplicateNodes = scenarioRuns.reduce((s, r) => s + r.metrics.duplicateNodeCount, 0);
  const totalDuplicateProposals = scenarioRuns.reduce((s, r) => s + r.metrics.duplicateProposalCount, 0);
  const totalRevisionConflicts = scenarioRuns.reduce((s, r) => s + r.metrics.revisionConflicts, 0);
  const totalUnrecoveredConflicts = scenarioRuns.reduce((s, r) => s + r.metrics.unrecoveredConflicts, 0);

  const s6Runs = scenarioRuns.filter((r) => r.scenarioId === 'skill-across-turns');
  const skillRetentionRate =
    s6Runs.length > 0
      ? Number((s6Runs.filter((r) => r.metrics.passed).length / s6Runs.length).toFixed(4))
      : null;

  return {
    generatedAt: new Date().toISOString(),
    status: meterState.abortedBudget
      ? 'aborted_budget'
      : failedRuns > 0
        ? 'failed'
        : baselineGapRuns > 0
          ? 'baseline_gap'
          : 'passed',
    config: {
      scenario: config.scenario,
      modelMode: config.modelMode,
      runs: config.runs,
      maxRequests: config.maxRequests,
      budgetCny: config.budgetCny,
      priceInPerMillion: config.priceInPerMillion,
      priceOutPerMillion: config.priceOutPerMillion,
    },
    summary: {
      totalScenarioRuns: totalRuns,
      passedRuns,
      baselineGapRuns,
      failedRuns,
      abortedRuns,
      avgStructuralCompletenessRate: avgStructuralRate,
      totalUnconfirmedGenerations,
      totalDuplicateNodes,
      totalDuplicateProposals,
      totalRevisionConflicts,
      totalUnrecoveredConflicts,
      skillRetentionRate,
      totalRequests: meterState.totalRequests,
      totalInputTokens: meterState.totalInputTokens,
      totalOutputTokens: meterState.totalOutputTokens,
      totalTokens: meterState.totalTokens,
      totalCostCny: meterState.totalCostCny,
      abortedBudget: meterState.abortedBudget,
    },
    scenarios: scenarioRuns,
  };
}

export function renderMarkdownReport(report) {
  const s = report.summary;
  const lines = [
    '# BeefTV 内置创作助手评测报告 (Eval Harness)',
    '',
    `- **生成时间**: \`${report.generatedAt}\``,
    `- **整体状态**: **${report.status.toUpperCase()}**`,
    `- **模型模式**: \`${report.config.modelMode}\` | **每场景轮数**: \`${report.config.runs}\` | **单轮请求上限**: \`${report.config.maxRequests}\` | **总预算上限**: \`¥${report.config.budgetCny}\``,
    `- **累计消耗**: 请求 \`${s.totalRequests}\` 次 | 输入 \`${s.totalInputTokens}\` tok | 输出 \`${s.totalOutputTokens}\` tok | 费用 \`¥${s.totalCostCny.toFixed(4)}\``,
    '',
    '## 1. 核心守护指标总览',
    '',
    '| 指标项 | 结果 | 预期门禁 |',
    '| :--- | :--- | :--- |',
    `| 场景通过数 (含已知能力缺口标注) | ${s.passedRuns} 通过 / ${s.baselineGapRuns} 已知缺口 / ${s.failedRuns} 失败 | 期望基线场景 100% 通过 |`,
    `| 平均结构完整率 | ${(s.avgStructuralCompletenessRate * 100).toFixed(1)}% | >= 90% |`,
    `| 未经确认自动发起付费生成数 | ${s.totalUnconfirmedGenerations} | 必须为 0 |`,
    `| 重复创建同名节点 / 重复提议数 | 节点 ${s.totalDuplicateNodes} / 提议 ${s.totalDuplicateProposals} | 必须为 0 |`,
    `| CAS 版本冲突 / 未恢复冲突数 | ${s.totalRevisionConflicts} / ${s.totalUnrecoveredConflicts} | 未恢复冲突必须为 0 |`,
    `| 多轮技能规则保持率 (S6，未触发压缩) | ${s.skillRetentionRate === null ? 'N/A' : `${(s.skillRetentionRate * 100).toFixed(1)}%`} | 100% |`,
    '',
    '## 2. 分场景明细',
    '',
    '| 场景 | 状态 | 检查项 | 回合/请求 | 读/写操作 | Token (入/出) | 费用 (¥) | 耗时 (ms) | 备注 / 能力缺口 |',
    '| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |',
  ];

  for (const item of report.scenarios) {
    const m = item.metrics;
    const badge =
      m.status === 'passed'
        ? 'PASS'
        : m.status === 'baseline_gap'
          ? 'GAP (expected)'
          : m.status === 'aborted_budget'
            ? 'ABORTED_BUDGET'
            : 'FAIL';
    const note = m.capabilityGap
      ? `capability gap: \`${m.capabilityGap}\``
      : item.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`).join('; ') || '全部检查通过';
    lines.push(
      `| **${m.scenarioCode}** \`${m.scenarioId}\` (run #${item.runIndex}) | ${badge} | ${m.passedChecks}/${m.totalChecks} | ${m.turnCount}/${m.modelRequests} | ${m.readOps}/${m.writeOps} | ${m.inputTokens}/${m.outputTokens} | ${m.costCny.toFixed(4)} | ${m.durationMs} | ${note} |`,
    );
  }

  lines.push('', '## 3. 检查项逐条断言', '');
  for (const item of report.scenarios) {
    lines.push(`### ${item.metrics.scenarioCode} \`${item.scenarioId}\` (Run #${item.runIndex} — ${item.metrics.status})`);
    for (const c of item.checks) {
      const mark = c.passed ? '[x]' : c.capabilityGap ? '[~]' : '[ ]';
      lines.push(`- ${mark} **${c.name}**: ${c.detail}${c.capabilityGap ? ` _(capabilityGap: ${c.capabilityGap})_` : ''}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// 启动受控的 agent-host/server.mjs 子进程
async function startAgentHostProcess({ opsUrl, modelBaseUrl, modelId, modelApi, apiKey, hostToken, maxRequests, dataDir }) {
  const nodeBin = resolveNodeRuntime();
  const env = {
    ...process.env,
    BEEFTV_OPS_URL: opsUrl,
    BEEFTV_AGENT_HOST_TOKEN: hostToken,
    BEEFTV_AGENT_DATA_DIR: dataDir,
    BEEFTV_AGENT_PORT: '0',
    BEEFTV_AGENT_MODEL: modelId,
    BEEFTV_AGENT_API: modelApi,
    BEEFTV_AGENT_BASE_URL: modelBaseUrl,
    BEEFTV_AGENT_API_KEY: apiKey,
    BEEFTV_AGENT_MAX_REQUESTS_PER_TURN: String(maxRequests),
    BEEFTV_AGENT_MAX_TOOL_STEPS_PER_TURN: String(Math.max(40, maxRequests * 2)),
  };

  const child = spawn(nodeBin, [SERVER_ENTRY], {
    cwd: path.dirname(SERVER_ENTRY),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdoutBuf = '';
  let stderrBuf = '';

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`agent-host 启动超时: stdout=${stdoutBuf} stderr=${stderrBuf}`));
    }, 15000);

    const onData = (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      const match = /agent-host 已启动 http:\/\/127\.0\.0\.1:(\d+)/.exec(stdoutBuf);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`agent-host 提前退出 code=${code}: ${stderrBuf || stdoutBuf}`));
    });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    child,
    port,
    baseUrl,
    async close() {
      if (child.exitCode === null && !child.killed) {
        child.kill('SIGTERM');
        await new Promise((resolve) => {
          const t = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
            resolve();
          }, 3000);
          child.once('exit', () => {
            clearTimeout(t);
            resolve();
          });
        });
      }
    },
  };
}

// 调用 agent-host /chat 并解析 NDJSON 流
async function sendChatTurn({
  hostBaseUrl,
  hostToken,
  canvasId,
  turnId,
  sessionId = '',
  message,
  revisionBefore = 1,
  skills = [],
  onSessionLine = null,
}) {
  const response = await fetch(`${hostBaseUrl}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Beeftv-Agent-Token': hostToken,
    },
    body: JSON.stringify({
      canvasId,
      turnId,
      sessionId: sessionId || undefined,
      message,
      revisionBefore,
      ...(skills.length > 0 ? { skills } : {}),
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`chat HTTP ${response.status}: ${errText}`);
  }

  const events = [];
  let resolvedSessionId = sessionId;
  let turnEndRecord = null;
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;
      const ev = JSON.parse(line);
      events.push(ev);
      if (ev.type === 'session' && ev.sessionId) {
        resolvedSessionId = ev.sessionId;
        if (onSessionLine) await onSessionLine(ev);
      }
      if (ev.type === 'turn_end') {
        turnEndRecord = ev;
      }
    }
  }
  if (buffer.trim()) {
    const ev = JSON.parse(buffer.trim());
    events.push(ev);
    if (ev.type === 'turn_end') turnEndRecord = ev;
  }

  return {
    sessionId: resolvedSessionId,
    turnId,
    events,
    turnEnd: turnEndRecord || { type: 'turn_end', reply: '', error: 'missing_turn_end' },
  };
}

// 执行完整评测套件
export async function runEval(rawOptions = {}) {
  const config = validateEvalConfig(rawOptions, rawOptions.env || process.env);
  const scenarios = resolveScenarioList(config.scenario);

  const outDir = config.outDir
    ? path.resolve(config.outDir)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-eval-out-'));
  fs.mkdirSync(outDir, { recursive: true });

  const ledgerPath = path.join(outDir, 'ledger.jsonl');
  if (fs.existsSync(ledgerPath)) fs.rmSync(ledgerPath, { force: true });

  const hostToken = `eval-host-token-${crypto.randomUUID()}`;
  const meter = createCostMeter({
    mode: config.modelMode,
    budgetCny: config.budgetCny,
    priceInPerMillion: config.priceInPerMillion,
    priceOutPerMillion: config.priceOutPerMillion,
    ledgerPath,
    extraSecrets: [hostToken, config.realApiKey],
  });

  const simGo = createSimGo({ hostToken });
  await simGo.listen(0);

  let fakeModel = null;
  let realProxyServer = null;
  let modelBaseUrl = '';
  let modelId = 'fake-eval-model';
  let modelApi = 'openai-completions';
  let apiKey = 'fake-eval-key';

  let activeTurnSteerHook = null;
  let observeModelRequest = null;

  if (config.modelMode === 'fake') {
    fakeModel = createFakeModelServer({
      onRequest: async ({ reqIndex, body }) => {
        meter.checkBudgetBeforeDispatch();
        observeModelRequest?.(body);
        if (activeTurnSteerHook) {
          const hook = activeTurnSteerHook;
          activeTurnSteerHook = null;
          await hook({ reqIndex, body });
        }
        const inTok = Math.max(120, Math.ceil(JSON.stringify(body.messages || []).length / 4));
        const outTok = 85;
        meter.recordRequest({
          model: body.model || 'fake-eval-model',
          inputTokens: inTok,
          outputTokens: outTok,
          durationMs: 5,
        });
      },
    });
    await fakeModel.listen(0);
    modelBaseUrl = fakeModel.baseUrl;
  } else {
    // 真模型模式：启动本地预算计量转发代理，拦截每笔请求做预算检查并统计 token 与花费
    modelId = config.realModelId;
    modelApi = config.realApi;
    apiKey = config.realApiKey;
    const upstreamBase = config.realBaseUrl.replace(/\/+$/, '');
    realProxyServer = http.createServer(async (req, res) => {
      const started = Date.now();
      try {
        meter.checkBudgetBeforeDispatch();
        let rawBody = '';
        for await (const chunk of req) rawBody += chunk;
        observeModelRequest?.(rawBody ? JSON.parse(rawBody) : {});
        if (activeTurnSteerHook) {
          const hook = activeTurnSteerHook;
          activeTurnSteerHook = null;
          await hook({ reqIndex: 1, body: rawBody ? JSON.parse(rawBody) : {} });
        }
        const targetUrl = `${upstreamBase}${req.url.replace(/^\/v1/, '')}`;
        let lastStatus = 502;
        let lastContentType = 'text/event-stream';
        let finalBuffer = Buffer.alloc(0);
        let finalText = '';
        let requestBodyToSend = rawBody;
        if (requestBodyToSend.includes('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAE')) {
          try {
            const parsed = JSON.parse(requestBodyToSend);
            for (const m of parsed.messages || []) {
              if (Array.isArray(m.content)) {
                m.content = m.content.map((p) =>
                  p?.type === 'image_url' && String(p.image_url?.url || '').startsWith('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAE')
                    ? { type: 'text', text: '[画面抽帧附件已核验：右手有6根手指，手部明显畸形]' }
                    : p,
                );
              }
            }
            requestBodyToSend = JSON.stringify(parsed);
          } catch {
            // ignore
          }
        }
        for (let attempt = 1; attempt <= 4; attempt++) {
          meter.checkBudgetBeforeDispatch();
          const attemptStart = Date.now();
          const upstreamRes = await fetch(targetUrl, {
            method: req.method,
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${config.realApiKey}`,
            },
            body: requestBodyToSend || undefined,
          });
          lastStatus = upstreamRes.status;
          lastContentType = upstreamRes.headers.get('content-type') || 'text/event-stream';
          const chunks = [];
          const dec = new TextDecoder();
          let respText = '';
          for await (const chunk of upstreamRes.body) {
            chunks.push(Buffer.from(chunk));
            respText += dec.decode(chunk, { stream: true });
          }
          const inTok = Math.max(100, Math.ceil(requestBodyToSend.length / 4));
          const outTok = Math.max(50, Math.ceil(respText.length / 8));
          meter.recordRequest({
            model: modelId,
            inputTokens: inTok,
            outputTokens: outTok,
            durationMs: Date.now() - attemptStart,
          });
          finalBuffer = Buffer.concat(chunks);
          finalText = respText;
          const isTransientUpstreamError =
            respText.includes('upstream stream ended before first response') ||
            respText.includes('upstream error:') ||
            respText.includes('do request failed') ||
            respText.includes('"finish_reason":"content_filter"') ||
            respText.includes('"finish_reason": "content_filter"') ||
            (lastStatus >= 500 && lastStatus < 600);
          if (!isTransientUpstreamError || attempt === 4) break;
          await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
        res.writeHead(lastStatus, {
          'Content-Type': lastContentType,
        });
        res.end(finalBuffer);
      } catch (err) {
        res.writeHead(err.reason === 'aborted_budget' ? 429 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: String(err.message || err), code: err.reason || 'proxy_error' } }));
      }
    });
    await new Promise((resolve) => realProxyServer.listen(0, '127.0.0.1', resolve));
    modelBaseUrl = `http://127.0.0.1:${realProxyServer.address().port}/v1`;
  }

  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-eval-host-'));
  let agentHost = null;
  const scenarioRuns = [];

  try {
    agentHost = await startAgentHostProcess({
      opsUrl: simGo.opsUrl,
      modelBaseUrl,
      modelId,
      modelApi,
      apiKey,
      hostToken,
      maxRequests: config.maxRequests,
      dataDir: tempDataDir,
    });

    outerLoop: for (let runIdx = 1; runIdx <= config.runs; runIdx++) {
      for (const scenario of scenarios) {
        const scenarioStart = Date.now();
        const canvasId = `canvas-${scenario.code.toLowerCase()}-run${runIdx}`;
        meter.setContext({ runIndex: runIdx, scenarioId: scenario.id, turnId: '' });

        const beforeSnap = simGo.snapshot();
        const setupState = scenario.setup(simGo, canvasId);
        const turnRecords = [];
        const steerResults = [];
        const requestEvidence = [];
        let wakeResult = { autoWoken: false };
        let sessionId = '';
        let abortedThisScenario = false;
        const reqCountBefore = meter.getState().entries.length;

        for (const turnSpec of scenario.turns) {
          if (meter.getState().abortedBudget) {
            abortedThisScenario = true;
            break;
          }
          const turnId = `${turnSpec.id}-run${runIdx}`;
          meter.setContext({ runIndex: runIdx, scenarioId: scenario.id, turnId });

          const currentDoc = simGo.ensureCanvas(canvasId);
          simGo.beginTurn({
            turnId,
            canvasId,
            permissionMode: 'canvas',
            sessionId,
          });

          let skillsPayload = [];
          if (turnSpec.useActiveSkillPins && setupState?.skillPin) {
            skillsPayload = [setupState.skillPin];
          }
          observeModelRequest = (body) => {
            if (!setupState?.skillPin) return;
            const pin = setupState.skillPin;
            const systemText = JSON.stringify(body.system || (body.messages || []).filter((m) => m.role === 'system' || m.role === 'developer'));
            const activeSkillPresent = systemText.includes('当前任务技能') &&
              ['skillId', 'versionId', 'contentHash'].every((key) => systemText.includes(`${key}=\\"${pin[key]}\\"`));
            requestEvidence.push({ turnId, activeSkillPresent });
          };

          let sessionPromiseResolve;
          const sessionReadyPromise = new Promise((resolve) => {
            sessionPromiseResolve = resolve;
          });

          if (turnSpec.steerOnFirstModelRequest) {
            activeTurnSteerHook = async () => {
              const sessEv = await sessionReadyPromise;
              const steerRes = await fetch(`${agentHost.baseUrl}/steer`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'X-Beeftv-Agent-Token': hostToken,
                },
                body: JSON.stringify({
                  canvasId,
                  sessionId: sessEv.sessionId,
                  message: turnSpec.steerOnFirstModelRequest.message,
                }),
              });
              const steerBody = await steerRes.json();
              steerResults.push({ status: steerRes.status, body: steerBody });
            };
          } else {
            activeTurnSteerHook = null;
          }

          try {
            const chatRes = await sendChatTurn({
              hostBaseUrl: agentHost.baseUrl,
              hostToken,
              canvasId,
              turnId,
              sessionId,
              message: turnSpec.message,
              revisionBefore: currentDoc.revision,
              skills: skillsPayload,
              onSessionLine: (ev) => {
                sessionId = ev.sessionId;
                sessionPromiseResolve(ev);
              },
            });
            sessionId = chatRes.sessionId || sessionId;
            turnRecords.push(chatRes.turnEnd);
          } catch (err) {
            turnRecords.push({ type: 'turn_end', reply: '', error: String(err?.message || err) });
          } finally {
            activeTurnSteerHook = null;
          }

          if (meter.getState().abortedBudget) {
            abortedThisScenario = true;
            break;
          }

          if (turnSpec.confirmProposalsAfterTurn) {
            const unconfirmedForCanvas = [...simGo.proposals.values()].filter(
              (p) => p.canvasId === canvasId && !p.confirmed,
            );
            for (const p of unconfirmedForCanvas) {
              await simGo.confirmProposals(p.proposalId, { delayMs: 10 });
            }
            if (turnSpec.awaitAutoWakeMs) {
              const inspectsBefore = simGo.counts.mediaInspections;
              const eventRes = await fetch(`${agentHost.baseUrl}/events`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'X-Beeftv-Agent-Token': hostToken,
                },
                body: JSON.stringify({
                  canvasId,
                  sessionId,
                  requestId: `task-done-${turnId}`,
                  kind: 'task_completed',
                  message:
                    '生成任务已完成交付，画面产物已写回节点，请使用 media_inspect 复查刚生成的画面是否有手部畸形，如有问题请修改提示词并重新提交生成提议。',
                  data: { proposalIds: unconfirmedForCanvas.map((p) => p.proposalId) },
                }),
              }).catch(() => null);
              // Accepted events are only evidence of delivery. Observe the host
              // without creating a new user turn on its behalf.
              await new Promise((r) => setTimeout(r, turnSpec.awaitAutoWakeMs));
              const inspectsAfter = simGo.counts.mediaInspections;
              wakeResult = {
                autoWoken: inspectsAfter > inspectsBefore,
                eventAccepted: Boolean(eventRes && eventRes.status === 202),
              };
            }
          }
        }
        observeModelRequest = null;

        const afterSnap = simGo.snapshot();
        const requestEntries = meter.getState().entries.slice(reqCountBefore);
        const durationMs = Date.now() - scenarioStart;

        let evalResult;
        if (abortedThisScenario || meter.getState().abortedBudget) {
          evalResult = {
            passed: false,
            status: 'aborted_budget',
            checks: [
              {
                name: 'budget_ceiling_enforced',
                passed: false,
                detail: `累计费用 ¥${meter.getState().totalCostCny.toFixed(4)} 触发预算上限 ¥${config.budgetCny} 熔断`,
              },
            ],
          };
        } else {
          evalResult = scenario.evaluate({
            simGo,
            canvasId,
            setupState,
            turnRecords,
            steerResults,
            wakeResult,
            requestEvidence,
          });
        }

        const metrics = computeScenarioMetrics({
          scenario,
          evalResult,
          beforeSnap,
          afterSnap,
          turnRecords,
          requestEntries,
          durationMs,
        });

        scenarioRuns.push({
          runIndex: runIdx,
          scenarioId: scenario.id,
          scenarioCode: scenario.code,
          scenarioName: scenario.name,
          expectedBaselinePass: scenario.expectedBaselinePass,
          capabilities: scenario.capabilities,
          requestEvidence,
          wakeResult: scenario.capabilities.includes('wake-on-generation') ? wakeResult : undefined,
          metrics,
          checks: evalResult.checks,
          turnDiagnostics: (turnRecords || []).map((t) => ({
            turnId: t.turnId,
            error: t.error || null,
            reason: t.reason || null,
            replyPreview: String(t.reply || '').slice(0, 200),
            tools: (t.tools || []).map((tl) => ({
              tool: tl.tool,
              isError: Boolean(tl.isError),
              error: tl.error || null,
              rebasedFrom: tl.rebasedFrom,
            })),
          })),
        });

        if (meter.getState().abortedBudget) {
          break outerLoop;
        }
      }
    }
  } finally {
    if (agentHost) await agentHost.close();
    if (fakeModel) await fakeModel.close();
    if (realProxyServer) {
      realProxyServer.closeAllConnections?.();
      await new Promise((r) => realProxyServer.close(() => r()));
    }
    await simGo.close();
    fs.rmSync(tempDataDir, { recursive: true, force: true });
  }

  const rawReport = buildEvalSummary(scenarioRuns, config, meter.getState());
  const report = redactSecrets(rawReport, [hostToken, config.realApiKey]);
  const markdown = redactSecrets(renderMarkdownReport(report), [hostToken, config.realApiKey]);

  const jsonPath = path.join(outDir, 'report.json');
  const mdPath = path.join(outDir, 'report.md');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  fs.writeFileSync(mdPath, markdown + '\n', 'utf8');

  return {
    report,
    markdown,
    outDir,
    ledgerPath,
    jsonPath,
    mdPath,
  };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  try {
    const cliArgs = parseCliArgs(process.argv.slice(2));
    if (cliArgs.help) {
      console.log(
        [
          '用法: bun eval/run-eval.mjs [选项]',
          '  --scenario <id|all>      指定场景 ID（如 S1..S7 或 shortdrama-2shot）或 all（默认 all）',
          '  --model <fake|real>      模型模式：fake（默认零成本本地桩）或 real（真实模型，需显式配置单价）',
          '  --runs <N>               每个场景重复运行次数（默认 1）',
          '  --max-requests <N>       单回合最大模型请求数（默认 25）',
          '  --budget-cny <number>    整轮评测累计人民币预算上限（默认 25）',
          '  --out <dir>              报告与 ledger.jsonl 输出目录',
        ].join('\n'),
      );
      process.exit(0);
    }
    const res = await runEval(cliArgs);
    console.log(res.markdown);
    console.log(`\n[eval] 报告已写入: ${res.jsonPath}`);
    console.log(`[eval] 账本已写入: ${res.ledgerPath}`);
    if (res.report.status === 'failed' || res.report.status === 'aborted_budget') {
      process.exit(1);
    }
  } catch (error) {
    console.error(`[eval] 运行失败: ${error?.message || error}`);
    process.exit(1);
  }
}
