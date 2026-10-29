import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Account } from '../shared/types';
import { CanvasBridge, type CanvasBridgeTask, isPendingDoubaoChatUrl, videoConversationForAccount, shouldRecoverTaskPage, normalizeTaskUrl, isRootDoubaoChatUrl, isSpecificDoubaoChatUrl, formatVideoPrompt, VIDEO_COMPLETION_PATTERN } from './canvas-bridge';

test('video switches start a new conversation while the same account continues its own conversation', () => {
  const thread = { accountId: 1, doubaoConversationId: 'account-one-conversation' };
  assert.equal(videoConversationForAccount(thread, 1), 'account-one-conversation');
  assert.equal(videoConversationForAccount(thread, 2), undefined);
  assert.equal(videoConversationForAccount(thread, null), undefined);
  assert.equal(videoConversationForAccount(null, 2), undefined);
});

const dispatchTestAccount: Account = {
  id: 1, name: '测试账号', platform: 'doubao', note: '', sessionName: 'test-only', isLoggedIn: true,
};

function dispatchFixture(t: { after: (cleanup: () => void) => void }, accounts: Account[], viewError = false) {
  const directory = mkdtempSync(path.join(tmpdir(), 'canvas-bridge-dispatch-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const opened: number[] = [];
  const bridge = new CanvasBridge({
    accounts: () => accounts,
    viewForAccount: () => { if (viewError) throw new Error('宿主创建失败'); return null; },
    // Stop before page submission: no Electron view or real account is needed.
    openAccount: accountId => { opened.push(accountId); return null; },
    onTaskChanged: () => {},
  }, directory);
  const state = bridge as unknown as { busyAccountIds: Set<number>; dispatchingTasks: Set<string> };
  return { bridge, state, opened };
}

test('busy target releases its dispatch guard and can be dispatched after the account is free', async t => {
  const { bridge, state, opened } = dispatchFixture(t, [dispatchTestAccount]);
  state.busyAccountIds.add(dispatchTestAccount.id);

  const task = await bridge.create({ prompt: '回归测试', targetAccountId: dispatchTestAccount.id });
  assert.equal(task.status, 'queued');
  assert.equal(task.statusText, '等待 测试账号 完成前一个任务');
  assert.equal(bridge.isBusy(dispatchTestAccount.id), true);
  assert.equal(state.dispatchingTasks.has(task.id), false);
  assert.deepEqual(opened, []);

  state.busyAccountIds.delete(dispatchTestAccount.id);
  // Public queue trigger calls the real dispatch again, not a mocked replacement.
  bridge.clearAccountCooldown(dispatchTestAccount.id);
  assert.deepEqual(opened, [dispatchTestAccount.id]);
  assert.equal(task.accountId, dispatchTestAccount.id);
  assert.equal(task.status, 'needs_attention');
  assert.equal(task.error, '无法打开豆包页面');
  assert.equal(bridge.isBusy(dispatchTestAccount.id), false);
  assert.equal(state.dispatchingTasks.has(task.id), false);
});

test('host creation failure reports an error and releases both account and dispatch locks', async t => {
  const { bridge, state } = dispatchFixture(t, [dispatchTestAccount], true);
  const task = await bridge.create({ prompt: '回归测试', targetAccountId: dispatchTestAccount.id });
  assert.equal(task.status, 'needs_attention');
  assert.equal(task.error, '宿主创建失败');
  assert.equal(bridge.isBusy(dispatchTestAccount.id), false);
  assert.equal(state.dispatchingTasks.has(task.id), false);
});

for (const [label, accounts] of [
  ['missing', []],
  ['non-doubao', [{ ...dispatchTestAccount, platform: 'dola' }]],
] as const) {
  test(`invalid ${label} target releases its dispatch guard`, async t => {
    const { bridge, state, opened } = dispatchFixture(t, [...accounts]);
    const task = await bridge.create({ prompt: '回归测试', targetAccountId: dispatchTestAccount.id });
    assert.equal(task.status, 'needs_attention');
    assert.equal(task.statusText, '执行账号不存在或不是豆包账号');
    assert.equal(task.error, '请选择可用的豆包执行账号');
    assert.equal(task.accountId, null);
    assert.equal(state.dispatchingTasks.has(task.id), false);
    assert.equal(bridge.isBusy(dispatchTestAccount.id), false);
    assert.deepEqual(opened, []);
  });
}

test('recovers a drifted task page repeatedly, but not forever', () => {
  // A doubao video render takes minutes and the page drifts off its task URL while it
  // works, so recovery must retry. A hard cap still stops a genuinely lost page from
  // looping indefinitely.
  const task = 'https://www.doubao.com/chat/38447157636539650';
  assert.equal(shouldRecoverTaskPage('https://www.doubao.com/', task, 0), true);
  assert.equal(shouldRecoverTaskPage('https://www.doubao.com/', task, 7), true);
  assert.equal(shouldRecoverTaskPage('https://www.doubao.com/', task, 8), false);
});

test('treats trailing slash and hash drift as the same page', () => {
  // The site appends a hash or a trailing slash while it works; that is not page loss.
  assert.equal(shouldRecoverTaskPage('https://www.doubao.com/chat/123#x', 'https://www.doubao.com/chat/123', 0), false);
  assert.equal(shouldRecoverTaskPage('https://www.doubao.com/chat/123/', 'https://www.doubao.com/chat/123', 0), false);
});

test('does not recover when already on the expected task page', () => {
  assert.equal(shouldRecoverTaskPage('https://www.doubao.com/chat/local_1', 'https://www.doubao.com/chat/local_1', 0), false);
});

test('does not recover when task page was root chat and naturally progressed to specific conversation', () => {
  // Sending a message from /chat/ leads to /chat/<id>; this is not page loss
  assert.equal(shouldRecoverTaskPage('https://www.doubao.com/chat/38447157636539650', 'https://www.doubao.com/chat/', 0), false);
  assert.equal(shouldRecoverTaskPage('https://www.doubao.com/chat/38447157636539650', 'https://www.doubao.com/chat', 0), false);
  assert.equal(isRootDoubaoChatUrl('https://www.doubao.com/chat/'), true);
  assert.equal(isRootDoubaoChatUrl('https://www.doubao.com/chat'), true);
  assert.equal(isRootDoubaoChatUrl('https://www.doubao.com/chat/38447157636539650'), false);
  assert.equal(isSpecificDoubaoChatUrl('https://www.doubao.com/chat/38447157636539650'), true);
  assert.equal(isSpecificDoubaoChatUrl('https://www.doubao.com/chat/'), false);
});

test('never recovers when there is no task page to return to', () => {
  assert.equal(shouldRecoverTaskPage('https://www.doubao.com/', null, 0), false);
});

test('normalizeTaskUrl strips hash and trailing slashes', () => {
  assert.equal(normalizeTaskUrl('https://x.com/a/#frag'), 'https://x.com/a');
  assert.equal(normalizeTaskUrl('https://x.com/a///'), 'https://x.com/a');
  assert.equal(normalizeTaskUrl(null), '');
});

test('formatVideoPrompt wraps pure text prompt with video command and specs', () => {
  const result = formatVideoPrompt('一只金毛幼犬在草地上奔跑', '16:9', 5, false);
  assert.match(result, /^生成视频：一只金毛幼犬在草地上奔跑/);
  assert.match(result, /按比例 16:9/);
  assert.match(result, /时长 5 秒/);
  assert.match(result, /直接开始/);
});

test('formatVideoPrompt wraps reference-image video requests with reference instructions', () => {
  const result = formatVideoPrompt('让图中的女孩微笑挥手', '9:16', 5, true);
  assert.match(result, /^请根据参考图生成视频：让图中的女孩微笑挥手/);
  assert.match(result, /按比例 9:16/);
  assert.match(result, /直接开始/);
});

test('formatVideoPrompt preserves existing reference keywords in prompt', () => {
  const result = formatVideoPrompt('根据参考图生成视频，镜头向前推', '16:9', undefined, true);
  assert.match(result, /^根据参考图生成视频，镜头向前推/);
  assert.match(result, /按比例 16:9/);
});

test('formatVideoPrompt adapts model to Seedance 2.0 Fast when duration is 5s', () => {
  const result = formatVideoPrompt('兔子跳起来', '16:9', 5, 'Seedance 2.5', true);
  assert.match(result, /使用 Seedance 2\.0 Fast 模型/);
  assert.match(result, /时长 5 秒/);
  assert.match(result, /按比例 16:9/);
});

test('formatVideoPrompt preserves Seedance 2.5 when duration is >= 10s', () => {
  const result = formatVideoPrompt('兔子跳起来', '16:9', 10, 'Seedance 2.5', true);
  assert.match(result, /使用 Seedance 2\.5 模型/);
  assert.match(result, /时长 10 秒/);
});

test('VIDEO_COMPLETION_PATTERN recognizes Doubao video completion messages', () => {
  assert.equal(VIDEO_COMPLETION_PATTERN.test('【视频生成完成】'), true);
  assert.equal(VIDEO_COMPLETION_PATTERN.test('视频生成完成'), true);
  assert.equal(VIDEO_COMPLETION_PATTERN.test('你的视频生成好了'), true);
  assert.equal(VIDEO_COMPLETION_PATTERN.test('视频已生成'), true);
  assert.equal(VIDEO_COMPLETION_PATTERN.test('已为你生成视频'), true);
  assert.equal(VIDEO_COMPLETION_PATTERN.test('正在生成视频中，请稍候'), false);
  assert.equal(VIDEO_COMPLETION_PATTERN.test('请确认参数后开始生成'), false);
});


test('temporary task routes are never loaded during SPA conversation creation', () => {
  const local = 'https://www.doubao.com/chat/local_1051722523543109';
  assert.equal(isPendingDoubaoChatUrl(local), true);
  assert.equal(shouldRecoverTaskPage('https://www.doubao.com/chat/123', local, 0), false);
  assert.equal(shouldRecoverTaskPage('https://www.doubao.com/chat/', local, 0), false);
  assert.equal(shouldRecoverTaskPage('https://www.doubao.com/chat/456', 'https://www.doubao.com/chat/123', 0), false);
});

for (const provisional of ['https://www.doubao.com/chat/', 'https://www.doubao.com/chat/local_1051722523543109']) {
  test('poll follows a verified server conversation without reloading ' + provisional, async t => {
    const directory = mkdtempSync(path.join(tmpdir(), 'canvas-route-regression-'));
    let currentUrl = 'https://www.doubao.com/chat/123';
    const loads: string[] = [];
    const view = { webContents: {
      isDestroyed: () => false, getURL: () => currentUrl,
      loadURL: async (url: string) => { loads.push(url); currentUrl = url; },
      executeJavaScript: async () => ({ url: currentUrl, messages: [{ id: 'server-user-turn', role: 'user', text: '让他们拥抱' }] }),
    } };
    const bridge = new CanvasBridge({ accounts: () => [], openAccount: () => null,
      viewForAccount: () => view as never, onTaskChanged: () => {} }, directory);
    t.after(() => { bridge.stop(); rmSync(directory, { recursive: true, force: true }); });
    const state = bridge as unknown as { tasks: Map<string, CanvasBridgeTask>; busyAccountIds: Set<number>; taskPageRecoveryAttempts: Map<string, number> };
    const task: CanvasBridgeTask = { id: 'route-regression', prompt: '让他们拥抱', ratio: '16:9', status: 'awaiting_reply', statusText: '', accountId: 2,
      pageUrl: provisional, referencePaths: [], videoPath: null, error: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), sentPrompt: '让他们拥抱',
      replyBaseline: { url: provisional, messages: [], prompt: '让他们拥抱', anchorId: 'client-user-turn', emitted: {} } };
    state.tasks.set(task.id, task); state.busyAccountIds.add(2);
    // A different conversation must not become the target until this task turn is visible.
    view.webContents.executeJavaScript = async () => ({ url: currentUrl, messages: [] as {id:string;role:string;text:string}[] });
    await bridge.tryDownloadCompletedVideo(2);
    assert.equal(task.pageUrl, provisional);
    view.webContents.executeJavaScript = async () => ({ url: currentUrl, messages: [{ id: 'server-user-turn', role: 'user', text: '让他们拥抱' }] });
    for (let poll = 0; poll < 12; poll++) await bridge.tryDownloadCompletedVideo(2);
    assert.equal(task.pageUrl, currentUrl);
    assert.equal(task.status, 'awaiting_reply');
    assert.equal(bridge.isBusy(2), true);
    assert.deepEqual(loads, []);
    // Reaching eight navigation attempts is not evidence of an unresponsive page.
    state.taskPageRecoveryAttempts.set(task.id, 8);
    await bridge.tryDownloadCompletedVideo(2);
    assert.equal(task.status, 'awaiting_reply');
    assert.equal(task.error, null);
  });

  test('pops up account window and updates status text when captcha is visible', async (t) => {
    const popups: { accountId: number; reason?: string }[] = [];
    const directory = mkdtempSync(path.join(tmpdir(), 'doubao-bridge-captcha-test-'));
    const dummyView = {
      webContents: {
        isDestroyed: () => false,
        getURL: () => 'https://www.doubao.com/chat/test-conv',
        executeJavaScript: async (script: string) => {
          if (script.includes('captcha_container')) return true;
          return { url: 'https://www.doubao.com/chat/test-conv', messages: [] };
        },
      },
    } as any;
    const bridge = new CanvasBridge({
      accounts: () => [{ id: 3, name: '账号3', platform: 'doubao', isLoggedIn: true, sessionName: 'doubao_03', note: '' }],
      openAccount: () => dummyView,
      viewForAccount: () => dummyView,
      onTaskChanged: () => {},
      popupAccountForCaptcha: (accountId, reason) => { popups.push({ accountId, reason }); },
    }, directory);
    t.after(() => { bridge.stop(); rmSync(directory, { recursive: true, force: true }); });
    const state = bridge as unknown as { tasks: Map<string, CanvasBridgeTask>; busyAccountIds: Set<number> };
    const task: CanvasBridgeTask = {
      id: 'captcha-task',
      prompt: '跳起来',
      ratio: '16:9',
      status: 'awaiting_reply',
      statusText: '',
      accountId: 3,
      pageUrl: 'https://www.doubao.com/chat/test-conv',
      referencePaths: [],
      videoPath: null,
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sentPrompt: '跳起来',
    };
    state.tasks.set(task.id, task);
    state.busyAccountIds.add(3);

    const handled = await bridge.tryDownloadCompletedVideo(3);
    assert.equal(handled, false);
    assert.equal(popups.length, 1);
    assert.equal(popups[0].accountId, 3);
    assert.match(task.statusText, /触发人机验证.*已自动弹出窗口/);

    // 验证完成滑块消失后，恢复提示
    dummyView.webContents.executeJavaScript = async (script: string) => {
      if (script.includes('captcha_container')) return false;
      return { url: 'https://www.doubao.com/chat/test-conv', messages: [] };
    };
    await bridge.tryDownloadCompletedVideo(3);
    assert.match(task.statusText, /人机验证已通过/);
  });
}
