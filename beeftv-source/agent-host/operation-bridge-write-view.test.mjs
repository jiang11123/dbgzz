import { describe, expect, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import { createOperationBridge } from './operation-bridge.mjs';
import { newTurnAccumulator, resetTurnAccumulator } from './canvas-turn.mjs';
import { canvasWriteView } from './canvas-write-view.mjs';
import { boundOutput } from '@earendil-works/chord/output';

// Documented Pi tool-output limits, exercised through the public shared API.
const DEFAULT_MAX_BYTES = 50 * 1024, DEFAULT_MAX_LINES = 2000;

const longPrompt = '镜'.repeat(9000);

async function fixture(run) {
  const node = { id: 'shot', type: 'image', title: '首帧', metadata: {
    composerContent: longPrompt, content: 'resource:rendered', model: 'resolved-model', prompt: longPrompt,
    size: '9:16', status: 'success', taskFailureDiagnostics: { message: 'unrelated'.repeat(10000) },
  } };
  const original = JSON.stringify(node), requests = [], seen = new Set();
  const descriptors = ['canvas.node.configure', 'canvas.node.update', 'canvas.node.bind_asset', 'canvas.get'].map(id => ({
    id, summary: id, assistantModes: ['canvas'], replay: 'safe', readOnly: id === 'canvas.get',
    params: { type: 'object', properties: { canvasId: { type: 'string' }, nodeId: { type: 'string' },
      expectedRevision: { type: 'integer' }, patch: { type: 'object', properties: { content: { type: 'string' }, title: { type: 'string' } } } } },
  }));
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/ops') { res.end(JSON.stringify({ code: 0, data: { ops: descriptors } })); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body); requests.push(input);
    if (req.url === '/ops/canvas.get') {
      res.end(JSON.stringify({ code: 0, data: { result: { canvasId: 'canvas', canvas: { revision: 42, nodes: [node], connections: [] } } } }));
      return;
    }
    const replayed = seen.has(input.opId); seen.add(input.opId);
    // Match Go map order: revision follows the full node, including its large metadata.
    res.end(JSON.stringify({ code: 0, data: { op: req.url.slice(5), replayed, result: {
      assetId: 'asset', canvasId: 'canvas', draftConfigured: req.url.endsWith('configure'), node,
      nodeId: 'shot', referenceBound: req.url.endsWith('bind_asset'), resourceId: 'rendered', revision: 42,
    } } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const bridge = createOperationBridge({ opsUrl: `http://127.0.0.1:${server.address().port}`, hostToken: 'fixture', turnBudgetContext: new AsyncLocalStorage() });
    await bridge.loadDescriptors();
    const turn = resetTurnAccumulator(newTurnAccumulator(), 1, 'turn');
    const tools = bridge.buildTools('canvas', [], { aborted: false }, turn, 'session');
    const call = (id, args, callId = 'write') => tools.find(t => t.label === id).execute(callId, args);
    await run({ call, node, turn, requests });
    expect(JSON.stringify(node)).toBe(original);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}

function retainedJSON(output) {
  const retained = boundOutput(output.content[0].text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES, retain: 'head' });
  expect(retained.droppedBytes).toBe(0);
  expect(retained.bytes).toBeLessThan(8000);
  return JSON.parse(retained.text);
}

describe('node write receipts keep their identity within official tool output limits', () => {
  test('task binding keeps current identity/status and omits the large canvas without mutating Go receipts', () => {
    const data = { replayed: true, result: { canvasId: 'canvas', revision: 99, nodeId: 'film', taskId: 'render',
      bindingStatus: 'replaced', assetId: 'asset', resourceId: 'resource', storageKey: 'resource:resource',
      canvas: { nodes: [{ metadata: { prompt: longPrompt.repeat(10) } }] }, node: { metadata: { prompt: longPrompt } },
      historical: { revision: 3, node: { metadata: { prompt: longPrompt } } } } };
    const original = JSON.stringify(data);
    const view = canvasWriteView(data, 'canvas.task.bind');
    const projected = retainedJSON({ content: [{ type: 'text', text: JSON.stringify(view) }] });
    expect(projected.result).toMatchObject({ canvasId: 'canvas', revision: 99, nodeId: 'film', taskId: 'render', bindingStatus: 'replaced',
      assetId: 'asset', resourceId: 'resource', storageKey: 'resource:resource' });
    expect(projected.result.canvas).toBeUndefined();
    expect(projected.result.historical).toBeUndefined();
    expect(JSON.stringify(data)).toBe(original);
  });
  test('short text edits retain actual values, leave the stored receipt intact and do not affect other operations', () => {
    const data = { replayed: false, result: { canvasId: 'canvas', nodeId: 'text', revision: 7,
      node: { id: 'text', type: 'text', title: '实际名称', position: { x: 1, y: 2 }, metadata: { content: '实际正文', custom: 'keep' } },
    } };
    const original = JSON.stringify(data);
    const output = canvasWriteView(data, 'canvas.node.update', { patch: { title: '请求名称', content: '请求正文' } });
    expect(output.result.node).toEqual({ id: 'text', type: 'text', title: '实际名称', metadata: { content: '实际正文' } });
    expect(JSON.stringify(data)).toBe(original);
    expect(canvasWriteView(data, 'canvas.get')).toBe(data);
    expect(canvasWriteView(data, 'canvas.task.bind')).toBe(data);
    const missingNode = { result: { nodeId: 'text', revision: 7 } };
    expect(canvasWriteView(missingNode, 'canvas.node.update')).toBe(missingNode);
  });

  test.each(['canvas.node.configure', 'canvas.node.update', 'canvas.node.bind_asset'])('%s omits unrelated node data without changing the write, effects or replay', async operation => {
    await fixture(async ({ call, turn, requests }) => {
      const patch = operation.endsWith('configure') ? { model: 'display-model', size: '9:16' } : { title: '首帧' };
      const args = { nodeId: 'shot', expectedRevision: 41, ...(operation.endsWith('bind_asset') ? { assetId: 'asset' } : { patch }) };
      const output = retainedJSON(await call(operation, args));
      expect(output.result.revision).toBe(42);
      expect(output.result.nodeId).toBe('shot');
      expect(output.result.node).toMatchObject({ id: 'shot', title: '首帧', type: 'image' });
      expect(output.result.node.metadata?.prompt).toBeUndefined();
      expect(output.result.node.metadata?.taskFailureDiagnostics).toBeUndefined();
      if (operation.endsWith('configure')) expect(output.result.node.metadata).toEqual({ model: 'resolved-model', size: '9:16' });
      if (operation.endsWith('bind_asset')) expect(output.result).toMatchObject({ assetId: 'asset', resourceId: 'rendered', referenceBound: true });
      expect(output.result.writeView).toEqual({ complete: false, omittedNodeFields: true, readView: { nodeId: 'shot', expectedRevision: 42 } });
      expect(turn.revisionAfter).toBe(42);
      expect(turn.updatedNodeIds).toContain('shot');
      expect(turn.operationIds).toHaveLength(1);
      const replay = retainedJSON(await call(operation, args));
      expect(replay.replayed).toBe(true);
      expect(replay.result).toEqual(output.result);
      expect(requests[0]).toEqual(requests[1]);
      expect(requests[0].params).toEqual({ ...args, canvasId: 'canvas' });
    });
  });

  test('a changed long draft has an explicit preview and its exact original stays readable', async () => {
    await fixture(async ({ call, requests }) => {
      const output = retainedJSON(await call('canvas.node.update', { nodeId: 'shot', expectedRevision: 41, patch: { content: longPrompt } }));
      const field = output.result.node.metadata.composerContent;
      expect(field.complete).toBe(false);
      expect(field.characters).toBe(longPrompt.length);
      expect(field.preview).toBe(longPrompt.slice(0, 160));
      expect(field.readView).toEqual({ nodeId: 'shot', fieldPath: '/metadata/composerContent', expectedRevision: 42 });
      expect(requests[0].params.patch.content).toBe(longPrompt);
      let restored = '', textOffset = 0;
      for (;;) {
        const read = JSON.parse((await call('canvas.get', { readView: { ...field.readView, textOffset } }, `read-${textOffset}`)).content[0].text).result;
        restored += read.value;
        if (read.readView.nextTextOffset === undefined) break;
        textOffset = read.readView.nextTextOffset;
      }
      expect(restored).toBe(longPrompt);
    });
  });
});
