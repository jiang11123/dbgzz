import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function runDurableNodeCases(file) {
  const configured = process.env.BEEFTV_NODE_RUNTIME;
  const bundled = '/Applications/BeefTV.app/Contents/Resources/agent-host/runtime/bin/node';
  const node = configured ? path.join(configured, process.platform === 'win32' ? 'node.exe' : 'bin/node') :
    process.platform === 'darwin' && fs.existsSync(bundled) ? bundled : 'node';
  return new Promise((resolve, reject) => {
    const child = spawn(node, ['--test', fileURLToPath(new URL(file, import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Node cases timed out: ' + output)); }, 180000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); if (code === 0) resolve(output); else reject(new Error(output)); });
  });
}
