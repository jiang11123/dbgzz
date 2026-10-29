// 助手评测尺子：确定性内存版 Go 业务权威模拟器（sim-go）。
// 零外部网络请求、零真实生成扣费；加载真实 operation-descriptors.fixture.json，
// 还原画布 revision CAS、分镜行与产出连线绑定、生成提议与用户确认、任务交付、历史撤销及技能上下文。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(__dirname, '../operation-descriptors.fixture.json');
const REPO_SKILL_PATH = path.resolve(__dirname, '../../../skills/short-drama-storyboard/SKILL.md');

const FALLBACK_SHORT_DRAMA_SKILL_MD = `---
name: 短剧分镜到首帧
version: "2"
description: 把一段短剧剧本或梗概，按「角色设定 → 分镜脚本 → 首帧图 → 视频」四步落到画布上。每一步做完都停下等确认，再进入下一步。适合竖屏短剧、漫剧的单集制作。
---

# 短剧分镜到首帧

适用于用户选择本技能或明确要求制作一集短剧。用户只要单张图片、单个视频，或中途明确缩小范围时，按最新要求完成，不添加整集剧本或角色确认等前置步骤。

完整制作一共四步，按顺序走。每一步只做这一步的事，做完用一两句话告诉用户画布上多了什么、需要确认什么，然后停下。用户确认或提出修改后，才进入下一步。继续时先读取当前画布，沿用已有的节点、分镜行和生成结果，避免重复创建或重复收费。

## 第 0 步：确认基本信息
1. 剧本或梗概（必须有）
2. 画幅：竖屏 9:16 还是横屏 16:9（默认竖屏 9:16）
3. 画面风格：例如写实电影感、日系动漫、国风水墨（默认写实电影感）
4. 本集目标时长（默认 60 秒）

## 第 1 步：角色设定
- 在画布上建一个 Markdown 节点，标题「角色设定」。
- 这一步不建图片节点，不提生成。

## 第 2 步：分镜脚本
- 建一个分镜脚本节点（script 类型），标题「分镜脚本」，再往里追加分镜行。
- 每一镜填写：剧情描述、景别、机位、镜头运动、台词、情绪、时长、首帧图片提示词（imageGenerationPrompt）和视频提示词（videoMotionPrompt）。
- 这一步不建图片节点，不提生成。

## 第 3 步：首帧图
- 只为用户确认过的镜头建图片节点，标题「镜 N 首帧」，内容用该镜的首帧图片提示词。
- 每个图片节点的画幅设成第 0 步确定的画幅，生成数量为 1。
- 创建节点后，用 canvas_script_row_update 将图片节点 ID 写入对应行的 imageNodeId；使用创建和追加操作返回的真实节点、行 ID。绑定成功后才能提出生成方案。
- 一批最多 4 张。镜头超过 4 个时，先做前 4 个，告诉用户剩下的下一批再做。
- 建完后为这一批提出生成提议，并告诉用户：在面板里确认后才会开始生成、才会计费。

## 第 4 步：视频
- 只在对应首帧图已经生成并被用户确认后才做。
- 每个确认过的镜头建一个视频节点，标题「镜 N 视频」，内容使用该行 videoMotionPrompt，把该镜首帧图节点连到视频节点作为参考。
- 用 canvas_script_row_update 将视频节点 ID 写入对应行的 videoNodeId；确认首帧和视频都绑定到同一分镜行。
- 一批最多 4 个，提出生成提议后停下，等用户确认。
`;

// 1x1 透明 PNG（确定性占位图，不联网）
const DETERMINISTIC_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfWQAAAAASUVORK5CYII=';
const DETERMINISTIC_PNG_BYTES = Buffer.from(DETERMINISTIC_PNG_BASE64, 'base64');
const DETERMINISTIC_PNG_SHA256 = crypto.createHash('sha256').update(DETERMINISTIC_PNG_BYTES).digest('hex');

const NODE_CAPABILITIES = {
  text: {
    defaultWidth: 340, defaultHeight: 240, inputKind: 'text', generationMode: '',
    canSource: true, canTarget: false, acceptedInputKinds: [], maxInputCount: 0,
    patchFields: new Set(['title', 'content']),
  },
  markdown: {
    defaultWidth: 420, defaultHeight: 320, inputKind: 'text', generationMode: '',
    canSource: true, canTarget: false, acceptedInputKinds: [], maxInputCount: 0,
    patchFields: new Set(['title', 'content']),
  },
  image: {
    defaultWidth: 720, defaultHeight: 405, inputKind: 'image', generationMode: 'image',
    canSource: true, canTarget: true, acceptedInputKinds: ['text', 'image'], maxInputCount: 0,
    patchFields: new Set(['title', 'content', 'model', 'size', 'quality', 'transparentBackground', 'count']),
  },
  video: {
    defaultWidth: 720, defaultHeight: 405, inputKind: 'video', generationMode: 'video',
    canSource: true, canTarget: true, acceptedInputKinds: ['text', 'image', 'video', 'audio'], maxInputCount: 0,
    patchFields: new Set(['title', 'content', 'model', 'size', 'seconds', 'vquality', 'generateAudio', 'watermark']),
  },
  audio: {
    defaultWidth: 340, defaultHeight: 120, inputKind: 'audio', generationMode: 'audio',
    canSource: true, canTarget: true, acceptedInputKinds: ['text'], maxInputCount: 1,
    patchFields: new Set(['title', 'content', 'model', 'audioVoice', 'audioFormat', 'audioSpeed', 'audioPitch', 'audioVolume', 'audioInstructions']),
  },
  frame: {
    defaultWidth: 760, defaultHeight: 520, inputKind: '', generationMode: '',
    canSource: false, canTarget: false, acceptedInputKinds: [], maxInputCount: 0,
    patchFields: new Set(['title']),
  },
  'batch-table': {
    defaultWidth: 1280, defaultHeight: 560, inputKind: 'text', generationMode: '',
    canSource: true, canTarget: true, acceptedInputKinds: ['image'], maxInputCount: 0,
    patchFields: new Set(['title']),
  },
  script: {
    defaultWidth: 920, defaultHeight: 360, inputKind: '', generationMode: '',
    canSource: false, canTarget: false, acceptedInputKinds: [], maxInputCount: 0,
    patchFields: new Set(['title']),
  },
};

const STORYBOARD_ROW_FIELDS = new Set([
  'durationSeconds', 'plotDescription', 'dialogue', 'narrativeIntent', 'viewerPOV',
  'performanceBlocking', 'shotSize', 'emotion', 'lightingAndAtmosphere', 'audioEffects',
  'camera', 'motion', 'timeBeats', 'imageGenerationPrompt', 'videoMotionPrompt',
  'mustHave', 'optionalDetails', 'continuityOut', 'negativePrompt',
]);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function parseSkillMarkdown(raw, skillId = 'short-drama-storyboard', versionId = 'v2') {
  const normalized = String(raw || '').replace(/\r\n/g, '\n');
  let name = skillId;
  let version = '2';
  let description = '';
  let body = normalized;
  const match = /^---\n([\s\S]*?)\n---\n+([\s\S]*)$/.exec(normalized);
  if (match) {
    const frontmatter = match[1];
    body = match[2].trim();
    for (const line of frontmatter.split('\n')) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      if (key === 'name') name = val;
      if (key === 'version') version = val;
      if (key === 'description') description = val;
    }
  }
  const contentHash = sha256Hex(body);
  return {
    pin: { skillId, versionId, contentHash },
    name,
    version,
    description,
    instruction: body,
    files: [],
    unsupportedCapabilities: [],
  };
}

function loadOperationDescriptors() {
  const raw = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  for (const descriptor of raw) {
    if (descriptor.id === 'canvas.script.row.update') {
      const itemProps = descriptor.params?.properties?.patches?.items?.properties;
      if (itemProps) {
        itemProps.imageNodeId ||= {
          type: 'string',
          description: '把同一画布的 image 节点绑定为本行首帧图片；空字符串解除绑定。本行只保留一条指向它的产出连线',
        };
        itemProps.videoNodeId ||= {
          type: 'string',
          description: '把同一画布的 video 节点绑定为本行镜头视频；空字符串解除绑定。本行只保留一条指向它的产出连线',
        };
      }
    }
    if (descriptor.id === 'skill.catalog') {
      descriptor.params = {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: '精确技能 id' },
          q: { type: 'string', description: '按名称或说明搜索' },
          offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
      };
    }
  }
  return raw;
}

class OpError extends Error {
  constructor(status, code, reason, message, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.reason = reason;
    this.details = details;
  }
}

function invalidArg(reason, message, details = null) {
  return new OpError(400, 'invalid_argument', reason, message, details);
}
function notFound(reason, message, details = null) {
  return new OpError(404, 'not_found', reason, message, details);
}
function conflict(reason, message, details = null) {
  return new OpError(409, 'conflict', reason, message, details);
}
function preconditionFailed(reason, message, details = null) {
  return new OpError(412, 'precondition_failed', reason, message, details);
}
function permissionDenied(reason, message, details = null) {
  return new OpError(403, 'permission_denied', reason, message, details);
}

function dimensionsForSize(size = '9:16') {
  if (size === '16:9') return { width: 1280, height: 720 };
  if (size === '1:1') return { width: 1024, height: 1024 };
  return { width: 720, height: 1280 };
}

