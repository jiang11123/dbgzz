export type AppUpdateState = {
  status: 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing' | 'error';
  currentVersion: string;
  latestVersion: string;
  releaseNotes: string;
  downloadedBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
  reconnecting: boolean;
  error: string;
};
