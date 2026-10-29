import { describe, expect, test } from 'bun:test';
import { PLAN_MAX_ITEMS, applyPlanUpdate, emptyPlan, planContinuation, publicPlan, renderPlanSection } from './plan.mjs';
import { fitRestoredSkills, missingActiveSkills, pickActiveSkills, restoredSkillMessage, skillBlockVisible } from './active-skills.mjs';

const item = (id, status, title = `步骤${id}`) => ({ id, title, status });

describe('plan', () => {
  test('整体替换步骤、保留 goal、校验状态', () => {
    const first = applyPlanUpdate(emptyPlan(), { goal: '做 2 镜短剧', items: [item('s1', 'doing'), item('s2', 'todo')] }, 't1');
    expect(first.goal).toBe('做 2 镜短剧');
    const second = applyPlanUpdate(first, { items: [item('s1', 'done'), item('s2', 'doing')] }, 't2');
    expect(second.goal).toBe('做 2 镜短剧');
    expect(second.items.map((x) => x.status)).toEqual(['done', 'doing']);
    expect(second.updatedAt).toBe('t2');
  });
  test('非法输入被拒绝并给出机器可读原因', () => {
    expect(() => applyPlanUpdate(emptyPlan(), { items: [item('s1', 'oops')] })).toThrow('invalid_plan');
    expect(() => applyPlanUpdate(emptyPlan(), { items: [item('s1', 'todo'), item('s1', 'todo')] })).toThrow('步骤编号重复');
    expect(() => applyPlanUpdate(emptyPlan(), { items: [item('a', 'doing'), item('b', 'doing')] })).toThrow('只能有一步');
    expect(() => applyPlanUpdate(emptyPlan(), { items: Array.from({ length: PLAN_MAX_ITEMS + 1 }, (_, i) => item(`s${i}`, 'todo')) })).toThrow('最多');
    expect(() => applyPlanUpdate(emptyPlan(), 'x')).toThrow('invalid_plan');
  });
  test('渲染计划段落；空计划不产生段落', () => {
    expect(renderPlanSection(emptyPlan())).toBeUndefined();
    expect(renderPlanSection(applyPlanUpdate(emptyPlan(), { items: [] }, 't1'))).toContain('所有步骤已完成');
    const text = renderPlanSection(applyPlanUpdate(emptyPlan(), { goal: 'G', items: [item('s1', 'done'), item('s2', 'needs_user', '首帧确认')] }));
    expect(text).toContain('目标：G');
    expect(text).toContain('1. [完成] 步骤s1');
    expect(text).toContain('2. [等你确认] 首帧确认');
    expect(text).toContain('没有实际做完的步骤不能标 done');
  });
  test('续跑：有待做且无需用户时继续；等用户/卡住/做完/超次数时停', () => {
    const plan = (...items) => applyPlanUpdate(emptyPlan(), { items });
    expect(planContinuation(plan(item('a', 'done'), item('b', 'todo', '分镜脚本')))).toContain('分镜脚本');
    expect(planContinuation(plan(item('a', 'doing', '角色设定'), item('b', 'todo')))).toContain('角色设定');
    expect(planContinuation(plan(item('a', 'needs_user'), item('b', 'todo')))).toBeUndefined();
    expect(planContinuation(plan(item('a', 'blocked'), item('b', 'todo')))).toBeUndefined();
    expect(planContinuation(plan(item('a', 'done')))).toBeUndefined();
    expect(planContinuation(plan(item('a', 'todo')), { continuations: 6 })).toBeUndefined();
    expect(planContinuation(emptyPlan())).toBeUndefined();
  });
  test('给界面的投影带完成进度', () => {
    expect(publicPlan(emptyPlan())).toBeNull();
    const view = publicPlan(applyPlanUpdate(emptyPlan(), { items: [item('a', 'done'), item('b', 'todo')] }, 't'));
    expect(view).toMatchObject({ done: 1, total: 2 });
  });
});

const rec = (skillId, extra = {}) => ({ skillId, versionId: `v-${skillId}`, contentHash: skillId.padEnd(64, '0'), ...extra });
const userMessage = (text) => ({ role: 'user', content: [{ type: 'text', text }] });

describe('active skills', () => {
  test('取最近 2 个、去重保留后出现的、跳过已放下的', () => {
    const loaded = [rec('a'), rec('b'), rec('a'), rec('c', { released: true }), rec('d')];
    expect(pickActiveSkills(loaded).map((r) => r.skillId)).toEqual(['a', 'd']);
  });
  test('正文还在消息里就不补；压缩掉了就补回', () => {
    const a = rec('a');
    const block = `<skill name="n" versionId="${a.versionId}" contentHash="${a.contentHash}">…</skill>`;
    expect(skillBlockVisible([userMessage(block)], a)).toBe(true);
    expect(missingActiveSkills([userMessage(block)], [a])).toEqual([]);
    expect(missingActiveSkills([userMessage('压缩摘要：目标……')], [a])).toEqual([a]);
  });
  test('补回消息使用官方技能块格式并说明原因', () => {
    const resource = { pin: { skillId: 'a', versionId: 'v-a', contentHash: 'a'.padEnd(64, '0') }, name: '短剧', version: '2', description: '', files: [], unsupportedCapabilities: [], instruction: '第一步……' };
    const message = restoredSkillMessage([resource], 1);
    expect(message.role).toBe('user');
    expect(message.content[0].text).toContain('对话被压缩');
    expect(message.content[0].text).toContain('versionId="v-a"');
    expect(message.content[0].text).toContain('第一步……');
  });
  test('总大小护栏：超过窗口 1/5 只保留最近一个', () => {
    const resource = (id, size) => ({ pin: { skillId: id }, instruction: 'x'.repeat(size) });
    expect(fitRestoredSkills([resource('a', 600), resource('b', 600)], 4000).map((r) => r.pin.skillId)).toEqual(['b']);
    expect(fitRestoredSkills([resource('a', 100), resource('b', 100)], 4000).map((r) => r.pin.skillId)).toEqual(['a', 'b']);
  });
});
