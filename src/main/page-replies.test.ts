import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { collectPageReplies, createPageReplyBaseline, normalizePageReplyText, pageReplySnapshotScript, type PageReplyMessage, type PageReplySnapshot } from './page-replies';

const user = (id: string, text = '生成视频'): PageReplyMessage => ({ id, role: 'user', text });
const bot = (id: string, text: string): PageReplyMessage => ({ id, role: 'assistant', text });
const snap = (...messages: PageReplyMessage[]): PageReplySnapshot => ({ url: 'https://www.doubao.com/chat/one', messages });
const greeting = bot('old', '你好，我是豆包');

test('normalizes line endings without losing confirmation parameters', () => {
  assert.equal(normalizePageReplyText('  请确认\r\n\r\n 16:9\u00a0 '), '请确认\n16:9');
});
test('unchanged history and a changed old streaming answer are not task replies', () => {
  const state = createPageReplyBaseline(snap(greeting), { prompt: '生成视频' });
  assert.equal(collectPageReplies(state, snap(bot('old', '你好，我是豆包！'))).latestText, '');
});
test('requires a new matching user message, not the old repeated prompt', () => {
  const state = createPageReplyBaseline(snap(user('u0'), greeting), { prompt: '生成视频' });
  assert.equal(collectPageReplies(state, snap(user('u0'), greeting, bot('other', '旧回复'))).latestText, '');
});
test('collects confirmation and missing-image replies, never user text', () => {
  const state = createPageReplyBaseline(snap(greeting), { prompt: '生成视频' });
  const result = collectPageReplies(state, snap(greeting, user('u1'), bot('b1', '请先确认参数'), user('u2', '确认'), bot('b2', '请上传参考图片')));
  assert.deepEqual(result.replies.map(message => message.text), ['请先确认参数', '请上传参考图片']);
  assert.equal(result.latestText, '请上传参考图片');
  assert.equal(state.anchorId, '');
});
test('emits changes to the same streaming id and suppresses unchanged polls', () => {
  let state = createPageReplyBaseline(snap(greeting), { prompt: '生成视频' });
  for (const text of ['请', '请先确认', '请先确认最终参数']) {
    const result = collectPageReplies(state, snap(greeting, user('u1'), bot('b1', text)));
    assert.equal(result.latestText, text);
    state = result.baseline;
    assert.equal(collectPageReplies(state, snap(greeting, user('u1'), bot('b1', text))).latestText, '');
  }
});
test('local-to-server id migration does not duplicate text but continues streaming', () => {
  const state = createPageReplyBaseline(snap(greeting), { prompt: '生成视频' });
  const first = collectPageReplies(state, snap(user('u1'), bot('local', '请确认')));
  const migrated = collectPageReplies(first.baseline, snap(user('u1'), bot('server', '请确认')));
  assert.equal(migrated.latestText, '');
  assert.equal(collectPageReplies(migrated.baseline, snap(user('u1'), bot('server', '请确认参数'))).latestText, '请确认参数');
});
test('empty placeholder after submit becomes a reply when streaming begins', () => {
  const state = createPageReplyBaseline(snap(greeting), { prompt: '生成视频' });
  const pending = collectPageReplies(state, snap(greeting, user('u1'), bot('b1', '')));
  assert.equal(pending.latestText, '');
  assert.equal(collectPageReplies(pending.baseline, snap(user('u1'), bot('b1', '缺少图片'))).latestText, '缺少图片');
});
test('new conversation URL is allowed only with matching task anchor', () => {
  const state = createPageReplyBaseline(snap(greeting), { prompt: '生成视频' });
  assert.equal(collectPageReplies(state, { ...snap(user('u1'), bot('b1', '确认生成')), url: 'https://www.doubao.com/chat/two' }).latestText, '确认生成');
});
test('history prepended before the anchor and unknown roles are ignored', () => {
  const state = createPageReplyBaseline(snap(greeting), { prompt: '生成视频' });
  const result = collectPageReplies(state, snap(bot('earlier', '历史'), greeting, user('u1'), { id: 'unknown', role: 'unknown', text: '用户文字' }));
  assert.equal(result.latestText, '');
});
test('without prompt requires a known tail and rejects remounted old greeting', () => {
  assert.equal(collectPageReplies(createPageReplyBaseline(snap()), snap(bot('g', '你好'))).latestText, '');
  const state = createPageReplyBaseline(snap(greeting));
  assert.equal(collectPageReplies(state, snap(greeting, bot('remount', greeting.text))).latestText, '');
  assert.equal(collectPageReplies(state, snap(greeting, bot('new', '开始生成'))).latestText, '开始生成');
});
test('snapshot errors and a missing anchor fail closed', () => {
  const state = createPageReplyBaseline(snap(greeting), { prompt: '生成视频' });
  const matched = collectPageReplies(state, snap(user('u1'), bot('b1', '确认')));
  assert.equal(collectPageReplies(matched.baseline, snap(bot('b2', '另一个会话'))).latestText, '');
  assert.equal(collectPageReplies(state, { ...snap(user('u1'), bot('b1', '确认')), error: 'failed' }).latestText, '');
});
test('finds the turn when the page echoes the pasted prompt with trimmed punctuation', () => {
  const prompt = '请根据参考图生成视频：让兔子跳起来。请使用 Seedance 2.0 Fast 模型、按比例 16:9、时长 5 秒生成，直接开始，无需确认。';
  const state = createPageReplyBaseline(snap(greeting), { prompt });
  const result = collectPageReplies(state, snap(greeting, user('u1', prompt.replace(/。$/, '')), bot('b1', '视频生成参数确认')));
  assert.equal(result.latestText, '视频生成参数确认');
});
test('falls back to the newest new user turn when the page rewrites the prompt', () => {
  const state = createPageReplyBaseline(snap(greeting), { prompt: '让兔子跳起来' });
  const result = collectPageReplies(state, snap(greeting, user('u1', '（附件 1 张）让兔子跳起来吧'), bot('b1', '确认后我再开始生成视频。')));
  assert.equal(result.latestText, '确认后我再开始生成视频。');
  assert.equal(result.baseline.anchorId, 'u1');
});
test('re-derives the anchor when a reload gives the turn a new identity', () => {
  let state = createPageReplyBaseline(snap(greeting), { prompt: '让兔子跳起来' });
  state = collectPageReplies(state, snap(greeting, user('u1', '让兔子跳起来'), bot('b1', '请确认参数'))).baseline;
  // The page reloaded, so every node now carries a fresh id.
  const result = collectPageReplies(state, snap(greeting, user('u9', '让兔子跳起来'), bot('b9', '参数已确认，开始生成')));
  assert.equal(result.latestText, '参数已确认，开始生成');
});

