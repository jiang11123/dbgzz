export type CanvasNodeType = 
  | 'script' 
  | 'image' 
  | 'video' 
  | 'audio' 
  | 'director' 
  | 'markdown' 
  | 'frame' 
  | 'doubao_account';

export interface CanvasPosition {
  x: number;
  y: number;
}

export interface CanvasConnection {
  id: string;
  fromNodeId: string;
  fromPort: 'output' | 'last_frame' | 'image_out' | 'reply_text' | 'script_out';
  toNodeId: string;
  toPort: 'input' | 'reference_image' | 'prompt_in';
}

export interface ScriptNodeData {
  title: string;
  content: string;
  generatedScenes?: Array<{ sceneNumber: number; prompt: string }>;
}

export interface ImageNodeData {
  title: string;
  prompt: string;
  model: string;
  ratio: string;
  imageUrl?: string;
  localPath?: string;
  status: 'idle' | 'generating' | 'completed' | 'failed';
  error?: string | null;
}

export interface VideoNodeData {
  title: string;
  sceneNumber?: number;
  prompt: string;
  model: string;
  ratio: string;
  duration: number;
  inputImageUrl?: string;
  inputImagePath?: string;
  videoUrl?: string;
  localPath?: string;
  lastFramePath?: string;
  lastFrameUrl?: string;
  taskId?: string;
  status: 'idle' | 'queued' | 'processing' | 'completed' | 'needs_attention' | 'failed';
  statusText?: string;
  progress: number;
  error?: string | null;
  accountId?: number | null;
}

export interface AudioNodeData {
  title: string;
  prompt: string;
  voice: string;
  audioUrl?: string;
  status: 'idle' | 'generating' | 'completed' | 'failed';
}

export interface DirectorNodeData {
  title: string;
  role: string;
  inputIdea: string;
  suggestions: string[];
}

export interface MarkdownNodeData {
  title: string;
  content: string;
}

export interface FrameNodeData {
  title: string;
  width: number;
  height: number;
  color?: string;
}

/** 专属豆包账号节点：绑定特定账号，文字直接定向发送该账号 */
export interface DoubaoAccountNodeData {
  title: string;
  selectedAccountId: number | null;
  accountName?: string;
  promptText: string;
  status: 'idle' | 'sending' | 'replied' | 'error';
  replyText?: string;
  error?: string | null;
}

export interface CanvasNode {
  id: string;
  type: CanvasNodeType;
  position: CanvasPosition;
  data: 
    | ScriptNodeData 
    | ImageNodeData 
    | VideoNodeData 
    | AudioNodeData 
    | DirectorNodeData 
    | MarkdownNodeData 
    | FrameNodeData 
    | DoubaoAccountNodeData;
}
