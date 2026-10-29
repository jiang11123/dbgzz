import {test,expect} from 'bun:test';
import {runDurableNodeCases} from './durable-node-test-runner.mjs';
test('official Durable automatic continuation identity and cancellation cases',async()=>{
  expect(await runDurableNodeCases('./durable-continuation-cases.mjs')).toContain('fail 0');
},200000);
