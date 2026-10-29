import { test, expect } from 'bun:test';
import { runDurableNodeCases } from './durable-node-test-runner.mjs';

test('skills follow the Durable transcript across turns and restart; thinking reaches requests', async () => {
  expect(await runDurableNodeCases('./durable-skills-cases.mjs')).toContain('fail 0');
}, 90000);
