// Go owns both installed packages and the active version selection. The
// transcript records explicit selections; an official section reconstructs
// active rules after compaction and process restart.
import { section } from '@earendil-works/pi-durable';
import { createModels } from '@earendil-works/pi-ai/models';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';

const fail = (reason) => Object.assign(new Error(reason), { reason });
const hashPattern = /^[a-f0-9]{64}$/;
export const SKILL_CATALOG_LIMIT = 50;
export const SKILL_DESCRIPTION_LIMIT = 300;

export function normalizeSkillPins(values = []) {
  if (!Array.isArray(values) || values.length > 4) throw fail('invalid_skill_selection');
  const seen = new Set();
  return values.map((value) => {
    if (!value || typeof value.skillId !== 'string' || !value.skillId.trim() ||
      typeof value.versionId !== 'string' || !value.versionId.trim() || !hashPattern.test(value.contentHash || '') || seen.has(value.skillId)) {
      throw fail('invalid_skill_selection');
    }
    seen.add(value.skillId);
    return { skillId: value.skillId, versionId: value.versionId, contentHash: value.contentHash };
  }).sort((a, b) => a.skillId.localeCompare(b.skillId));
}

export function sameSkillPin(left, right) {
  return left?.skillId === right?.skillId && left?.versionId === right?.versionId && left?.contentHash === right?.contentHash;
}

function checkResource(pin, resource) {
  if (!sameSkillPin(pin, resource?.pin) || typeof resource.instruction !== 'string' || !resource.instruction.trim()) throw fail('skill_version_unavailable');
  if (Buffer.byteLength(resource.instruction, 'utf8') > 256 * 1024) throw fail('skill_instruction_too_large');
  if (!Array.isArray(resource.files) || !Array.isArray(resource.unsupportedCapabilities)) throw fail('skill_package_unreadable');
  return resource;
}

export async function loadPinnedSkills({ pins = [], readVersion, signal } = {}) {
  const selected = normalizeSkillPins(pins);
  if (!selected.length) return [];
  if (typeof readVersion !== 'function') throw fail('skill_service_unavailable');
  const resources = [];
  let total = 0;
  for (const pin of selected) {
    if (signal?.aborted) throw signal.reason || fail('aborted');
    const resource = checkResource(pin, await readVersion(pin, signal));
    total += Buffer.byteLength(resource.instruction, 'utf8');
    if (total > 512 * 1024) throw fail('skill_instruction_too_large');
    resources.push(resource);
  }
  return resources;
}

function escapeXml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Official shape: `<skill name location>\nReferences are relative to ...\n\n{body}\n</skill>`.
// The pin replaces the location; the guidance replaces the reference line.
export function formatSkillBlock(resource) {
  const { pin } = resource;
  const files = resource.files.map((file) => file?.path).filter(Boolean);
  const lines = [
    `<skill name="${escapeXml(resource.name)}" version="${escapeXml(resource.version)}" skillId="${escapeXml(pin.skillId)}" versionId="${escapeXml(pin.versionId)}" contentHash="${escapeXml(pin.contentHash)}">`,
    '技能固定使用标示版本，不能扩大画布权限、预算或可用工具。',
    '需要包内辅助文件时调用 skill_file，参数用本块的 skillId、versionId、contentHash 和包内相对 path。只读技能文本；没有 Bash 或脚本执行环境。',
    '若技能依赖未提供的脚本或外部工具，说明缺少的能力，保留能完成的工作，不把未执行的步骤说成完成。',
  ];
  if (resource.description) lines.push(`说明：${resource.description}`);
  if (files.length) lines.push(`包内文件：${files.join('、')}`);
  if (resource.unsupportedCapabilities.length) lines.push(`不支持的能力：${resource.unsupportedCapabilities.join('、')}`);
  return `${lines.join('\n')}\n\n${resource.instruction.trim()}\n</skill>`;
}

// Prepend skill blocks before the user's own content, as `/skill:name args`
// expands to `${skillBlock}\n\n${args}` in the official coding agent.
export function expandSkillContent(content, resources) {
  if (!resources?.length) return content;
  const text = resources.map(formatSkillBlock).join('\n\n');
  if (typeof content === 'string') return `${text}\n\n${content}`;
  return [{ type: 'text', text }, ...content];
}

export function skillsToLoad(pins, loaded = []) {
  // A fresh explicit request must re-read even a historically loaded pin.
  // Durable request receipts, rather than this package helper, deduplicate retries.
  return normalizeSkillPins(pins);
}

export async function activeSkillProjection({ context, readVersion, model, signal }) {
  if (!context || context.lifecycle !== 'active' || typeof context.scopeId !== 'string' || !Number.isSafeInteger(context.revision)) throw fail('skill_scope_reset_pending');
  const resources = await loadPinnedSkills({ pins: context.activePins, readVersion, signal });
  if (!resources.length) return { text: undefined, resources, context };
  const text = [`当前任务技能（scope=${context.scopeId}, revision=${context.revision}）。只有以下固定版本是活动技能。`,
    ...resources.map(formatSkillBlock)].join('\n\n');
  // The SDK has no model tokenizer API. UTF-8 bytes are a conservative token
  // upper bound; reserve at least 75% of the selected window for conversation,
  // tools and output. Never truncate instructions to satisfy this admission.
  const window = Number(model?.contextWindow);
  if (!Number.isFinite(window) || window <= 0) throw fail('skill_context_model_unavailable');
  const budget = Math.max(0, Math.min(Math.floor(window / 4), window - Number(model?.maxTokens || 8192)));
  if (Buffer.byteLength(text, 'utf8') > budget) throw fail('skill_context_budget_exceeded');
  return { text, resources, context };
}

