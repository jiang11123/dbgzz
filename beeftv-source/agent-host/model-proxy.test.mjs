import {test,expect} from 'bun:test';
import {runDurableNodeCases} from './durable-node-test-runner.mjs';
test('actual host and official SDK honor the Node proxy environment',async()=>{
  expect(await runDurableNodeCases('./model-proxy-cases.mjs')).toContain('fail 0');
},120000);
