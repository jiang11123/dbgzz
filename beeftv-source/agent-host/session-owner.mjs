// 旧 JSONL 会话的只读历史。
//
// 旧执行运行时（createAgentSession 的 create / prompt / replace / abort）已退役：
// 新回合一律走 durable-session-owner.mjs 的官方 Durable 运行时。这里只保留读取、
// 展示，以及「旧会话 → 新 Durable 会话」交接所需的只读能力；历史数据文件不删除。
//
// 交接说明由旧 JSONL 的最后若干条 user/assistant 文本拼成，不调用模型生成摘要。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { projectTurnHistory, sessionTitle } from './canvas-turn.mjs';

export const TURN_ENTRY_TYPE = 'beeftv.canvas.turn';
export const HANDOFF_MESSAGE_LIMIT = 20;
export const HANDOFF_CHAR_LIMIT = 8000;
export const HANDOFF_HEADER = '以下是同一画布此前对话的交接记录，请在此基础上继续，不要提及本说明。';

export function canvasKey(canvasId) {
  return crypto.createHash('sha256').update(canvasId).digest('hex').slice(0, 24);
}

function pointerFailed(message, cause) {
  const error = new Error(message);
  error.reason = 'session_pointer_failed';
  if (cause) error.cause = cause;
  return error;
}

function sessionNotFound() {
  const error = new Error('session_not_found');
  error.reason = 'session_not_found';
  return error;
}

function messageText(message) {
  if (!message || (message.role !== 'user' && message.role !== 'assistant')) return '';
  const content = message.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text).join('').trim();
}

// 纯文本交接说明：取最近 messageLimit 条 user/assistant 文本，总长不超过 charLimit。
// 超长时保留最新的内容；单条本身就超限时截断该条，绝不调用模型生成摘要。
export function handoffNote(messages, { messageLimit = HANDOFF_MESSAGE_LIMIT, charLimit = HANDOFF_CHAR_LIMIT } = {}) {
  const recent = (messages || []).filter((message) => message && message.text).slice(-messageLimit);
  const lines = [];
  let total = 0;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const message = recent[index];
    let line = `${message.role === 'user' ? '用户' : '助手'}：${message.text}`;
    if (lines.length === 0) {
      if (line.length > charLimit) line = line.slice(0, charLimit);
    } else if (total + line.length > charLimit) break;
    lines.push(line);
    total += line.length;
  }
  if (lines.length === 0) return '';
  lines.reverse();
  return [HANDOFF_HEADER, ...lines].join('\n');
}

export function createLegacyHistory({ sessionRoot, workspaceRoot }) {
  function canvasWorkspace(canvasId) {
    return path.join(workspaceRoot, canvasKey(canvasId));
  }

  function canvasSessionDir(canvasId) {
    const dir = path.join(sessionRoot, canvasKey(canvasId));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function currentSessionPointerPath(canvasId) {
    return path.join(canvasSessionDir(canvasId), 'current.json');
  }

  function readCurrentSessionId(canvasId) {
    const file = currentSessionPointerPath(canvasId);
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return '';
      throw pointerFailed(`当前会话指针无法读取（${error.code || error.message}）`, error);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw pointerFailed('当前会话指针内容无效', error);
    }
    if (typeof parsed?.sessionId !== 'string' || !parsed.sessionId.trim()) {
      throw pointerFailed('当前会话指针缺少 sessionId');
    }
    return parsed.sessionId;
  }

  function writeCurrentSessionId(canvasId, sessionId) {
    const dest = currentSessionPointerPath(canvasId);
    const tmp = path.join(canvasSessionDir(canvasId), `current.${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(tmp, JSON.stringify({ sessionId }), { mode: 0o600 });
      fs.renameSync(tmp, dest);
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch { /* 临时文件尽量清掉 */ }
      throw pointerFailed(`当前会话指针无法写入（${error.code || error.message}）`, error);
    }
  }

  function turnEntries(manager) {
    return projectTurnHistory(manager.getEntries(), TURN_ENTRY_TYPE, '');
  }

  function openLegacySession(canvasId, sessionId) {
    const cwd = canvasWorkspace(canvasId);
    fs.mkdirSync(cwd, { recursive: true });
    const sessionDir = canvasSessionDir(canvasId);
    const file = SessionManager.findById(cwd, sessionId, sessionDir);
    if (!file) throw sessionNotFound();
    return { manager: SessionManager.open(file, sessionDir, cwd), cwd, sessionDir, file };
  }

  async function listCanvasSessions(canvasId) {
    const cwd = canvasWorkspace(canvasId);
    fs.mkdirSync(cwd, { recursive: true });
    const sessionDir = canvasSessionDir(canvasId);
    const known = await SessionManager.list(cwd, sessionDir);
    const out = [];
    for (const info of known) {
      let turns = [];
      try { turns = turnEntries(SessionManager.open(info.path, sessionDir, cwd)); } catch { turns = []; }
      out.push({
        sessionId: info.id,
        title: sessionTitle(turns),
        updatedAt: new Date(info.modified).toISOString(),
        turnCount: turns.length,
      });
    }
    out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return out;
  }

  // 找不到旧会话文件时返回空说明：调用方仍会新建 Durable 会话，只是没有交接正文。
  function readHandoffNote(canvasId, sessionId) {
    if (!sessionId) return '';
    let opened;
    try { opened = openLegacySession(canvasId, sessionId); } catch { return ''; }
    const messages = [];
    for (const entry of opened.manager.getEntries()) {
      if (entry.type !== 'message') continue;
      const text = messageText(entry.message);
      if (text) messages.push({ role: entry.message.role, text });
    }
    return handoffNote(messages);
  }

  return {
    canvasWorkspace,
    canvasSessionDir,
    currentSessionPointerPath,
    readCurrentSessionId,
    writeCurrentSessionId,
    turnEntries,
    openLegacySession,
    listCanvasSessions,
    readHandoffNote,
  };
}
