import { expect, test } from 'bun:test';
import { runDurableNodeCases } from './durable-node-test-runner.mjs';

test('official Durable composes timeline delivery without model polling or hidden CAS overrides', async () => {
  expect(await runDurableNodeCases('./durable-timeline-delivery-cases.mjs')).toContain('fail 0');
}, 60000);
