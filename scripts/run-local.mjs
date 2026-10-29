// 本地运行：不打安装包，直接用源码启动工作站。
//   node scripts/run-local.mjs            主程序代码有改动才重新构建（几秒），然后启动；已在运行则只切到前台
//   node scripts/run-local.mjs --restart  先正常关闭正在运行的实例，再构建并启动（改完代码后用这个）
//   node scripts/run-local.mjs --full     连 Go 后端、协议包、BeefTV 网页前端一起重建（几分钟）
// 运行时的资源取自源码目录：build/beeftv-backend.exe、build/cli、build/agent-host、
// ../doubao3.0/web/dist；数据目录与安装版相同（doubao-video-workspace），账号和画布都在。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const siblingSource = path.resolve(root, '..', 'doubao3.0');
const beeftvRoot = process.env.BEEFTV_SOURCE_DIR ? path.resolve(process.env.BEEFTV_SOURCE_DIR)
  : fs.existsSync(path.join(siblingSource, 'web', 'package.json')) ? siblingSource : path.join(root, 'beeftv-source');
const args = new Set(process.argv.slice(2));
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');

const log = (message) => console.log(`[本地版] ${message}`);

/** 目录下最新的修改时间（毫秒）；skip 命中的目录和不匹配 accept 的文件都忽略。 */
function newest(dir, accept, skip = /node_modules|[\\/]dist$|[\\/]\.git$/) {
  let latest = 0;
  const walk = (current) => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { if (!skip.test(full)) walk(full); continue; }
      if (!accept(entry.name)) continue;
      try { latest = Math.max(latest, fs.statSync(full).mtimeMs); } catch { /* 文件刚被删除 */ }
    }
  };
  walk(dir);
  return latest;
}
const mtime = (file) => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };

function run(command, commandArgs, cwd = root) {
  const result = spawnSync(command, commandArgs, { cwd, stdio: 'inherit', shell: true });
  if (result.status !== 0) { log(`失败：${command} ${commandArgs.join(' ')}`); process.exit(result.status || 1); }
}

/** 正在运行的、属于本项目的工作站进程（源码运行版或 release 里的解压版）。 */
function runningProcessIds() {
  const script = `Get-Process | Where-Object { $_.Path -and ($_.Path -like '${root}\\node_modules\\electron\\*' -or $_.Path -like '${root}\\release*\\win-unpacked\\*') } | ForEach-Object { $_.Id }`;
  const out = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).stdout || '';
  return out.split(/\s+/).filter(Boolean).map(Number);
}

function closeRunning() {
  const ids = runningProcessIds();
  if (!ids.length) return;
  log('正在正常关闭正在运行的工作站…');
  spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-Process | Where-Object { $_.Id -in @(${ids.join(',')}) -and $_.MainWindowHandle -ne 0 } | ForEach-Object { [void]$_.CloseMainWindow() }`]);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && runningProcessIds().length) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  if (runningProcessIds().length) {
    log('仍有进程未退出，请先手动关闭工作站再重试。');
    process.exit(2);
  }
}

if (!fs.existsSync(electronExe)) { log('找不到 Electron，请先在项目目录执行 npm install'); process.exit(1); }

if (args.has('--restart') || args.has('--full')) closeRunning();
else if (runningProcessIds().length) {
  log('工作站已在运行（改过代码的话请用「重启本地版」）。');
  spawn(electronExe, [root], { detached: true, stdio: 'ignore' }).unref(); // 单实例锁会把已运行的窗口切到前台
  process.exit(0);
}

// 1) 完整重建：Go 后端、随包 CLI、协议包、agent-host、BeefTV 网页前端
if (args.has('--full')) {
  log('完整重建（后端 / CLI / 协议包 / 网页前端），需要几分钟…');
  run('npm', ['run', 'build:beeftv']);
}

// 2) 主程序与旧界面：源码比产物新才构建
const mainBuilt = mtime(path.join(root, 'dist', 'main', 'main', 'main.js'));
const rendererBuilt = mtime(path.join(root, 'dist', 'renderer', 'index.html'));
const mainSrc = newest(path.join(root, 'src'), (name) => /\.(ts|tsx|html|css)$/.test(name));
if (args.has('--full') || mainSrc > Math.min(mainBuilt, rendererBuilt) || !mainBuilt) {
  log('主程序代码有更新，正在构建…');
  run('npm', ['run', 'build']);
} else {
  log('主程序已是最新，跳过构建。');
}

// 3) 提醒：这几类资源不会自动重建，源码比产物新时提示
const warnings = [];
const goSrc = newest(path.join(beeftvRoot, 'backend'), (name) => name.endsWith('.go') && !name.endsWith('_test.go'));
if (goSrc > mtime(path.join(root, 'build', 'beeftv-backend.exe'))) warnings.push('Go 后端源码比 build/beeftv-backend.exe 新');
const webSrc = newest(path.join(beeftvRoot, 'web', 'src'), (name) => /\.(ts|tsx|css)$/.test(name));
if (webSrc > mtime(path.join(beeftvRoot, 'web', 'dist', 'index.html'))) warnings.push('BeefTV 网页前端源码比 web/dist 新');
if (warnings.length) {
  log(`提示：${warnings.join('；')}。这些改动要用「完整重建并启动」才会生效。`);
}

// 4) 启动：脱离当前控制台，命令行窗口可以直接关闭
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
spawn(electronExe, [root], { detached: true, stdio: 'ignore', env, cwd: root }).unref();
log('已启动。');
