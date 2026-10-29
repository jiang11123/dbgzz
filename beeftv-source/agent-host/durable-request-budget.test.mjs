import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
test('durable request budget survives real host crashes and filesystem faults', () => {
  const result = spawnSync('node', [root + 'agent-host/test-support/durable-budget-probe.mjs', root], { encoding: 'utf8', timeout: 240000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 250000);
