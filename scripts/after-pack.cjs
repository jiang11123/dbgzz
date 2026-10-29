// electron-builder afterPack：extraResources 复制会丢弃 node_modules 目录名，
// agent-host 的运行时依赖（141MB，@earendil-works/pi-coding-agent 等）必须补回
// win-unpacked/resources/agent-host/node_modules，NSIS 随后才打安装包。
const { cpSync, existsSync } = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const source = path.join(context.packager.projectDir, 'build', 'agent-host', 'node_modules');
  const target = path.join(context.appOutDir, 'resources', 'agent-host', 'node_modules');
  if (!existsSync(source)) {
    console.warn(`[after-pack] 缺少 ${source}，跳过（Beef Agent 将不可用）`);
    return;
  }
  if (existsSync(target)) return;
  console.log('[after-pack] restoring agent-host node_modules ...');
  cpSync(source, target, { recursive: true });
  console.log('[after-pack] agent-host node_modules restored');
};
