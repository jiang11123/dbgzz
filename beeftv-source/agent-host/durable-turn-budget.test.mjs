import { test, expect } from 'bun:test';
import { runDurableNodeCases } from './durable-node-test-runner.mjs';
test('persistent per-turn counters use isolated official Node runner', async () => {
  expect(await runDurableNodeCases('./durable-turn-budget-cases.mjs')).toContain('fail 0');
}, 90000);
