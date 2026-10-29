import { describe, expect, test } from 'bun:test';
import { durableLifecycleState, durableRetryReason, durableStreamEvents } from './durable-session-owner.mjs';
import { createDurableTextProjection } from './durable-stream-text.mjs';

const SECRET = 'sk-synthetic-upstream-secret';

describe('official Durable events projected to the panel stream', () => {
  test('tool events keep their existing lines and plans carry the committed value', () => {
    expect(durableStreamEvents({ type: 'plan', plan: null })).toEqual([{ type: 'plan', plan: null }]);
    expect(durableStreamEvents({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'media_inspect', args: {} }))
      .toEqual([{ type: 'lifecycle', phase: 'tool', toolName: 'media_inspect' }]);
    expect(durableStreamEvents({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'media_inspect' }))
      .toEqual([{ type: 'lifecycle', phase: 'tool_end', toolName: 'media_inspect' }]);
  });

  test('official retry start/end become retry lifecycle with a classified reason and no upstream text', () => {
    const start = durableStreamEvents({ type: 'auto_retry_start', attempt: 1, at: 1791374400000, errorMessage: `503 upstream detail ${SECRET}` });
    expect(start).toEqual([{ type: 'lifecycle', phase: 'retry', attempt: 1, reason: 'provider_unavailable' }]);
    expect(JSON.stringify(start)).not.toContain(SECRET);
    expect(durableStreamEvents({ type: 'auto_retry_end', attempt: 1 })).toEqual([{ type: 'lifecycle', phase: 'retry_end', attempt: 1 }]);
  });

  test('only the matching official tool result confirms success and never forwards its payload', () => {
    const event = { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'canvas_node_configure', entry: { model: [
      { role: 'toolResult', toolCallId: 'c1', toolName: 'canvas_node_configure', isError: false, content: [{ type: 'text', text: SECRET }] },
    ] } };
    expect(durableStreamEvents(event)[0]).toEqual({ type: 'lifecycle', phase: 'tool_end', toolName: 'canvas_node_configure', success: true });
    expect(JSON.stringify(durableStreamEvents(event))).not.toContain(SECRET);
    event.entry.model[0].isError = true;
    expect(durableStreamEvents(event)[0].success).toBe(false);
    event.entry.model[0].toolCallId = 'other';
    expect(durableStreamEvents(event)[0]).not.toHaveProperty('success');
    expect(durableStreamEvents({ ...event, entry: undefined })[0]).not.toHaveProperty('success');
  });

  test('blocking compaction is visible, background work cannot replace foreground progress', () => {
    const tool = { type: 'lifecycle', phase: 'tool', toolName: 'media_inspect' };
    const start = { type: 'compaction_start', taskId: 42, blocking: true };
    const busy = durableLifecycleState(tool, start);
    expect(busy).toEqual({ type: 'lifecycle', phase: 'compaction', taskId: 42 });
    expect(durableStreamEvents({ ...start, blocking: false }, tool)).toEqual([]);
    expect(durableLifecycleState(tool, { ...start, blocking: false })).toEqual(tool);
    expect(durableStreamEvents({ type: 'compaction_end', taskId: 99 }, busy)).toEqual([]);
    expect(durableLifecycleState(busy, { type: 'compaction_end', taskId: 99 })).toEqual(busy);
    expect(durableStreamEvents({ type: 'compaction_end', taskId: 42, error: SECRET }, busy)).toEqual([{ type: 'lifecycle', phase: 'compaction_end', success: false }]);
    expect(durableLifecycleState(busy, { type: 'compaction_end', taskId: 42 })).toBeNull();
    expect(durableStreamEvents({ type: 'snapshot', compactions: [{ taskId: 42, blocking: true }], tools: [] })).toEqual([busy]);
  });

  test('a snapshot taken during backoff or a running tool restores that progress', () => {
    const backoff = { type: 'snapshot', entries: [], tools: [], generation: { attempt: 2, retry: { at: 1, error: `429 Too Many Requests ${SECRET}` } } };
    expect(durableStreamEvents(backoff)).toEqual([{ type: 'lifecycle', phase: 'retry', attempt: 2, reason: 'rate_limited' }]);
    expect(JSON.stringify(durableStreamEvents(backoff))).not.toContain(SECRET);
    const tool = { type: 'snapshot', entries: [], tools: [{ callId: 'c1', name: 'media_overview', status: 'running' }] };
    expect(durableStreamEvents(tool)).toEqual([{ type: 'lifecycle', phase: 'tool', toolName: 'media_overview' }]);
    expect(durableStreamEvents({ type: 'snapshot', entries: [], tools: [{ callId: 'c1', name: 'media_overview', status: 'done' }] })).toEqual([]);
  });

  test('retry reasons are a closed set', () => {
    for (const [message, reason] of [
      ['stream idle timeout after 95000ms', 'timeout'], ['Request timed out.', 'timeout'],
      ['429 rate limit reached', 'rate_limited'], ['Too Many Requests', 'rate_limited'],
      ['503 Service Unavailable', 'provider_unavailable'], ['overloaded_error', 'provider_unavailable'], ['502 Bad Gateway', 'provider_unavailable'],
      ['fetch failed', 'network'], ['socket hang up', 'network'], ['terminated', 'network'], ['Connection error.', 'network'],
      ['unexpected provider wording', 'model_error'], [undefined, 'model_error'],
    ]) expect(durableRetryReason(message)).toBe(reason);
  });
});

