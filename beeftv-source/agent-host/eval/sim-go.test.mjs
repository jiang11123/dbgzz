import { test, expect, describe } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createSimGo } from './sim-go.mjs';
import { SCENARIOS, resolveScenarioList, buildS3SeedCanvas } from './scenarios.mjs';
import {
  parseCliArgs,
  validateEvalConfig,
  redactSecrets,
  createCostMeter,
  computeScenarioMetrics,
  runEval,
} from './run-eval.mjs';

describe('sim-go 内存版 Go 业务权威模拟器测试', () => {
  test('支持 /api/ops、画布 CRUD、CAS revision 冲突检测与 opId 幂等重放', async () => {
    const sim = createSimGo({ hostToken: 'secret-token' });
    await sim.listen(0);
    try {
      // 未授权 token 应被拒绝
      const unauth = await fetch(`${sim.opsUrl}/ops`, {
        headers: { 'X-Beeftv-Agent-Token': 'wrong-token' },
      });
      expect(unauth.status).toBe(403);

      // 正常获取描述符
      const opsRes = await fetch(`${sim.opsUrl}/ops`, {
        headers: { 'X-Beeftv-Agent-Token': 'secret-token' },
      });
      expect(opsRes.status).toBe(200);
      const opsJson = await opsRes.json();
      expect(opsJson.code).toBe(0);
      expect(opsJson.data.ops.length).toBeGreaterThan(10);

      // 读取初始画布 revision=1
      const get1 = sim.executeOp('canvas.get', { canvasId: 'canvas-1' });
      expect(get1.result.canvas.revision).toBe(1);

      // 创建节点成功推进到 revision=2，且相同 opId 重放不重复创建
      const create1 = sim.executeOp(
        'canvas.nodes.create',
        {
          canvasId: 'canvas-1',
          expectedRevision: 1,
          nodes: [
            { type: 'script', title: '分镜脚本' },
            { type: 'image', title: '镜 1 首帧', prompt: '雨夜霓虹街头' },
            { type: 'video', title: '镜 1 视频', prompt: '镜头缓推' },
          ],
        },
        'op-create-1',
        'turn-1',
      );
      expect(create1.replayed).toBe(false);
      expect(create1.result.revision).toBe(2);
      expect(create1.result.created.length).toBe(3);

      const replay1 = sim.executeOp(
        'canvas.nodes.create',
        {
          canvasId: 'canvas-1',
          expectedRevision: 1,
          nodes: [
            { type: 'script', title: '分镜脚本' },
            { type: 'image', title: '镜 1 首帧', prompt: '雨夜霓虹街头' },
            { type: 'video', title: '镜 1 视频', prompt: '镜头缓推' },
          ],
        },
        'op-create-1',
        'turn-1',
      );
      expect(replay1.replayed).toBe(true);
      expect(replay1.result.revision).toBe(2);

      // 过期 expectedRevision=1 写操作触发 CAS revision_conflict
      expect(() =>
        sim.executeOp(
          'canvas.node.update',
          {
            canvasId: 'canvas-1',
            nodeId: create1.result.created[1].id,
            expectedRevision: 1,
            patch: { content: '新提示词' },
          },
          'op-stale-1',
        ),
      ).toThrow(/画布已变化/);
      expect(sim.counts.revisionConflicts).toBe(1);

      // 用户手动编辑模拟推进 revision，随后旧版本写入被拒
      const afterUserEdit = sim.userEditNode(create1.result.created[1].id, { content: '用户手改提示词' }, 'canvas-1');
      expect(afterUserEdit.revision).toBe(3);
      expect(sim.counts.userEdits).toBe(1);
    } finally {
      await sim.close();
    }
  });

  test('分镜行增删改与 imageNodeId/videoNodeId 产出连线绑定一致性', () => {
    const sim = createSimGo();
    const created = sim.executeOp(
      'canvas.nodes.create',
      {
        canvasId: 'canvas-1',
        expectedRevision: 1,
        nodes: [
          { type: 'script', title: '分镜脚本' },
          { type: 'image', title: '镜 1 首帧', prompt: '首帧A' },
          { type: 'image', title: '镜 1 备选首帧', prompt: '首帧B' },
          { type: 'video', title: '镜 1 视频', prompt: '视频A' },
        ],
      },
      'op-init',
    ).result.created;

    const [scriptNode, img1, img2, vid1] = created;

    const appended = sim.executeOp(
      'canvas.script.rows.append',
      {
        canvasId: 'canvas-1',
        nodeId: scriptNode.id,
        expectedRevision: 2,
        rows: [
          { durationSeconds: 5, plotDescription: '第一镜', dialogue: '台词1' },
          { durationSeconds: 5, plotDescription: '第二镜', dialogue: '台词2' },
        ],
      },
      'op-append',
    ).result;
    expect(appended.rowCount).toBe(2);
    const row1Id = appended.created[0].id;
    const row2Id = appended.created[1].id;

    // 绑定 row1 -> img1 与 vid1，应自动创建两条 storyboard-output 连线
    const update1 = sim.executeOp(
      'canvas.script.row.update',
      {
        canvasId: 'canvas-1',
        nodeId: scriptNode.id,
        expectedRevision: 3,
        patches: [{ rowId: row1Id, imageNodeId: img1.id, videoNodeId: vid1.id }],
      },
      'op-row-bind-1',
    ).result;
    expect(update1.createdEdgeIds.length).toBe(2);

    // 改绑 row1 -> img2，旧 img1 连线应被自动替换删除
    const update2 = sim.executeOp(
      'canvas.script.row.update',
      {
        canvasId: 'canvas-1',
        nodeId: scriptNode.id,
        expectedRevision: 4,
        patches: [{ rowId: row1Id, imageNodeId: img2.id }],
      },
      'op-row-bind-2',
    ).result;
    expect(update2.createdEdgeIds.length).toBe(1);
    expect(update2.deletedEdgeIds.length).toBe(1);

    // 删除 row1，其关联的产出连线也一并清除，剩余行重新编号为 1
    const removed = sim.executeOp(
      'canvas.script.row.remove',
      {
        canvasId: 'canvas-1',
        nodeId: scriptNode.id,
        expectedRevision: 5,
        rowIds: [row1Id],
      },
      'op-row-remove',
    ).result;
    expect(removed.rowCount).toBe(1);
    expect(removed.deletedEdgeIds.length).toBe(2);

    const doc = sim.executeOp('canvas.get', { canvasId: 'canvas-1' }).result.canvas;
    const remainingRows = doc.nodes.find((n) => n.id === scriptNode.id).metadata.storyboard.rows;
    expect(remainingRows.length).toBe(1);
    expect(remainingRows[0].id).toBe(row2Id);
    expect(remainingRows[0].shotNumber).toBe(1);
  });

  test('绑定和解绑首帧保留同一分镜行的动作演示板连线', () => {
    const sim = createSimGo();
    const canvasId = 'canvas-action-board';
    sim.ensureCanvas(canvasId, {
      id: canvasId, revision: 1,
      nodes: [
        { id: 'script', type: 'script', metadata: { storyboard: { rows: [{ id: 'row-1' }] } } },
        { id: 'board', type: 'image', metadata: { workflowKind: 'action_board' } },
        { id: 'frame', type: 'image', metadata: {} },
      ],
      connections: [{ id: 'board-edge', fromNodeId: 'script', toNodeId: 'board', fromHandleId: 'row:row-1' }],
    });
    for (const [index, imageNodeId] of ['frame', ''].entries()) {
      const result = sim.executeOp('canvas.script.row.update', {
        canvasId, nodeId: 'script', expectedRevision: index + 1,
        patches: [{ rowId: 'row-1', imageNodeId }],
      }, `bind-frame-${index}`).result;
      expect(result.deletedEdgeIds).not.toContain('board-edge');
      const doc = sim.ensureCanvas(canvasId);
      expect(doc.connections.some((edge) => edge.id === 'board-edge')).toBe(true);
      expect(doc.connections.filter((edge) => edge.toNodeId === 'frame').length).toBe(imageNodeId ? 1 : 0);
    }
  });

  test('生成提议确认、失败模拟、缺陷画面 media.inspect 及回合撤销 undo', async () => {
    const sim = createSimGo({ taskDelayMs: 5 });
    await sim.listen(0);
    try {
      sim.beginTurn({ turnId: 'turn-gen-1', canvasId: 'canvas-1' });
      const created = sim.executeOp(
        'canvas.nodes.create',
        {
          canvasId: 'canvas-1',
          expectedRevision: 1,
          nodes: [
            { type: 'image', title: '镜 1 首帧', prompt: '雨夜侦探特写' },
            { type: 'image', title: '镜 2 首帧', prompt: '暗巷追逐' },
          ],
        },
        'op-c1',
        'turn-gen-1',
      ).result.created;

      // 拒绝未经确认的直接生成任务请求
      const unconfirmedRes = await fetch(`${sim.baseUrl}/api/generation-tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canvasId: 'canvas-1', nodeId: created[0].id, ConfirmedByUser: false }),
      });
      expect(unconfirmedRes.status).toBe(403);
      expect(sim.counts.unconfirmedTasks).toBe(1);

      // 发起生成提议
      const prop = sim.executeOp(
        'canvas.generation.propose',
        {
          canvasId: 'canvas-1',
          kind: 'image',
          nodeIds: [created[0].id, created[1].id],
          note: '测试提议',
        },
        'op-prop-1',
        'turn-gen-1',
      ).result;
      expect(prop.proposalId).toBeTruthy();

      // 预设第 1 个节点生成画面带六指缺陷，第 2 个节点生成失败
      sim.flagNextTaskDefect('右手六指畸形', created[0].id);
      sim.failNextTask('upstream_timeout', created[1].id);

      const tasks = await sim.confirmProposals(prop.proposalId, { delayMs: 5 });
      expect(tasks.length).toBe(2);
      expect(tasks[0].status).toBe('succeeded');
      expect(tasks[1].status).toBe('failed');

      // media.inspect 读取第 1 个节点，返回合法 PNG 与缺陷说明
      const inspectRes = sim.executeOp('media.inspect', {
        canvasId: 'canvas-1',
        nodeId: created[0].id,
      }).result;
      expect(inspectRes.note).toContain('右手六指畸形');
      expect(inspectRes.content.length).toBe(1);
      const pngBytes = Buffer.from(inspectRes.content[0].data, 'base64');
      const sha = crypto.createHash('sha256').update(pngBytes).digest('hex');
      expect(sha).toBe(inspectRes.content[0].sha256);

      // 撤销回合 turn-gen-1，画布节点回到初始空状态，且再次确认该回合提议会被拒绝
      const undone = sim.undoTurn('turn-gen-1', 'canvas-1');
      expect(undone.undone).toBe(true);
      expect(undone.canvas.nodes.length).toBe(0);
      await expect(sim.confirmProposals(prop.proposalId)).rejects.toThrow(/已撤销/);
    } finally {
      await sim.close();
    }
  });
});

describe('预算门禁、密钥脱敏与评测配置校验测试', () => {
  test('--model real 缺少单价或单价为 0 时拒绝启动', () => {
    const args = parseCliArgs(['--model', 'real', '--scenario', 'S1', '--budget-cny', '10']);
    expect(() => validateEvalConfig(args, {})).toThrow(/real_mode_price_missing/);
    expect(() =>
      validateEvalConfig(args, {
        BEEFTV_EVAL_PRICE_IN: '0',
        BEEFTV_EVAL_PRICE_OUT: '15',
      }),
    ).toThrow(/real_mode_price_missing/);
    expect(() =>
      validateEvalConfig(args, {
        BEEFTV_EVAL_PRICE_IN: '2',
        BEEFTV_EVAL_PRICE_OUT: '8',
      }),
    ).toThrow(/real_mode_credentials_missing/);

    const valid = validateEvalConfig(args, {
      BEEFTV_EVAL_PRICE_IN: '2.5',
      BEEFTV_EVAL_PRICE_OUT: '10',
      BEEFTV_AGENT_BASE_URL: 'https://example.invalid/v1',
      BEEFTV_AGENT_API_KEY: 'sk-test-secret-123456',
      BEEFTV_AGENT_MODEL: 'gpt-test',
    });
    expect(valid.modelMode).toBe('real');
    expect(valid.priceInPerMillion).toBe(2.5);
    expect(valid.priceOutPerMillion).toBe(10);
  });

  test('累计费用超预算上限时立即触发 aborted_budget 熔断并记录 ledger.jsonl', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-meter-test-'));
    const ledgerPath = path.join(tmpDir, 'ledger.jsonl');
    try {
      const meter = createCostMeter({
        mode: 'fake',
        budgetCny: 0.05,
        priceInPerMillion: 100, // 每万 token 1 元
        priceOutPerMillion: 200,
        ledgerPath,
      });
      meter.setContext({ runIndex: 1, scenarioId: 'shortdrama-2shot', turnId: 't1' });

      // 第 1 笔请求花费 0.03 元，未超 0.05 元
      const e1 = meter.recordRequest({ inputTokens: 100, outputTokens: 100, durationMs: 10 });
      expect(e1.costCny).toBeCloseTo(0.03, 5);
      expect(e1.abortedBudget).toBe(false);

      // 第 2 笔请求再花 0.03 元，累计 0.06 元 > 0.05 元，立即抛 aborted_budget
      expect(() => meter.recordRequest({ inputTokens: 100, outputTokens: 100, durationMs: 10 })).toThrow(
        /aborted_budget/,
      );
      expect(meter.getState().abortedBudget).toBe(true);

      // 后续派发前检查也直接拒绝
      expect(() => meter.checkBudgetBeforeDispatch()).toThrow(/aborted_budget/);

      const lines = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n');
      expect(lines.length).toBe(2);
      expect(JSON.parse(lines[1]).abortedBudget).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('redactSecrets 彻底脱敏环境变量密钥、sk-* 与 Bearer Token', () => {
    const raw = {
      apiKey: 'sk-live-9876543210abcdef',
      nested: {
        Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
        note: '调用失败: Bearer secret_token_xyz123 及 key=sk-abcdef1234567890 和 custom-sec-9999',
      },
    };
    const cleaned = redactSecrets(raw, ['custom-sec-9999']);
    const serialized = JSON.stringify(cleaned);
    expect(serialized).not.toContain('sk-live-9876543210abcdef');
    expect(serialized).not.toContain('sk-abcdef1234567890');
    expect(serialized).not.toContain('secret_token_xyz123');
    expect(serialized).not.toContain('custom-sec-9999');
    expect(cleaned.apiKey).toBe('[REDACTED]');
    expect(cleaned.nested.Authorization).toBe('[REDACTED]');
  });

  test('场景选择器与端到端单场景 fake 评测运行通过', async () => {
    expect(resolveScenarioList('all').length).toBe(7);
    expect(resolveScenarioList('S1,S3').map((s) => s.code)).toEqual(['S1', 'S3']);
    expect(buildS3SeedCanvas('c-s3').nodes.length).toBe(9);

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-eval-e2e-'));
    try {
      const res = await runEval({
        scenario: 'S2',
        model: 'fake',
        runs: 1,
        maxRequests: 15,
        budgetCny: 10,
        outDir,
      });
      expect(res.report.status).toBe('passed');
      expect(res.report.scenarios.length).toBe(1);
      expect(res.report.scenarios[0].metrics.passed).toBe(true);
      expect(fs.existsSync(res.jsonPath)).toBe(true);
      expect(fs.existsSync(res.mdPath)).toBe(true);
      expect(fs.existsSync(res.ledgerPath)).toBe(true);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('已知自动唤醒缺口不能掩盖首轮失败或完成事件投递失败', () => {
    const scenario = SCENARIOS.find((item) => item.code === 'S5');
    const simGo = createSimGo();
    scenario.setup(simGo, 'canvas-s5');
    const result = scenario.evaluate({ simGo, canvasId: 'canvas-s5', wakeResult: { eventAccepted: true, autoWoken: false } });
    expect(result.status).toBe('failed');
    const rejectedEvent = scenario.evaluate({ simGo, canvasId: 'canvas-s5', wakeResult: { eventAccepted: false, autoWoken: false } });
    expect(rejectedEvent.status).toBe('failed');
    expect(rejectedEvent.capabilityGap).toBeNull();
  });

  test('事件自动唤醒与用户复查分别计分，技能仅首轮激活后仍进入后续请求', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-eval-truth-'));
    try {
      const { report, markdown } = await runEval({
        scenario: 'S5,S6,S7', model: 'fake', runs: 1, maxRequests: 20, budgetCny: 10, outDir,
      });
      expect(report.status).toBe('baseline_gap');
      const [auto, skill, userReview] = report.scenarios;
      expect(auto.expectedBaselinePass).toBe(false);
      expect(auto.wakeResult).toEqual({ autoWoken: false, eventAccepted: true });
      expect(auto.metrics.status).toBe('baseline_gap');
      expect(auto.metrics.turnCount).toBe(1);
      expect(auto.metrics.mediaInspections).toBe(0);
      expect(skill.scenarioId).toBe('skill-across-turns');
      expect(skill.metrics.passed).toBe(true);
      expect(skill.requestEvidence.every((entry) => entry.activeSkillPresent)).toBe(true);
      expect(SCENARIOS.find((scenario) => scenario.code === 'S6').turns.filter((turn) => turn.useActiveSkillPins).length).toBe(1);
      expect(userReview.metrics.passed).toBe(true);
      expect(userReview.metrics.turnCount).toBe(2);
      expect(userReview.metrics.mediaInspections).toBe(2); // overview + versioned inspect
      expect(userReview.metrics.unconfirmedGenerationCount).toBe(0);
      expect(markdown).not.toContain('多轮压缩后技能规则保持率');
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }, 30_000);
});
