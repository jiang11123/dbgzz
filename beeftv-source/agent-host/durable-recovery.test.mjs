import { test, expect } from 'bun:test';
import { runDurableNodeCases } from './durable-node-test-runner.mjs';
test('official Durable recovery reads do not replay a live or concurrent admission', async () => {
  expect(await runDurableNodeCases('./durable-recovery-cases.mjs')).toContain('fail 0');
}, 90000);
