import { test, expect } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import { createOperationBridge } from './operation-bridge.mjs';
import { newTurnAccumulator, resetTurnAccumulator } from './canvas-turn.mjs';
import { publicDurableTurn } from './durable-session-owner.mjs';

const source = { canvasId: 'canvas', nodeId: 'node', resourceId: 'resource-1', version: 'a'.repeat(64), startMs: 5000, endMs: 12000 };
function result(mode = 'video', overrides = {}) {
  const bytes = Buffer.from('synthetic-media');
  return { source, durationMs: 18000, hasAudio: true,
    content: mode === 'check' ? [] : [{ type: mode === 'frames' ? 'image' : 'media', mimeType: mode === 'audio' ? 'audio/wav' : mode === 'frames' ? 'image/jpeg' : 'video/mp4',
      data: bytes.toString('base64'), sha256: crypto.createHash('sha256').update(bytes).digest('hex'), source }], ...overrides };
}
async function withBridge(run, modelId = 'gemini-fixture') {
  let response = result(), failed = false;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/ops') return res.end(JSON.stringify({ code: 0, data: { ops: ['media.overview', 'media.inspect', 'media.check'].map(id => ({ id, readOnly: true, replay: 'safe', assistantModes: ['canvas'], params: { type: 'object', properties: { canvasId: { type: 'string' } } } })) } }));
    if (failed) { res.writeHead(400); return res.end(JSON.stringify({ code: 1, reason: 'media_read_failed', msg: 'fixture failure' })); }
    res.end(JSON.stringify({ code: 0, data: { result: response } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const log = [], bridge = createOperationBridge({ opsUrl: `http://127.0.0.1:${server.address().port}`, hostToken: 'fixture', turnBudgetContext: new AsyncLocalStorage(), mediaModel: { api: 'openai-completions', modelId } });
    await bridge.loadDescriptors();
    const tools = bridge.buildTools('canvas', log, { aborted: false }, resetTurnAccumulator(newTurnAccumulator(), 1, 'turn'), 'session');
    await run({ log, execute: (op, args = {}) => tools.find(tool => tool.label === op).execute(String(log.length + 1), args), set: value => { response = value; }, fail: () => { failed = true; } });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('actual bridge projects only successful response facts through durable history serialization', async () => {
  await withBridge(async ({ log, execute, set }) => {
    await execute('media.inspect', { mode: 'audio', startMs: 0, endMs: 18000, mediaFacts: { forged: true } });
    expect(log[0].mediaFacts).toEqual({ source: { resourceId: 'resource-1', version: source.version, startMs: 5000, endMs: 12000, nodeId: 'node' }, mode: 'video', durationMs: 18000, hasAudio: true });
    set(result('check', { source: { ...source, startMs: 0, endMs: 18000, url: 'https://secret.invalid' }, meanDb: -91, peakDb: -91,
      silenceIntervals: [{ startMs: 0, endMs: 18000, secret: 'hidden' }], note: 'arbitrary text', url: 'https://secret.invalid' }));
    await execute('media.check');
    expect(log[1].mediaFacts).toEqual({ source: { resourceId: 'resource-1', version: source.version, startMs: 0, endMs: 18000, nodeId: 'node' }, mode: 'check', durationMs: 18000, hasAudio: true,
      meanDb: -91, peakDb: -91, silenceIntervals: [{ startMs: 0, endMs: 18000 }] });
    const history = JSON.parse(JSON.stringify(publicDurableTurn({ turnId: 'turn', toolCalls: log, status: 'unanswered' })));
    expect(history.toolCalls.map(call => call.mediaFacts)).toEqual(log.map(call => call.mediaFacts));
    const facts = JSON.stringify(history.toolCalls.map(call => call.mediaFacts));
    for (const forbidden of ['secret', 'content', 'data', 'url', 'canvasId', 'note', 'forged']) expect(facts).not.toContain(forbidden);
  });
});

test('HTTP failures and failed native conversion never record a successful media read', async () => {
  await withBridge(async ({ log, execute, fail }) => {
    fail(); await expect(execute('media.inspect')).rejects.toThrow('media_read_failed');
    expect(log).toHaveLength(1); expect(log[0].isError).toBe(true); expect(log[0].mediaFacts).toBeUndefined();
  });
  await withBridge(async ({ log, execute }) => {
    await expect(execute('media.inspect')).rejects.toThrow('media_input_unsupported');
    expect(log).toHaveLength(1); expect(log[0].isError).toBe(true); expect(log[0].mediaFacts).toBeUndefined();
  }, 'text-only-fixture');
  await withBridge(async ({ log, execute, set }) => {
    const value = result(); value.content[0].sha256 = 'wrong'; set(value);
    await expect(execute('media.inspect')).rejects.toThrow('media_content_changed');
    expect(log).toHaveLength(1); expect(log[0].isError).toBe(true); expect(log[0].mediaFacts).toBeUndefined();
  });
});

test('malformed facts are omitted and static previews cannot become native video receipts', async () => {
  await withBridge(async ({ log, execute, set }) => {
    set(result('check', { source: { ...source, endMs: 19000 } })); await execute('media.check');
    expect(log[0].mediaFacts).toBeUndefined();
    set(result('frames')); await execute('media.overview', { mode: 'video' });
    expect(log[1].mediaFacts.mode).toBe('frames');
    expect(log[1].mediaFacts).not.toHaveProperty('silenceIntervals');
    const still = result('frames', { durationMs: 0, source: { ...source, startMs: 0, endMs: 0 } });
    still.content[0].source = still.source;
    set(still); await execute('media.overview');
    expect(log[2].isError).toBe(false);
    expect(log[2].mediaFacts).toBeUndefined();
  });
});

test('one overview bundle records every actual mode without relying on request claims', async () => {
  await withBridge(async ({ log, execute, set }) => {
    const bundle = result('check', { evidence: ['frames', 'video', 'audio', 'check'],
      content: ['frames', 'video', 'audio'].flatMap(mode => result(mode).content), meanDb: -20, peakDb: -4,
      silenceDetection: { noiseDb: -35, minimumDurationMs: 120, timestampKind: 'source_time' },
      silenceIntervals: [{ startMs: 6000, endMs: 6500 }] });
    set(bundle);
    await execute('media.overview', { evidence: { modes: ['audio'], forged: true } });
    expect(log).toHaveLength(1);
    expect(log[0].mediaFacts).toBeUndefined();
    expect(log[0].mediaEvidence.map(facts => facts.mode)).toEqual(['frames', 'video', 'audio', 'check']);
    expect(log[0].mediaEvidence.at(-1)).toMatchObject({ meanDb: -20, peakDb: -4, silenceIntervals: [{ startMs: 6000, endMs: 6500 }] });
    expect(log[0].mediaEvidence.every(facts => facts.source.version === source.version)).toBe(true);
    const history = JSON.parse(JSON.stringify(publicDurableTurn({ turnId: 'bundle-turn', toolCalls: log, status: 'unanswered' })));
    expect(history.toolCalls[0].mediaEvidence).toEqual(log[0].mediaEvidence);
    for (const forbidden of ['data', 'content', 'forged', 'canvasId', 'silenceDetection']) expect(JSON.stringify(history.toolCalls[0].mediaEvidence)).not.toContain(forbidden);
  });
});

test('a missing bundle modality fails without recording partial evidence', async () => {
  await withBridge(async ({ log, execute, set }) => {
    set(result('frames', { evidence: ['frames', 'audio'] }));
    await expect(execute('media.overview')).rejects.toThrow('invalid_media_evidence');
    expect(log).toHaveLength(1);
    expect(log[0].isError).toBe(true);
    expect(log[0].mediaFacts).toBeUndefined();
    expect(log[0].mediaEvidence).toBeUndefined();
  });
});
