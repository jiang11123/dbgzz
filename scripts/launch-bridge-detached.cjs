const { spawn } = require('node:child_process');
const path = require('node:path');

const workspace = path.resolve(__dirname, '..');
const child = spawn('cmd.exe', ['/d', '/s', '/c', 'npm.cmd start'], {
  cwd: workspace,
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});

child.unref();
