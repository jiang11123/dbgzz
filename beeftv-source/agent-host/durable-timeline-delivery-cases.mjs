import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createOperationBridge } from './operation-bridge.mjs';
import { modelFixture } from './test-support/durable-model-switch-probe.mjs';

const descriptors = JSON.parse(fs.readFileSync(new URL('./operation-descriptors.fixture.json', import.meta.url)));
const timeline = { version: 2, durationMs: 12000, tracks: [{ id: 'video', kind: 'video' }],
  clips: [{ id: 'shot', kind: 'video', trackId: 'video', nodeId: 'source', startMs: 0, durationMs: 12000 }],
  output: { width: 480, height: 854, fps: 24 } };

for (const scenario of ['delivery', 'refresh', 'lines', 'large-bind', 'foreign-edit', 'export-failure', 'export-recovery']) {
  test(`one official tool performs delivery: ${scenario}`, { timeout: 30000 }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-delivery-'));
    let revision = 5;
    const requestTimeline = scenario === 'lines' ? { ...timeline, clips: [...timeline.clips,
      { id: 'caption', kind: 'subtitle', trackId: 'captions', startMs: 0, durationMs: 12000, text: '旧字幕', lines: ['第一行', '第二行'] }] } : timeline;
    const expectedTimeline = scenario === 'lines' ? { ...timeline, clips: [...timeline.clips,
      { id: 'caption', kind: 'subtitle', trackId: 'captions', startMs: 0, durationMs: 12000, text: '第一行\n第二行' }] } : timeline;
    const posts = [], effects = new Map();
    const names = new Set(['canvas.get', 'canvas.timeline.update', 'canvas.timeline.render', 'canvas.nodes.create', 'canvas.task.bind', 'canvas.project.export', 'task.get']);
    const server = createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      const wrap = data => res.end(JSON.stringify({ code: 0, data }));
      if (req.url === '/ops') return wrap({ ops: descriptors.filter(op => names.has(op.id)) });
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw), op = req.url.slice('/ops/'.length), p = body.params;
      posts.push({ op, ...body });
      assert.equal(p.canvasId ?? 'canvas', 'canvas');
      if (op === 'canvas.get') return wrap({ result: { canvasId: 'canvas', canvas: { revision, nodes: scenario === 'refresh'
        ? [...Array.from({ length: 51 }, (_, index) => ({ id: `node-${index}`, title: `素材 ${index}` })), { title: '新成片' }, { title: '新成片 · 2' }] : [] } } });
      if (op === 'task.get') {
        assert.equal(p.taskId, 'original-render');
        if (scenario === 'foreign-edit') revision++;
        return wrap({ result: { id: p.taskId, status: 'succeeded', outputs: [{ resourceId: 'film', materializedAssetId: 'film-asset' }] } });
      }
      if (op === 'canvas.project.export' && (scenario === 'export-failure' || scenario === 'export-recovery' && posts.filter(post => post.op === op).length === 1)) {
        res.writeHead(503); return res.end(JSON.stringify({ code: 1, reason: 'disk_unavailable', msg: 'export unavailable' }));
      }
      if (p.expectedRevision !== undefined && p.expectedRevision !== revision) {
        res.writeHead(409); return res.end(JSON.stringify({ code: 1, reason: 'revision_conflict', msg: 'canvas changed' }));
      }
      let result;
      if (op === 'canvas.timeline.update') {
        if (scenario === 'refresh') {
          assert.deepEqual(p.refreshNodeIds, ['source']);
          assert.equal(p.timeline, undefined, 'replacement must not rewrite subtitles or track settings');
        } else assert.deepEqual(p.timeline, expectedTimeline);
        result = { canvasId: 'canvas', revision: ++revision, timelineUpdated: true };
      } else if (op === 'canvas.timeline.render') {
        result = { canvasId: 'canvas', sourceRevision: revision, taskId: 'original-render', status: 'queued', charged: false };
      } else if (op === 'canvas.nodes.create') {
        assert.deepEqual(p.nodes, [{ type: 'video', title: scenario === 'refresh' ? '新成片 · 3' : '新成片' }]);
        result = { canvasId: 'canvas', revision: ++revision, created: [{ id: 'result-node', type: 'video', title: '新成片' }] };
      } else if (op === 'canvas.task.bind') {
        assert.deepEqual(p, { canvasId: 'canvas', taskId: 'original-render', nodeId: 'result-node', outputIndex: 0 });
        assert.equal(body.opId, 'attach-node:original-render:result-node:0');
        result = { canvasId: 'canvas', nodeId: 'result-node', revision: ++revision, bindingStatus: 'bound' };
        if (scenario === 'large-bind') result.canvas = { nodes: [{ id: 'source', metadata: { prompt: '镜'.repeat(40000) } }] };
      } else {
        assert.equal(op, 'canvas.project.export');
        result = { canvasId: 'canvas', sourceRevision: revision, resourceId: 'project-zip', editable: true, bytes: 123 };
      }
      assert.ok(!effects.has(body.opId), 'completed operation dispatched twice');
      effects.set(body.opId, result);
      return wrap({ result, replayed: false });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let fixture;
    try {
      const bridge = createOperationBridge({ opsUrl: `http://127.0.0.1:${server.address().port}`, hostToken: 'synthetic', turnBudgetContext: new AsyncLocalStorage() });
      await bridge.loadDescriptors();
      assert.ok(!bridge.buildTools('canvas', [], { permissionMode: 'read-only' }, {}, 'test').some(tool => tool.name === 'canvas_timeline_deliver'));
      let responses = 0;
      fixture = await modelFixture(directory, 'fixture', ['fixture'], body => {
        if (++responses === 1) {
          assert.ok(body.tools.some(tool => tool.function.name === 'canvas_timeline_deliver'));
          return { toolCalls: [{ id: 'deliver', name: 'canvas_timeline_deliver', args: { expectedRevision: 5,
            ...(scenario === 'refresh' ? { refreshNodeIds: ['source'] } : { timeline: requestTimeline }), title: '新成片' } }] };
        }
        if (scenario === 'export-recovery' && responses === 2) {
          return { toolCalls: [{ id: 'resume-export', name: 'canvas_project_export', args: { expectedRevision: 8 } }] };
        }
        return { reply: '交付回执已读取。' };
      }, { buildTools: bridge.buildTools });
      const entry = await fixture.store.createSession('canvas');
      const input = { turnId: 'delivery-turn', requestId: 'delivery-request', revisionBefore: 5, content: '渲染已准备的时间线并交付工程。' };
      const submission = await fixture.store.submit(entry, input);
      const result = await fixture.store.wait(entry, submission);
      assert.equal(result.error, null);
      const responseCount = scenario === 'export-recovery' ? 3 : 2;
      assert.equal(fixture.requests.length, responseCount, 'only a failed business step may need a recovery response');
      const reply = fixture.payloads[1].messages.find(message => message.role === 'tool');
      const delivered = JSON.parse(typeof reply.content === 'string' ? reply.content : reply.content.map(part => part.text || '').join(''));
      assert.ok(!Object.keys(delivered.receipts).some(key => key.startsWith('names:')), 'delivery must not expose the source canvas');
      if (scenario === 'large-bind') {
        assert.equal(delivered.receipts.bind.canvas, undefined);
        assert.ok(JSON.stringify(delivered).length < 10000, 'nested delivery must not expose source prompts');
      }
      if (scenario === 'delivery' || scenario === 'refresh' || scenario === 'large-bind' || scenario === 'lines') {
        assert.equal(delivered.result.status, 'delivered');
        assert.equal(delivered.result.project.resourceId, 'project-zip');
        assert.equal(delivered.result.nodeId, 'result-node');
        assert.equal(delivered.result.revision, 8);
        assert.equal(result.change.timelineUpdated, true);
        assert.deepEqual(result.change.createdNodeIds, ['result-node']);
      } else {
        assert.equal(delivered.result.status, 'incomplete');
        assert.equal(delivered.result.taskId, 'original-render');
        assert.equal(delivered.result.failedStep, scenario === 'foreign-edit' ? 'canvas.nodes.create' : 'canvas.project.export');
        assert.equal(delivered.result.nodeId, scenario === 'foreign-edit' ? undefined : 'result-node');
        if (scenario === 'foreign-edit') assert.equal(revision, 7, 'foreign edit must survive');
      }
      assert.equal(posts.filter(post => post.op === 'canvas.timeline.render').length, 1);
      assert.equal(posts.filter(post => post.op === 'canvas.nodes.create').length, 1);
      if (scenario === 'export-recovery') {
        assert.equal(posts.filter(post => post.op === 'canvas.project.export').length, 2);
        const resumed = fixture.payloads[2].messages.filter(message => message.role === 'tool').at(-1);
        assert.equal(JSON.parse(typeof resumed.content === 'string' ? resumed.content : resumed.content.map(part => part.text || '').join('')).result.resourceId, 'project-zip');
      }
      const before = posts.length;
      assert.equal((await fixture.store.submit(entry, input)).id, submission.id);
      await fixture.store.wait(entry, submission);
      assert.equal(posts.length, before, 'repeat observation must not rerun nested effects');
      assert.equal(fixture.requests.length, responseCount);
      if (scenario === 'lines') assert.deepEqual(requestTimeline.clips.at(-1).lines, ['第一行', '第二行'], 'composition must not mutate journaled arguments');
    } finally {
      await fixture?.close();
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
