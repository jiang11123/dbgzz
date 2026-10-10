export type TaskStatus = 'ready' | 'waiting' | 'generating' | 'completed' | 'failed';
export type AccountPlatform = 'doubao' | 'dola';
export interface ImageAsset { id: string; name: string; url: string; size: number; }

export interface Account {
  id: number;
  name: string;
  platform: AccountPlatform;
  note: string;
  sessionName: string;
  isLoggedIn: boolean;
}

export interface Project {
  id: number;
  name: string;
  directory: string;
  createdAt: string;
  updatedAt: string;
}

export interface Asset {
  id: number;
  projectId: number | null;
  taskId: number | null;
  type: 'image' | 'video';
  path: string;
  createdAt: string;
}

export interface VideoTask {
  id: number;
  projectId: number;
  sceneNumber: string;
  name: string;
  prompt: string;
  ratio: string;
  accountId: number | null;
  status: TaskStatus;
  videoPath: string | null;
  note: string;
  createdAt: string;
  updatedAt: string;
  assets: Asset[];
}

export interface Dashboard {
  completedCount: number;
  statusCounts: Record<TaskStatus, number>;
  recentProjects: Project[];
}

export interface DownloadCandidate { path: string; name: string; }

export interface ShareVideo {
  id: string;
  vid: string;
  name: string;
  url: string;
  width: number;
  height: number;
  definition: string;
}
export interface ShareParseResult { shareUrl: string; videos: ShareVideo[]; warnings: string[]; }

export type DownloadStatus = {
  state: 'started' | 'completed' | 'failed' | 'duplicate';
  accountId: number;
  name: string;
  path?: string;
  reason?: string;
};

export interface VideoLibraryItem {
  taskId: number;
  projectId: number;
  projectName: string;
  sceneNumber: string;
  taskName: string;
  accountId: number | null;
  accountName: string | null;
  videoPath: string;
  completedAt: string;
}

export type UpscaleTarget = '2k' | '4k';
export interface UpscaleJob {
  id: string;
  inputPath: string;
  target: UpscaleTarget;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  stage: string;
  progress?: { percent: number; frame: number; total: number; fps: number; elapsed: string; remaining: string };
  outputPath?: string;
  error?: string;
}
