import { test, expect } from 'bun:test';
import { mkdtempSync, cpSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createTCPServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { packageAgentHost, verifyRuntime, NODE_VERSION } from './package-agent-host.mjs';

test('release rejects missing runtime and unsupported target', () => {
  expect(() => verifyRuntime('', 'darwin/arm64')).toThrow('required');
  expect(() => verifyRuntime('/missing', 'linux/arm64')).toThrow('Unsupported');
  expect(() => verifyRuntime('/missing', 'linux/amd64')).toThrow('Missing bundled Node');
  expect(() => verifyRuntime('/missing', 'windows/amd64')).toThrow('Missing bundled Node');
});

test('bundled runtime, locked dependencies, and paths with spaces', () => {
  const runtime = process.env.BEEFTV_NODE_RUNTIME;
  expect(runtime).toBeTruthy();
  const target = `${process.platform === 'win32' ? 'windows' : process.platform}/${process.arch === 'x64' ? 'amd64' : 'arm64'}`;
  const scratch = mkdtempSync(path.join(tmpdir(), 'beeftv package test '));
  try {
    const runtimeCopy = path.join(scratch, 'runtime source with spaces');
    const relative = process.platform === 'win32' ? 'node.exe' : 'bin/node';
    mkdirSync(path.dirname(path.join(runtimeCopy, relative)), { recursive: true });
    cpSync(path.join(runtime, relative), path.join(runtimeCopy, relative), { dereference: true });
    expect(() => verifyRuntime(runtimeCopy, target === 'darwin/arm64' ? 'darwin/amd64' : 'darwin/arm64')).toThrow();
    const destination = path.join(scratch, 'release with spaces', 'agent-host');
    packageAgentHost({ runtime: runtimeCopy, target, destination });
    const bundled = path.join(destination, 'runtime', relative);
    expect(existsSync(bundled)).toBe(true);
    expect(existsSync(path.join(destination, 'model-stream-idle.mjs'))).toBe(true);
    expect(existsSync(path.join(destination, 'model-transport-error.mjs'))).toBe(true);
    expect(existsSync(path.join(destination, 'durable-stream-text.mjs'))).toBe(true);
    expect(existsSync(path.join(destination, 'business-progress.mjs'))).toBe(true);
    expect(existsSync(path.join(destination, 'canvas-write-view.mjs'))).toBe(true);
    expect(existsSync(path.join(destination, 'node_modules/@earendil-works/pi-coding-agent/package.json'))).toBe(true);
    expect(existsSync(path.join(destination, 'run-agent-host.sh'))).toBe(false);
    const result = spawnSync(bundled, ['-p', 'process.versions.node'], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(NODE_VERSION);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 240000);

test('packaged server starts with local imports and makes zero model requests', async () => {
  const runtime = process.env.BEEFTV_NODE_RUNTIME;
  expect(runtime).toBeTruthy();
  const target = `${process.platform === 'win32' ? 'windows' : process.platform}/${process.arch === 'x64' ? 'amd64' : 'arm64'}`;
  const scratch = mkdtempSync(path.join(tmpdir(), 'beeftv packaged server '));
  const requests = [];
  let modelRequests = 0;
  // The host's request budget classifies model calls by origin, so keep this separate from ops.
  const provider = createServer((_request, response) => {
    modelRequests += 1;
    response.writeHead(500).end('No model requests allowed in packaging tests');
  });
  const ops = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url, host: request.headers['x-beeftv-agent-token'] });
    response.setHeader('Content-Type', 'application/json');
    if (request.method !== 'GET' || request.url !== '/api/ops' || request.headers['x-beeftv-agent-token'] !== 'test-host') {
      response.writeHead(403).end(JSON.stringify({ code: 403 }));
      return;
    }
    response.end(JSON.stringify({ code: 0, data: { ops: [{ id: 'canvas.get', readOnly: true,
      summary: 'Read test canvas', scope: 'canvas', params: { type: 'object', properties: {} } }] } }));
  });
  let child;
  let exited;
  try {
    const destination = path.join(scratch, 'release with spaces', 'agent-host');
    packageAgentHost({ runtime, target, destination });
    await new Promise((resolve, reject) => { ops.once('error', reject); ops.listen(0, '127.0.0.1', resolve); });
    const opsURL = `http://127.0.0.1:${ops.address().port}`;
    await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
    const providerURL = `http://127.0.0.1:${provider.address().port}/v1`;
    const reservation = createTCPServer();
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    const port = reservation.address().port;
    await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
    const bundled = path.join(destination, 'runtime', process.platform === 'win32' ? 'node.exe' : 'bin/node');
    let output = '';
    let spawnError;
    child = spawn(bundled, ['server.mjs'], { cwd: destination, stdio: ['ignore', 'pipe', 'pipe'], env: {
      PATH: '', HOME: scratch, USERPROFILE: scratch, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      BEEFTV_OPS_URL: `${opsURL}/api`, BEEFTV_AGENT_HOST_TOKEN: 'test-host',
      BEEFTV_AGENT_DATA_DIR: path.join(scratch, 'data'), BEEFTV_AGENT_PORT: String(port),
      BEEFTV_AGENT_MODEL: 'packaging-test-model', BEEFTV_AGENT_API: 'openai-completions',
      BEEFTV_AGENT_BASE_URL: providerURL, BEEFTV_AGENT_API_KEY: 'test-placeholder', BEEFTV_AGENT_TOTAL_REQUEST_BUDGET: '0',
    } });
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', (error) => { spawnError = error; });
    exited = new Promise((resolve) => child.once('close', resolve));
    let health;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (spawnError || child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Packaged server exited before health: ${spawnError || child.exitCode}\n${output}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) { health = await response.json(); break; }
      } catch { /* Wait only while the packaged child is starting. */ }
      await delay(100);
    }
    if (!health) throw new Error(`Packaged server did not become healthy\n${output}`);
    if (health.operations !== 1) throw new Error(`Packaged server did not discover operations: ${JSON.stringify(requests)}\n${output}`);
    expect(health.ok).toBe(true);
    expect(health.reason).toBeUndefined();
    expect(health.model).toBe('packaging-test-model');
    expect(health.api).toBe('openai-completions');
    expect(health.baseUrl).toBe(providerURL);
    expect(health.operations).toBe(1);
    expect(health.requests).toEqual({ dispatched: 0, perTurnRequests: 40, perTurnToolSteps: 40, lifetimeBudget: 0, lifetimeUsed: 0 });
    expect(modelRequests).toBe(0);
    expect(requests).toEqual([{ method: 'GET', path: '/api/ops', host: 'test-host' }]);
  } finally {
    if (child) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
    for (const server of [ops, provider]) {
      if (server.listening) {
        const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        server.closeAllConnections();
        await closed;
      }
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}, 240000);
