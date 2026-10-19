import Database from 'better-sqlite3';
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { Account, AccountPlatform, Asset, Dashboard, GatewayAttachment, GatewayMessage, GatewayThread, Project, TaskStatus, VideoLibraryItem, VideoTask } from '../shared/types';
import { platformConfig } from './account-platform';

type DbRow = Record<string, unknown>;
const stamp = () => new Date().toISOString();

export class WorkspaceDatabase {
  private db: Database.Database;

  constructor() {
    const dataDir = path.join(app.getPath('userData'), 'workspace-data');
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new Database(path.join(dataDir, 'workspace.db'));
    this.db.pragma('journal_mode = WAL');
    this.migrate();
    this.ensureAccounts();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL DEFAULT 'doubao', note TEXT NOT NULL DEFAULT '',
        session_name TEXT NOT NULL UNIQUE,
        is_logged_in INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, directory TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, scene_number TEXT NOT NULL,
        name TEXT NOT NULL, prompt TEXT NOT NULL DEFAULT '',
        ratio TEXT NOT NULL DEFAULT '16:9', account_id INTEGER, status TEXT NOT NULL DEFAULT 'ready',
        video_path TEXT, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id), FOREIGN KEY(account_id) REFERENCES accounts(id)
      );
      CREATE TABLE IF NOT EXISTS assets (
        id INTEGER PRIMARY KEY, project_id INTEGER, task_id INTEGER, type TEXT NOT NULL,
        path TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS manual_downloads (
        id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, file_name TEXT NOT NULL,
        file_path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
        FOREIGN KEY(account_id) REFERENCES accounts(id)
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      -- Gateway-mode chat threads. doubao_conversation_id is what makes multi-turn
      -- work: passing it back to /chat/completion continues the same Doubao thread.
      CREATE TABLE IF NOT EXISTS gateway_threads (
        id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '新对话',
        doubao_conversation_id TEXT NOT NULL DEFAULT '', account_id INTEGER,
        model TEXT NOT NULL DEFAULT 'doubao',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gateway_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL,
        role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
        attachments TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'done',
        error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
        -- Which account produced this message, so the chat can label it 账号N 回复.
        account_id INTEGER,
        FOREIGN KEY(thread_id) REFERENCES gateway_threads(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS share_downloads (
        id INTEGER PRIMARY KEY, file_name TEXT NOT NULL, file_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
    `);
    const retiredColumns: Record<string, string[]> = {
      accounts: ['daily_quota', 'used_quota', 'last_reset_date'],
      tasks: ['duration'], share_downloads: ['duration'],
    };
    const changes = Object.entries(retiredColumns).flatMap(([table, names]) => {
      const columns = this.db.prepare(`PRAGMA table_info('${table}')`).all() as DbRow[];
      return names.filter(name => columns.some(column => column.name === name)).map(name => ({ table, name }));
    });
    if (changes.length) {
      const backup = path.join(path.dirname(this.db.name), `workspace-before-duration-removal-${Date.now()}.db`);
      this.db.prepare('VACUUM INTO ?').run(backup);
      this.db.transaction(() => {
        for (const table of ['quota_logs', 'quota_adjustments', 'generation_events', 'upscale_videos']) this.db.exec(`DROP TABLE IF EXISTS ${table}`);
        for (const { table, name } of changes) this.db.exec(`ALTER TABLE ${table} DROP COLUMN ${name}`);
      })();
    }
    const accountColumns = this.db.prepare("PRAGMA table_info('accounts')").all() as DbRow[];
    if (!accountColumns.some((column) => String(column.name) === 'platform')) this.db.exec("ALTER TABLE accounts ADD COLUMN platform TEXT NOT NULL DEFAULT 'doubao'");
    const messageColumns = this.db.prepare("PRAGMA table_info('gateway_messages')").all() as DbRow[];
    if (!messageColumns.some(column => column.name === 'account_id')) {
      this.db.exec('ALTER TABLE gateway_messages ADD COLUMN account_id INTEGER');
    }
    if (!accountColumns.some(column => column.name === 'sort_order')) {
      this.db.transaction(() => {
        this.db.exec('ALTER TABLE accounts ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
        this.db.exec('UPDATE accounts SET sort_order=id');
      })();
    }
  }

  private ensureAccounts() {
    const existing = Number((this.db.prepare('SELECT COUNT(*) as count FROM accounts').get() as DbRow).count);
    if (existing) return;
    const insert = this.db.prepare('INSERT INTO accounts (name,note,session_name) VALUES (?,?,?)');
    const run = this.db.transaction(() => {
      for (let i = 1; i <= 5; i++) insert.run(`账号${i}`, i === 1 ? '主号' : '', `persist:doubao_${String(i).padStart(2, '0')}`);
    });
    run();
  }

  private mapAccount(row: DbRow): Account {
    return { id: Number(row.id), name: String(row.name), platform: row.platform === 'dola' ? 'dola' : 'doubao', note: String(row.note), sessionName: String(row.session_name), isLoggedIn: Boolean(row.is_logged_in) };
  }

  accounts(): Account[] { return (this.db.prepare('SELECT * FROM accounts ORDER BY sort_order,id').all() as DbRow[]).map((r) => this.mapAccount(r)); }
  moveAccount(id: number, targetId: number, before: boolean) {
    if (!Number.isSafeInteger(id) || !Number.isSafeInteger(targetId) || typeof before !== 'boolean') throw new Error('账号排序参数无效');
    return this.db.transaction(() => {
      const ids = this.accounts().map(account => account.id);
      if (!ids.includes(id) || !ids.includes(targetId)) throw new Error('账号已不存在，请刷新后重试');
      if (id !== targetId) {
        ids.splice(ids.indexOf(id), 1);
        ids.splice(ids.indexOf(targetId) + (before ? 0 : 1), 0, id);
        const update = this.db.prepare('UPDATE accounts SET sort_order=? WHERE id=?');
        ids.forEach((accountId, index) => update.run(index, accountId));
      }
      return this.accounts();
    })();
  }
  createAccount(data: { name?: string; note?: string; platform?: AccountPlatform }) {
    const nextId = Number((this.db.prepare('SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM accounts').get() as DbRow).nextId);
    const platform: AccountPlatform = data.platform === 'dola' ? 'dola' : 'doubao';
    const account = { name: data.name?.trim() || `账号${nextId}`, note: data.note?.trim() || '', platform };
    this.db.prepare('INSERT INTO accounts (id,name,platform,note,session_name) VALUES (?,?,?,?,?)').run(nextId, account.name, account.platform, account.note, platformConfig(platform, nextId).sessionName);
    this.db.prepare('UPDATE accounts SET sort_order=(SELECT COALESCE(MAX(sort_order),0)+1 FROM accounts) WHERE id=?').run(nextId);
    return this.accounts().find((item) => item.id === nextId)!;
  }
  updateAccount(id: number, patch: Partial<Pick<Account, 'name' | 'note' | 'isLoggedIn'>>) {
    const current = this.accounts().find((a) => a.id === id); if (!current) throw new Error('账号不存在');
    // Names are trimmed and whitespace-only values are ignored, so a stray blur
    // carrying spaces can never corrupt an account identity.
    const nextName = patch.name != null && patch.name.trim() ? patch.name.trim() : current.name;
    this.db.prepare('UPDATE accounts SET name=?,note=?,is_logged_in=? WHERE id=?').run(nextName, patch.note ?? current.note, Number(patch.isLoggedIn ?? current.isLoggedIn), id);
    return this.accounts().find((a) => a.id === id)!;
  }
  deleteAccount(id: number) {
    const account = this.accounts().find((item) => item.id === id); if (!account) throw new Error('账号不存在');
    const apply = this.db.transaction(() => {
      this.db.prepare('UPDATE tasks SET account_id=NULL WHERE account_id=?').run(id);
      // Keep downloaded videos in the account-independent archive before removing
      // the download records whose foreign key would otherwise block deletion.
      this.db.prepare(`INSERT OR IGNORE INTO share_downloads(file_name,file_path,created_at)
        SELECT file_name,file_path,created_at FROM manual_downloads WHERE account_id=?`).run(id);
      this.db.prepare('DELETE FROM manual_downloads WHERE account_id=?').run(id);
      this.db.prepare('DELETE FROM accounts WHERE id=?').run(id);
    }); apply(); return true;
  }

  projects(): Project[] { return this.db.prepare('SELECT id,name,directory,created_at as createdAt,updated_at as updatedAt FROM projects ORDER BY updated_at DESC').all() as Project[]; }
  project(id: number) { return this.projects().find((project) => project.id === id) ?? null; }
  createProject(name: string) {
    const root = this.getSetting('workspaceRoot') || path.join(app.getPath('documents'), 'DoubaoWorkspace');
    const safeName = name.replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名项目';
    const directory = path.join(root, 'projects', safeName);
    fs.mkdirSync(path.join(directory, 'images'), { recursive: true }); fs.mkdirSync(path.join(directory, 'videos'), { recursive: true });
    const now = stamp(); const result = this.db.prepare('INSERT INTO projects(name,directory,created_at,updated_at) VALUES(?,?,?,?)').run(name, directory, now, now);
    return this.projects().find((p) => p.id === result.lastInsertRowid)!;
  }

  tasks(projectId?: number): VideoTask[] {
    const rows = (projectId ? this.db.prepare('SELECT * FROM tasks WHERE project_id=? ORDER BY CAST(scene_number AS INTEGER), scene_number').all(projectId) : this.db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC').all()) as DbRow[];
    return rows.map((r) => this.mapTask(r));
  }
  private mapTask(r: DbRow): VideoTask {
    const assets = this.db.prepare('SELECT id,project_id as projectId,task_id as taskId,type,path,created_at as createdAt FROM assets WHERE task_id=? ORDER BY id').all(r.id) as Asset[];
    return { id: Number(r.id), projectId: Number(r.project_id), sceneNumber: String(r.scene_number), name: String(r.name), prompt: String(r.prompt), ratio: String(r.ratio), accountId: r.account_id === null ? null : Number(r.account_id), status: r.status as TaskStatus, videoPath: r.video_path ? String(r.video_path) : null, note: String(r.note), createdAt: String(r.created_at), updatedAt: String(r.updated_at), assets };
  }
  task(id: number) { const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as DbRow | undefined; return row ? this.mapTask(row) : null; }
  createTask(data: Pick<VideoTask, 'projectId' | 'sceneNumber' | 'name' | 'prompt' | 'ratio' | 'note'>) {
    const now = stamp(); const result = this.db.prepare('INSERT INTO tasks(project_id,scene_number,name,prompt,ratio,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(data.projectId, data.sceneNumber, data.name, data.prompt, data.ratio, data.note, now, now); return this.task(Number(result.lastInsertRowid))!;
  }
  updateTask(id: number, patch: Partial<Pick<VideoTask, 'sceneNumber' | 'name' | 'prompt' | 'ratio' | 'accountId' | 'status' | 'note'>>) {
    const task = this.task(id); if (!task) throw new Error('任务不存在'); const next = { ...task, ...patch };
    this.db.prepare('UPDATE tasks SET scene_number=?,name=?,prompt=?,ratio=?,account_id=?,status=?,note=?,updated_at=? WHERE id=?').run(next.sceneNumber, next.name, next.prompt, next.ratio, next.accountId, next.status, next.note, stamp(), id); return this.task(id)!;
  }
  addAsset(projectId: number, taskId: number | null, type: Asset['type'], filePath: string) { const result = this.db.prepare('INSERT INTO assets(project_id,task_id,type,path,created_at) VALUES(?,?,?,?,?)').run(projectId, taskId, type, filePath, stamp()); return Number(result.lastInsertRowid); }
  completeTask(id: number, videoPath: string, accountId: number) {
    const task = this.task(id); if (!task) throw new Error('任务不存在');
    const apply = this.db.transaction(() => {
      this.db.prepare('UPDATE tasks SET status=?,account_id=?,video_path=?,updated_at=? WHERE id=?').run('completed', accountId, videoPath, stamp(), id);
      this.addAsset(task.projectId, id, 'video', videoPath);
    }); apply(); return this.task(id)!;
  }
  hasRecentManualDownload(accountId: number, fileName: string, withinMs = 120_000) {
    const since = new Date(Date.now() - withinMs).toISOString();
    return Boolean(this.db.prepare('SELECT id FROM manual_downloads WHERE account_id=? AND file_name=? AND created_at>=? LIMIT 1').get(accountId, fileName, since));
  }
  recordManualDownload(accountId: number, filePath: string, fileName: string) {
    if (!fs.existsSync(filePath)) return false;
    const result = this.db.prepare('INSERT OR IGNORE INTO manual_downloads(account_id,file_name,file_path,created_at) VALUES(?,?,?,?)').run(accountId, fileName, filePath, stamp());
    return result.changes === 1;
  }
  videoLibrary(): VideoLibraryItem[] {
    return this.db.prepare(`SELECT * FROM (
      SELECT t.id as taskId,t.project_id as projectId,p.name as projectName,t.scene_number as sceneNumber,t.name as taskName,t.account_id as accountId,a.name as accountName,t.video_path as videoPath,t.updated_at as completedAt FROM tasks t JOIN projects p ON p.id=t.project_id LEFT JOIN accounts a ON a.id=t.account_id WHERE t.video_path IS NOT NULL
      UNION ALL
      SELECT -m.id as taskId,0 as projectId,'手动下载' as projectName,'—' as sceneNumber,m.file_name as taskName,m.account_id as accountId,a.name as accountName,m.file_path as videoPath,m.created_at as completedAt FROM manual_downloads m LEFT JOIN accounts a ON a.id=m.account_id
        UNION ALL
        SELECT -1000000000-s.id as taskId,0 as projectId,'豆包分享下载' as projectName,'—' as sceneNumber,s.file_name as taskName,NULL as accountId,NULL as accountName,s.file_path as videoPath,s.created_at as completedAt FROM share_downloads s
      ) ORDER BY completedAt DESC`).all() as VideoLibraryItem[];
  }
  recordShareDownload(filePath: string, fileName: string) {
    if (!fs.existsSync(filePath)) throw new Error('视频文件不存在，无法归档');
    this.db.prepare('INSERT OR IGNORE INTO share_downloads(file_name,file_path,created_at) VALUES(?,?,?)').run(fileName, filePath, stamp());
  }
  dashboard(): Dashboard {
    const stats: Record<TaskStatus, number> = { ready: 0, waiting: 0, generating: 0, completed: 0, failed: 0 };
    for (const row of this.db.prepare('SELECT status,COUNT(*) as count FROM tasks GROUP BY status').all() as DbRow[]) stats[row.status as TaskStatus] = Number(row.count);
    return { completedCount: stats.completed, statusCounts: stats, recentProjects: this.projects().slice(0, 4) };
  }
  // ── Gateway-mode chat threads ─────────────────────────────────────────────
  gatewayThreads(): GatewayThread[] {
    return (this.db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM gateway_messages m WHERE m.thread_id=t.id) as message_count
      FROM gateway_threads t ORDER BY t.updated_at DESC`).all() as DbRow[]).map(row => this.mapThread(row));
  }
  gatewayThread(id: string): GatewayThread | null {
    const row = this.db.prepare('SELECT * FROM gateway_threads WHERE id=?').get(id) as DbRow | undefined;
    return row ? this.mapThread(row) : null;
  }
  private mapThread(row: DbRow): GatewayThread {
    return {
      id: String(row.id), title: String(row.title),
      doubaoConversationId: String(row.doubao_conversation_id ?? ''),
      accountId: row.account_id === null || row.account_id === undefined ? null : Number(row.account_id),
      model: String(row.model ?? 'doubao'),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      messageCount: row.message_count === undefined ? undefined : Number(row.message_count),
    };
  }
  gatewayMessages(threadId: string): GatewayMessage[] {
    return (this.db.prepare('SELECT * FROM gateway_messages WHERE thread_id=? ORDER BY id').all(threadId) as DbRow[]).map(row => ({
      id: Number(row.id), threadId: String(row.thread_id),
      role: row.role === 'assistant' ? 'assistant' : 'user',
      content: String(row.content ?? ''),
      attachments: (() => { try { const v = JSON.parse(String(row.attachments ?? '[]')); return Array.isArray(v) ? v : []; } catch { return []; } })(),
      status: (['pending', 'streaming', 'done', 'failed'].includes(String(row.status)) ? String(row.status) : 'done') as GatewayMessage['status'],
      error: String(row.error ?? ''), createdAt: String(row.created_at),
      accountId: row.account_id === null || row.account_id === undefined ? null : Number(row.account_id),
    }));
  }
  createGatewayThread(thread: { id: string; title?: string; model?: string; accountId?: number | null }) {
    const now = stamp();
    this.db.prepare('INSERT INTO gateway_threads(id,title,doubao_conversation_id,account_id,model,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(thread.id, thread.title || '新对话', '', thread.accountId ?? null, thread.model || 'doubao', now, now);
    return this.gatewayThread(thread.id)!;
  }
  updateGatewayThread(id: string, patch: Partial<Pick<GatewayThread, 'title' | 'doubaoConversationId' | 'accountId' | 'model'>>) {
    const thread = this.gatewayThread(id); if (!thread) throw new Error('会话不存在');
    const next = { ...thread, ...patch };
    this.db.prepare('UPDATE gateway_threads SET title=?,doubao_conversation_id=?,account_id=?,model=?,updated_at=? WHERE id=?')
      .run(next.title, next.doubaoConversationId, next.accountId, next.model, stamp(), id);
    return this.gatewayThread(id)!;
  }
  deleteGatewayThread(id: string) {
    const apply = this.db.transaction(() => {
      this.db.prepare('DELETE FROM gateway_messages WHERE thread_id=?').run(id);
      this.db.prepare('DELETE FROM gateway_threads WHERE id=?').run(id);
    });
    apply();
    return this.gatewayThreads();
  }
  appendGatewayMessage(message: { threadId: string; role: GatewayMessage['role']; content: string; attachments?: GatewayAttachment[]; status?: GatewayMessage['status']; error?: string; accountId?: number | null }) {
    const result = this.db.prepare('INSERT INTO gateway_messages(thread_id,role,content,attachments,status,error,created_at,account_id) VALUES(?,?,?,?,?,?,?,?)')
      .run(message.threadId, message.role, message.content, JSON.stringify(message.attachments ?? []), message.status ?? 'done', message.error ?? '', stamp(), message.accountId ?? null);
    this.db.prepare('UPDATE gateway_threads SET updated_at=? WHERE id=?').run(stamp(), message.threadId);
    return Number(result.lastInsertRowid);
  }
  updateGatewayMessage(id: number, patch: { content?: string; status?: GatewayMessage['status']; error?: string; attachments?: GatewayAttachment[]; accountId?: number | null }) {
    const row = this.db.prepare('SELECT * FROM gateway_messages WHERE id=?').get(id) as DbRow | undefined;
    if (!row) return;
    this.db.prepare('UPDATE gateway_messages SET content=?,status=?,error=?,attachments=?,account_id=? WHERE id=?').run(
      patch.content ?? String(row.content ?? ''), patch.status ?? String(row.status ?? 'done'), patch.error ?? String(row.error ?? ''),
      patch.attachments ? JSON.stringify(patch.attachments) : String(row.attachments ?? '[]'),
      patch.accountId !== undefined ? patch.accountId : (row.account_id ?? null), id,
    );
  }
  getSetting(key: string) { return (this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as DbRow | undefined)?.value as string | undefined; }
  setSetting(key: string, value: string) { this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
}
