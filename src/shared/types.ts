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

// ---------------------------------------------------------------------------
// 豆包 3.0 网关视频规范与 BeefTV 对接契约
// ---------------------------------------------------------------------------

export type GatewayVideoTaskStatus =
  | 'queued'
  | 'processing'
  | 'awaiting_confirmation'
  | 'completed'
  | 'needs_attention'
  | 'failed'
  | 'cancelled';

export interface GatewayVideoTaskResponse {
  task_id: string;
  status: GatewayVideoTaskStatus;
  progress?: number;
  video_url?: string | null;
  local_path?: string | null;
  last_frame_path?: string | null;
  status_text?: string;
  /** 豆包最新回复原文；awaiting_confirmation 时是待用户确认的问题内容。 */
  latest_reply?: string | null;
  error?: string | null;
  created_at?: number;
  updated_at?: number;
}
