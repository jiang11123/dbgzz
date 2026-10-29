// Official Durable and operation bridge against actual Go/SQLite/FFmpeg.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createOperationBridge } from '../operation-bridge.mjs';
import { modelFixture } from './durable-model-switch-probe.mjs';
import { durableStreamEvents } from '../durable-session-owner.mjs';

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const bridge = createOperationBridge({ opsUrl: config.backend, hostToken: config.hostToken, turnBudgetContext: new AsyncLocalStorage() });
await bridge.loadDescriptors();
const counterPath = path.join(config.directory, 'model-count.json');
let responses = fs.existsSync(counterPath) ? JSON.parse(fs.readFileSync(counterPath)) : 0;
const fixture = await modelFixture(config.directory, 'fixture', ['fixture'], () => {
  fs.writeFileSync(counterPath, JSON.stringify(++responses));
  return responses === 1 ? { toolCalls: [{ id: 'deliver', name: 'canvas_timeline_deliver', args: {
    expectedRevision: config.revision, title: 'Delivered film', ...(config.refresh ? { refreshNodeIds: ['source'] } : { timeline: {
      version: 2, durationMs: 1000, output: { width: 320, height: 240, fps: 24 },
      tracks: [{ id: 'visual', kind: 'video' }, { id: 'captions', kind: 'subtitle' }],
      clips: [
        { id: 'visual', kind: 'video', nodeId: 'source', trackId: 'visual', startMs: 0, durationMs: 1000 },
        { id: 'caption', kind: 'subtitle', trackId: 'captions', startMs: 0, durationMs: 1000, lines: ['First line', 'Second line'] },
      ],
    } }),
  } }] }
  : { reply: 'Saved both outputs.' };
}, {
    buildTools: bridge.buildTools,
    authorizeTurn: async ({ turnId }) => bridge.opsRequest('GET', `/assistant/runtime/turns/${turnId}`),
  });
try {
  const sessionPath = path.join(config.directory, 'session-id.json');
  const entry = config.resume
    ? await fixture.store.activateSession(config.canvasId, JSON.parse(fs.readFileSync(sessionPath)).sessionId)
    : await fixture.store.createSession(config.canvasId);
  fs.writeFileSync(sessionPath, JSON.stringify({ sessionId: entry.sessionId }));
  const input = { turnId: config.turnId, requestId: 'real-go-delivery', revisionBefore: config.revision, content: 'Deliver the saved media with two subtitle lines.' };
  const submission = config.resume ? await fixture.store.recover(entry) : await fixture.store.submit(entry, input);
  const progress = [];
  const result = await fixture.store.wait(entry, submission, { onEvent: event => {
    progress.push(...durableStreamEvents(event).filter(item => item.phase === 'business'));
  } });
  assert.equal(result.error, null);
  assert.equal(responses, 2);
  const reply = fixture.payloads.at(-1).messages.find(message => message.role === 'tool');
  const receipt = JSON.parse(typeof reply.content === 'string' ? reply.content : reply.content.map(part => part.text || '').join(''));
  assert.equal(receipt.result.status, 'delivered', JSON.stringify(receipt));
  assert.ok(receipt.result.project.resourceId);
  assert(progress.some(item => item.stage === 'exporting'), JSON.stringify(progress));
  fs.writeFileSync(path.join(config.directory, 'business-progress.json'), JSON.stringify(progress));
  assert.equal((await fixture.store.submit(entry, input)).id, submission.id);
  await fixture.store.wait(entry, submission);
  assert.equal(responses, 2);
  fs.writeFileSync(path.join(config.directory, 'delivery-result.json'), JSON.stringify(receipt.result));
} finally { await fixture.close(); }
