import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

export function beeftvWebDist(): string {
  const fromEnv = process.env.BEEFTV_WEB_DIST;
  if (fromEnv) return path.resolve(fromEnv);
  if (app.isPackaged) {
    const packaged = path.join(process.resourcesPath, 'beeftv-web');
    if (fs.existsSync(path.join(packaged, 'index.html'))) return packaged;
  }
  // 开发态：与工作站同级的 BeefTV 仓库（规范指定路径 doubao3.0/web）
  const source = process.env.BEEFTV_SOURCE_DIR;
  if (source) return path.resolve(source, 'web', 'dist');
  const sibling = path.resolve(app.getAppPath(), '..', 'doubao3.0', 'web', 'dist');
  return fs.existsSync(path.join(sibling, 'index.html')) ? sibling : path.join(app.getAppPath(), 'beeftv-source', 'web', 'dist');
}

export function beeftvBackendExe(): string | null {
  const fromEnv = process.env.BEEFTV_BACKEND_PATH;
  if (fromEnv) return path.resolve(fromEnv);
  if (app.isPackaged) {
    const packaged = path.join(process.resourcesPath, 'beeftv-backend.exe');
    return fs.existsSync(packaged) ? packaged : null;
  }
  const dev = path.resolve(app.getAppPath(), 'build', 'beeftv-backend.exe');
  return fs.existsSync(dev) ? dev : null;
}

export function beeftvPluginDir(): string {
  const fromEnv = process.env.BEEFTV_PLUGIN_DIR;
  if (fromEnv) return path.resolve(fromEnv);
  if (app.isPackaged) {
    const packaged = path.join(process.resourcesPath, 'beeftv-plugins');
    if (fs.existsSync(packaged)) return packaged;
  }
  return path.resolve(app.getAppPath(), 'build', 'beeftv-plugins');
}