export function createSimGo(options = {}) {
  const hostToken = options.hostToken || '';
  const defaultCanvasId = options.defaultCanvasId || 'canvas-1';
  const descriptors = loadOperationDescriptors();
  const descriptorMap = new Map(descriptors.map((d) => [d.id, d]));

  let nodeSeq = 0;
  let edgeSeq = 0;
  let rowSeq = 0;
  let proposalSeq = 0;
  let taskSeq = 0;
  let assetSeq = 0;
  let resourceSeq = 0;
  let scopeSeq = 0;

  const canvases = new Map();
  const canvasHistory = new Map();
  const turns = new Map();
  const opReceipts = new Map();
  const proposals = new Map();
  const tasks = new Map();
  const assets = new Map();
  const resources = new Map();
  const skills = new Map();
  const skillContexts = new Map();
  const skillContextReceipts = new Map();
  const events = [];
  const opLog = [];
  const nextTaskFailures = [];
  const nextTaskDefects = [];
  const pendingTimers = new Set();

  const counts = {
    ops: {},
    WriteOps: 0,
    ReadOps: 0,
    revisionConflicts: 0,
    scopeDenied: 0,
    duplicateNodeAttempts: 0,
    duplicateProposals: 0,
    unconfirmedTasks: 0,
    userConfirmations: 0,
    userEdits: 0,
    undoCalls: 0,
    mediaInspections: 0,
    proposedNodes: {},
    createdNodeTitles: {},
  };

  const models = [
    {
      modelKey: 'seedream-3.0',
      display: 'Seedream 3.0',
      kind: 'image',
      revision: 1,
      default: true,
      capabilities: { sizes: ['9:16', '16:9', '1:1', '3:4', '4:3'], maxCount: 8, referenceImages: 4 },
      pricePerUnitCny: 0.2,
    },
    {
      modelKey: 'seedance-1.0',
      display: 'Seedance 1.0',
      kind: 'video',
      revision: 1,
      default: true,
      capabilities: { sizes: ['9:16', '16:9', '1:1'], durations: ['4', '5', '6', '8', '10'], referenceImages: 2 },
      pricePerSecondCny: 0.5,
    },
    {
      modelKey: 'cosyvoice-v1',
      display: 'CosyVoice v1',
      kind: 'audio',
      revision: 1,
      default: true,
      capabilities: { formats: ['mp3', 'wav'] },
      pricePerUnitCny: 0.05,
    },
  ];

  // 载入官方短剧分镜技能
  const skillRaw = fs.existsSync(REPO_SKILL_PATH)
    ? fs.readFileSync(REPO_SKILL_PATH, 'utf8')
    : FALLBACK_SHORT_DRAMA_SKILL_MD;
  const builtinSkill = parseSkillMarkdown(skillRaw, 'short-drama-storyboard', 'v2');
  skills.set(builtinSkill.pin.skillId, builtinSkill);

  function ensureCanvas(canvasId = defaultCanvasId, seed = null) {
    if (!canvases.has(canvasId)) {
      const initial = seed
        ? clone(seed)
        : {
            id: canvasId,
            title: `画布 ${canvasId}`,
            revision: 1,
            nodes: [],
            connections: [],
            timeline: null,
            updatedAt: new Date().toISOString(),
          };
      initial.id = canvasId;
      if (!Number.isSafeInteger(initial.revision)) initial.revision = 1;
      initial.nodes ||= [];
      initial.connections ||= [];
      if (initial.timeline === undefined) initial.timeline = null;
      canvases.set(canvasId, initial);
      canvasHistory.set(canvasId, [{ revision: initial.revision, reason: 'init', doc: clone(initial) }]);
    } else if (seed) {
      const doc = clone(seed);
      doc.id = canvasId;
      if (!Number.isSafeInteger(doc.revision)) doc.revision = 1;
      doc.nodes ||= [];
      doc.connections ||= [];
      if (doc.timeline === undefined) doc.timeline = null;
      canvases.set(canvasId, doc);
      canvasHistory.set(canvasId, [{ revision: doc.revision, reason: 'seed', doc: clone(doc) }]);
    }
    return canvases.get(canvasId);
  }

  ensureCanvas(defaultCanvasId, options.seed);

  function saveCanvas(canvasId, doc, expectedRevision, reason = 'op', turnId = '') {
    const current = canvases.get(canvasId);
    if (!current) throw notFound('canvas_not_found', `画布不存在: ${canvasId}`);
    if (expectedRevision !== undefined && expectedRevision !== null) {
      if (!Number.isSafeInteger(Number(expectedRevision)) || Number(expectedRevision) < 0) {
        throw invalidArg('invalid_params', 'expectedRevision 必须是非负整数');
      }
      if (Number(expectedRevision) !== current.revision) {
        counts.revisionConflicts += 1;
        throw conflict('revision_conflict', '画布已变化，请重新读取', { currentRevision: current.revision });
      }
    }
    doc.id = canvasId;
    doc.revision = current.revision + 1;
    doc.updatedAt = new Date().toISOString();
    canvases.set(canvasId, clone(doc));
    const list = canvasHistory.get(canvasId) || [];
    list.push({ revision: doc.revision, reason, turnId, doc: clone(doc) });
    canvasHistory.set(canvasId, list);
    return canvases.get(canvasId);
  }

  function buildDefaultMetadata(type, prompt = '') {
    switch (type) {
      case 'text':
        return { content: prompt, status: 'idle', fontSize: 14 };
      case 'markdown':
        return { content: prompt, status: 'idle' };
      case 'image':
        return { content: '', prompt, composerContent: prompt, status: 'idle', size: '9:16', count: 1 };
      case 'video':
        return { content: '', prompt, composerContent: prompt, status: 'idle', size: '9:16', seconds: '6' };
      case 'audio':
        return { content: '', prompt, composerContent: prompt, status: 'idle', audioFormat: 'mp3' };
      case 'frame':
        return { frame: { collapsed: false, expandedWidth: 760, expandedHeight: 520 } };
      case 'batch-table':
        return {
          status: 'idle',
          batchTable: {
            operation: 'try_on',
            concurrency: 10,
            referenceColumns: [
              { id: 'reference-1', label: '参考图 1' },
              { id: 'reference-2', label: '参考图 2' },
              { id: 'reference-3', label: '参考图 3' },
            ],
            rows: [],
          },
        };
      case 'script':
        return {
          status: 'idle',
          workflowKind: 'script',
          storyboard: {
            rows: [],
            visibleColumns: ['shotNumber', 'durationSeconds', 'videoMotionPrompt', 'dialogue', 'assets'],
            referenceNodeIds: [],
          },
        };
      default:
        return { content: prompt, status: 'idle' };
    }
  }

  function buildStoryboardRow(shotNumber, draft = {}) {
    rowSeq += 1;
    const row = {
      id: `shot-${rowSeq}`,
      shotNumber,
      durationSeconds: 6,
      plotDescription: '',
      dialogue: '',
      characters: [],
      narrativeIntent: '',
      viewerPOV: '',
      performanceBlocking: '',
      shotSize: '',
      emotion: '',
      lightingAndAtmosphere: '',
      audioEffects: '',
      camera: '',
      motion: '',
      timeBeats: '',
      imageGenerationPrompt: '',
      videoMotionPrompt: '',
      mustHave: [],
      optionalDetails: [],
      continuityOut: '',
      negativePrompt: '',
      assetBindings: [],
      status: 'idle',
    };
    applyStoryboardDraft(row, draft);
    return row;
  }

  function applyStoryboardDraft(row, draft = {}) {
    for (const key of STORYBOARD_ROW_FIELDS) {
      if (draft[key] === undefined || draft[key] === null) continue;
      if (key === 'durationSeconds') {
        const num = Number(draft[key]);
        if (!Number.isFinite(num) || num < 1 || num > 60) {
          throw invalidArg('invalid_params', '镜头时长必须为 1 至 60 秒');
        }
        row.durationSeconds = num;
      } else if (key === 'mustHave' || key === 'optionalDetails') {
        if (!Array.isArray(draft[key])) throw invalidArg('invalid_params', `${key} 必须是字符串数组`);
        row[key] = draft[key].map((v) => String(v));
      } else {
        row[key] = String(draft[key]);
      }
    }
  }

  function isStoryboardRowOutput(edge, scriptId, rowId) {
    if (!edge || edge.fromNodeId !== scriptId) return false;
    return edge.fromHandleId === `row:${rowId}` || (edge.relation === 'storyboard-output' && edge.storyboardRowId === rowId);
  }

  function bindStoryboardRowOutput(doc, scriptId, row, field, kind, targetId) {
    if (targetId !== '') {
      const target = (doc.nodes || []).find((n) => n.id === targetId);
      if (!target) {
        throw notFound('node_not_in_canvas', `${field} 指向的节点不在这个画布: ${targetId}`);
      }
      if (target.type !== kind) {
        throw invalidArg('node_kind_mismatch', `${field} 只能绑定 ${kind} 节点，${targetId} 是 ${target.type}`);
      }
      row[field] = targetId;
    } else {
      delete row[field];
    }
    const rowId = row.id;
    const connections = Array.isArray(doc.connections) ? doc.connections : [];
    const kept = [];
    const created = [];
    const deleted = [];
    let linked = false;
    for (const edge of connections) {
      if (isStoryboardRowOutput(edge, scriptId, rowId)) {
        const toNode = (doc.nodes || []).find((n) => n.id === edge.toNodeId);
        if (targetId !== '' && edge.toNodeId === targetId && !linked) {
          linked = true;
        } else if (toNode?.type === kind && toNode.metadata?.workflowKind !== 'action_board') {
          deleted.push(edge.id);
          continue;
        }
      }
      kept.push(edge);
    }
    if (targetId !== '' && !linked) {
      edgeSeq += 1;
      const edgeId = `edge-${edgeSeq}`;
      kept.push({
        id: edgeId,
        fromNodeId: scriptId,
        toNodeId: targetId,
        fromHandleId: `row:${rowId}`,
        relation: 'storyboard-output',
        storyboardRowId: rowId,
      });
      created.push(edgeId);
    }
    doc.connections = kept;
    return { created, deleted };
  }

  function resolveGenerationModel(kind, requestedModel = '') {
    const trimmed = String(requestedModel || '').trim();
    if (trimmed) {
      const exact = models.find((m) => m.modelKey === trimmed || m.display === trimmed);
      if (!exact) return { modelKey: '', display: '', revision: 1, kindMismatch: false };
      if (exact.kind !== kind) return { modelKey: exact.modelKey, display: exact.display, revision: exact.revision, kindMismatch: true };
      return { modelKey: exact.modelKey, display: exact.display, revision: exact.revision, kindMismatch: false };
    }
    const fallback = models.find((m) => m.kind === kind && m.default);
    if (!fallback) return { modelKey: '', display: '', revision: 1, kindMismatch: false };
    return { modelKey: fallback.modelKey, display: fallback.display, revision: fallback.revision, kindMismatch: false };
  }

  function beginTurn({
    turnId,
    canvasId = defaultCanvasId,
    permissionMode = 'canvas',
    selectedNodeIds = [],
    assetIds = [],
    canvasIds = [],
    skillPins = [],
    sessionId = '',
  } = {}) {
    const id = String(turnId || `turn-${turns.size + 1}`).trim();
    if (!id) throw invalidArg('invalid_turn_id', 'turnId 必填');
    if (!['read-only', 'canvas', 'full-access'].includes(permissionMode)) {
      throw invalidArg('invalid_permission_mode', '助手权限无效');
    }
    const doc = ensureCanvas(canvasId);
    const existing = turns.get(id);
    if (existing) {
      if (existing.canvasId !== canvasId || existing.permissionMode !== permissionMode) {
        throw conflict('turn_id_collision', '同一轮次标识已用于不同的范围或身份');
      }
      return existing;
    }
    const rec = {
      turnId: id,
      canvasId,
      permissionMode,
      open: true,
      undone: false,
      sessionId: sessionId || '',
      revisionBefore: doc.revision,
      snapshotBefore: clone(doc),
      selectedNodeIds: [...selectedNodeIds],
      referencedAssetIds: [...assetIds],
      referencedCanvasIds: [...canvasIds],
      skillPins: clone(skillPins),
      receipts: [],
      proposals: [],
      createdAt: new Date().toISOString(),
    };
    turns.set(id, rec);
    return rec;
  }

  function authorizeTurnForOp(turnId, descriptor, params) {
    if (!turnId) return null;
    let rec = turns.get(turnId);
    if (!rec && options.autoAuthorizeTurns !== false) {
      rec = beginTurn({ turnId, canvasId: params?.canvasId || defaultCanvasId, permissionMode: 'canvas' });
    }
    if (!rec || !rec.open || rec.undone) {
      counts.scopeDenied += 1;
      throw permissionDenied('turn_not_open', '助手当前回合未开启或已结束');
    }
    const mode = rec.permissionMode || 'canvas';
    if (mode === 'read-only' && (!descriptor.readOnly || descriptor.id === 'canvas.generation.propose')) {
      counts.scopeDenied += 1;
      throw permissionDenied('scope_denied', '本轮助手只能读取');
    }
    const targetCanvasId = params?.canvasId;
    if (targetCanvasId && descriptor.id !== 'canvas.search') {
      if (mode === 'canvas' && targetCanvasId !== rec.canvasId) {
        const canReadRef = descriptor.readOnly && descriptor.id === 'canvas.get' && rec.referencedCanvasIds.includes(targetCanvasId);
        if (!canReadRef) {
          counts.scopeDenied += 1;
          throw permissionDenied('scope_denied', `画布参数与当前会话不一致（${targetCanvasId} ≠ ${rec.canvasId}）`);
        }
      }
    }
    return rec;
  }

  function executeOp(opIdName, rawParams = {}, opKey = '', turnId = '') {
    const descriptor = descriptorMap.get(opIdName);
    if (!descriptor) {
      throw notFound('unknown_operation', `未知操作: ${opIdName}`);
    }
    counts.ops[opIdName] = (counts.ops[opIdName] || 0) + 1;
    if (descriptor.readOnly) counts.ReadOps += 1;
    else counts.WriteOps += 1;

    const turnRec = authorizeTurnForOp(turnId, descriptor, rawParams);

    const payloadDigest = sha256Hex(JSON.stringify({ op: opIdName, params: rawParams }));
    if (!descriptor.readOnly && opKey) {
      const prior = opReceipts.get(opKey);
      if (prior) {
        if (prior.digest !== payloadDigest) {
          throw conflict('operation_id_reused_with_different_payload', '工具调用标识对应的操作已经改变');
        }
        opLog.push({ op: opIdName, opId: opKey, params: clone(rawParams), turnId, status: 'replayed', replayed: true, at: new Date().toISOString() });
        return { op: opIdName, replayed: true, result: clone(prior.result) };
      }
    }

    let result;
    switch (opIdName) {
      case 'canvas.get': {
        const canvasId = String(rawParams.canvasId || '').trim();
        if (!canvasId) throw invalidArg('invalid_params', 'canvasId 必填');
        const doc = canvases.get(canvasId);
        if (!doc) throw notFound('canvas_not_found', `画布不存在: ${canvasId}`);
        result = { canvasId, canvas: clone(doc) };
        break;
      }
      case 'canvas.search': {
        const query = String(rawParams.query || '').trim().toLowerCase();
        const page = Math.max(1, Number(rawParams.page || 1));
        const pageSize = Math.min(100, Math.max(1, Number(rawParams.pageSize || 20)));
        const all = [...canvases.values()].filter((c) => !query || String(c.title || '').toLowerCase().includes(query) || c.id.toLowerCase().includes(query));
        const items = all.slice((page - 1) * pageSize, page * pageSize).map((c) => ({
          id: c.id, title: c.title, revision: c.revision, nodeCount: (c.nodes || []).length, updatedAt: c.updatedAt,
        }));
        result = { items, total: all.length, page, pageSize };
        break;
      }
      case 'canvas.nodes.create': {
        const canvasId = String(rawParams.canvasId || '').trim();
        const expectedRevision = Number(rawParams.expectedRevision);
        const drafts = Array.isArray(rawParams.nodes) ? rawParams.nodes : [];
        if (!canvasId) throw invalidArg('invalid_params', 'canvasId 必填');
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0) {
          throw invalidArg('invalid_params', '写操作必须带上读取时的 expectedRevision');
        }
        if (drafts.length === 0 || drafts.length > 8) {
          throw invalidArg('invalid_batch', 'nodes 必须是 1..8 项的数组');
        }
        const doc = clone(ensureCanvas(canvasId));
        if (doc.revision !== expectedRevision) {
          counts.revisionConflicts += 1;
          throw conflict('revision_conflict', '画布已变化，请重新读取', { currentRevision: doc.revision });
        }
        const existingTitles = new Set((doc.nodes || []).map((n) => String(n.title || '').trim()).filter(Boolean));
        const batchTitles = new Set();
        for (const draft of drafts) {
          const title = String(draft?.title || '').trim();
          const type = String(draft?.type || '').trim();
          if (!title) throw invalidArg('invalid_params', '每个节点都需要标题');
          if (batchTitles.has(title)) {
            counts.duplicateNodeAttempts += 1;
            throw invalidArg('duplicate_node_title', `同一批次内标题重复: ${title}`);
          }
          batchTitles.add(title);
          if (existingTitles.has(title)) {
            counts.duplicateNodeAttempts += 1;
            throw conflict('duplicate_node_title', `标题已存在: ${title}`);
          }
          if (!NODE_CAPABILITIES[type]) {
            throw invalidArg('unsupported_node_type', `不支持的节点类型: ${type}`);
          }
        }
        let cursorX = 120;
        for (const node of doc.nodes || []) {
          const x = Number(node.position?.x || 0);
          const w = Number(node.width || NODE_CAPABILITIES[node.type]?.defaultWidth || 320);
          if (x + w + 60 > cursorX) cursorX = x + w + 60;
        }
        const created = [];
        for (const draft of drafts) {
          nodeSeq += 1;
          const id = `node-${nodeSeq}`;
          const cap = NODE_CAPABILITIES[draft.type];
          const prompt = String(draft.prompt || '');
          const normTitle = `${canvasId}::${String(draft.title).trim()}`;
          counts.createdNodeTitles[normTitle] = (counts.createdNodeTitles[normTitle] || 0) + 1;
          doc.nodes.push({
            id,
            type: draft.type,
            title: draft.title,
            position: { x: cursorX, y: 160 },
            width: cap.defaultWidth,
            height: cap.defaultHeight,
            metadata: buildDefaultMetadata(draft.type, prompt),
          });
          created.push({ id, title: draft.title, type: draft.type });
          cursorX += cap.defaultWidth + 60;
        }
        const saved = saveCanvas(canvasId, doc, expectedRevision, 'canvas.nodes.create', turnId);
        result = { canvasId, revision: saved.revision, created };
        break;
      }
      case 'canvas.node.update': {
        const canvasId = String(rawParams.canvasId || '').trim();
        const nodeId = String(rawParams.nodeId || '').trim();
        const expectedRevision = Number(rawParams.expectedRevision);
        const patch = rawParams.patch;
        if (!canvasId || !nodeId) throw invalidArg('invalid_params', 'canvasId 与 nodeId 必填');
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0) {
          throw invalidArg('invalid_params', '写操作必须带上读取时的 expectedRevision');
        }
        if (!patch || typeof patch !== 'object' || Object.keys(patch).length === 0) {
          throw invalidArg('empty_patch', 'patch 至少要有一个字段');
        }
        const doc = clone(ensureCanvas(canvasId));
        if (doc.revision !== expectedRevision) {
          counts.revisionConflicts += 1;
          throw conflict('revision_conflict', '画布已变化，请重新读取', { currentRevision: doc.revision });
        }
        const node = (doc.nodes || []).find((n) => n.id === nodeId);
        if (!node) throw notFound('node_not_found', `目标节点不存在: ${nodeId}`);
        const cap = NODE_CAPABILITIES[node.type] || NODE_CAPABILITIES.text;
        node.metadata ||= {};
        for (const [k, v] of Object.entries(patch)) {
          if (k === 'title') {
            if (typeof v !== 'string') throw invalidArg('invalid_params', 'title 必须是字符串');
            node.title = v;
          } else if (k === 'prompt') {
            if (typeof v !== 'string') throw invalidArg('invalid_params', 'prompt 必须是字符串');
            node.metadata.prompt = v;
          } else if (k === 'content') {
            if (!cap.patchFields.has('content')) {
              throw invalidArg('unsupported_field', `${node.type} 节点不支持更新字段 content`);
            }
            if (typeof v !== 'string') throw invalidArg('invalid_params', 'content 必须是字符串');
            if (['image', 'video', 'audio'].includes(node.type)) {
              node.metadata.composerContent = v;
              node.metadata.prompt = v;
            } else {
              node.metadata.content = v;
            }
          } else {
            throw invalidArg('unsupported_field', `${node.type} 节点不支持更新字段 ${k}`);
          }
        }
        const saved = saveCanvas(canvasId, doc, expectedRevision, 'canvas.node.update', turnId);
        result = { canvasId, nodeId, revision: saved.revision, node: clone(node) };
        break;
      }
      case 'canvas.node.configure': {
        const canvasId = String(rawParams.canvasId || '').trim();
        const nodeId = String(rawParams.nodeId || '').trim();
        const kind = String(rawParams.kind || '').trim();
        const expectedRevision = Number(rawParams.expectedRevision);
        const patch = rawParams.patch;
        if (!canvasId || !nodeId || !kind || !Number.isSafeInteger(expectedRevision) || expectedRevision <= 0 || !patch || typeof patch !== 'object' || Object.keys(patch).length === 0) {
          throw invalidArg('invalid_params', '需要画布、节点、类型、当前版本和参数');
        }
        if (!['image', 'video', 'audio'].includes(kind)) {
          throw invalidArg('unsupported_node_kind', '仅媒体生成节点支持参数配置');
        }
        const doc = clone(ensureCanvas(canvasId));
        if (doc.revision !== expectedRevision) {
          counts.revisionConflicts += 1;
          throw conflict('revision_conflict', '画布已变化，请重新读取', { currentRevision: doc.revision });
        }
        const node = (doc.nodes || []).find((n) => n.id === nodeId);
        if (!node) throw notFound('node_not_found', '节点不在当前画布');
        if (node.type !== kind) throw invalidArg('node_kind_mismatch', '参数类型与目标节点不一致');
        const cap = NODE_CAPABILITIES[kind];
        node.metadata ||= {};
        for (const [name, val] of Object.entries(patch)) {
          if (!cap.patchFields.has(name) || name === 'title' || name === 'content') {
            throw invalidArg('unsupported_field', `该类型不支持参数 ${name}`);
          }
          if (name === 'count') {
            const count = Number(val);
            if (!Number.isSafeInteger(count) || count < 1 || count > 8) {
              throw invalidArg('invalid_parameter', 'count 必须是 1..8 的整数');
            }
            node.metadata.count = count;
            continue;
          }
          if (typeof val !== 'string' || !val.trim()) {
            throw invalidArg('invalid_parameter', `${name} 必须是有效字符串`);
          }
          if (name === 'model') {
            const choice = resolveGenerationModel(kind, val);
            if (choice.kindMismatch) throw invalidArg('generation_model_kind_mismatch', '所选模型不支持该媒体类型');
            if (!choice.modelKey) throw preconditionFailed('generation_model_unavailable', '所选模型当前不可用');
            node.metadata.model = choice.modelKey;
            continue;
          }
          node.metadata[name] = val;
        }
        const saved = saveCanvas(canvasId, doc, expectedRevision, 'canvas.node.configure', turnId);
        result = { canvasId, nodeId, revision: saved.revision, node: clone(node), draftConfigured: true };
        break;
      }
      case 'canvas.node.move': {
        const canvasId = String(rawParams.canvasId || '').trim();
        const nodeId = String(rawParams.nodeId || '').trim();
        const expectedRevision = Number(rawParams.expectedRevision);
        const pos = rawParams.position;
        if (!canvasId || !nodeId || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
          throw invalidArg('invalid_params', 'canvasId、nodeId 和有效 expectedRevision 必填');
        }
        if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number' || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
          throw invalidArg('invalid_position', 'position.x 和 position.y 必须是有效坐标');
        }
        const doc = clone(ensureCanvas(canvasId));
        if (doc.revision !== expectedRevision) {
          counts.revisionConflicts += 1;
          throw conflict('revision_conflict', '画布已变化，请重新读取', { currentRevision: doc.revision });
        }
        const node = (doc.nodes || []).find((n) => n.id === nodeId);
        if (!node) throw notFound('node_not_in_canvas', '节点不属于这个画布');
        node.position = { x: pos.x, y: pos.y };
        const saved = saveCanvas(canvasId, doc, expectedRevision, 'canvas.node.move', turnId);
        result = { canvasId, nodeId, revision: saved.revision };
        break;
      }
      case 'canvas.node.delete': {
        const canvasId = String(rawParams.canvasId || '').trim();
        const nodeId = String(rawParams.nodeId || '').trim();
        const expectedRevision = Number(rawParams.expectedRevision);
        if (!canvasId || !nodeId || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
          throw invalidArg('invalid_params', 'canvasId、nodeId 和有效 expectedRevision 必填');
        }
        const doc = clone(ensureCanvas(canvasId));
        if (doc.revision !== expectedRevision) {
          counts.revisionConflicts += 1;
          throw conflict('revision_conflict', '画布已变化，请重新读取', { currentRevision: doc.revision });
        }
        const idx = (doc.nodes || []).findIndex((n) => n.id === nodeId);
        if (idx < 0) throw notFound('node_not_in_canvas', '节点不属于这个画布');
        doc.nodes.splice(idx, 1);
        const deletedEdgeIds = [];
        doc.connections = (doc.connections || []).filter((edge) => {
          if (edge.fromNodeId === nodeId || edge.toNodeId === nodeId) {
            deletedEdgeIds.push(edge.id);
            return false;
          }
          return true;
        });
        const saved = saveCanvas(canvasId, doc, expectedRevision, 'canvas.node.delete', turnId);
        result = { canvasId, revision: saved.revision, deletedNodeIds: [nodeId], deletedEdgeIds };
        break;
      }
      case 'canvas.node.bind_asset': {
        const canvasId = String(rawParams.canvasId || '').trim();
        const nodeId = String(rawParams.nodeId || '').trim();
        const assetId = String(rawParams.assetId || '').trim();
        let resourceId = String(rawParams.resourceId || '').trim();
        const expectedRevision = Number(rawParams.expectedRevision);
        if (!canvasId || !nodeId || !assetId || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
          throw invalidArg('invalid_params', '画布、节点、素材和当前版本必填');
        }
        const asset = assets.get(assetId);
        if (!asset) throw notFound('asset_not_found', '素材不存在');
        if (!resourceId) resourceId = asset.resourceId;
        const resource = resources.get(resourceId);
        if (!resource) throw notFound('resource_not_found', '素材资源不存在');
        const doc = clone(ensureCanvas(canvasId));
        if (doc.revision !== expectedRevision) {
          counts.revisionConflicts += 1;
          throw conflict('revision_conflict', '画布已变化，请重新读取', { currentRevision: doc.revision });
        }
        const node = (doc.nodes || []).find((n) => n.id === nodeId);
        if (!node) throw notFound('node_not_found', '节点不属于指定画布');
        if (node.type !== asset.kind) throw invalidArg('node_kind_mismatch', '素材与参考节点类型不一致');
        node.metadata ||= {};
        if (node.metadata.taskId) throw preconditionFailed('node_has_task', '请使用独立参考节点，不覆盖已有任务节点');
        Object.assign(node.metadata, {
          assetId: asset.id,
          resourceId: resource.id,
          storageKey: `resource:${resource.id}`,
          content: `/api/resources/${resource.id}/file`,
          nodeRole: 'result',
          resultOrigin: 'library',
          status: 'success',
          mimeType: resource.mimeType,
          bytes: resource.size,
          width: resource.width,
          height: resource.height,
        });
        const saved = saveCanvas(canvasId, doc, expectedRevision, 'canvas.node.bind_asset', turnId);
        result = { canvasId, nodeId, assetId: asset.id, resourceId: resource.id, node: clone(node), revision: saved.revision, referenceBound: true };
        break;
      }
      case 'canvas.edge.create': {
        const canvasId = String(rawParams.canvasId || '').trim();
        const fromNodeId = String(rawParams.fromNodeId || '').trim();
        const toNodeId = String(rawParams.toNodeId || '').trim();
        const expectedRevision = Number(rawParams.expectedRevision);
        if (!canvasId || !fromNodeId || !toNodeId) {
          throw invalidArg('invalid_params', 'canvasId、fromNodeId、toNodeId 必填');
        }
        if (fromNodeId === toNodeId) throw invalidArg('self_loop', '不能把节点连接到自身');
        const doc = clone(ensureCanvas(canvasId));
        if (doc.revision !== expectedRevision) {
          counts.revisionConflicts += 1;
          throw conflict('revision_conflict', '画布已变化，请重新读取', { currentRevision: doc.revision });
        }
        const fromNode = (doc.nodes || []).find((n) => n.id === fromNodeId);
        if (!fromNode) throw notFound('node_not_found', `起点节点不存在: ${fromNodeId}`);
        const toNode = (doc.nodes || []).find((n) => n.id === toNodeId);
        if (!toNode) throw notFound('node_not_found', `终点节点不存在: ${toNodeId}`);
        const fromCap = NODE_CAPABILITIES[fromNode.type];
        const toCap = NODE_CAPABILITIES[toNode.type];
        if (!fromCap?.canSource || !toCap?.canTarget || !toCap.acceptedInputKinds.includes(fromCap.inputKind)) {
          throw invalidArg('invalid_connection', `不支持从 ${fromNode.type} 连接到 ${toNode.type}`);
        }
        const existingEdge = (doc.connections || []).find((e) => e.fromNodeId === fromNodeId && e.toNodeId === toNodeId);
        if (existingEdge) {
          result = { canvasId, duplicate: true, revision: doc.revision, edgeId: existingEdge.id, created: false };
          break;
        }
        edgeSeq += 1;
        const edgeId = `edge-${edgeSeq}`;
        doc.connections.push({ id: edgeId, fromNodeId, toNodeId });
        const saved = saveCanvas(canvasId, doc, expectedRevision, 'canvas.edge.create', turnId);
        result = { canvasId, duplicate: false, revision: saved.revision, edgeId, created: true };
        break;
      }
      case 'canvas.edge.delete': {
        const canvasId = String(rawParams.canvasId || '').trim();
        const edgeId = String(rawParams.edgeId || '').trim();
        const expectedRevision = Number(rawParams.expectedRevision);
        if (!canvasId || !edgeId || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
          throw invalidArg('invalid_params', 'canvasId、edgeId 和有效 expectedRevision 必填');
        }
        const doc = clone(ensureCanvas(canvasId));
        if (doc.revision !== expectedRevision) {
          counts.revisionConflicts += 1;
          throw conflict('revision_conflict', '画布已变化，请重新读取', { currentRevision: doc.revision });
        }
        const idx = (doc.connections || []).findIndex((e) => e.id === edgeId);
        if (idx < 0) throw notFound('edge_not_found', '连接不属于这个画布');
        doc.connections.splice(idx, 1);
        const saved = saveCanvas(canvasId, doc, expectedRevision, 'canvas.edge.delete', turnId);
        result = { canvasId, revision: saved.revision, deletedEdgeIds: [edgeId] };
        break;
      }
      case 'canvas.script.rows.append': {
        const canvasId = String(rawParams.canvasId || '').trim();
        const nodeId = String(rawParams.nodeId || '').trim();
        const expectedRevision = Number(rawParams.expectedRevision);
        const drafts = Array.isArray(rawParams.rows) ? rawParams.rows : [];
        if (!canvasId || !nodeId) throw invalidArg('invalid_params', 'canvasId 与 nodeId 必填');
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0) {
          throw invalidArg('invalid_params', '写操作必须带上读取时的 expectedRevision');
        }
        if (drafts.length === 0 || drafts.length > 32) {
          throw invalidArg('invalid_batch', 'rows 必须是 1..32 项的数组');
        }
        for (const d of drafts) {
          if (d && ('imageNodeId' in d || 'videoNodeId' in d)) {
            throw invalidArg('invalid_params', 'append 不接受产出节点绑定，请用 canvas.script.row.update');
          }
        }
        const doc = clone(ensureCanvas(canvasId));
        if (doc.revision !== expectedRevision) {
          counts.revisionConflicts += 1;
          throw conflict('revision_conflict', '画布已变化，请重新读取', { currentRevision: doc.revision });
        }
        const node = (doc.nodes || []).find((n) => n.id === nodeId);
        if (!node) throw notFound('node_not_found', `目标节点不存在: ${nodeId}`);
        if (node.type !== 'script') {
          throw invalidArg('node_kind_mismatch', `分镜行操作只接受 script 节点，目标节点类型是 ${node.type}`);
        }
        node.metadata ||= {};
        node.metadata.storyboard ||= {
          rows: [],
          referenceNodeIds: [],
          visibleColumns: ['shotNumber', 'durationSeconds', 'videoMotionPrompt', 'dialogue', 'assets'],
        };
        const rows = node.metadata.storyboard.rows;
        const created = [];
        for (const draft of drafts) {
          const shotNumber = rows.length + 1;
          const row = buildStoryboardRow(shotNumber, draft);
          rows.push(row);
          created.push({ id: row.id, shotNumber });
        }
        const saved = saveCanvas(canvasId, doc, expectedRevision, 'canvas.script.rows.append', turnId);
        result = { canvasId, nodeId, revision: saved.revision, created, rowCount: rows.length };
        break;
      }
      case 'canvas.script.row.update': {
        const canvasId = String(rawParams.canvasId || '').trim();
        const nodeId = String(rawParams.nodeId || '').trim();
        const expectedRevision = Number(rawParams.expectedRevision);
        const patches = Array.isArray(rawParams.patches) ? rawParams.patches : [];
        if (!canvasId || !nodeId) throw invalidArg('invalid_params', 'canvasId 与 nodeId 必填');
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0) {
          throw invalidArg('invalid_params', '写操作必须带上读取时的 expectedRevision');
        }
        if (patches.length === 0 || patches.length > 32) {
          throw invalidArg('invalid_batch', 'patches 必须是 1..32 项的数组');
        }
        const doc = clone(ensureCanvas(canvasId));
        if (doc.revision !== expectedRevision) {
          counts.revisionConflicts += 1;
          throw conflict('revision_conflict', '画布已变化，请重新读取', { currentRevision: doc.revision });
        }
        const node = (doc.nodes || []).find((n) => n.id === nodeId);
        if (!node) throw notFound('node_not_found', `目标节点不存在: ${nodeId}`);
        if (node.type !== 'script') {
          throw invalidArg('node_kind_mismatch', `分镜行操作只接受 script 节点，目标节点类型是 ${node.type}`);
        }
        const rows = node.metadata?.storyboard?.rows || [];
        const seenRows = new Set();
        const updated = [];
        const createdEdgeIds = [];
        const deletedEdgeIds = [];
        for (const patch of patches) {
          const rowId = String(patch?.rowId || '').trim();
          if (!rowId) throw invalidArg('invalid_params', '每个 patch 都需要 rowId');
          if (seenRows.has(rowId)) throw invalidArg('duplicate_row_patch', `同一批次内行重复: ${rowId}`);
          seenRows.add(rowId);
          const keys = Object.keys(patch).filter((k) => k !== 'rowId' && patch[k] !== undefined);
          if (keys.length === 0) throw invalidArg('empty_patch', `patch 至少要有一个字段: ${rowId}`);
          const row = rows.find((r) => r.id === rowId);
          if (!row) throw notFound('row_not_found', `分镜行不存在: ${rowId}`);
          applyStoryboardDraft(row, patch);
          if (patch.imageNodeId !== undefined) {
            const { created, deleted } = bindStoryboardRowOutput(doc, nodeId, row, 'imageNodeId', 'image', String(patch.imageNodeId));
            createdEdgeIds.push(...created);
            deletedEdgeIds.push(...deleted);
          }
          if (patch.videoNodeId !== undefined) {
            const { created, deleted } = bindStoryboardRowOutput(doc, nodeId, row, 'videoNodeId', 'video', String(patch.videoNodeId));
            createdEdgeIds.push(...created);
            deletedEdgeIds.push(...deleted);
          }
          updated.push({ id: row.id, shotNumber: row.shotNumber });
        }
        const saved = saveCanvas(canvasId, doc, expectedRevision, 'canvas.script.row.update', turnId);
        result = {
          canvasId,
          nodeId,
          revision: saved.revision,
          updated,
          rowCount: rows.length,
          createdEdgeIds,
          deletedEdgeIds,
        };
        break;
      }
      case 'canvas.script.row.remove': {
        const canvasId = String(rawParams.canvasId || '').trim();
        const nodeId = String(rawParams.nodeId || '').trim();
        const expectedRevision = Number(rawParams.expectedRevision);
        const rowIds = Array.isArray(rawParams.rowIds) ? rawParams.rowIds : [];
        if (!canvasId || !nodeId) throw invalidArg('invalid_params', 'canvasId 与 nodeId 必填');
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0) {
          throw invalidArg('invalid_params', '写操作必须带上读取时的 expectedRevision');
        }
        if (rowIds.length === 0 || rowIds.length > 32) {
          throw invalidArg('invalid_batch', 'rowIds 必须是 1..32 项的数组');
        }
        const doc = clone(ensureCanvas(canvasId));
        if (doc.revision !== expectedRevision) {
          counts.revisionConflicts += 1;
          throw conflict('revision_conflict', '画布已变化，请重新读取', { currentRevision: doc.revision });
        }
        const node = (doc.nodes || []).find((n) => n.id === nodeId);
        if (!node || node.type !== 'script') throw notFound('node_not_found', `分镜节点不存在: ${nodeId}`);
        const rows = node.metadata?.storyboard?.rows || [];
        const removeSet = new Set();
        for (const id of rowIds) {
          if (removeSet.has(id)) throw invalidArg('duplicate_row_id', `同一批次内行重复: ${id}`);
          if (!rows.some((r) => r.id === id)) throw notFound('row_not_found', `分镜行不存在: ${id}`);
          removeSet.add(id);
        }
        const kept = rows.filter((r) => !removeSet.has(r.id));
        kept.forEach((r, idx) => { r.shotNumber = idx + 1; });
        node.metadata.storyboard.rows = kept;
        const deletedEdgeIds = [];
        doc.connections = (doc.connections || []).filter((edge) => {
          const isRemovedRowEdge = [...removeSet].some((rowId) => isStoryboardRowOutput(edge, nodeId, rowId) || edge.storyboardRowId === rowId);
          if (isRemovedRowEdge) {
            deletedEdgeIds.push(edge.id);
            return false;
          }
          return true;
        });
        const saved = saveCanvas(canvasId, doc, expectedRevision, 'canvas.script.row.remove', turnId);
        result = { canvasId, nodeId, revision: saved.revision, removed: rowIds.length, rowCount: kept.length, deletedEdgeIds };
        break;
      }
      case 'canvas.generation.propose': {
        const canvasId = String(rawParams.canvasId || '').trim();
        const kind = String(rawParams.kind || '').trim();
        const nodeIds = Array.isArray(rawParams.nodeIds) ? rawParams.nodeIds : [];
        const note = String(rawParams.note || '').trim();
        if (!canvasId) throw invalidArg('invalid_params', 'canvasId 必填');
        if (kind !== 'image' && kind !== 'video') throw invalidArg('invalid_kind', 'kind 只能是 image 或 video');
        if (nodeIds.length === 0 || nodeIds.length > 8) throw invalidArg('invalid_batch', 'nodeIds 必须是 1..8 项的数组');
        const doc = ensureCanvas(canvasId);
        const deduped = [];
        const seen = new Set();
        for (const id of nodeIds) {
          const node = (doc.nodes || []).find((n) => n.id === id);
          if (!node) throw invalidArg('node_not_in_canvas', `节点不属于当前画布: ${id}`);
          if (node.type !== kind) throw invalidArg('generation_kind_mismatch', `这个节点不能用来生成${kind === 'video' ? '视频' : '图片'}`);
          if (!seen.has(id)) {
            seen.add(id);
            deduped.push(id);
          }
        }
        const choice = resolveGenerationModel(kind, '');
        proposalSeq += 1;
        const proposalId = `gp-${proposalSeq}`;
        counts.proposedNodePrompts ||= {};
        for (const id of deduped) {
          const prevCount = counts.proposedNodes[id] || 0;
          counts.proposedNodes[id] = prevCount + 1;
          const node = (doc.nodes || []).find((n) => n.id === id);
          const promptKey = `${id}::${String(node?.metadata?.composerContent || node?.metadata?.prompt || '').trim()}`;
          const prevSamePrompt = counts.proposedNodePrompts[promptKey] || 0;
          counts.proposedNodePrompts[promptKey] = prevSamePrompt + 1;
          if (prevSamePrompt > 0 && node?.metadata?.status !== 'failed') {
            counts.duplicateProposals += 1;
          }
        }
        const proposal = {
          proposalId,
          turnId: turnId || '',
          canvasId,
          kind,
          nodeIds: deduped,
          model: choice.display,
          modelKey: choice.modelKey,
          note,
          confirmed: false,
          taskIds: [],
          source: {
            canvasId,
            canvasRevision: doc.revision,
            modelConfigRevision: choice.revision,
          },
          createdAt: new Date().toISOString(),
        };
        proposals.set(proposalId, proposal);
        if (turnRec) turnRec.proposals.push(proposalId);
        result = {
          proposalId,
          kind,
          nodeIds: deduped,
          model: choice.display,
          modelKey: choice.modelKey,
          note,
          source: proposal.source,
        };
        break;
      }
      case 'canvas.task.bind': {
        const canvasId = String(rawParams.canvasId || '').trim();
        const taskId = String(rawParams.taskId || '').trim();
        const nodeId = String(rawParams.nodeId || '').trim();
        const outputIndex = Number(rawParams.outputIndex ?? 0);
        if (!canvasId || !taskId || !nodeId) throw invalidArg('invalid_params', 'canvasId、taskId、nodeId 必填');
        const task = tasks.get(taskId);
        if (!task) throw notFound('task_not_found', '任务不存在');
        if (task.status !== 'succeeded') throw preconditionFailed('task_not_ready', '任务尚未完成交付');
        const output = (task.outputs || [])[outputIndex] || task.outputs?.[0];
        if (!output) throw notFound('task_output_not_found', '任务产物不存在');
        const doc = clone(ensureCanvas(canvasId));
        const node = (doc.nodes || []).find((n) => n.id === nodeId);
        if (!node) throw notFound('node_not_in_canvas', '节点不属于当前画布');
        node.metadata ||= {};
        const alreadyBound = node.metadata.taskId === taskId && node.metadata.resourceId === output.resourceId;
        Object.assign(node.metadata, {
          taskId,
          taskStatus: 'succeeded',
          taskProgress: 100,
          status: 'success',
          assetId: output.assetId,
          resourceId: output.resourceId,
          storageKey: output.storageKey,
          content: `/api/resources/${output.resourceId}/file`,
          mimeType: output.mimeType,
        });
        const saved = alreadyBound ? doc : saveCanvas(canvasId, doc, doc.revision, 'canvas.task.bind', turnId);
        result = {
          applied: !alreadyBound,
          alreadyBound,
          canvasId,
          nodeId,
          taskId,
          outputIndex,
          revision: saved.revision,
          node: clone(node),
          bindingStatus: 'bound',
          content: node.metadata.content,
          storageKey: node.metadata.storageKey,
          assetId: node.metadata.assetId,
        };
        break;
      }
      case 'task.get': {
        const taskId = String(rawParams.taskId || '').trim();
        if (!taskId) throw invalidArg('invalid_params', 'taskId 必填');
        const task = tasks.get(taskId);
        if (!task) throw notFound('task_not_found', '任务不存在');
        result = {
          taskId: task.id,
          type: task.type,
          status: task.status,
          progress: task.progress,
          outputs: clone(task.outputs || []),
          resultState: task.resultState || task.status,
          error: task.error || null,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
        };
        break;
      }
      case 'model.catalog': {
        result = { models: clone(models), revision: 1 };
        break;
      }
      case 'skill.catalog': {
        const idFilter = String(rawParams.id || '').trim();
        const qFilter = String(rawParams.q || '').trim().toLowerCase();
        const offset = Math.max(0, Number(rawParams.offset || 0));
        const limit = Math.min(50, Math.max(1, Number(rawParams.limit || 50)));
        const allItems = [...skills.values()]
          .filter((s) => (!idFilter || s.pin.skillId === idFilter) && (!qFilter || `${s.name}\n${s.description}`.toLowerCase().includes(qFilter)))
          .map((s) => ({
            pin: clone(s.pin),
            name: s.name,
            version: s.version,
            description: s.description,
          }));
        result = {
          skills: allItems.slice(offset, offset + limit),
          total: allItems.length,
          offset,
          limit,
        };
        break;
      }
      case 'skill.get': {
        if (rawParams.path) throw invalidArg('unexpected_path', '正文读取不接收文件路径');
        const skill = skills.get(String(rawParams.skillId || ''));
        if (!skill || skill.pin.versionId !== rawParams.versionId || skill.pin.contentHash !== rawParams.contentHash) {
          throw notFound('skill_version_unavailable', '技能版本不存在或已失效');
        }
        result = clone(skill);
        break;
      }
      case 'skill.file': {
        const filePath = String(rawParams.path || '').trim();
        if (!filePath) throw invalidArg('skill_path_required', '辅助文件读取需要包内路径');
        const skill = skills.get(String(rawParams.skillId || ''));
        if (!skill || skill.pin.versionId !== rawParams.versionId || skill.pin.contentHash !== rawParams.contentHash) {
          throw notFound('skill_version_unavailable', '技能版本不存在或已失效');
        }
        const file = (skill.files || []).find((f) => f.path === filePath);
        if (!file) throw notFound('skill_file_unavailable', `技能文件不存在: ${filePath}`);
        result = {
          pin: clone(skill.pin),
          file: { path: file.path, size: Buffer.byteLength(file.content || '', 'utf8') },
          content: file.content || '',
          executionSupported: false,
        };
        break;
      }
      case 'asset.list':
      case 'project.media.search':
      case 'project.canvas.search': {
        const page = Math.max(1, Number(rawParams.page || 1));
        const pageSize = Math.min(100, Math.max(1, Number(rawParams.pageSize || 40)));
        const kind = String(rawParams.kind || '').trim();
        const query = String(rawParams.query || '').trim().toLowerCase();
        const all = [...assets.values()].filter(
          (a) => (!kind || a.kind === kind) && (!query || String(a.name || '').toLowerCase().includes(query)),
        );
        result = {
          items: clone(all.slice((page - 1) * pageSize, page * pageSize)),
          total: all.length,
          page,
          pageSize,
        };
        break;
      }
      case 'asset.get': {
        const assetId = String(rawParams.assetId || '').trim();
        if (!assetId) throw invalidArg('invalid_params', 'assetId 必填');
        const asset = assets.get(assetId);
        if (!asset) throw notFound('asset_not_found', '素材不存在');
        result = { assetId, asset: clone(asset) };
        break;
      }
      case 'media.overview':
      case 'media.inspect':
      case 'media.check': {
        const canvasId = String(rawParams.canvasId || '').trim();
        const nodeId = String(rawParams.nodeId || '').trim();
        const assetId = String(rawParams.assetId || '').trim();
        if (!canvasId || (!nodeId && !assetId)) {
          throw invalidArg('invalid_media_target', '指定 canvasId 和一个 nodeId 或 assetId');
        }
        const doc = ensureCanvas(canvasId);
        let resourceId = String(rawParams.resourceId || '').trim();
        let promptText = '';
        let defectNote = '';
        let mediaKind = 'image';
        let durationMs = 6000;
        if (nodeId) {
          const node = (doc.nodes || []).find((n) => n.id === nodeId);
          if (!node) throw permissionDenied('node_not_in_canvas', '节点不属于指定画布');
          mediaKind = node.type === 'video' ? 'video' : node.type === 'audio' ? 'audio' : 'image';
          resourceId = resourceId || node.metadata?.resourceId || '';
          promptText = node.metadata?.composerContent || node.metadata?.prompt || '';
          defectNote = node.metadata?.reviewNote || '';
          durationMs = Number(node.metadata?.durationMs || (Number(node.metadata?.seconds || 6) * 1000));
        } else if (assetId) {
          const asset = assets.get(assetId);
          if (!asset) throw notFound('asset_not_found', '素材不存在');
          mediaKind = asset.kind || 'image';
          resourceId = resourceId || asset.resourceId || '';
          promptText = asset.prompt || '';
          defectNote = asset.reviewNote || '';
        }
        if (!resourceId) {
          throw notFound('media_not_found', '目标节点尚未生成或绑定媒体资源');
        }
        const resource = resources.get(resourceId);
        if (resource) {
          promptText = resource.prompt || promptText;
          defectNote = resource.reviewNote || defectNote;
          durationMs = resource.durationMs || durationMs;
        }
        counts.mediaInspections += 1;
        const source = {
          canvasId,
          ...(nodeId ? { nodeId } : { assetId }),
          resourceId,
          version: resource?.version || 'v1',
          startMs: Number(rawParams.startMs || 0),
          endMs: Number(rawParams.endMs || durationMs),
        };
        const noteParts = [`占位媒体提示词: ${promptText || '无'}`];
        if (defectNote) noteParts.push(`画面检查结果: ${defectNote}`);
        const content = [];
        if (opIdName === 'media.inspect') {
          content.push({
            type: 'image',
            mimeType: 'image/png',
            data: DETERMINISTIC_PNG_BASE64,
            sha256: DETERMINISTIC_PNG_SHA256,
            source,
          });
        }
        result = {
          source,
          durationMs,
          hasVideo: mediaKind === 'video' || mediaKind === 'image',
          hasAudio: mediaKind === 'video' || mediaKind === 'audio',
          content,
          note: noteParts.join('；'),
          ...(opIdName === 'media.check'
            ? {
                blackIntervals: [],
                silenceIntervals: [],
                silenceDetection: { noiseDb: -35, minimumDurationMs: 120, timestampKind: 'source' },
                meanDb: -18.0,
                peakDb: -3.0,
              }
            : {}),
        };
        break;
      }
      case 'canvas.timeline.update': {
        const canvasId = String(rawParams.canvasId || '').trim();
        const expectedRevision = Number(rawParams.expectedRevision);
        const timeline = rawParams.timeline;
        if (!canvasId || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !timeline) {
          throw invalidArg('invalid_params', 'canvasId、expectedRevision 和 timeline 必填');
        }
        const doc = clone(ensureCanvas(canvasId));
        if (doc.revision !== expectedRevision) {
          counts.revisionConflicts += 1;
          throw conflict('revision_conflict', '画布已经变化，请重新读取', { currentRevision: doc.revision });
        }
        doc.timeline = clone(timeline);
        const saved = saveCanvas(canvasId, doc, expectedRevision, 'canvas.timeline.update', turnId);
        result = { canvasId, revision: saved.revision, timelineUpdated: true };
        break;
      }
      case 'canvas.timeline.render': {
        const canvasId = String(rawParams.canvasId || '').trim();
        const expectedRevision = Number(rawParams.expectedRevision);
        if (!canvasId || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
          throw invalidArg('invalid_params', 'canvasId 和 expectedRevision 必填');
        }
        const doc = ensureCanvas(canvasId);
        if (doc.revision !== expectedRevision) {
          counts.revisionConflicts += 1;
          throw conflict('revision_conflict', '画布已变化，请重新读取', { currentRevision: doc.revision });
        }
        if (!doc.timeline) throw invalidArg('invalid_timeline', '画布中没有有效时间线');
        taskSeq += 1;
        const taskId = `task-render-${taskSeq}`;
        const task = {
          id: taskId,
          type: 'timeline_render',
          canvasId,
          status: 'succeeded',
          progress: 100,
          local: true,
          charged: false,
          confirmedByUser: true,
          outputs: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        tasks.set(taskId, task);
        result = { canvasId, taskId, status: 'succeeded', local: true, charged: false, sourceRevision: expectedRevision };
        break;
      }
      case 'canvas.document.commit': {
        const canvasId = String(rawParams.canvasId || '').trim();
        const expectedRevision = Number(rawParams.expectedRevision);
        const document = rawParams.document;
        if (!canvasId || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !document || typeof document !== 'object') {
          throw invalidArg('invalid_params', 'canvasId、expectedRevision 和 document 必填');
        }
        const doc = clone(ensureCanvas(canvasId));
        if (doc.revision !== expectedRevision) {
          counts.revisionConflicts += 1;
          throw conflict('revision_conflict', '画布已变化，请重新读取', { currentRevision: doc.revision });
        }
        const merged = { ...doc, ...clone(document), id: canvasId };
        const saved = saveCanvas(canvasId, merged, expectedRevision, 'canvas.document.commit', turnId);
        result = { canvasId, revision: saved.revision, title: saved.title, updatedAt: saved.updatedAt };
        break;
      }
      default:
        throw invalidArg('unsupported_operation', `模拟器未实现操作: ${opIdName}`);
    }

    if (!descriptor.readOnly && opKey) {
      opReceipts.set(opKey, { op: opIdName, digest: payloadDigest, result: clone(result), turnId });
    }
    if (turnRec && !descriptor.readOnly) {
      turnRec.receipts.push({ op: opIdName, opId: opKey, result: clone(result) });
    }
    opLog.push({ op: opIdName, opId: opKey, params: clone(rawParams), turnId, status: 'ok', replayed: false, result: clone(result), at: new Date().toISOString() });
    return { op: opIdName, replayed: false, result };
  }

  function failNextTask(reason = 'generation_provider_failed', nodeId = null) {
    nextTaskFailures.push({ reason: String(reason), nodeId: nodeId ? String(nodeId) : null });
  }

  function flagNextTaskDefect(defectNote = '内容与提示词不符', nodeId = null) {
    nextTaskDefects.push({ defectNote: String(defectNote), nodeId: nodeId ? String(nodeId) : null });
  }

  function takeQueuedFailure(nodeId) {
    const idx = nextTaskFailures.findIndex((item) => item.nodeId === nodeId || item.nodeId === null);
    if (idx < 0) return null;
    return nextTaskFailures.splice(idx, 1)[0];
  }

  function takeQueuedDefect(nodeId) {
    const idx = nextTaskDefects.findIndex((item) => item.nodeId === nodeId || item.nodeId === null);
    if (idx < 0) return null;
    return nextTaskDefects.splice(idx, 1)[0];
  }

  async function confirmProposals(proposalId = null, confirmOptions = {}) {
    const delayMs = Number(confirmOptions.delayMs ?? options.taskDelayMs ?? 5);
    const targets = proposalId
      ? [proposals.get(proposalId)].filter(Boolean)
      : [...proposals.values()].filter((p) => !p.confirmed);

    if (proposalId && targets.length === 0) {
      throw notFound('proposal_not_found', `生成提议不存在: ${proposalId}`);
    }

    const createdTasks = [];
    for (const proposal of targets) {
      if (proposal.turnId) {
        const turnRec = turns.get(proposal.turnId);
        if (turnRec?.undone) {
          throw conflict('turn_undone', '这一轮已撤销，不会生成。');
        }
      }
      proposal.confirmed = true;
      counts.userConfirmations += 1;

      const doc = ensureCanvas(proposal.canvasId);
      for (const nodeId of proposal.nodeIds) {
        const node = (doc.nodes || []).find((n) => n.id === nodeId);
        taskSeq += 1;
        const taskId = `task-${taskSeq}`;
        const task = {
          id: taskId,
          proposalId: proposal.proposalId,
          canvasId: proposal.canvasId,
          nodeId,
          type: proposal.kind,
          kind: proposal.kind,
          modelKey: proposal.modelKey,
          status: 'running',
          progress: 10,
          confirmedByUser: true,
          outputs: [],
          error: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        tasks.set(taskId, task);
        proposal.taskIds.push(taskId);
        if (node) {
          node.metadata ||= {};
          node.metadata.status = 'running';
          node.metadata.taskId = taskId;
          node.metadata.taskStatus = 'running';
        }
        createdTasks.push(task);
      }
    }

    if (delayMs > 0) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingTimers.delete(timer);
          resolve();
        }, delayMs);
        pendingTimers.add(timer);
      });
    }

    for (const task of createdTasks) {
      const currentDoc = clone(ensureCanvas(task.canvasId));
      const node = (currentDoc.nodes || []).find((n) => n.id === task.nodeId);
      const queuedFail = takeQueuedFailure(task.nodeId);
      if (queuedFail) {
        task.status = 'failed';
        task.progress = 100;
        task.resultState = 'failed';
        task.error = queuedFail.reason;
        task.updatedAt = new Date().toISOString();
        if (node) {
          node.metadata ||= {};
          node.metadata.status = 'failed';
          node.metadata.taskId = task.id;
          node.metadata.taskStatus = 'failed';
          node.metadata.errorDetails = queuedFail.reason;
          node.metadata.taskFailureDiagnostics = { reason: queuedFail.reason, message: queuedFail.reason };
        }
        saveCanvas(task.canvasId, currentDoc, currentDoc.revision, 'task.failed');
        events.push({ type: 'generation.failed', taskId: task.id, canvasId: task.canvasId, nodeId: task.nodeId, reason: queuedFail.reason, at: new Date().toISOString() });
        continue;
      }

      const queuedDefect = takeQueuedDefect(task.nodeId);
      const promptText = node?.metadata?.composerContent || node?.metadata?.prompt || '';
      const sizeStr = node?.metadata?.size || '9:16';
      const dims = dimensionsForSize(sizeStr);
      resourceSeq += 1;
      assetSeq += 1;
      const resourceId = `res-${resourceSeq}`;
      const assetId = `asset-${assetSeq}`;
      const mimeType = task.kind === 'video' ? 'video/mp4' : 'image/png';
      const resource = {
        id: resourceId,
        assetId,
        kind: task.kind,
        mimeType,
        size: DETERMINISTIC_PNG_BYTES.length,
        width: dims.width,
        height: dims.height,
        durationMs: task.kind === 'video' ? Number(node?.metadata?.seconds || 6) * 1000 : 0,
        version: `v1-${resourceId}`,
        prompt: promptText,
        reviewNote: queuedDefect?.defectNote || '',
        sha256: DETERMINISTIC_PNG_SHA256,
        dataBase64: DETERMINISTIC_PNG_BASE64,
      };
      resources.set(resourceId, resource);
      const asset = {
        id: assetId,
        name: node?.title || `${task.kind}-${assetSeq}`,
        kind: task.kind,
        resourceId,
        mimeType,
        width: dims.width,
        height: dims.height,
        prompt: promptText,
        reviewNote: queuedDefect?.defectNote || '',
        generated: true,
        payloadJson: JSON.stringify({ resourceId, storageKey: `resource:${resourceId}` }),
        createdAt: new Date().toISOString(),
      };
      assets.set(assetId, asset);

      task.status = 'succeeded';
      task.progress = 100;
      task.resultState = 'succeeded';
      task.outputs = [
        {
          index: 0,
          assetId,
          resourceId,
          mimeType,
          width: dims.width,
          height: dims.height,
          storageKey: `resource:${resourceId}`,
        },
      ];
      task.updatedAt = new Date().toISOString();

      if (node) {
        node.metadata ||= {};
        Object.assign(node.metadata, {
          status: 'success',
          taskId: task.id,
          taskStatus: 'succeeded',
          taskProgress: 100,
          assetId,
          resourceId,
          storageKey: `resource:${resourceId}`,
          content: `/api/resources/${resourceId}/file`,
          mimeType,
          width: dims.width,
          height: dims.height,
          ...(queuedDefect ? { reviewNote: queuedDefect.defectNote } : {}),
        });
      }
      for (const n of currentDoc.nodes || []) {
        if (n.type === 'script' && Array.isArray(n.metadata?.storyboard?.rows)) {
          for (const row of n.metadata.storyboard.rows) {
            if (row.imageNodeId === task.nodeId || row.videoNodeId === task.nodeId) {
              row.status = 'success';
            }
          }
        }
      }
      saveCanvas(task.canvasId, currentDoc, currentDoc.revision, 'task.succeeded');
      events.push({
        type: 'generation.succeeded',
        taskId: task.id,
        canvasId: task.canvasId,
        nodeId: task.nodeId,
        assetId,
        resourceId,
        reviewNote: queuedDefect?.defectNote || null,
        at: new Date().toISOString(),
      });
    }

    return clone(createdTasks);
  }

  function userEditNode(nodeId, patch = {}, canvasId = defaultCanvasId) {
    const doc = clone(ensureCanvas(canvasId));
    const node = (doc.nodes || []).find((n) => n.id === nodeId);
    if (!node) throw notFound('node_not_found', `节点不存在: ${nodeId}`);
    node.metadata ||= {};
    if (patch.title !== undefined) node.title = String(patch.title);
    if (patch.content !== undefined) {
      if (['image', 'video', 'audio'].includes(node.type)) {
        node.metadata.composerContent = String(patch.content);
        node.metadata.prompt = String(patch.content);
      } else {
        node.metadata.content = String(patch.content);
      }
    }
    if (patch.metadata && typeof patch.metadata === 'object') {
      Object.assign(node.metadata, clone(patch.metadata));
    }
    for (const [k, v] of Object.entries(patch)) {
      if (!['title', 'content', 'metadata'].includes(k)) {
        node.metadata[k] = v;
      }
    }
    counts.userEdits += 1;
    const saved = saveCanvas(canvasId, doc, doc.revision, 'user.edit');
    events.push({ type: 'user.edit', canvasId, nodeId, revision: saved.revision, patch: clone(patch), at: new Date().toISOString() });
    return clone(saved);
  }

  function undoTurn(turnId = null, canvasId = defaultCanvasId) {
    let target = turnId ? turns.get(turnId) : null;
    if (!target) {
      const candidates = [...turns.values()].filter((t) => t.canvasId === canvasId && !t.undone);
      target = candidates.at(-1) || null;
    }
    if (!target) throw notFound('turn_not_found', '未找到可撤销的回合');
    if (target.undone) return { turnId: target.turnId, undone: true, revision: ensureCanvas(target.canvasId).revision };

    const current = ensureCanvas(target.canvasId);
    const restored = clone(target.snapshotBefore);
    restored.id = target.canvasId;
    restored.revision = current.revision;
    const saved = saveCanvas(target.canvasId, restored, current.revision, 'turn.undo', target.turnId);
    target.undone = true;
    target.open = false;
    counts.undoCalls += 1;
    events.push({ type: 'turn.undone', turnId: target.turnId, canvasId: target.canvasId, revision: saved.revision, at: new Date().toISOString() });
    return { turnId: target.turnId, canvasId: target.canvasId, undone: true, revision: saved.revision, canvas: clone(saved) };
  }

  function getOrInitSkillContext(canvasId, sessionId = 'default') {
    ensureCanvas(canvasId);
    const key = `${canvasId}::${sessionId || 'default'}`;
    if (!skillContexts.has(key)) {
      scopeSeq += 1;
      skillContexts.set(key, {
        canvasId,
        sessionId: sessionId || 'default',
        scopeId: `scope-${scopeSeq.toString(16).padStart(8, '0')}`,
        revision: 0,
        activePins: [],
        lifecycle: 'active',
      });
    }
    return skillContexts.get(key);
  }

  function changeSkillContext(canvasId, body = {}) {
    const sessionId = String(body.sessionId || 'default');
    const ctx = getOrInitSkillContext(canvasId, sessionId);
    const action = String(body.action || 'activate');
    const expectedRevision = body.expectedRevision !== undefined ? Number(body.expectedRevision) : ctx.revision;
    const requestId = String(body.requestId || `req-${Date.now()}`);

    if (action === 'ack_reset') {
      if (ctx.revision !== expectedRevision || (body.scopeId && ctx.scopeId !== body.scopeId)) {
        throw conflict('skill_context_revision_conflict', '独立任务状态已变化');
      }
      ctx.lifecycle = 'active';
      return clone(ctx);
    }

    const receiptKey = `${canvasId}::${sessionId}::${requestId}`;
    const digest = sha256Hex(JSON.stringify({ action, pins: body.pins || [] }));
    if (skillContextReceipts.has(receiptKey)) {
      const prior = skillContextReceipts.get(receiptKey);
      if (prior.digest !== digest) {
        throw conflict('skill_context_request_conflict', '相同请求标识已用于不同技能操作');
      }
      return clone(prior.result);
    }

    if (ctx.lifecycle !== 'active') {
      throw conflict('skill_scope_reset_pending', '独立任务正在准备，请重试原请求');
    }
    if (expectedRevision !== ctx.revision) {
      throw conflict('skill_context_revision_conflict', '技能状态已变化，请刷新后重试');
    }

    const incomingPins = Array.isArray(body.pins) ? body.pins : [];
    if (incomingPins.length > 4) {
      throw invalidArg('skill_selection_limit', '最多使用 4 个技能');
    }
    if (action === 'activate') {
      ctx.activePins = clone(incomingPins);
    } else if (action === 'clear') {
      ctx.activePins = [];
    } else if (action === 'new_scope') {
      scopeSeq += 1;
      ctx.scopeId = `scope-${scopeSeq.toString(16).padStart(8, '0')}`;
      ctx.activePins = clone(incomingPins);
      ctx.lifecycle = 'reset_pending';
    } else if (action !== 'refresh') {
      throw invalidArg('invalid_skill_context_action', '技能操作无效');
    }
    ctx.revision += 1;
    const snapshot = clone(ctx);
    skillContextReceipts.set(receiptKey, { digest, result: snapshot });
    return snapshot;
  }

  function registerSkill(skillDef) {
    const pin = skillDef.pin || {
      skillId: skillDef.skillId || skillDef.id,
      versionId: skillDef.versionId || 'v1',
      contentHash: skillDef.contentHash || sha256Hex(skillDef.instruction || ''),
    };
    const record = {
      pin,
      name: skillDef.name || pin.skillId,
      version: String(skillDef.version || '1'),
      description: String(skillDef.description || ''),
      instruction: String(skillDef.instruction || ''),
      files: Array.isArray(skillDef.files) ? clone(skillDef.files) : [],
      unsupportedCapabilities: Array.isArray(skillDef.unsupportedCapabilities) ? clone(skillDef.unsupportedCapabilities) : [],
    };
    skills.set(pin.skillId, record);
    return clone(record);
  }

  function getSkillPin(skillId = 'short-drama-storyboard') {
    const s = skills.get(skillId);
    return s ? clone(s.pin) : null;
  }

  function snapshot() {
    return {
      canvases: Object.fromEntries([...canvases.entries()].map(([k, v]) => [k, clone(v)])),
      turns: Object.fromEntries([...turns.entries()].map(([k, v]) => [k, clone(v)])),
      proposals: [...proposals.values()].map((p) => clone(p)),
      tasks: [...tasks.values()].map((t) => clone(t)),
      assets: [...assets.values()].map((a) => clone(a)),
      resources: [...resources.values()].map((r) => clone(r)),
      skills: [...skills.values()].map((s) => ({ pin: clone(s.pin), name: s.name, version: s.version, description: s.description })),
      skillContexts: Object.fromEntries([...skillContexts.entries()].map(([k, v]) => [k, clone(v)])),
      events: clone(events),
      opLog: clone(opLog),
      counts: clone(counts),
    };
  }

  async function readJsonBody(req) {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  }

  function sendEnvelope(res, status, code, data, msg = 'ok', reason = undefined, details = undefined) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        code,
        data,
        msg,
        ...(reason ? { reason } : {}),
        ...(details ? { details } : {}),
      }),
    );
  }

  function sendOk(res, data) {
    sendEnvelope(res, 200, 0, data, 'ok');
  }

  function sendError(res, error) {
    if (error instanceof OpError) {
      sendEnvelope(res, error.status, error.status, null, error.message, error.reason, error.details);
      return;
    }
    sendEnvelope(res, 500, 500, null, String(error?.message || error), error?.reason || 'internal_error');
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      const pathname = url.pathname.replace(/\/+$/, '') || '/';

      if (hostToken) {
        const gotToken = req.headers['x-beeftv-agent-token'];
        if (gotToken !== undefined && gotToken !== hostToken) {
          sendEnvelope(res, 403, 403, null, 'unauthorized', 'unauthorized');
          return;
        }
      }

      // 1. 操作描述符与共享操作层路由 (/api/ops, /api/ops/:id, /api/canvas/operations)
      if (req.method === 'GET' && (pathname === '/api/ops' || pathname === '/ops' || pathname === '/api/canvas/operations')) {
        sendOk(res, { ops: descriptors });
        return;
      }

      if (req.method === 'POST' && (pathname.startsWith('/api/ops/') || pathname.startsWith('/ops/'))) {
        const opIdName = decodeURIComponent(pathname.replace(/^(\/api)?\/ops\//, ''));
        const body = await readJsonBody(req);
        const turnId = String(req.headers['x-beeftv-agent-turn'] || body.turnId || '').trim();
        const opKey = String(body.opId || body.operationId || body.params?.operationId || '').trim();
        const params = body.params !== undefined ? body.params : body;
        const data = executeOp(opIdName, params, opKey, turnId);
        sendOk(res, data);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/canvas/operations') {
        const body = await readJsonBody(req);
        const opIdName = String(body.op || body.operation || body.id || '').trim();
        const turnId = String(req.headers['x-beeftv-agent-turn'] || body.turnId || '').trim();
        const opKey = String(body.opId || body.operationId || body.params?.operationId || '').trim();
        const params = body.params !== undefined ? body.params : body;
        const data = executeOp(opIdName, params, opKey, turnId);
        sendOk(res, data);
        return;
      }

      // 2. 画布直接读写端点 (/api/canvas, /api/canvas/:id)
      if (pathname === '/api/canvas' || pathname.startsWith('/api/canvas/')) {
        const subId = pathname.startsWith('/api/canvas/') ? decodeURIComponent(pathname.slice('/api/canvas/'.length)) : '';
        if (req.method === 'GET') {
          const canvasId = subId || url.searchParams.get('canvasId') || defaultCanvasId;
          const doc = canvases.get(canvasId);
          if (!doc) throw notFound('canvas_not_found', `画布不存在: ${canvasId}`);
          sendOk(res, { canvasId, canvas: clone(doc) });
          return;
        }
        if (req.method === 'POST' || req.method === 'PUT') {
          const body = await readJsonBody(req);
          const canvasId = subId || String(body.canvasId || body.id || defaultCanvasId);
          if (body.seed === true || !canvases.has(canvasId)) {
            const doc = ensureCanvas(canvasId, body.canvas || body);
            sendOk(res, { canvasId, revision: doc.revision, canvas: clone(doc) });
            return;
          }
          const current = ensureCanvas(canvasId);
          const expectedRevision = body.expectedRevision !== undefined ? Number(body.expectedRevision) : current.revision;
          const nextDoc = { ...clone(current), ...(body.canvas || body), id: canvasId };
          const saved = saveCanvas(canvasId, nextDoc, expectedRevision, 'api.canvas.put');
          sendOk(res, { canvasId, revision: saved.revision, canvas: clone(saved) });
          return;
        }
      }

      // 3. 回合授权与生命周期端点 (/api/assistant/runtime/turns/:id..., /api/assistant/turns...)
      const runtimeTurnMatch = /^(\/api)?\/assistant\/(runtime\/)?turns\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+)\/run)?$/.exec(pathname);
      if (runtimeTurnMatch) {
        const turnId = decodeURIComponent(runtimeTurnMatch[3]);
        const action = runtimeTurnMatch[4] || '';
        const subParam = runtimeTurnMatch[5] || '';

        if (req.method === 'GET' && !action) {
          let rec = turns.get(turnId);
          if (!rec && options.autoAuthorizeTurns !== false) {
            rec = beginTurn({ turnId, canvasId: defaultCanvasId, permissionMode: 'canvas' });
          }
          if (!rec) throw permissionDenied('turn_not_open', '任务不可恢复');
          sendOk(res, {
            turnId: rec.turnId,
            canvasId: rec.canvasId,
            permissionMode: rec.permissionMode,
            open: rec.open && !rec.undone,
            undone: rec.undone,
            sessionId: rec.sessionId,
            revisionBefore: rec.revisionBefore,
          });
          return;
        }

        if (req.method === 'POST' && action === 'bind-session') {
          const body = await readJsonBody(req);
          let rec = turns.get(turnId);
          if (!rec) rec = beginTurn({ turnId, canvasId: defaultCanvasId, sessionId: body.sessionId });
          rec.sessionId = String(body.sessionId || rec.sessionId || '');
          sendOk(res, { bound: true, turnId, sessionId: rec.sessionId });
          return;
        }

        if (req.method === 'POST' && action === 'native-rehydrate') {
          const body = await readJsonBody(req);
          sendOk(res, { source: body.source });
          return;
        }

        if (req.method === 'POST' && action === 'complete') {
          let rec = turns.get(turnId);
          if (!rec) rec = beginTurn({ turnId, canvasId: defaultCanvasId });
          rec.open = false;
          sendOk(res, {
            turnId: rec.turnId,
            canvasId: rec.canvasId,
            permissionMode: rec.permissionMode,
            open: false,
            undone: rec.undone,
          });
          return;
        }

        if (req.method === 'POST' && action === 'undo') {
          const body = await readJsonBody(req);
          const undone = undoTurn(turnId, body.canvasId || defaultCanvasId);
          sendOk(res, undone);
          return;
        }

        if (req.method === 'POST' && action === 'proposals' && subParam) {
          const proposalId = decodeURIComponent(subParam);
          const created = await confirmProposals(proposalId);
          sendOk(res, { proposalId, tasks: created });
          return;
        }
      }

      if (pathname === '/api/assistant/turns') {
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          const rec = beginTurn(body);
          sendOk(res, {
            turnId: rec.turnId,
            canvasId: rec.canvasId,
            permissionMode: rec.permissionMode,
            open: rec.open,
            revisionBefore: rec.revisionBefore,
          });
          return;
        }
        if (req.method === 'GET') {
          sendOk(res, { turns: [...turns.values()].map((t) => clone(t)) });
          return;
        }
      }

      // 4. 技能与活动技能上下文端点 (/api/assistant/skills, /api/assistant/skills/active, /api/assistant/runtime/canvases/:canvasId/skill-context)
      const skillCtxMatch = /^(\/api)?\/assistant\/(runtime\/)?canvases\/([^/]+)\/skill-context$/.exec(pathname);
      if (skillCtxMatch) {
        const canvasId = decodeURIComponent(skillCtxMatch[3]);
        if (req.method === 'GET') {
          const sessionId = url.searchParams.get('sessionId') || 'default';
          sendOk(res, clone(getOrInitSkillContext(canvasId, sessionId)));
          return;
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          sendOk(res, changeSkillContext(canvasId, body));
          return;
        }
      }

      if (pathname === '/api/assistant/skills') {
        if (req.method === 'GET') {
          const data = executeOp('skill.catalog', Object.fromEntries(url.searchParams));
          sendOk(res, data.result);
          return;
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          sendOk(res, registerSkill(body));
          return;
        }
      }

      if (pathname === '/api/assistant/skills/active') {
        if (req.method === 'GET') {
          const canvasId = url.searchParams.get('canvasId') || defaultCanvasId;
          const sessionId = url.searchParams.get('sessionId') || 'default';
          sendOk(res, clone(getOrInitSkillContext(canvasId, sessionId)));
          return;
        }
        if (req.method === 'POST' || req.method === 'PUT') {
          const body = await readJsonBody(req);
          const canvasId = String(body.canvasId || defaultCanvasId);
          sendOk(res, changeSkillContext(canvasId, body));
          return;
        }
      }

      // 5. 生成任务端点 (/api/generation-tasks, /api/generation-tasks/:id)
      if (pathname === '/api/generation-tasks' || pathname.startsWith('/api/generation-tasks/')) {
        const sub = pathname.startsWith('/api/generation-tasks/')
          ? pathname.slice('/api/generation-tasks/'.length)
          : '';
        if (req.method === 'GET') {
          if (sub) {
            const task = tasks.get(decodeURIComponent(sub));
            if (!task) throw notFound('task_not_found', '任务不存在');
            sendOk(res, clone(task));
            return;
          }
          const canvasId = url.searchParams.get('canvasId') || '';
          const list = [...tasks.values()].filter((t) => !canvasId || t.canvasId === canvasId);
          sendOk(res, { tasks: clone(list), total: list.length });
          return;
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          if (body.proposalId || body.confirmAll) {
            const created = await confirmProposals(body.proposalId || null, body);
            sendOk(res, { tasks: created });
            return;
          }
          if (body.ConfirmedByUser === false || body.confirmed === false) {
            counts.unconfirmedTasks += 1;
            throw permissionDenied('generation_confirmation_required', '付费生成必须经过用户确认');
          }
          // 直接为指定节点创建生成任务（测试/模拟用）
          proposalSeq += 1;
          const pId = `gp-${proposalSeq}`;
          proposals.set(pId, {
            proposalId: pId,
            turnId: body.turnId || '',
            canvasId: body.canvasId || defaultCanvasId,
            kind: body.kind || 'image',
            nodeIds: Array.isArray(body.nodeIds) ? body.nodeIds : [body.nodeId].filter(Boolean),
            model: 'Seedream 3.0',
            modelKey: 'seedream-3.0',
            note: body.note || '',
            confirmed: false,
            taskIds: [],
          });
          const created = await confirmProposals(pId, body);
          sendOk(res, { tasks: created });
          return;
        }
      }

      sendEnvelope(res, 404, 404, null, `未找到路由: ${req.method} ${pathname}`, 'not_found');
    } catch (error) {
      sendError(res, error);
    }
  });

  const sim = {
    server,
    port: 0,
    baseUrl: '',
    opsUrl: '',
    descriptors,
    counts,
    canvases,
    turns,
    proposals,
    tasks,
    assets,
    resources,
    skills,
    events,
    opLog,
    ensureCanvas,
    beginTurn,
    executeOp,
    confirmProposals,
    failNextTask,
    flagNextTaskDefect,
    userEditNode,
    undoTurn,
    registerSkill,
    getSkillPin,
    getOrInitSkillContext,
    changeSkillContext,
    snapshot,
    async listen(port = 0) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve());
      });
      const addr = server.address();
      sim.port = typeof addr === 'object' && addr ? addr.port : port;
      sim.baseUrl = `http://127.0.0.1:${sim.port}`;
      sim.opsUrl = `${sim.baseUrl}/api`;
      return sim;
    },
    async close() {
      for (const timer of pendingTimers) clearTimeout(timer);
      pendingTimers.clear();
      if (server.listening) {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(() => resolve()));
      }
    },
  };

  return sim;
}
