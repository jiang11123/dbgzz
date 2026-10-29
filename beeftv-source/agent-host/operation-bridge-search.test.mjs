import { test, expect } from 'bun:test';
import { createServer } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createOperationBridge } from './operation-bridge.mjs';
import { newTurnAccumulator } from './canvas-turn.mjs';

test('workspace search project filter never inherits canvas; canvas project search and unknown tools retain injection', async () => {
  const calls = [];
  const server = createServer(async (req, res) => {
    if (req.url === '/ops') {
      res.end(JSON.stringify({ code: 0, data: { ops: ['canvas.search', 'project.canvas.search', 'unknown.read'].map(id => ({ id, assistantModes: ['canvas', 'full-access', 'read-only'], replay: 'safe', readOnly: true, summary: id,
        params: { type: 'object', properties: { canvasId: { type: 'string' }, query: { type: 'string' } } } })) } })); return;
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    calls.push({ path: req.url, params: JSON.parse(raw).params });
    res.end(JSON.stringify({ code: 0, data: { result: { total: 2 } } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const bridge = createOperationBridge({ opsUrl: `http://127.0.0.1:${server.address().port}`, hostToken: 'synthetic', turnBudgetContext: new AsyncLocalStorage() });
    await bridge.loadDescriptors();
    const tools = bridge.buildTools('current-canvas', [], { permissionMode: 'full-access' }, newTurnAccumulator(), 'session');
    const workspace = tools.find(t => t.name === 'canvas_search');
    expect(workspace.parameters.properties.canvasId).toBeUndefined();
    expect(workspace.parameters.properties.projectId.type).toBe('string');
    await workspace.execute('one', {});
    await workspace.execute('two', { projectId: 'project-1', query: 'coffee' });
    await workspace.execute('legacy', { canvasId: 'legacy-project' });
    await expect(workspace.execute('conflict', { projectId: 'one', canvasId: 'two' })).rejects.toThrow('invalid_project_filter');
    await tools.find(t => t.name === 'project_canvas_search').execute('three', {});
    await tools.find(t => t.name === 'unknown_read').execute('four', {});
    expect(calls).toEqual([
      { path: '/ops/canvas.search', params: {} },
      { path: '/ops/canvas.search', params: { canvasId: 'project-1', query: 'coffee' } },
      { path: '/ops/canvas.search', params: { canvasId: 'legacy-project' } },
      { path: '/ops/project.canvas.search', params: { canvasId: 'current-canvas' } },
      { path: '/ops/unknown.read', params: { canvasId: 'current-canvas' } },
    ]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
