import { expect, test } from 'bun:test';
import { businessLifecycle } from './business-progress.mjs';
import { durableLifecycleState, durableStreamEvents } from './durable-session-owner.mjs';

test('only our closed business progress reaches streams and reconnect snapshots', () => {
  const details = { beeftvProgress: { stage: 'saving', total: 3, saved: 2, error: 'synthetic-private', url: 'https://private.invalid' } };
  const progress = { type: 'lifecycle', phase: 'business', toolName: 'canvas_generation_submit', stage: 'saving', total: 3, saved: 2 };
  const event = { type: 'tool_execution_update', toolName: 'canvas_generation_submit', details };
  expect(durableStreamEvents(event)).toEqual([progress]);
  expect(durableLifecycleState(null, event)).toEqual(progress);
  expect(durableStreamEvents({ type: 'snapshot', tools: [], nestedTools: [{ name: event.toolName, status: 'running', details }] })).toEqual([progress]);
  expect(JSON.stringify(progress)).not.toContain('private');
  expect(businessLifecycle('other_tool', details)).toBeNull();
  expect(businessLifecycle(event.toolName, { beeftvProgress: { stage: 'provider-raw' } })).toBeNull();
  expect(businessLifecycle(event.toolName, { beeftvProgress: { stage: 'saving', total: 1, saved: 2 } })).toEqual({ ...progress, total: undefined, saved: undefined });
});

test('background details cannot erase a retry and matching business completion clears progress', () => {
  const retry = { type: 'lifecycle', phase: 'retry', reason: 'timeout' };
  expect(durableLifecycleState(retry, { type: 'tool_execution_update', toolName: 'other', details: {} })).toEqual(retry);
  const progress = { type: 'lifecycle', phase: 'business', toolName: 'canvas_timeline_deliver', stage: 'exporting' };
  expect(durableLifecycleState(progress, { type: 'tool_execution_end', toolName: 'other' })).toEqual(progress);
  expect(durableLifecycleState(progress, { type: 'tool_execution_end', toolName: progress.toolName })).toEqual({ type: 'lifecycle', phase: 'tool_end', toolName: progress.toolName });
});
