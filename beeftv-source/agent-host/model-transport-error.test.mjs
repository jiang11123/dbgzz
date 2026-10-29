import {test, expect} from 'bun:test';
import {runDurableNodeCases} from './durable-node-test-runner.mjs';

test('terminal model transport failures and Stop use official Durable over real HTTP', async () => {
  expect(await runDurableNodeCases('./model-transport-error-cases.mjs')).toContain('fail 0');
}, 90000);
