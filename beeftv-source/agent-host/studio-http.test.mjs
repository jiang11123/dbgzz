import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('production readCanvas -> Durable digest and unbound checks across HTTP', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const scratch = mkdtempSync(path.join(tmpdir(), 'beeftv-studio-receipt-'));
  try {
    const receipt = path.join(scratch, 'receipt.json');
    const child = spawnSync('node', [path.join(root, 'agent-host/test-support/studio-http-probe.mjs'), root, receipt], { cwd: root, encoding: 'utf8', timeout: 150000 });
    if (child.error) throw child.error;
    const result = JSON.parse(readFileSync(receipt, 'utf8'));
    expect(result.results.length).toBe(13);
    expect(result.results.filter(r => !r.passed), JSON.stringify(result)).toEqual([]);
    expect(child.status, child.stderr).toBe(0);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 170000);