describe('Durable visible text projection', () => {
  const assistant = (text) => ({ role: 'assistant', content: [{ type: 'thinking', thinking: SECRET }, { type: 'text', text }] });
  const entry = (id, text) => ({ id, model: [assistant(text)] });
  test('an unobserved projection is distinct from an official empty snapshot', () => {
    const projection = createDurableTextProjection();
    expect(projection.initialized).toBe(false);
    expect(projection.accept({ type: 'snapshot', afterEntry: 10, entries: [entry(8, 'previous turn')], tools: [] }))
      .toEqual({ type: 'text_snapshot', text: '' });
    expect(projection.initialized).toBe(true);
  });
  test('initial partial, text starts, deltas, whole replacements and final-only suffix are all retained once', () => {
    const projection = createDurableTextProjection();
    projection.accept({ type: 'snapshot', afterEntry: 10, entries: [entry(8, 'previous turn')], tools: [] });
    expect(projection.accept({ type: 'message_start', message: assistant('开头') })).toEqual({ type: 'text_snapshot', text: '开头' });
    projection.accept({ type: 'message_update', changes: [{ type: 'text_delta', contentIndex: 1, delta: '中段' }] });
    expect(projection.text).toBe('开头中段');
    projection.accept({ type: 'message_update', changes: [{ type: 'text_start', contentIndex: 2, block: { type: 'text', text: '新段' } }] });
    expect(projection.text).toBe('开头中段新段');
    projection.accept({ type: 'message_update', changes: [{ type: 'block', contentIndex: 2, block: { type: 'text', text: '修订段' } }] });
    expect(projection.text).toBe('开头中段修订段');
    projection.accept({ type: 'message_update', changes: [{ type: 'message', message: assistant('完整替换') }] });
    expect(projection.accept({ type: 'message_end', entry: entry(12, '完整替换和尾部') })).toEqual({ type: 'text_snapshot', text: '完整替换和尾部' });
    expect(projection.accept({ type: 'message_end', entry: entry(12, '完整替换和尾部') })).toBeNull();
    expect(projection.text).not.toContain(SECRET);
  });
  test('late attachment and overflow snapshots restore only this turn without duplication', () => {
    const projection = createDurableTextProjection();
    const snapshot = { type: 'snapshot', afterEntry: 10, entries: [entry(8, 'previous turn'), entry(12, '工具前说明')], generation: { message: assistant('当前开头') } };
    expect(projection.accept(snapshot)?.text).toBe('工具前说明\n\n当前开头');
    projection.accept({ type: 'message_update', changes: [{ type: 'text_delta', contentIndex: 1, delta: '中段' }] });
    expect(snapshot.generation.message.content[1].text).toBe('当前开头');
    projection.accept({ type: 'snapshot', entries: [entry(8, 'previous turn'), entry(12, '工具前说明'), entry(15, '当前开头中段尾部')], generation: { message: assistant('继续处理') } });
    expect(projection.text).toBe('工具前说明\n\n当前开头中段尾部\n\n继续处理');
    projection.accept({ type: 'message_end', entry: entry(16, '继续处理完成') });
    expect(projection.text).toBe('工具前说明\n\n当前开头中段尾部\n\n继续处理完成');
    expect(projection.text).not.toContain('previous turn');
  });
});

describe('latest transient progress kept for history polling', () => {
  const retry = { type: 'lifecycle', phase: 'retry', attempt: 1, reason: 'timeout' };
  const tool = { type: 'lifecycle', phase: 'tool', toolName: 'media_inspect' };
  test('start sets, tool end keeps its receipt, unrelated events keep the current state', () => {
    let state = durableLifecycleState(null, { type: 'auto_retry_start', attempt: 1, at: 1, errorMessage: 'stream idle timeout' });
    expect(state).toEqual(retry);
    expect(durableLifecycleState(state, { type: 'message_update', changes: [] })).toEqual(retry);
    expect(durableLifecycleState(state, { type: 'tool_execution_end', toolName: 'media_inspect' })).toEqual(retry);
    expect(durableLifecycleState(state, { type: 'auto_retry_end', attempt: 1 })).toBeNull();
    state = durableLifecycleState(null, { type: 'tool_execution_start', toolName: 'media_inspect' });
    expect(state).toEqual(tool);
    expect(durableLifecycleState(state, { type: 'tool_execution_end', toolName: 'media_inspect' })).toEqual({ type: 'lifecycle', phase: 'tool_end', toolName: 'media_inspect' });
    expect(durableLifecycleState(state, { type: 'tool_execution_end', toolName: 'other' })).toEqual(state);
  });
  test('a snapshot replaces stale progress', () => {
    expect(durableLifecycleState(retry, { type: 'snapshot', entries: [], tools: [] })).toBeNull();
    expect(durableLifecycleState(null, { type: 'snapshot', entries: [], tools: [], generation: { attempt: 1, retry: { at: 1, error: 'stream idle timeout' } } })).toEqual(retry);
  });
});
