import { test, expect } from 'bun:test';
import { runDurableNodeCases } from './durable-node-test-runner.mjs';
test('official Durable Node SQLite crash, replay, steering, stop and history cases', async () => {
  expect(await runDurableNodeCases('./durable-session-owner-cases.mjs')).toContain('fail 0');
}, 200000);
