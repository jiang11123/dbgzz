import { cpSync, mkdtempSync, mkdirSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const NODE_VERSION = '24.22.1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = { 'darwin/arm64': ['darwin', 'arm64'], 'darwin/amd64': ['darwin', 'x64'], 'windows/amd64': ['win32', 'x64'], 'linux/amd64': ['linux', 'x64'] };
const runtimeModules = ['session-identity.mjs', 'canvas-turn.mjs', 'request-budget.mjs', 'durable-request-budget.mjs',
  'durable-session-owner.mjs', 'durable-stream-text.mjs', 'business-progress.mjs', 'durable-turn-budget.mjs', 'media-content.mjs', 'native-part-store.mjs', 'native-history.mjs', 'skill-resource.mjs',
  'operation-bridge.mjs', 'await-business-tasks.mjs', 'timeline-delivery.mjs', 'canvas-read-view.mjs', 'canvas-write-view.mjs', 'session-owner.mjs', 'system-prompt.mjs', 'model-stream-idle.mjs', 'model-transport-error.mjs', 'plan.mjs', 'studio-digest.mjs', 'dispatch-diagnostics.mjs'];
const sourceFiles = ['server.mjs', ...runtimeModules, 'package.json', 'bun.lock'];

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 180000 });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout.trim();
}

export function verifyRuntime(runtime, target) {
  if (!runtime) throw new Error('BEEFTV_NODE_RUNTIME is required; release builds cannot use global Node');
  const expected = targets[target];
  if (!expected) throw new Error(`Unsupported agent-host target: ${target}`);
  const node = path.resolve(runtime, expected[0] === 'win32' ? 'node.exe' : 'bin/node');
  if (!existsSync(node)) throw new Error(`Missing bundled Node: ${node}`);
  const actual = JSON.parse(run(node, ['-p', 'JSON.stringify([process.platform,process.arch,process.versions.node])']));
  if (actual.join('/') !== [...expected, NODE_VERSION].join('/')) throw new Error(`Node target/version mismatch: expected ${expected.join('/')} ${NODE_VERSION}, got ${actual.join('/')}`);
  if (expected[0] === 'darwin') {
    const links = run('/usr/bin/otool', ['-L', node]).split('\n').slice(1).map(line => line.trim().split(' ')[0]).filter(Boolean);
    if (links.some(link => !link.startsWith('/usr/lib/') && !link.startsWith('/System/'))) throw new Error(`Bundled Node has non-system dylibs: ${links.join(', ')}`);
  }
  return node;
}

export function packageAgentHost({ runtime, target, destination, source = path.join(root, 'agent-host') }) {
  const node = verifyRuntime(runtime, target);
  if (!destination) throw new Error('agent-host destination is required');
  for (const name of sourceFiles) {
    if (!existsSync(path.join(source, name))) throw new Error(`Missing agent-host source: ${name}`);
  }
  const stage = mkdtempSync(path.join(tmpdir(), 'beeftv agent host '));
  try {
    for (const name of sourceFiles) cpSync(path.join(source, name), path.join(stage, name));
    // Install from the committed lock into a clean tree, never from developer node_modules.
    run(process.execPath, ['install', '--production', '--frozen-lockfile', '--backend', 'copyfile', '--os', targets[target][0], '--cpu', targets[target][1]], stage);
    const nodeRelative = target.startsWith('windows/') ? 'runtime/node.exe' : 'runtime/bin/node';
    const bundledNode = path.join(stage, nodeRelative);
    mkdirSync(path.dirname(bundledNode), { recursive: true });
    cpSync(node, bundledNode, { dereference: true });
    chmodSync(bundledNode, 0o755);
    // Resolve precisely the host imports under the shipped Node and shipped dependency tree.
    const imports = ['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai',
      '@earendil-works/pi-durable', '@earendil-works/pi-durable/storage/sqlite/node',
      '@earendil-works/pi-ai/providers/openai', ...runtimeModules.map(name => `./${name}`)];
    run(bundledNode, ['--input-type=module', '-e',
      imports.map(name => `await import(${JSON.stringify(name)});`).join('\n')], stage);
    run(bundledNode, ['--check', 'server.mjs'], stage);
    if (existsSync(destination)) throw new Error(`Refusing to overwrite existing agent-host: ${destination}`);
    cpSync(stage, destination, { recursive: true, dereference: true });
    console.log(`Packaged agent-host with Node ${NODE_VERSION} for ${target}: ${destination}`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.versions.bun) throw new Error('Run this packaging helper with Bun');
    const [target, destination] = process.argv.slice(2);
    if (destination === '--verify-runtime') verifyRuntime(process.env.BEEFTV_NODE_RUNTIME, target);
    else packageAgentHost({ runtime: process.env.BEEFTV_NODE_RUNTIME, target, destination });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
