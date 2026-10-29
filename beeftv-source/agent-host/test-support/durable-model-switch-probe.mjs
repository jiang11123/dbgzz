import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createModels } from '@earendil-works/pi-ai/models';
import { createDurableSessionStore } from '../durable-session-owner.mjs';

export async function modelFixture(directory, selected, available, onRequest = () => {}, overrides = {}) {
  const requests = [], payloads = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body.model); payloads.push(body);
    const response = await onRequest(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    // A scripted tool round uses the same official provider and Durable owner
    // as the plain-reply fixtures; tests need not replace the tool scheduler.
    const calls = response?.toolCalls;
    frame(calls?.length ? { role: 'assistant', tool_calls: calls.map((call, index) => ({
      index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) },
    })) } : { role: 'assistant', content: response?.reply || `Actual ${body.model} reply` });
    frame({}, calls?.length ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const runtime = await ModelRuntime.create({ authPath: path.join(directory, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider('beeftv', { api: 'openai-completions', apiKey: 'synthetic', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    models: available.map(id => ({ id, name: id, reasoning: false, input: ['text'], contextWindow: 200000, maxTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })) });
  const models = createModels(); models.setProvider(runtime.getProvider('beeftv'));
  const completed = [];
  const store = createDurableSessionStore({ sessionRoot: path.join(directory, 'sessions'), workspaceRoot: path.join(directory, 'workspace'),
    getModels: () => models, getModelRef: () => ({ provider: 'beeftv', modelId: selected }), buildTools: () => [],
    authorizeTurn: async () => ({ open: true, canvasId: 'canvas', permissionMode: 'canvas' }),
    completeTurn: async data => completed.push(data.turnId), settings: { retry: { maxRetries: 0 } }, ...overrides });
  return { store, requests, payloads, completed, async close() { await store.disposeAll(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

if (process.argv[2] === 'crash') {
  const directory = process.argv[3];
  const fixture = await modelFixture(directory, 'astra', ['astra'], () => {
    fs.writeFileSync(path.join(directory, 'checkpoint.json'), JSON.stringify({ actualModel: 'astra', pid: process.pid }));
    process.kill(process.pid, 'SIGKILL');
  });
  const entry = await fixture.store.createSession('canvas');
  fs.writeFileSync(path.join(directory, 'session.json'), JSON.stringify({ sessionId: entry.sessionId }));
  await fixture.store.submit(entry, { turnId: 'interrupted', content: 'Original frozen request' });
}
