import { expect, test } from 'bun:test';
import { runDurableNodeCases } from './durable-node-test-runner.mjs';

test('official Durable serializes independent writes from one model response without hiding foreign edits', async () => {
  expect(await runDurableNodeCases('./durable-write-batch-cases.mjs')).toContain('fail 0');
}, 45000);
