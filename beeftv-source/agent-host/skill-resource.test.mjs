import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSkillCatalogSection, expandSkillContent, formatSkillBlock, formatSkillCatalog, loadPinnedSkills, normalizeSkillCatalog,
  normalizeSkillPins, readPinnedSkillFile, skillsToLoad, activeSkillProjection } from './skill-resource.mjs';

const pin = { skillId: 'user-skill', versionId: 'v1', contentHash: 'a'.repeat(64) };
const resource = { pin, name: '采访切片', version: '1', description: '保留原话', instruction: '先读取 references/interview.md，再按原话整理三个镜头。', files: [{ path: 'references/interview.md' }], unsupportedCapabilities: [] };

test('large Chinese instructions remain complete and oversized instructions are rejected', async () => {
  const instruction = '镜头'.repeat(13000);
  const loaded = await loadPinnedSkills({ pins: [pin], readVersion: async () => ({ ...resource, instruction }) });
  assert.equal(loaded[0].instruction, instruction);
  await assert.rejects(loadPinnedSkills({ pins: [pin], readVersion: async () => ({ ...resource, instruction: '字'.repeat(90000) }) }), /skill_instruction_too_large/);
  const many = ['a', 'b', 'c'].map((id) => ({ skillId: id, versionId: 'v1', contentHash: 'b'.repeat(64) }));
  await assert.rejects(loadPinnedSkills({ pins: many, readVersion: async (selected) => ({ ...resource, pin: selected, instruction: '字'.repeat(60000) }) }), /skill_instruction_too_large/);
  assert.throws(() => normalizeSkillPins([1, 2, 3, 4, 5].map((n) => ({ ...pin, skillId: `s${n}` }))), /invalid_skill_selection/);
});

test('selected skill expands into the user message in the official skill block shape', () => {
  const block = formatSkillBlock(resource);
  assert.match(block, /^<skill name="采访切片" version="1" skillId="user-skill" versionId="v1" contentHash="a{64}">/);
  assert.match(block, /references\/interview.md/);
  assert.match(block, /skill_file/);
  assert.match(block, /不能扩大画布权限、预算或可用工具/);
  assert.match(block, /\n\n先读取 references\/interview.md，再按原话整理三个镜头。\n<\/skill>$/);
  assert.equal(expandSkillContent('只要原话', [resource]), `${block}\n\n只要原话`);
  const parts = expandSkillContent([{ type: 'text', text: '用户原文' }, { type: 'image', data: 'x', mimeType: 'image/png' }], [resource]);
  assert.equal(parts.length, 3); assert.equal(parts[0].text, block); assert.equal(parts[1].text, '用户原文');
  assert.equal(expandSkillContent('原文', []), '原文');
  assert.match(formatSkillBlock({ ...resource, name: 'a"<b>' }), /name="a&quot;&lt;b&gt;"/);
});

test('fresh explicit selection reads even a historically loaded exact pin', () => {
  const loaded = [{ ...pin, name: '采访切片', source: 'selected' }];
  assert.deepEqual(skillsToLoad([pin], loaded), [pin]);
  assert.deepEqual(skillsToLoad([{ ...pin, versionId: 'v2' }], loaded), [{ ...pin, versionId: 'v2' }]);
  assert.throws(() => skillsToLoad([{ ...pin, contentHash: 'fixture-hash' }], loaded), /invalid_skill_selection/);
});

test('active projection restores full fixed rules and refuses a small model window without truncation', async () => {
  const context={scopeId:'scope',revision:2,lifecycle:'active',activePins:[pin]};
  const projected=await activeSkillProjection({context,readVersion:async()=>resource,model:{contextWindow:200000,maxTokens:16000}});
  assert(projected.text.includes(resource.instruction));
  await assert.rejects(activeSkillProjection({context,readVersion:async()=>({...resource,instruction:'规则'.repeat(400)}),model:{contextWindow:4096,maxTokens:2048}}),/skill_context_budget_exceeded/);
  await assert.rejects(activeSkillProjection({context:{...context,lifecycle:'reset_pending'},readVersion:async()=>resource,model:{contextWindow:200000}}),/skill_scope_reset_pending/);
});

test('update does not replace a pinned version and uninstall cannot silently use cached instructions', async () => {
  await assert.rejects(loadPinnedSkills({ pins: [pin], readVersion: async () => ({ ...resource, pin: { ...pin, versionId: 'v2' } }) }), /skill_version_unavailable/);
  await assert.rejects(loadPinnedSkills({ pins: [pin], readVersion: async () => { throw Error('skill_uninstalled'); } }), /skill_uninstalled/);
});

test('auxiliary files require selected version and package relative path; scripts remain read only', async () => {
  const readFile = async (selected, path) => ({ pin: selected, file: { path }, content: '原话来自采访素材', executionSupported: false });
  const result = await readPinnedSkillFile({ pins: [pin], pin, path: 'references/interview.md', readFile });
  assert.equal(result.content, '原话来自采访素材');
  for (const path of ['../secrets', '/etc/passwd', 'https://example.com', 'scripts\\run.js']) {
    await assert.rejects(readPinnedSkillFile({ pins: [pin], pin, path, readFile }), /invalid_skill_path/);
  }
  await assert.rejects(readPinnedSkillFile({ pins: [], pin, path: 'SKILL.md', readFile }), /skill_not_selected/);
});

test('no selection performs no package discovery; script dependent skill exposes missing execution explicitly', async () => {
  let called = false;
  assert.deepEqual(await loadPinnedSkills({ pins: [], readVersion: async () => { called = true; } }), []);
  assert.equal(called, false);
  const block = formatSkillBlock({ ...resource, unsupportedCapabilities: ['script_execution'] });
  assert.match(block, /script_execution/);
  assert.match(block, /不把未执行的步骤说成完成/);
});

test('catalog mirrors available_skills, is bounded, and stays byte-stable across requests and failures', async () => {
  const items = Array.from({ length: 60 }, (_, index) => ({ pin: { skillId: `skill-${String(index).padStart(2, '0')}`, versionId: 'v1', contentHash: 'c'.repeat(64), skillName: `技能${index}` },
    name: `技能${index}`, description: '说明'.repeat(200) }));
  const normalized = normalizeSkillCatalog({ skills: [...items, { pin: { skillId: 'bad', versionId: 'v', contentHash: 'nope' } }] });
  assert.equal(normalized.length, 50);
  assert.equal([...normalized[0].description].length, 301);
  const text = formatSkillCatalog(normalized);
  assert.match(text, /<available_skills>\n {2}<skill>\n {4}<id>skill-00<\/id>\n {4}<name>技能0<\/name>/);
  assert.match(text, /skill_load/);
  assert.doesNotMatch(text, /contentHash|cccc/);
  assert.equal(formatSkillCatalog([]), undefined);
  let fail = false; let calls = 0;
  const cache = {};
  const section = createSkillCatalogSection({ cache, readCatalog: async () => { calls++; if (fail) throw new Error('offline'); return { skills: items.slice(0, 2) }; } });
  assert.equal(section.key, 'beeftv_skill_catalog');
  const first = await section.render({}, {});
  assert.equal(await section.render({}, {}), first);
  fail = true;
  assert.equal(await section.render({}, {}), first, 'a failed refresh must not drop the section');
  assert.equal(calls, 3);
  assert.equal(cache.items.length, 2);
});
