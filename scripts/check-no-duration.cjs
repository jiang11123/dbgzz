const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-no-duration-'));
app.setPath('userData', profile);
app.whenReady().then(async () => {
  try {
    const { WorkspaceDatabase } = require('../dist/main/main/database.js');
    const { CanvasBridge, pickAvailableAccount } = require('../dist/main/main/canvas-bridge.js');
    const original = new WorkspaceDatabase();
    original.setSetting('workspaceRoot', profile);
    const project = original.createProject('preserved project');
    const task = original.createTask({ projectId: project.id, sceneNumber: '1', name: 'preserved task', prompt: 'test', ratio: '9:16', note: '' });
    const video = path.join(profile, 'preserved.mp4');
    fs.writeFileSync(video, 'video fixture');
    original.completeTask(task.id, video, 1);
    original.recordShareDownload(video, 'preserved.mp4');
    original.recordUpscaleVideo(video, video);
    // Recreate an old installation with populated duration and quota columns.
    original.db.exec(`
      ALTER TABLE accounts ADD COLUMN daily_quota INTEGER NOT NULL DEFAULT 30;
      ALTER TABLE accounts ADD COLUMN used_quota INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE accounts ADD COLUMN last_reset_date TEXT NOT NULL DEFAULT '';
      ALTER TABLE tasks ADD COLUMN duration INTEGER NOT NULL DEFAULT 10;
      ALTER TABLE share_downloads ADD COLUMN duration REAL NOT NULL DEFAULT 0;
      ALTER TABLE upscale_videos ADD COLUMN duration REAL NOT NULL DEFAULT 0;
      CREATE TABLE quota_logs(id INTEGER PRIMARY KEY,account_id INTEGER,seconds INTEGER);
      CREATE TABLE quota_adjustments(id INTEGER PRIMARY KEY,account_id INTEGER,seconds INTEGER,FOREIGN KEY(account_id) REFERENCES accounts(id));
      CREATE TABLE generation_events(id INTEGER PRIMARY KEY,account_id INTEGER,task_id INTEGER,duration INTEGER,FOREIGN KEY(account_id) REFERENCES accounts(id),FOREIGN KEY(task_id) REFERENCES tasks(id));
      UPDATE accounts SET used_quota=30 WHERE id=1;
      UPDATE tasks SET duration=20;
      INSERT INTO quota_logs VALUES(1,1,20);
      INSERT INTO quota_adjustments VALUES(1,1,10);
      INSERT INTO generation_events VALUES(1,1,1,20);
    `);
    original.db.close();
    const migrated = new WorkspaceDatabase();
    for (const table of ['accounts', 'tasks', 'share_downloads', 'upscale_videos']) {
      const columns = migrated.db.prepare(`PRAGMA table_info('${table}')`).all().map(c => c.name);
      assert.equal(columns.some(name => ['duration', 'daily_quota', 'used_quota', 'last_reset_date'].includes(name)), false);
    }
    for (const table of ['quota_logs', 'quota_adjustments', 'generation_events']) assert.equal(migrated.db.prepare('SELECT name FROM sqlite_master WHERE name=?').get(table), undefined);
    assert.deepEqual(migrated.db.pragma('foreign_key_check'), []);
    assert.equal(migrated.accounts().length, 5);
    assert.equal(migrated.task(task.id).videoPath, video);
    assert.equal(migrated.task(task.id).ratio, '9:16');
    assert.equal(migrated.videoLibrary().length, 3);
    assert.equal(migrated.videoLibrary().some(item => 'duration' in item), false);
    assert.equal('dailyQuota' in migrated.accounts()[0], false);
    const backupDir = path.join(profile, 'workspace-data');
    const backups = () => fs.readdirSync(backupDir).filter(name => name.startsWith('workspace-before-duration-removal-'));
    assert.equal(backups().length, 1);
    const backup = new Database(path.join(backupDir, backups()[0]), { readonly: true });
    assert.equal(backup.prepare('SELECT duration FROM tasks WHERE id=?').get(task.id).duration, 20);
    backup.close();
    const account = migrated.createAccount({ name: 'no quota required' });
    migrated.updateAccount(account.id, { isLoggedIn: true });
    assert.equal(pickAvailableAccount(migrated.accounts(), new Set()).id, account.id);
    assert.equal(pickAvailableAccount(migrated.accounts(), new Set([account.id])), null);
    migrated.db.close();
    const reopened = new WorkspaceDatabase();
    assert.equal(backups().length, 1);
    assert.equal(reopened.task(task.id).videoPath, video);
    reopened.db.close();
    fs.writeFileSync(path.join(profile, 'canvas-bridge-tasks.json'), JSON.stringify([{ id: 'legacy', status: 'completed', videoPath: video, duration: 20 }]));
    const bridge = new CanvasBridge({ accounts: () => [], openAccount: () => null, viewForAccount: () => null, onTaskChanged: () => {} }, profile);
    assert.equal('duration' in bridge.list()[0], false);
    await bridge.create({ prompt: 'no duration required' });
    assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'canvas-bridge-tasks.json'), 'utf8')).some(item => 'duration' in item), false);
    console.log('PASS: old database backed up and migrated; account/project/video data preserved; no duration or quota fields; account dispatch ignores local quota; bridge records omit duration; restart migration is idempotent');
    app.quit();
  } catch (error) { console.error(error); app.exit(1); }
});
