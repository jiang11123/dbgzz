import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HANDOFF_CHAR_LIMIT, HANDOFF_HEADER, HANDOFF_MESSAGE_LIMIT, TURN_ENTRY_TYPE, createLegacyHistory, handoffNote } from './session-owner.mjs';

function scratchHistory(root = mkdtempSync(join(tmpdir(), 'beeftv-legacy-history-'))) {
  const legacy = createLegacyHistory({ sessionRoot: join(root, 'sessions'), workspaceRoot: join(root, 'workspace') });
  return { root, legacy };
}

function writeLegacySession(legacy, canvasId, sessionId, messages = []) {
  const cwd = legacy.canvasWorkspace(canvasId);
  mkdirSync(cwd, { recursive: true });
  const sessionDir = legacy.canvasSessionDir(canvasId);
  const timestamp = '2026-10-07T12:00:00.000Z';
  const file = join(sessionDir, `2026-10-07T12-00-00-000Z_${sessionId}.jsonl`);
  const rows = [{ type: 'session', version: 3, id: sessionId, timestamp, cwd }];
  let parentId = null;
  let index = 0;
  for (const message of messages) {
    const id = `entry-${index++}`;
    rows.push({ type: 'message', id, parentId, timestamp,
      message: { role: message.role, content: [{ type: 'text', text: message.text }], timestamp: 1791374400000 + index } });
    parentId = id;
  }
  if (messages.length > 0) {
    rows.push({ type: 'custom', id: 'turn-old', parentId, timestamp, customType: TURN_ENTRY_TYPE,
      data: { turnId: 'turn-legacy', userText: messages[0].text, reply: '旧回执', toolCalls: [], proposals: [], error: null, cancelled: false, createdAt: timestamp } });
  }
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return file;
}

describe('旧 JSONL 会话只读历史', () => {
  test('读取升级前 JSONL v3 的用户消息和 BeefTV 轮次，不改会话身份', () => {
    const { root, legacy } = scratchHistory();
    try {
      const canvasId = 'legacy-v3';
      const sessionId = 'legacy-pi-0871-session';
      writeLegacySession(legacy, canvasId, sessionId, [{ role: 'user', text: '旧会话原话' }, { role: 'assistant', text: '旧回执' }]);
      legacy.writeCurrentSessionId(canvasId, sessionId);
      expect(legacy.readCurrentSessionId(canvasId)).toBe(sessionId);
      const opened = legacy.openLegacySession(canvasId, sessionId);
      expect(opened.manager.getSessionId()).toBe(sessionId);
      expect(legacy.turnEntries(opened.manager)[0].reply).toBe('旧回执');
      expect(opened.manager.buildSessionContext().messages[0].content[0].text).toBe('旧会话原话');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('openLegacySession 找不到会话时抛 session_not_found', () => {
    const { root, legacy } = scratchHistory();
    try {
      expect(() => legacy.openLegacySession('missing-canvas', 'no-such-session')).toThrow(/session_not_found/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('current.json 是目录时读取抛 session_pointer_failed', () => {
    const { root, legacy } = scratchHistory();
    try {
      mkdirSync(legacy.currentSessionPointerPath('bad-pointer'), { recursive: true });
      expect(() => legacy.readCurrentSessionId('bad-pointer')).toThrow(/当前会话指针无法读取/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('current.json 内容损坏时读取抛 session_pointer_failed', () => {
    const { root, legacy } = scratchHistory();
    try {
      writeFileSync(legacy.currentSessionPointerPath('bad-json'), '{');
      expect(() => legacy.readCurrentSessionId('bad-json')).toThrow(/当前会话指针内容无效/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('listCanvasSessions 列出旧会话的标题与轮次', async () => {
    const { root, legacy } = scratchHistory();
    try {
      writeLegacySession(legacy, 'list-canvas', 'legacy-list-session', [{ role: 'user', text: '列表标题' }, { role: 'assistant', text: '回执' }]);
      const list = await legacy.listCanvasSessions('list-canvas');
      expect(list).toHaveLength(1);
      expect(list[0].sessionId).toBe('legacy-list-session');
      expect(list[0].title).toBe('列表标题');
      expect(list[0].turnCount).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('旧会话 → Durable 交接说明', () => {
  test('readHandoffNote 包含旧会话最近的 user/assistant 文本', () => {
    const { root, legacy } = scratchHistory();
    try {
      writeLegacySession(legacy, 'handoff-canvas', 'legacy-handoff-session', [
        { role: 'user', text: '旧会话的第一句原话' },
        { role: 'assistant', text: '旧会话的第一条回执' },
      ]);
      const note = legacy.readHandoffNote('handoff-canvas', 'legacy-handoff-session');
      expect(note.startsWith(HANDOFF_HEADER)).toBe(true);
      expect(note).toContain('用户：旧会话的第一句原话');
      expect(note).toContain('助手：旧会话的第一条回执');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('readHandoffNote 找不到旧会话时返回空说明', () => {
    const { root, legacy } = scratchHistory();
    try {
      expect(legacy.readHandoffNote('no-canvas', 'no-session')).toBe('');
      expect(legacy.readHandoffNote('no-canvas', '')).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('handoffNote 只保留最近 20 条消息', () => {
    const messages = Array.from({ length: 30 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: `第${index}条` }));
    const note = handoffNote(messages);
    expect(note).toContain('第29条');
    expect(note).toContain('第10条');
    expect(note).not.toContain('第9条');
    const lines = note.split('\n').slice(1);
    expect(lines).toHaveLength(HANDOFF_MESSAGE_LIMIT);
  });

  test('handoffNote 总长截断到约 8000 字符并保留最新内容', () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: `${index}`.padEnd(900, 'x') }));
    const note = handoffNote(messages);
    const body = note.split('\n').slice(1).join('\n');
    expect(body.length).toBeLessThanOrEqual(HANDOFF_CHAR_LIMIT);
    expect(note).toContain('19');
    expect(note).not.toContain('0' + 'x'.repeat(800));
  });

  test('单条消息本身超限时截断该条，不整体丢弃', () => {
    const note = handoffNote([{ role: 'user', text: 'y'.repeat(20000) }]);
    const body = note.split('\n').slice(1).join('\n');
    expect(body.length).toBeLessThanOrEqual(HANDOFF_CHAR_LIMIT);
    expect(body.startsWith('用户：yyy')).toBe(true);
  });

  test('没有 user/assistant 文本时不生成交接说明', () => {
    expect(handoffNote([])).toBe('');
    expect(handoffNote([{ role: 'user', text: '' }])).toBe('');
  });
});
