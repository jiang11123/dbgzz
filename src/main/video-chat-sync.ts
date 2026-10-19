import type { CanvasBridgeTask } from './canvas-bridge';
import type { GatewayMessage, GatewayThread } from '../shared/types';

export type ChatStore = {
  gatewayThread(id: string): GatewayThread | null;
  gatewayMessages(id: string): GatewayMessage[];
  updateGatewayMessage(id: number, patch: Partial<GatewayMessage>): void;
  appendGatewayMessage(message: {threadId:string;role:GatewayMessage['role'];content:string;status?:GatewayMessage['status'];accountId?:number|null}):number;
  updateGatewayThread?: (id: string, patch: Partial<Pick<GatewayThread, 'title' | 'doubaoConversationId' | 'accountId' | 'model'>>) => void;
};
export function syncVideoTaskToChat(task: CanvasBridgeTask, store: ChatStore, emit: (payload: { threadId: string; messageId: number; full: string; videoTaskId: string; videoStatus: string }) => void) {
  if (!task.gatewayThreadId || task.gatewayReplyMessageId == null || !store.gatewayThread(task.gatewayThreadId)) return false;
  const message = store.gatewayMessages(task.gatewayThreadId).find(m => m.id === task.gatewayReplyMessageId && m.role === 'assistant');
  if (!message) return false;
  const full = task.latestReply || task.statusText;
  const failed = ['failed', 'needs_attention', 'cancelled'].includes(task.status);
  store.updateGatewayMessage(message.id, { content: full, accountId: task.accountId,
    status: failed ? 'failed' : task.status === 'completed' ? 'done' : 'streaming', error: failed ? task.error || task.statusText : '' });

  if (task.pageUrl && store.updateGatewayThread) {
    const match = /\/chat\/([0-9a-zA-Z_-]+)/.exec(task.pageUrl);
    if (match && match[1] && !match[1].startsWith('local_')) {
      const thread = store.gatewayThread(task.gatewayThreadId);
      if (thread && (!thread.doubaoConversationId || thread.doubaoConversationId !== match[1])) {
        store.updateGatewayThread(task.gatewayThreadId, {
          doubaoConversationId: match[1],
          accountId: task.accountId ?? thread.accountId
        });
      }
    }
  }

  emit({ threadId: task.gatewayThreadId, messageId: message.id, full, videoTaskId: task.id, videoStatus: task.status });
  return true;
}

export function findVideoTaskForThread(tasks: CanvasBridgeTask[], threadId: string) {
  const candidates = tasks.filter(t => t.gatewayThreadId === threadId && ['awaiting_reply','awaiting_confirmation','generating'].includes(t.status));
  return candidates.length === 1 ? candidates[0] : null;
}

/** Upgrade legacy in-flight jobs only when prompt AND creation time identify one exact turn. */
export function recoverLegacyVideoLink(task: CanvasBridgeTask, threads: GatewayThread[], messages: (id: string) => GatewayMessage[]) {
  const matches: { threadId: string; replyMessageId: number }[] = [];
  for (const thread of threads) {
    const rows = messages(thread.id);
    for (let i=0;i<rows.length;i++) {
      const row=rows[i];
      if (row.role !== 'user' || row.content.trim() !== task.prompt.trim() || Math.abs(Date.parse(row.createdAt)-Date.parse(task.createdAt)) > 30000 || !Number.isFinite(Date.parse(row.createdAt))) continue;
      const reply=rows.slice(i+1).find(m=>m.role==='assistant');
      if (reply && (reply.status==='pending' || reply.status==='streaming')) matches.push({threadId:thread.id,replyMessageId:reply.id});
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

const followupLocks = new WeakMap<object, Set<string>>();
export async function forwardVideoChatMessage(bridge: {
  list(): CanvasBridgeTask[];
  linkChatTask(taskId:string,threadId:string,replyId:number,resetReply?:boolean):void;
  confirmTask(taskId:string,text:string):Promise<boolean>;
}, store: ChatStore, threadId: string, text: string) {
  text = text.trim();
  if (!threadId || !text || !store.gatewayThread(threadId)) return false;
  const task = findVideoTaskForThread(bridge.list(), threadId);
  if (!task) return false;
  const locks = followupLocks.get(bridge) || new Set<string>(); followupLocks.set(bridge, locks);
  if (locks.has(threadId)) throw new Error('本会话的上一条补充消息正在转交');
  locks.add(threadId);
  let userId: number | undefined, replyId: number | undefined;
  try {
    const previous = store.gatewayMessages(threadId).find(m => m.id === task.gatewayReplyMessageId);
    if (previous && ['streaming','pending'].includes(previous.status)) store.updateGatewayMessage(previous.id, {status:'done'});
    userId=store.appendGatewayMessage({threadId,role:'user',content:text,status:'pending',accountId:task.accountId});
    replyId=store.appendGatewayMessage({threadId,role:'assistant',content:'正在转交补充消息…',status:'streaming',accountId:task.accountId});
    bridge.linkChatTask(task.id,threadId,replyId,true);
    if(!await bridge.confirmTask(task.id,text))throw new Error('本任务当前不能接收补充消息，未发送到其他会话');
    store.updateGatewayMessage(userId,{status:'done'});
    return true;
  } catch(error) {
    const detail=error instanceof Error?error.message:String(error);
    if(userId!=null)store.updateGatewayMessage(userId,{status:'failed',error:detail});
    if(replyId!=null)store.updateGatewayMessage(replyId,{status:'failed',error:detail});
    throw error;
  } finally { locks.delete(threadId); }
}
