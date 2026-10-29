import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createModels } from '@earendil-works/pi-ai/models';
import { createOperationBridge } from './operation-bridge.mjs';
import { createDurableSessionStore } from './durable-session-owner.mjs';

test('official Durable provider receives complete parseable 23-node view and original field chunk', { timeout: 30000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-canvas-view-'));
  const longPrompt = 'original prompt '.repeat(4000);
  let canvas = { nodes: Array.from({ length: 23 }, (_, i) => ({ id: `node-${i}`, type: i === 0 ? 'image' : 'video',
    title: `synthetic shot ${i}`, metadata: { prompt: i === 22 ? longPrompt : `prompt ${i}`, model: 'configured-model',
      size: '16:9', seconds: '5', assetId: `asset-${i}`, taskId: `task-${i}`, storageKey: `resource:r-${i}`,
      taskFailureDiagnostics: { request: 'diagnostic blob '.repeat(10000) },
      ...(i === 0 ? { svg: '<svg>' + 'synthetic'.repeat(50000) + '</svg>' } : {}) } })),
    connections: [{ id: 'edge', source: 'node-0', target: 'node-22' }], revision: 399 };
  if (process.env.BEEFTV_CANVAS_VIEW_TEST_FIXTURE) {
    canvas = JSON.parse(fs.readFileSync(process.env.BEEFTV_CANVAS_VIEW_TEST_FIXTURE, 'utf8'));
    assert.equal(canvas.nodes.length, 23);
    canvas.revision = 399;
    for (let i = 0; i < canvas.nodes.length; i++) {
      canvas.nodes[i].id = `node-${i}`;
      canvas.nodes[i].metadata = { ...canvas.nodes[i].metadata, model: 'configured-model',
        taskId: `task-${i}`, storageKey: `resource:r-${i}`,
        ...(i === 22 ? { prompt: longPrompt } : {}) };
    }
  }
  canvas.nodes[0].metadata = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`field-${i}`, 'x'.repeat(1900)]));
  let requests = 0, reads = 0, providerError;
  const server = createServer(async (req, res) => {
    try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    if (req.url === '/ops') { res.end(JSON.stringify({ code: 0, data: { ops: [{ id: 'canvas.get', assistantModes: ['canvas', 'full-access', 'read-only'], readOnly: true,
      summary: 'Read canvas', params: { type: 'object', properties: { canvasId: { type: 'string' } } } }] } })); return; }
    if (req.url === '/ops/canvas.get') {
      const body = JSON.parse(raw); assert.deepEqual(body.params, { canvasId: 'canvas' });
      assert.equal(req.headers['x-beeftv-agent-turn'], 'canvas-view-turn');
      reads++; res.end(JSON.stringify({ code: 0, data: { result: { canvasId: 'canvas', canvas } } })); return;
    }
    const payload = JSON.parse(raw); requests++;
    const descriptor = payload.tools.find(tool => tool.function.name === 'canvas_get');
    assert(descriptor.function.parameters.properties.readView, 'actual official provider schema lacks paging');
    const toolResults = payload.messages.filter(message => message.role === 'tool');
    if (requests > 1) {
      const content = toolResults.at(-1).content;
      const text = typeof content === 'string' ? content : content.map(part => part.text || '').join('');
      assert(!text.includes('Output truncated'), 'official truncation still corrupted tool JSON');
      const view = JSON.parse(text);
      assert(Buffer.byteLength(text) < 40000);
      if (requests === 2) {
        assert.equal(view.result.canvas.revision, 399);
        assert.deepEqual(view.result.canvas.nodeIndex.map(n => n.id), canvas.nodes.map(n => n.id));
        assert.equal(view.result.readView.nodeIndexPage.recordsComplete, true);
        assert.equal(view.result.canvas.nodes[0].id, 'node-0');
        assert.equal(view.result.canvas.nodes[0].complete, false);
      } else if (requests === 3) {
        assert.equal(view.result.value[0].value.id, 'node-0');
        assert.equal(view.result.value[0].value.complete, false);
        assert.equal(view.result.readView.complete, false);
      } else if (requests === 4) {
        assert.equal(view.result.value, 'x'.repeat(1900));
        assert.equal(view.result.readView.complete, true);
      } else if (requests === 5) {
        const tail = view.result.value;
        assert.equal(tail.id, 'node-22');
        assert.equal(tail.metadata.taskId, 'task-22'); assert.equal(tail.metadata.storageKey, 'resource:r-22');
        assert.equal(tail.metadata.model, 'configured-model');
        assert.equal(tail.metadata.prompt.complete, false);
      } else assert.equal(view.result.value, longPrompt.slice(8000, 16000));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    const args = requests === 1 ? {} : { readView: { expectedRevision: 399,
      ...(requests === 2 ? { section: 'canvas', fieldPath: '/nodes' } :
        requests === 3 ? { nodeId: 'node-0', fieldPath: '/metadata/field-19' } :
        { nodeId: 'node-22', ...(requests === 5 ? { fieldPath: '/metadata/prompt', textOffset: 8000 } : {}) }) } };
    frame(requests < 6 ? { role: 'assistant', tool_calls: [{ index: 0, id: `canvas-${requests}`, type: 'function', function: { name: 'canvas_get', arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: 'Verified all 23 IDs and revision' });
    frame({}, requests < 6 ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n');
    } catch (error) { providerError = error; res.writeHead(500); res.end('fixture assertion failed'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let store;
  try {
    const runtime = await ModelRuntime.create({ authPath: path.join(directory, 'auth.json'), modelsPath: null, refreshOnCreate: false });
    runtime.registerProvider('fixture', { api: 'openai-completions', apiKey: 'synthetic', baseUrl: `${baseUrl}/v1`, models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], contextWindow: 200000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
    const models = createModels(); models.setProvider(runtime.getProvider('fixture'));
    const bridge = createOperationBridge({ opsUrl: baseUrl, hostToken: 'synthetic', turnBudgetContext: new AsyncLocalStorage() });
    await bridge.loadDescriptors();
    store = createDurableSessionStore({ sessionRoot: path.join(directory, 'sessions'), workspaceRoot: path.join(directory, 'workspace'),
      getModels: () => models, getModelRef: () => ({ provider: 'fixture', modelId: 'fixture' }), buildTools: bridge.buildTools,
      authorizeTurn: async () => ({ open: true, canvasId: 'canvas', permissionMode: 'canvas' }), completeTurn: async () => {}, settings: { retry: { maxRetries: 0 } } });
    const entry = await store.ensureSession('canvas');
    const submitted = await store.submit(entry, { turnId: 'canvas-view-turn', content: 'Read the canvas and inspect the final node original prompt', revisionBefore: 399 });
    const result = await store.wait(entry, submitted);
    if (providerError) throw providerError;
    assert.equal(result.error, null); assert.equal(requests, 6); assert.equal(reads, 5);
  } finally {
    await store?.disposeAll(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
