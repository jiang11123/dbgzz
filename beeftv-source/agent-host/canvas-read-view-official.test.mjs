import { test, expect } from 'bun:test';
import { runDurableNodeCases } from './durable-node-test-runner.mjs';

test('official Durable actually transports bounded canvas JSON and field reads', async () => {
  expect(await runDurableNodeCases('./canvas-read-view-official-cases.mjs')).toContain('fail 0');
}, 45000);
