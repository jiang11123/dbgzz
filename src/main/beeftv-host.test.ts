import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BeefTvHost } from './beeftv-host';

test('model config restoration uses local UI credentials while writes retain owner identity', async t => {
  const upstream = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ owner: req.headers['x-beeftv-owner'] || '', path: req.url }));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => upstream.close());
  const host = new BeefTvHost({
    webRoot: '.', backendAddr: `127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    port: 19871, ownerToken: () => 'test-owner',
  });
  t.after(() => host.stop());
  await host.start();
  const config = await fetch(`${host.url}/api/workspace/model-config`).then(r => r.json());
  assert.equal(config.owner, '');
  for (const [method, path] of [['PUT', '/api/workspace/model-config'], ['POST', '/api/ops/canvas.node.update'], ['GET', '/api/tasks']]) {
    const result = await fetch(`${host.url}${path}`, { method }).then(r => r.json());
    assert.equal(result.owner, 'test-owner');
  }
  const external = await fetch(`${host.url}/api/workspace/model-config`, { headers: { 'X-Beeftv-Owner': 'explicit-owner' } }).then(r => r.json());
  assert.equal(external.owner, 'explicit-owner');
});
