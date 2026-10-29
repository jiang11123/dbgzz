import { test, expect } from 'bun:test';
import { runDurableNodeCases } from './durable-node-test-runner.mjs';

test('official model switch and frozen SIGKILL recovery', async () => {
  expect(await runDurableNodeCases('./durable-model-switch-cases.mjs')).toContain('fail 0');
}, 70000);
