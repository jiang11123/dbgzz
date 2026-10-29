import { describe, expect, test } from 'bun:test';
import { buildStudioDigest, describeChangesSince, nodeState, snapshotOf } from './studio-digest.mjs';

const media = (id, type, title, meta = {}) => ({ id, type, title, metadata: meta });
const board = (rows) => ({ id: 'board-1', type: 'script', title: '13楼的外卖', metadata: { storyboard: { rows } } });
const row = (n, extra = {}) => ({ id: `row-${n}`, shotNumber: n, durationSeconds: 5, plotDescription: `第${n}镜剧情`, imageGenerationPrompt: 'p', videoMotionPrompt: '', ...extra });

describe('nodeState', () => {
  test('进行中、失败、完成、空', () => {
    expect(nodeState(media('a', 'image', 'x', { status: 'loading' }))).toBe('running');
    expect(nodeState(media('a', 'image', 'x', { taskStatus: 'queued' }))).toBe('running');
    expect(nodeState(media('a', 'image', 'x', { status: 'error' }))).toBe('failed');
    expect(nodeState(media('a', 'image', 'x', { assetId: 'asset-1' }))).toBe('done');
    expect(nodeState(media('a', 'image', 'x'))).toBe('empty');
  });
});

describe('buildStudioDigest', () => {
  const canvas = {
    revision: 12,
    nodes: [
      board([row(1, { imageNodeId: 'img-1', videoNodeId: 'vid-1' }), row(2, { imageNodeId: 'img-2' }), row(3)]),
      media('img-1', 'image', '镜1首帧', { status: 'success', assetId: 'a1' }),
      media('vid-1', 'video', '镜1视频', { status: 'loading' }),
      media('img-2', 'image', '镜2首帧', { status: 'error', generationErrorSummary: '内容审核未通过' }),
    ],
    connections: [{ id: 'c1', fromNodeId: 'img-1', toNodeId: 'vid-1' }],
  };
  test('包含版本、分镜行绑定、进行中与失败，并带上 id', () => {
    const { text } = buildStudioDigest(canvas, { selectedNodeIds: ['img-2'] });
    expect(text).toContain('画布版本 12');
    expect(text).toContain('分镜板「13楼的外卖」id=board-1，共 3 镜');
    expect(text).toContain('镜1 5s｜行id=row-1｜首帧 img-1 完成｜视频 vid-1 生成中');
    expect(text).toContain('镜2 5s｜行id=row-2｜首帧 img-2 失败｜视频 — 未建');
    expect(text).toContain('镜3 5s｜行id=row-3｜首帧 — 未建');
    expect(text).toContain('生成中：vid-1');
    expect(text).toContain('失败：img-2「镜2首帧」内容审核未通过');
    expect(text).toContain('用户选中：img-2');
  });
  test('同一状态输出完全相同（缓存友好）', () => {
    expect(buildStudioDigest(canvas).text).toBe(buildStudioDigest(JSON.parse(JSON.stringify(canvas))).text);
  });
  test('超预算先收缩分镜明细，关键信息保留', () => {
    const rows = Array.from({ length: 60 }, (_, i) => row(i + 1, { imageNodeId: `i${i}`, plotDescription: '很长的剧情描述'.repeat(5) }));
    const big = { revision: 3, nodes: [board(rows), media('i0', 'image', 'x', { status: 'error', generationErrorSummary: '失败了' })], connections: [] };
    const { text } = buildStudioDigest(big, { maxBytes: 1500 });
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1500);
    expect(text).toContain('失败：i0');
    expect(text).toContain('分镜明细已收缩');
  });
  test('空画布', () => {
    expect(buildStudioDigest({ revision: 0, nodes: [], connections: [] }).text).toContain('画布是空的');
  });
});

describe('describeChangesSince', () => {
  const before = snapshotOf([
    media('a', 'image', '镜1首帧', { status: 'loading' }),
    media('b', 'text', '角色设定', { content: '老内容' }),
    media('c', 'image', '要删的', { assetId: 'x' }),
  ]);
  test('生成完成、用户修改、新增、删除都能说出来', () => {
    const after = snapshotOf([
      media('a', 'image', '镜1首帧', { status: 'success', assetId: 'a1' }),
      media('b', 'text', '角色设定', { content: '用户改过的内容' }),
      media('d', 'image', '新的', {}),
    ]);
    const text = describeChangesSince(before, after);
    expect(text).toContain('用户修改了「角色设定」');
    expect(text).toContain('新增 1 个节点');
    expect(text).toContain('删除了「要删的」');
    expect(text).toContain('「镜1首帧」生成完成');
  });
  test('失败要说出来；位置变化不算改动；无变化返回空串', () => {
    const failed = snapshotOf([media('a', 'image', '镜1首帧', { status: 'error' }), media('b', 'text', '角色设定', { content: '老内容' }), media('c', 'image', '要删的', { assetId: 'x' })]);
    expect(describeChangesSince(before, failed)).toContain('「镜1首帧」生成失败');
    const moved = snapshotOf([{ ...media('a', 'image', '镜1首帧', { status: 'loading' }), position: { x: 99, y: 1 } }, media('b', 'text', '角色设定', { content: '老内容' }), media('c', 'image', '要删的', { assetId: 'x' })]);
    expect(describeChangesSince(before, moved)).toBe('');
    expect(describeChangesSince(null, moved)).toBe('');
  });
  test('列表过长时压缩成“等 N 个”', () => {
    const many = (suffix) => snapshotOf(Array.from({ length: 9 }, (_, i) => media(`n${i}`, 'text', `节点${i}`, { content: suffix })));
    expect(describeChangesSince(many('旧'), many('新'))).toContain('等 9 个');
  });
});
