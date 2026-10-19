import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveStagedAssetPaths, resolveStagedAttachments } from './staged-attachments';

const store: Record<string, string> = { a: 'C:/assets/a.png', b: 'C:/assets/b.jpg', c: 'C:/assets/report.pdf' };
const resolve = (id: string) => {
  const file = store[id];
  if (!file) throw new Error('图片资产不存在，请刷新资产库');
  return file;
};

test('no attachments resolves to an empty list', () => {
  assert.deepEqual(resolveStagedAttachments([], resolve), []);
  assert.deepEqual(resolveStagedAttachments(undefined, resolve), []);
});

test('a single attachment keeps its path, name and mime type', () => {
  const [item] = resolveStagedAttachments([{ id: 'a', assetId: 'a', name: '截图.png', mimeType: 'image/png' }], resolve);
  assert.deepEqual({ path: item.path, name: item.name, mimeType: item.mimeType }, { path: 'C:/assets/a.png', name: '截图.png', mimeType: 'image/png' });
});

test('multiple attachments all survive the round trip', () => {
  const items = resolveStagedAttachments([
    { id: 'a', assetId: 'a', name: 'a.png', mimeType: 'image/png' },
    { id: 'b', assetId: 'b', name: 'b.jpg', mimeType: 'image/jpeg' },
    { id: 'c', assetId: 'c', name: 'report.pdf', mimeType: 'application/pdf' },
  ], resolve);
  assert.deepEqual(items.map(item => item.path), ['C:/assets/a.png', 'C:/assets/b.jpg', 'C:/assets/report.pdf']);
});

test('assetId wins over the UI-only id when both are present', () => {
  const [item] = resolveStagedAttachments([{ id: 'staged-1', assetId: 'b', name: 'b.jpg' }], resolve);
  assert.equal(item.path, 'C:/assets/b.jpg');
});

test('name and mime type fall back when the renderer did not send them', () => {
  const [item] = resolveStagedAttachments([{ assetId: 'a' }], resolve);
  assert.equal(item.name, 'a.png');
  assert.equal(item.mimeType, 'application/octet-stream');
});

test('a stale attachment fails loudly instead of being silently dropped', () => {
  assert.throws(
    () => resolveStagedAttachments([{ assetId: 'a' }, { assetId: 'gone' }], resolve),
    /附件已失效.*gone/,
  );
});

test('a missing asset id is reported once even when staged twice', () => {
  assert.throws(
    () => resolveStagedAttachments([...Array(3)].map(() => ({ id: 'gone' })), resolve),
    error => /gone/g.test((error as Error).message) && String((error as Error).message).split('gone').length === 2,
  );
});

test('account mode resolves bare asset ids to paths in draft order', () => {
  assert.deepEqual(resolveStagedAssetPaths([], resolve), []);
  assert.deepEqual(resolveStagedAssetPaths(['b', 'a'], resolve), ['C:/assets/b.jpg', 'C:/assets/a.png']);
});

test('account mode fails loudly on a stale draft image', () => {
  assert.throws(
    () => resolveStagedAssetPaths(['a', 'gone'], resolve),
    /附件已失效.*gone/,
  );
});

test('account mode ignores a non-array asset id list instead of crashing', () => {
  assert.deepEqual(resolveStagedAssetPaths(undefined, resolve), []);
  assert.deepEqual(resolveStagedAssetPaths(null as unknown as string[], resolve), []);
});