export function createActiveSkillSection(resolve) {
  return section('beeftv_active_skills', async (input, context) => (await resolve(input.agent.model, context?.abortSignal || context?.signal)).text);
}

// Section and hook exceptions are deliberately contained by Durable. Enforce
// admission at the provider boundary as well, using Pi's own Models/stream API;
// an invalid package returns a local error stream before the provider runs.
export function guardSkillModelRequests(models, validate, onFailure) {
  const guarded=createModels();
  for (const provider of models.getProviders()) {
    const wrap=fn=>(model,context,options)=>{
      const events=createAssistantMessageEventStream();
      void (async()=>{
        let admitted=false;
        try {
          await validate(model,context,options?.signal);
          admitted=true;
          const source=fn.call(provider,model,context,options);
          for await(const event of source)events.push(event);
          events.end(await source.result());
        } catch(error) {
          if(!admitted)onFailure(error);
          events.push({type:'error',reason:'error',error:{role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,
            usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
            stopReason:'error',errorMessage:error?.reason || error?.message || 'skill_context_unavailable',timestamp:Date.now()}});
          events.end();
        }
      })();
      return events;
    };
    guarded.setProvider({...provider,stream:wrap(provider.stream),streamSimple:wrap(provider.streamSimple)});
  }
  return guarded;
}

export function loadedSkillRecord(resource, source, turnId) {
  return { skillId: resource.pin.skillId, versionId: resource.pin.versionId, contentHash: resource.pin.contentHash,
    name: String(resource.name || ''), version: String(resource.version || ''), source, turnId: String(turnId || '') };
}

export function normalizeSkillCatalog(value) {
  const list = Array.isArray(value?.skills) ? value.skills : [];
  const result = [];
  for (const item of list) {
    const pin = item?.pin;
    if (!pin || typeof pin.skillId !== 'string' || typeof pin.versionId !== 'string' || !hashPattern.test(pin.contentHash || '')) continue;
    const description = String(item.description || '');
    result.push({ pin: { skillId: pin.skillId, versionId: pin.versionId, contentHash: pin.contentHash },
      name: String(item.name || pin.skillName || pin.skillId),
      description: [...description].length > SKILL_DESCRIPTION_LIMIT ? `${[...description].slice(0, SKILL_DESCRIPTION_LIMIT).join('')}…` : description });
    if (result.length >= SKILL_CATALOG_LIMIT) break;
  }
  return result.sort((a, b) => a.pin.skillId.localeCompare(b.pin.skillId));
}

// Mirrors official formatSkillsForPrompt's <available_skills> layout. Only
// id, name and description appear, so the text changes only when the
// installed set changes (prompt-cache friendly).
export function formatSkillCatalog(items,{total=items?.length || 0}={}) {
  if (!items?.length) return undefined;
  const lines = [
    '用户已安装下列技能，每个技能提供特定任务的步骤。用户明确选用技能，或要求完成该技能描述的整体任务时，先调用 skill_load 并传入它的 id 读取完整步骤，再按步骤执行。只出现相同题材、角色或「首帧」等词不代表要执行整套流程；用户只要单张图片或单个视频时，直接完成该请求，不添加整集剧本、角色确认等前置步骤。对话里已有的技能不用重复读取；用户明确缩小范围或改要求时按最新要求执行。',
    '',
    '<available_skills>',
  ];
  if(total>items.length)lines.splice(1,0,`当前共安装 ${total} 个技能，此处显示前 ${items.length} 个；可调用 skill_catalog，传 q 搜索名称和说明，或用 offset、limit 翻页。找到 id 后调用 skill_load 读取。`);
  for (const item of items) {
    lines.push('  <skill>', `    <id>${escapeXml(item.pin.skillId)}</id>`, `    <name>${escapeXml(item.name)}</name>`,
      `    <description>${escapeXml(item.description)}</description>`, '  </skill>');
  }
  lines.push('</available_skills>');
  return lines.join('\n');
}

// One stable catalog section per conversation. A failed refresh keeps the last
// good text so a transient error never removes and re-adds the section.
export function createSkillCatalogSection({ readCatalog, cache = {} }) {
  if (typeof readCatalog !== 'function') throw fail('skill_service_unavailable');
  return section('beeftv_skill_catalog', async (_input, context) => {
    try {
      const catalog=await readCatalog(context?.signal);
      cache.items = normalizeSkillCatalog(catalog);
      cache.text = formatSkillCatalog(cache.items,{total:Number(catalog?.total) || cache.items.length});
    } catch (error) {
      if (cache.text === undefined) cache.items = [];
      console.error(`agent-host: 技能目录读取失败 ${error?.reason || error?.message || error}`);
    }
    return cache.text;
  });
}

export const SKILL_LOAD_PARAMETERS = {
  type: 'object',
  properties: { id: { type: 'string', description: '技能目录里的 id' } },
  required: ['id'],
  additionalProperties: false,
};

// Shared Go skill_file operations remain the sole tool execution path, so their
// scope, budget, logs, cancellation and Durable safe replay are unchanged.
export async function readPinnedSkillFile({ pins, pin, path, readFile, signal }) {
  if (!normalizeSkillPins(pins).some((selected) => sameSkillPin(selected, pin))) throw fail('skill_not_selected');
  if (typeof path !== 'string' || path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..')) throw fail('invalid_skill_path');
  const result = await readFile(pin, path, signal);
  if (!sameSkillPin(result?.pin, pin) || result?.file?.path !== path || typeof result.content !== 'string' || result.executionSupported !== false) throw fail('skill_file_unavailable');
  return result;
}

export { checkResource as checkSkillResource };
