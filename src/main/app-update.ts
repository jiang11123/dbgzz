import type { AppUpdateState } from '../shared/app-update';

export interface UpdateEngine {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

// The renderer owns saving editors; this controller only downloads and installs
// via electron-updater, which verifies the published SHA-512 before staging.
export class AppUpdateService {
  private state: AppUpdateState;
  private checkJob: Promise<AppUpdateState> | null = null;
  private downloadJob: Promise<AppUpdateState> | null = null;
  private lastNotifiedVersion = '';

  constructor(private readonly engine: UpdateEngine, version: string, private readonly options: {
    disabledReason?: string;
    beforeInstall: () => void;
    notifyAvailable?: (version: string) => void;
    log?: (message: string) => void;
  }) {
    this.state = {
      status: options.disabledReason ? 'disabled' : 'idle', currentVersion: version,
      latestVersion: '', releaseNotes: '', downloadedBytes: 0, totalBytes: 0,
      bytesPerSecond: 0, reconnecting: false, error: options.disabledReason || '',
    };
    engine.autoDownload = false;
    engine.autoInstallOnAppQuit = false;
    engine.allowPrerelease = false;
    engine.allowDowngrade = false;
    engine.on('checking-for-update', () => this.patch({ status: 'checking', error: '' }));
    engine.on('update-available', (info: { version: string; releaseNotes?: string | Array<{ note: string }> }) => {
      const releaseNotes = typeof info.releaseNotes === 'string' ? info.releaseNotes : (info.releaseNotes || []).map(item => item.note).join('\n');
      this.patch({ status: 'available', latestVersion: info.version, releaseNotes, error: '' });
      if (this.lastNotifiedVersion !== info.version) {
        this.lastNotifiedVersion = info.version;
        options.notifyAvailable?.(info.version);
      }
    });
    engine.on('update-not-available', () => this.patch({ status: 'idle', latestVersion: '', releaseNotes: '', error: '' }));
    engine.on('download-progress', (progress: { transferred: number; total: number; bytesPerSecond: number }) => {
      this.patch({ status: 'downloading', downloadedBytes: progress.transferred, totalBytes: progress.total, bytesPerSecond: progress.bytesPerSecond });
    });
    engine.on('update-downloaded', () => this.patch({ status: 'ready', downloadedBytes: this.state.totalBytes, bytesPerSecond: 0, error: '' }));
    engine.on('error', (error: Error) => this.fail(error));
  }

  snapshot(): AppUpdateState { return { ...this.state }; }

  check(): Promise<AppUpdateState> {
    if (this.checkJob) return this.checkJob;
    if (this.options.disabledReason || ['downloading', 'ready', 'installing'].includes(this.state.status)) return Promise.resolve(this.snapshot());
    this.patch({ status: 'checking', latestVersion: '', releaseNotes: '', downloadedBytes: 0, totalBytes: 0, bytesPerSecond: 0, error: '' });
    this.checkJob = Promise.resolve().then(() => this.engine.checkForUpdates())
      .then(() => this.snapshot(), error => { this.fail(error); return this.snapshot(); })
      .finally(() => { this.checkJob = null; });
    return this.checkJob;
  }

  download(): Promise<AppUpdateState> {
    if (this.downloadJob) return this.downloadJob;
    if (this.options.disabledReason) return Promise.resolve(this.snapshot());
    if (!this.state.latestVersion || !['available', 'error'].includes(this.state.status)) return Promise.resolve(this.snapshot());
    this.patch({ status: 'downloading', error: '', bytesPerSecond: 0 });
    this.downloadJob = Promise.resolve().then(() => this.engine.downloadUpdate())
      .then(() => this.snapshot(), error => { this.fail(error); return this.snapshot(); })
      .finally(() => { this.downloadJob = null; });
    return this.downloadJob;
  }

  install(): void {
    if (this.options.disabledReason || this.state.status !== 'ready') throw new Error('请先下载并校验更新包。');
    this.options.beforeInstall();
    this.patch({ status: 'installing', error: '' });
    // Return the IPC response before closing the window that initiated it.
    setImmediate(() => {
      try { this.engine.quitAndInstall(false, true); }
      catch (error) { this.fail(error); }
    });
  }

  private patch(patch: Partial<AppUpdateState>) { Object.assign(this.state, patch); }

  private fail(error: unknown) {
    this.options.log?.(error instanceof Error ? error.message : String(error));
    this.patch({ status: 'error', bytesPerSecond: 0, error: '更新连接或文件校验失败，请检查网络后重试。' });
  }
}
