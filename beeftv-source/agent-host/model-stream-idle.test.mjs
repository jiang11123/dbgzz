import {test, expect} from 'bun:test';
import {runDurableNodeCases} from './durable-node-test-runner.mjs';
test('real HTTP SSE body idle uses official Node runtime',async()=>{
  expect(await runDurableNodeCases('./model-stream-idle-cases.mjs')).toContain('fail 0');
},90000);
