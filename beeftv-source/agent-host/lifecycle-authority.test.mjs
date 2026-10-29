import { expect, test } from 'bun:test';
import http, { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverPath = path.join(root, 'agent-host/server.mjs');

function proof(nonce) {
  return crypto.createHash('sha256').update(nonce).digest('hex').slice(0, 16);
}

async function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function reservePort() {
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  return port;
}

function spawnHost(env, stdio = ['ignore', 'pipe', 'pipe']) {
  const child = spawn('node', [serverPath], { cwd: root, env, stdio });
  let log = '';
  if (child.stdout) child.stdout.on('data', (chunk) => { log += chunk; });
  if (child.stderr) child.stderr.on('data', (chunk) => { log += chunk; });
  return { child, getLog: () => log };
}

async function waitExit(child, ms) {
  const exited = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  return Promise.race([
    exited,
    delay(ms).then(() => { child.kill('SIGKILL'); throw new Error('host did not exit in time'); }),
  ]);
}

function readPidFile(file) {
  try {
    const pid = Number(String(readFileSync(file, 'utf8')).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitPidExit(pid, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return;
    await delay(20);
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  throw new Error('pid ' + pid + ' did not exit in time');
}

function syntheticHostEnv(directory, extra = {}) {
  return {
    ...process.env,
    BEEFTV_AGENT_DATA_DIR: directory,
    BEEFTV_AGENT_HOST_TOKEN: extra.hostToken || 'lifecycle-host-token',
    BEEFTV_AGENT_PORT: String(extra.port),
    BEEFTV_AGENT_INSTANCE_NONCE: extra.nonce || '',
    BEEFTV_AGENT_LIFETIME_STDIN: extra.lifetime === false ? '' : '1',
    BEEFTV_OPS_URL: extra.opsURL,
    BEEFTV_AGENT_API: 'openai-completions',
    BEEFTV_AGENT_MODEL: 'synthetic',
    BEEFTV_AGENT_API_KEY: 'synthetic-only',
    BEEFTV_AGENT_BASE_URL: extra.modelURL,
    BEEFTV_AGENT_TOTAL_REQUEST_BUDGET: '0',
  };
}

test('server exits when PORT and LISTEN_FD are missing', async () => {
  const { child } = spawnHost({
    ...process.env,
    BEEFTV_AGENT_PORT: '',
    BEEFTV_AGENT_LISTEN_FD: '',
    BEEFTV_AGENT_HOST_TOKEN: 't',
    BEEFTV_AGENT_DATA_DIR: mkdtempSync(path.join(tmpdir(), 'beeftv lifecycle missing port ')),
  });
  const result = await waitExit(child, 15000);
  expect(result.code).toBe(2);
},20000);

test('health requires instance nonce and omits the secret; stdin EOF shuts down', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'beeftv lifecycle authority '));
  const nonce = 'lifecycle-authority-nonce-value';
  const hostToken = 'lifecycle-host-token';
  const ops = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ code: 0, data: { ops: [] } }));
  });
  const provider = createServer((_req, res) => {
    res.writeHead(500).end('no model calls');
  });
  let child;
  try {
    const opsPort = await listen(ops);
    const modelPort = await listen(provider);
    const port = await reservePort();
    const env = {
      ...process.env,
      BEEFTV_AGENT_DATA_DIR: directory,
      BEEFTV_AGENT_HOST_TOKEN: hostToken,
      BEEFTV_AGENT_PORT: String(port),
      BEEFTV_AGENT_INSTANCE_NONCE: nonce,
      BEEFTV_AGENT_LIFETIME_STDIN: '1',
      BEEFTV_OPS_URL: `http://127.0.0.1:${opsPort}/api`,
      BEEFTV_AGENT_API: 'openai-completions',
      BEEFTV_AGENT_MODEL: 'synthetic',
      BEEFTV_AGENT_API_KEY: 'synthetic-only',
      BEEFTV_AGENT_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
      BEEFTV_AGENT_TOTAL_REQUEST_BUDGET: '0',
    };
    const spawned = spawnHost(env, ['pipe', 'pipe', 'pipe']);
    child = spawned.child;
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 15000;
    let health;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('host exited: ' + spawned.getLog());
      try {
        const denied = await fetch(base + '/health', { signal: AbortSignal.timeout(500) });
        expect(denied.status).toBe(403);
        const ok = await fetch(base + '/health', {
          headers: { 'X-Beeftv-Instance-Nonce': nonce, 'X-Beeftv-Agent-Token': hostToken },
          signal: AbortSignal.timeout(500),
        });
        if (ok.ok) {
          health = await ok.json();
          break;
        }
      } catch { /* starting */ }
      await delay(50);
    }
    if (!health) throw new Error('host never became healthy: ' + spawned.getLog());
    expect(health.ok).toBe(true);
    expect(health.instance).toBe(proof(nonce));
    expect(JSON.stringify(health)).not.toContain(nonce);
    expect(health.requests.dispatched).toBe(0);
    const malformed = nonce.slice(0, -1) + '\u00ff';
    expect(malformed.length).toBe(nonce.length);
    expect(Buffer.from(malformed).length).not.toBe(Buffer.from(nonce).length);
    const badNonce = await fetch(base + '/health', {
      headers: { 'X-Beeftv-Instance-Nonce': malformed },
      signal: AbortSignal.timeout(2000),
    });
    expect(badNonce.status).toBe(403);
    const malformedToken = hostToken.slice(0, -1) + '\u00ff';
    const badToken = await fetch(base + '/sessions?canvasId=x', {
      headers: { 'X-Beeftv-Instance-Nonce': nonce, 'X-Beeftv-Agent-Token': malformedToken },
      signal: AbortSignal.timeout(2000),
    });
    expect(badToken.status).toBe(403);
    const stillOk = await fetch(base + '/health', {
      headers: { 'X-Beeftv-Instance-Nonce': nonce, 'X-Beeftv-Agent-Token': hostToken },
      signal: AbortSignal.timeout(2000),
    });
    expect(stillOk.ok).toBe(true);
    expect((await stillOk.json()).instance).toBe(proof(nonce));
    const closed = waitExit(child, 8000);
    child.stdin.end();
    const result = await closed;
    expect(result.code === 0 || result.signal === 'SIGTERM' || result.signal == null).toBe(true);
    child = null;
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGKILL');
      await delay(200);
    }
    for (const server of [ops, provider]) {
      if (server.listening) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
}, 25000);