class FakeNode {
  className = '';
  parent: FakeNode | null = null;
  constructor(public attrs: Record<string, string>, public textContent: string) {}
  getAttribute(name: string) { return this.attrs[name] || null; }
  closest() { return null; }
  contains(node: FakeNode): boolean { return node === this || node.parent === this; }
  cloneNode() { return new FakeNode(this.attrs, this.textContent); }
  querySelectorAll() { return []; }
}
function page(nodes: FakeNode[], host: object = {}) {
  const body = { get innerText(): never { throw new Error('body reads forbidden'); }, get textContent(): never { throw new Error('body reads forbidden'); } };
  return JSON.parse(JSON.stringify(vm.runInNewContext(pageReplySnapshotScript, {
    document: { body, documentElement: {}, querySelectorAll: () => nodes, createTextNode: (text: string) => ({ textContent: text }) },
    location: { href: 'https://www.doubao.com/chat/one' }, window: host,
  }))) as PageReplySnapshot;
}
test('script uses semantic roles/testids and never reads body text', () => {
  const result = page([new FakeNode({ 'data-message-role': 'user', 'data-message-id': 'u' }, '用户'), new FakeNode({ 'data-testid': 'assistant-message', 'data-message-id': 'b' }, '请先确认')]);
  assert.deepEqual(result.messages, [user('u', '用户'), bot('b', '请先确认')]);
});
test('message list and ambiguous text cannot become assistant replies', () => {
  assert.deepEqual(page([new FakeNode({ 'data-testid': 'message-list' }, '整段历史'), new FakeNode({ 'data-testid': 'message-text' }, '未知角色')]).messages, []);
});
test('local fiber messageData supplies verified role and id without reading stores', () => {
  const node = new FakeNode({ 'data-testid': 'message-item' }, '请上传图片');
  Object.assign(node, { '__reactFiber$test': { memoizedProps: { messageData: { message_id: 'b', user_type: 2 }, get accountStore(): never { throw new Error('must not read account'); } } } });
  assert.deepEqual(page([node]).messages, [bot('b', '请上传图片')]);
});
test('nested duplicate roots and repeated snapshots use stable message identity', () => {
  const outer = new FakeNode({ 'data-message-role': 'assistant' }, '确认');
  const inner = new FakeNode({ 'data-message-role': 'assistant' }, '确认');
  inner.parent = outer;
  const host = {};
  const first = page([outer, inner], host);
  assert.equal(first.messages.length, 1);
  assert.deepEqual(page([outer, inner], host).messages, first.messages);
});
