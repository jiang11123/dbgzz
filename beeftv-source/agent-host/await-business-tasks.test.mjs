import { test, expect } from 'bun:test';
import { awaitBusinessTasks } from './await-business-tasks.mjs';

test('generation wait observes original tasks through materialization and canvas binding without resubmitting', async () => {
  let reads=0, bindings=0;
  const paths=[];
  const data={revision:2,result:{revision:2,canvasId:'canvas',taskIds:['accepted-task'],nodeIds:['shot'],status:'submitted'}};
  const result=await awaitBusinessTasks(data,{canvasId:'canvas',turnId:'turn',intervalMs:1,opsRequest:async(method,path,body)=>{
    paths.push(path);
    if(path==='/ops/task.get') {expect(body.params.taskId).toBe('accepted-task');reads++;return {result:reads===1?{status:'succeeded',outputs:[]}:{status:'succeeded',outputs:[{resourceId:'saved-media'}]}};}
    bindings++;return {result:{canvas:{revision:bindings+2,nodes:bindings===1?[]:[{id:'shot',metadata:{taskId:'accepted-task',status:'success',storageKey:'resource:saved-media'}}]}}};
  }});
  expect(result.result.status).toBe('succeeded');expect(reads).toBe(3);expect(bindings).toBe(2);
  expect(result.revision).toBe(4);expect(result.result.revision).toBe(4);
  expect(data.revision).toBe(2);expect(data.result.revision).toBe(2);
  expect(paths.every(path=>['/ops/task.get','/ops/canvas.get'].includes(path))).toBe(true);
});

test('failed accepted task is returned with its original identity and no retry',async()=>{
  let calls=0;
  const result=await awaitBusinessTasks({result:{taskIds:['original']}},{opsRequest:async()=>{calls++;return {result:{taskId:'original',status:'failed',outputs:[]}};}});
  expect(calls).toBe(1);expect(result.result.status).toBe('failed');expect(result.result.taskIds).toEqual(['original']);
});

test('stop aborts the waiting observer without purchasing a replacement',async()=>{
  const controller=new AbortController();let calls=0;
  const promise=awaitBusinessTasks({result:{taskIds:['original']}},{signal:controller.signal,intervalMs:1,opsRequest:async()=>{calls++;controller.abort();return {result:{status:'running'}};}});
  await expect(promise).rejects.toThrow();expect(calls).toBe(1);
});

test('a failed sibling waits for admitted successful files and emits only changing progress', async () => {
  let reads = 0;
  const progress = [];
  const result = await awaitBusinessTasks({ result: { taskIds: ['failed', 'saving'] } }, {
    intervalMs: 1, onProgress: async value => progress.push(value),
    opsRequest: async (_method, path, body) => {
      expect(path).toBe('/ops/task.get');
      if (body.params.taskId === 'failed') return { result: { status: 'failed' } };
      return { result: { status: 'succeeded', outputs: ++reads < 3 ? [] : [{ resourceId: 'original-saved' }] } };
    },
  });
  expect(reads).toBe(3);
  expect(result.result.status).toBe('failed');
  expect(result.result.taskIds).toEqual(['failed', 'saving']);
  expect(progress).toEqual([{ stage: 'saving', saved: 0, total: 2 }]);
});

test('a recorded save failure returns the original task immediately without polling or generation', async () => {
  let calls = 0;
  const result = await awaitBusinessTasks({ result: { taskIds: ['original'] } }, { opsRequest: async () => {
    calls++;
    return { result: { status: 'succeeded', outputs: [{ materializationErrorCode: 'download_failed' }] } };
  } });
  expect(calls).toBe(1);
  expect(result.result.taskIds).toEqual(['original']);
  expect(result.result.status).toBe('incomplete');
  expect(result.result.materializationFailed).toBe(true);
});

test('transfer, saving and saved progress follow canonical original task state', async () => {
  const states = [
    { status: 'succeeded', outputs: [], delivery: { outputs: [{ state: 'retrying' }] } },
    { status: 'succeeded', outputs: [{ outputIndex: 0 }] },
    { status: 'succeeded', outputs: [{ resourceId: 'original-resource' }] },
  ];
  const progress = [];
  const result = await awaitBusinessTasks({ result: { taskIds: ['original'] } }, {
    intervalMs: 1, onProgress: async value => progress.push(value.stage),
    opsRequest: async (_method, path, body) => {
      expect(path).toBe('/ops/task.get');
      expect(body.params.taskId).toBe('original');
      return { result: states.shift() };
    },
  });
  expect(result.result.status).toBe('succeeded');
  expect(progress).toEqual(['downloading', 'saving', 'saved']);
});

test('a failed progress commit still returns the admitted task identity', async () => {
  let calls = 0;
  const result = await awaitBusinessTasks({ result: { taskIds: ['original'] } }, {
    onProgress: async () => { throw new Error('fixture progress storage unavailable'); },
    opsRequest: async () => { calls++; return { result: { status: 'running' } }; },
  });
  expect(calls).toBe(1);
  expect(result.result.taskIds).toEqual(['original']);
  expect(result.result.status).toBe('pending');
  expect(result.result.observationFailed).toBe(true);
});