test('stdio ignore without lifetime flag does not exit immediately', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'beeftv lifecycle ignore '));
  const ops = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ code: 0, data: { ops: [] } }));
  });
  const provider = createServer((_req, res) => res.writeHead(500).end('no'));
  let child;
  try {
    const opsPort = await listen(ops);
    const modelPort = await listen(provider);
    const port = await reservePort();
    const spawned = spawnHost({
      ...process.env,
      BEEFTV_AGENT_DATA_DIR: directory,
      BEEFTV_AGENT_HOST_TOKEN: 'lifecycle-host-token',
      BEEFTV_AGENT_PORT: String(port),
      BEEFTV_OPS_URL: `http://127.0.0.1:${opsPort}/api`,
      BEEFTV_AGENT_API: 'openai-completions',
      BEEFTV_AGENT_MODEL: 'synthetic',
      BEEFTV_AGENT_API_KEY: 'synthetic-only',
      BEEFTV_AGENT_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
    }, ['ignore', 'pipe', 'pipe']);
    child = spawned.child;
    const deadline = Date.now() + 15000;
    let healthy = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('host exited without lifetime flag: ' + spawned.getLog());
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
        if (response.ok) { healthy = true; break; }
      } catch { /* starting */ }
      await delay(50);
    }
    expect(healthy).toBe(true);
    await delay(300);
    expect(child.exitCode).toBeNull();
  } finally {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    for (const server of [ops, provider]) {
      if (server.listening) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
}, 25000);

