// 豆包 3.0：构建 BeefTV 宿主产物——Go 后端（cmd/server → build/beeftv-backend.exe）
// 与 BeefTV web（../doubao3.0/web → dist）。打包前运行；缺 Go 时只构建 web 并提示。
// agent-host（含 Node 运行时）从本机已安装的 BeefTV 发行版复制到 exe 旁——
// 后端按 Windows 布局在自身目录找 agent-host/runtime/node.exe + server.mjs（BundledConfig）。
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(process.cwd());
const siblingSource = path.resolve(root, '..', 'doubao3.0');
const beeftvRoot = process.env.BEEFTV_SOURCE_DIR ? path.resolve(process.env.BEEFTV_SOURCE_DIR)
  : existsSync(path.join(siblingSource, 'web', 'package.json')) ? siblingSource : path.join(root, 'beeftv-source');
const backendOut = path.join(root, 'build', 'beeftv-backend.exe');
// 外部客户端（Codex / Claude Code / Cursor）通过随包 CLI 接入 BeefTV MCP；
// 后端只在自身目录的 cli/ 下找 beeftv.exe，缺失时 MCP 页提示“安装文件不完整”。
const cliOut = path.join(root, 'build', 'cli', 'beeftv.exe');

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: 'inherit', ...options });
}

// 后端读取的是 .beeftv-plugin ZIP 包，不会加载 manifest 源码目录。
run('powershell', ['-NoProfile', '-File', path.join(root, 'scripts', 'build-beeftv-plugins.ps1'),
  '-SourceDir', path.join(beeftvRoot, 'plugin-packages'), '-OutputDir', path.join(root, 'build', 'beeftv-plugins')]);

let backendBuilt = false;
const goCandidates = [process.env.GO_PATH, 'D:\\doubao\\go\\bin\\go.exe', 'go', 'C:\\Program Files\\Go\\bin\\go.exe'].filter(Boolean);
// go-sqlite3 必须启用 CGO；gcc 用本机 winlibs 工具链（winget/系统 PATH 里通常没有）。
const mingwBin = 'D:\\doubao\\mingw-extract\\mingw64\\bin';
const goEnv = {
  ...process.env,
  CGO_ENABLED: '1',
  CC: 'gcc',
  GOPROXY: process.env.GOPROXY || 'https://goproxy.cn,direct',
  PATH: `${mingwBin};${process.env.PATH || process.env.Path}`,
};
for (const go of goCandidates) {
  try {
    run(go, ['build', '-trimpath', '-ldflags', '-s -w', '-o', backendOut, './cmd/server'], { cwd: path.join(beeftvRoot, 'backend'), env: goEnv });
    backendBuilt = true;
    console.log(`[build-beeftv] backend -> ${backendOut}`);
    mkdirSync(path.dirname(cliOut), { recursive: true });
    run(go, ['build', '-trimpath', '-ldflags', '-s -w', '-o', cliOut, './cmd/beeftv'], { cwd: path.join(beeftvRoot, 'backend'), env: goEnv });
    console.log(`[build-beeftv] cli -> ${cliOut}`);
    break;
  } catch (error) {
    if (go === goCandidates[goCandidates.length - 1]) console.warn(`[build-beeftv] Go 构建失败（${error.message}）；如需打包请安装 Go 或设置 GO_PATH`);
  }
}
if (!backendBuilt) console.warn('[build-beeftv] 跳过后端构建：宿主将仅提供静态服务，/api 需外部后端');

// agent-host：优先从本机 BeefTV 发行版复制（带 Node 运行时），exe 旁布局是 BundledConfig 的硬约定
const agentHostSources = ['E:\\beeftv\\agent-host', 'D:\\beeftv\\agent-host', 'C:\\Program Files\\BeefTV\\agent-host'];
const agentHostSource = agentHostSources.find((dir) => existsSync(`${dir}\\runtime\\node.exe`) && existsSync(`${dir}\\server.mjs`));
if (agentHostSource) {
  cpSync(agentHostSource, path.join(root, 'build', 'agent-host'), { recursive: true });
  console.log(`[build-beeftv] agent-host -> build/agent-host（来自 ${agentHostSource}）`);
  // 发行版 agent-host 是原版；doubao3.0/agent-host 里有 3.0 的修改（如放宽 system-prompt 的画布专用限制），
  // 同名的顶层 .mjs 以 doubao3.0 为准覆盖，避免打包时把修改冲回原版。
  const overlayDir = path.join(beeftvRoot, 'agent-host');
  for (const name of readdirSync(path.join(root, 'build', 'agent-host'))) {
    if (!name.endsWith('.mjs') || name.endsWith('.test.mjs')) continue;
    const override = path.join(overlayDir, name);
    if (existsSync(override)) { cpSync(override, path.join(root, 'build', 'agent-host', name)); console.log(`[build-beeftv] agent-host overlay <- doubao3.0/agent-host/${name}`); }
  }
} else if (!existsSync(path.join(root, 'build', 'agent-host', 'server.mjs'))) {
  console.warn('[build-beeftv] 未找到 BeefTV 发行版的 agent-host：Beef Agent 助手将不可用（host_command_missing）');
}

// electron-builder（extraResources 与 NSIS 两处）都会忽略 node_modules 目录名，
// agent-host 的运行时依赖必须以 zip 携带、安装时由 NSIS customInstall 解压。
const nodeModulesSource = path.join(root, 'build', 'agent-host', 'node_modules');
const nodeModulesZip = path.join(root, 'build', 'agent-host-node_modules.zip');
if (existsSync(nodeModulesSource)) {
  if (process.env.BEEFTV_7ZA) {
    run(process.env.BEEFTV_7ZA, ['a', '-tzip', '-mx=5', nodeModulesZip, 'node_modules'], { cwd: path.dirname(nodeModulesSource) });
  } else {
    execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path "${nodeModulesSource}" -DestinationPath "${nodeModulesZip}" -Force`], { stdio: 'inherit' });
  }
  console.log('[build-beeftv] agent-host node_modules -> build/agent-host-node_modules.zip');
}

const webDir = path.join(beeftvRoot, 'web');
if (existsSync(path.join(webDir, 'node_modules'))) {
  run('npm', ['run', 'build'], { cwd: webDir, shell: process.platform === 'win32', env: {
    ...process.env, CANVAS_BUILD_VERSION: JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version,
  } });
  cpSync(path.join(webDir, 'dist'), path.join(root, 'build', 'beeftv-web'), { recursive: true });
  console.log('[build-beeftv] web dist 构建完成，并复制到 build/beeftv-web');
} else {
  console.warn(`[build-beeftv] ${webDir} 未安装依赖，跳过 web 构建（沿用现有 dist）`);
}
