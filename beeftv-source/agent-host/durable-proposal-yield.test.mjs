import { expect, test } from 'bun:test';
import { runDurableNodeCases } from './durable-node-test-runner.mjs';

test('official Durable proposal termination preserves acknowledgement, input and recovery contracts', async () => {
  expect(await runDurableNodeCases('./durable-proposal-yield-cases.mjs')).toContain('fail 0');
}, 90000);