test('parent SIGKILL during pending capability discovery shuts the child down promptly', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'beeftv lifecycle discovery '));
  const pidPath = path.join(directory, 'host.pid');
  const opsRef = { server: null };
  let sawOps = false;
  const opsSeen = new Promise((resolve) => {
    opsRef.server = createServer(() => { sawOps = true; resolve(); });
  });
  const provider = createServer((_req, res) => res.writeHead(500).end('no'));
  let wrapper;
  let hostPid = 0;
  try {
    const opsPort = await listen(opsRef.server);
    const modelPort = await listen(provider);
    const port = await reservePort();
    const env = syntheticHostEnv(directory, {
      port,
      nonce: 'discovery-nonce',
      opsURL: `http://127.0.0.1:${opsPort}/api`,
      modelURL: `http://127.0.0.1:${modelPort}/v1`,
    });
    const script = `
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      const child = spawn(process.execPath, ${JSON.stringify([serverPath])}, {
        cwd: ${JSON.stringify(root)},
        env: process.env,
        stdio: ['pipe', 'inherit', 'inherit'],
      });
      if (!child.pid) process.exit(1);
      writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
      child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
    `;
    wrapper = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !hostPid) {
      hostPid = readPidFile(pidPath);
      if (hostPid) break;
      await delay(20);
    }
    if (!hostPid) throw new Error('wrapper never spawned host');
    await Promise.race([
      opsSeen,
      delay(15000).then(() => { throw new Error('capability discovery never started'); }),
    ]);
    expect(sawOps).toBe(true);
    expect(pidAlive(hostPid)).toBe(true);
    wrapper.kill('SIGKILL');
    await waitPidExit(hostPid, 3000);
    hostPid = 0;
    wrapper = null;
  } finally {
    if (hostPid && pidAlive(hostPid)) {
      try { process.kill(hostPid, 'SIGKILL'); } catch { /* already gone */ }
    }
    if (wrapper && wrapper.exitCode === null && wrapper.signalCode == null) {
      try { wrapper.kill('SIGKILL'); } catch { /* already gone */ }
    }
    for (const server of [opsRef.server, provider]) {
      if (server?.listening) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
}, 25000);

test('stdin EOF with an idle HTTP keepalive socket still shuts down promptly', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'beeftv lifecycle keepalive '));
  const nonce = 'keepalive-nonce-value';
  const hostToken = 'lifecycle-host-token';
  const ops = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ code: 0, data: { ops: [] } }));
  });
  const provider = createServer((_req, res) => res.writeHead(500).end('no'));
  const agent = new http.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 1 });
  let child;
  try {
    const opsPort = await listen(ops);
    const modelPort = await listen(provider);
    const port = await reservePort();
    const spawned = spawnHost(syntheticHostEnv(directory, {
      port,
      nonce,
      hostToken,
      opsURL: `http://127.0.0.1:${opsPort}/api`,
      modelURL: `http://127.0.0.1:${modelPort}/v1`,
    }), ['pipe', 'pipe', 'pipe']);
    child = spawned.child;
    const deadline = Date.now() + 15000;
    let healthy = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('host exited: ' + spawned.getLog());
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          headers: { 'X-Beeftv-Instance-Nonce': nonce, 'X-Beeftv-Agent-Token': hostToken },
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) { healthy = true; break; }
      } catch { /* starting */ }
      await delay(50);
    }
    if (!healthy) throw new Error('host never became healthy: ' + spawned.getLog());
    await new Promise((resolve, reject) => {
      const req = http.get({
        hostname: '127.0.0.1',
        port,
        path: '/health',
        headers: {
          'X-Beeftv-Instance-Nonce': nonce,
          'X-Beeftv-Agent-Token': hostToken,
          Connection: 'keep-alive',
        },
        agent,
      }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
    });
    const idle = Object.values(agent.freeSockets).flat();
    expect(idle.length).toBeGreaterThan(0);
    const closed = waitExit(child, 3000);
    child.stdin.end();
    await closed;
    child = null;
  } finally {
    agent.destroy();
    if (child && child.exitCode === null) child.kill('SIGKILL');
    for (const server of [ops, provider]) {
      if (server.listening) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
}, 25000);
