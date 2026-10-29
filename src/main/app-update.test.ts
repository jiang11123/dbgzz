import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppUpdateService } from './app-update';

class Engine extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
  allowDowngrade = true;
  checks = 0;
  downloads = 0;
  installs = 0;
  failDownload = false;
  async checkForUpdates() {
    this.checks++;
    this.emit('checking-for-update');
    await Promise.resolve();
    this.emit('update-available', { version: '3.0.1', releaseNotes: '修复问题' });
  }
  async downloadUpdate() {
    this.downloads++;
    await Promise.resolve();
    if (this.failDownload) throw new Error('checksum mismatch');
    this.emit('download-progress', { transferred: 50, total: 100, bytesPerSecond: 20 });
    this.emit('download-progress', { transferred: 100, total: 100, bytesPerSecond: 20 });
    this.emit('update-downloaded');
  }
  quitAndInstall(silent?: boolean, runAfter?: boolean) {
    assert.equal(silent, false);
    assert.equal(runAfter, true);
    this.installs++;
  }
}

test('development and unpacked builds do not check, download or install', async () => {
  const engine = new Engine();
  const service = new AppUpdateService(engine, '3.0.0', { disabledReason: '请先安装正式安装版', beforeInstall() {} });
  assert.equal((await service.check()).status, 'disabled');
  await service.download();
  assert.equal(engine.checks + engine.downloads, 0);
  assert.throws(() => service.install());
});

test('concurrent checks share a request, notify once, and never auto-download', async () => {
  const engine = new Engine();
  let notices = 0;
  const service = new AppUpdateService(engine, '3.0.0', { beforeInstall() {}, notifyAvailable() { notices++; } });
  await Promise.all([service.check(), service.check()]);
  assert.equal(engine.checks, 1);
  assert.equal(service.snapshot().latestVersion, '3.0.1');
  await service.check();
  assert.equal(notices, 1);
  assert.equal(engine.downloads, 0);
  assert.equal(engine.autoDownload, false);
  assert.equal(engine.autoInstallOnAppQuit, false);
  assert.equal(engine.allowDowngrade, false);
  assert.equal(engine.allowPrerelease, false);
});

test('verified download is staged once and cannot be erased by periodic checks', async () => {
  const engine = new Engine();
  const service = new AppUpdateService(engine, '3.0.0', { beforeInstall() {} });
  await service.check();
  await Promise.all([service.download(), service.download(), service.check()]);
  assert.equal(service.snapshot().status, 'ready');
  assert.equal(service.snapshot().downloadedBytes, 100);
  assert.equal(engine.downloads, 1);
  assert.equal(engine.checks, 1);
  assert.equal(engine.installs, 0);
  await service.check();
  assert.equal(service.snapshot().status, 'ready');
});

test('checksum failure refuses installation and allows a fresh download', async () => {
  const engine = new Engine();
  engine.failDownload = true;
  const service = new AppUpdateService(engine, '3.0.0', { beforeInstall() {} });
  await service.check();
  assert.equal((await service.download()).status, 'error');
  assert.throws(() => service.install());
  engine.failDownload = false;
  assert.equal((await service.download()).status, 'ready');
  assert.equal(engine.downloads, 2);
});

test('active tasks block restart while preserving the verified download', async () => {
  const engine = new Engine();
  let busy = true;
  const service = new AppUpdateService(engine, '3.0.0', { beforeInstall() { if (busy) throw new Error('仍有任务'); } });
  await service.check();
  await service.download();
  assert.throws(() => service.install(), /仍有任务/);
  assert.equal(service.snapshot().status, 'ready');
  assert.equal(engine.installs, 0);
  busy = false;
  service.install();
  assert.equal(service.snapshot().status, 'installing');
  assert.throws(() => service.install());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(engine.installs, 1);
});

test('feed and engine errors can be retried without executing the installer', async () => {
  const engine = new Engine();
  const service = new AppUpdateService(engine, '3.0.0', { beforeInstall() {} });
  engine.checkForUpdates = async () => { throw new Error('network offline'); };
  assert.equal((await service.check()).status, 'error');
  engine.emit('error', new Error('HTTP 404'));
  assert.equal(service.snapshot().status, 'error');
  engine.checkForUpdates = async () => { engine.emit('update-not-available'); };
  assert.equal((await service.check()).status, 'idle');
  assert.equal(engine.installs, 0);
});
