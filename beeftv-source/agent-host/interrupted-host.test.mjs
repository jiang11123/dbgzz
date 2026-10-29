import { expect, test } from 'bun:test';
import { projectTurnHistory } from './canvas-turn.mjs';

// 旧 JSONL 会话执行运行时已退役；这里只保留只读历史投影的确定性用例。
// Durable 会话的硬杀恢复由 durable-session-owner-cases.mjs 覆盖。
const kind = 'beeftv.canvas.turn';
test('running journal entries stay hidden and completed entries replace their starts once', () => {
  const start = { type:'custom',customType:kind+'.started',data:{turnId:'aa',userText:'original'} };
  const end = { type:'custom',customType:kind,data:{turnId:'aa',userText:'original',reply:'done'} };
  expect(projectTurnHistory([start],kind,'aa')).toEqual([]);
  expect(projectTurnHistory([start],kind)[0].errorReason).toBe('turn_interrupted');
  expect(projectTurnHistory([start,end],kind)).toEqual([end.data]);
});
