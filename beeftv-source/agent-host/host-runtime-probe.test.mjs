import { beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let receipt;
beforeAll(() => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'beeftv runtime receipt '));
  try {
    const output = path.join(scratch, 'receipt.json');
    const child = spawnSync('node', [path.join(root, 'agent-host/test-support/host-runtime-probe.mjs'), root, output], { cwd: root, encoding: 'utf8', timeout: 150000 });
    if (child.error) throw child.error;
    receipt = JSON.parse(readFileSync(output, 'utf8'));
    if (!receipt.results?.length) throw new Error('Runtime probe returned no scenario results');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 170000);

describe('真实 Node 与 pi SDK 的隔离执行链（模型和操作端点均为本地替身）', () => {
  for (const name of [
    'budget-exhaustion-is-an-explicit-failed-turn',
    'new-turn-after-budget-exhaustion-still-works',
    'asset-tool-does-not-inject-unknown-canvasId',
    'explicit-reference-canvas-can-reach-backend-read-guard',
  ]) {
    test(name, () => {
      const result = receipt.results.find((item) => item.name === name);
      expect(result, JSON.stringify(receipt.results)).toBeDefined();
      expect(result.passed, result.error).toBe(true);
    });
  }
});
