export type TaskStatus = 'ready' | 'waiting' | 'generating' | 'completed' | 'failed';
export type AccountPlatform = 'doubao' | 'dola';
export interface ImageAsset { id: string; name: string; url: string; size: number; }

/** Renderer-safe attachment descriptor. Only the id is used to resolve the file in main. */
export interface StagedAttachment {
  id: string;
  assetId: string;
  name: string;
  mimeType: string;
  url?: string;
}

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

export type GatewayRole = 'user' | 'assistant';

export interface GatewayAttachment {
  id: string;
  kind: 'image' | 'video';
  /** Local file URL, so the renderer can display it without a network round trip. */
  url: string;
  name: string;
  path?: string;
}

export interface GatewayMessage {
  id: number;
  threadId: string;
  role: GatewayRole;
  content: string;
  attachments: GatewayAttachment[];
  status: 'pending' | 'streaming' | 'done' | 'failed';
  error: string;
  createdAt: string;
  /** Account that produced this message, shown as 账号N 回复 in the chat. */
  accountId: number | null;
}

export interface GatewayThread {
  id: string;
  title: string;
  doubaoConversationId: string;
  accountId: number | null;
  model: string;
  createdAt: string;
  updatedAt: string;
  messageCount?: number;
}

/** Result of one gateway chat turn, as reported to the renderer. */
export interface GatewayTurnResult {
  thread: GatewayThread;
  message: GatewayMessage;
}
