// Model-facing reads only. The Go canvas and write/CAS payloads stay intact.
const MAX_BYTES = 40000;
const MAX_ITEMS = 50;
const pointer = parts => parts.length ? '/' + parts.map(p => String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('/') : '';
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const noisy = new Set(['taskFailureDiagnostics', 'generationFailureDiagnostics']);

export const CANVAS_READ_VIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  description: '只读分页。默认返回节点与连线紧凑视图；complete=false 的字段通过 nodeId + fieldPath 读取原文。每页核对 revision，后续页带 expectedRevision；不改变业务画布。',
  properties: {
    section: { type: 'string', enum: ['nodes', 'connections', 'canvas'] },
    nodeId: { type: 'string', description: '按真实节点 ID 定位；可搭配 fieldPath 读取完整字段' },
    fieldPath: { type: 'string', description: 'JSON Pointer，例如 /metadata/prompt、/metadata/taskFailureDiagnostics；相对于指定节点或 section=canvas 的画布' },
    offset: { type: 'integer', minimum: 0, description: '数组或对象字段分页起点' },
    limit: { type: 'integer', minimum: 1, maximum: MAX_ITEMS },
    textOffset: { type: 'integer', minimum: 0, description: '长字符串原文字符起点，沿 nextTextOffset 续读' },
    expectedRevision: { type: 'integer', minimum: 0 },
  },
};

export function canvasReadView(data, request = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw Error('invalid_canvas_read_view');
  if (Object.keys(request).some(key => !Object.hasOwn(CANVAS_READ_VIEW_SCHEMA.properties, key))) throw Error('invalid_canvas_read_view');
  for (const key of ['offset', 'textOffset', 'expectedRevision', 'limit']) {
    if (request[key] !== undefined && (!Number.isSafeInteger(request[key]) || request[key] < (key === 'limit' ? 1 : 0))) throw Error('invalid_canvas_read_view');
  }
  if (request.limit > MAX_ITEMS || (request.section !== undefined && !['nodes', 'connections', 'canvas'].includes(request.section))) throw Error('invalid_canvas_read_view');
  if (request.nodeId !== undefined && typeof request.nodeId !== 'string' || request.fieldPath !== undefined && typeof request.fieldPath !== 'string') throw Error('invalid_canvas_read_view');
  const doc = data?.result?.canvas;
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw Error('invalid_canvas_read_result');
  const revision = doc.revision;
  if (!Number.isSafeInteger(revision) || revision < 0) throw Error('canvas_read_revision_missing');
  if (request.expectedRevision !== undefined && revision !== request.expectedRevision) throw Error('canvas_read_revision_changed: 画布已变化，请重新读取第一页');
  const nodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  const base = { canvasId: data.result.canvasId, revision };
  let partialFields = 0;
  const rootRead = request.nodeId ? { nodeId: request.nodeId } : { section: 'canvas' };
  function shortened(value, parts) {
    partialFields++;
    return { complete: false, type: Array.isArray(value) ? 'array' : typeof value,
      ...(value && typeof value === 'object' && typeof value.id === 'string' ? { id: value.id } : {}),
      ...(typeof value === 'string' ? { characters: value.length, preview: value.slice(0, 160) } : {}),
      readView: { ...rootRead, fieldPath: pointer(parts), expectedRevision: revision } };
  }
  function compact(value, parts = [], depth = 0) {
    if (typeof value === 'string') return Buffer.byteLength(value, 'utf8') > 2000 ? shortened(value, parts) : value;
    if (!value || typeof value !== 'object') return value;
    if (depth > 5 || noisy.has(parts.at(-1)) || Object.keys(value).length > MAX_ITEMS) return shortened(value, parts);
    if (Array.isArray(value)) return value.map((v, i) => compact(v, [...parts, i], depth + 1));
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, compact(v, [...parts, k], depth + 1)]));
  }
  function page(values, budget, transform, offset = request.offset ?? 0, overflow) {
    const limit = request.limit ?? MAX_ITEMS, items = [];
    for (let i = offset; i < Math.min(values.length, offset + limit); i++) {
      let item = transform(values[i], i);
      // A single rich record must remain discoverable even when each field is
      // individually small. Its locator exposes the original fields on demand.
      if (bytes([item]) > budget && overflow) item = overflow(values[i], i);
      if (bytes([...items, item]) > budget) break;
      items.push(item);
    }
    if (offset < values.length && !items.length) throw Error('canvas_read_field_too_large: 请按 nodeId/fieldPath 定位字段');
    const next = offset + items.length;
    return { items, page: { offset, returned: items.length, total: values.length, recordsComplete: next >= values.length,
      ...(next < values.length ? { nextOffset: next } : {}) } };
  }
  let output;
  if (request.nodeId || request.fieldPath !== undefined || request.section === 'canvas') {
    let selected = request.nodeId ? nodes.find(node => node?.id === request.nodeId) : doc;
    if (!selected) throw Error('canvas_read_node_missing');
    const parts = request.fieldPath === undefined || request.fieldPath === '' ? [] : request.fieldPath.split('/').slice(1).map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (request.fieldPath && !request.fieldPath.startsWith('/')) throw Error('invalid_canvas_field_path');
    for (const part of parts) {
      if (!selected || typeof selected !== 'object' || !Object.hasOwn(selected, part)) throw Error('canvas_read_field_missing');
      selected = selected[part];
    }
    let value, pagination;
    if (typeof selected === 'string') {
      const offset = request.textOffset ?? 0;
      value = selected.slice(offset, offset + 8000);
      while (bytes(value) > 30000) value = value.slice(0, Math.floor(value.length * 0.8));
      // UTF-8 can use four bytes per character, safely below official 50KiB.
      const next = offset + value.length;
      pagination = { textOffset: offset, characters: selected.length, recordsComplete: next >= selected.length,
        ...(next < selected.length ? { nextTextOffset: next } : {}) };
    } else if (selected && typeof selected === 'object' && request.fieldPath !== undefined) {
      const entries = Array.isArray(selected) ? selected.map((v, i) => [i, v]) : Object.entries(selected);
      const result = page(entries, 30000, ([key, value]) => ({ key, value: compact(value, [...parts, key]) }), request.offset ?? 0,
        ([key, value]) => ({ key, value: shortened(value, [...parts, key]) }));
      value = result.items; pagination = { ...result.page, type: Array.isArray(selected) ? 'arrayEntries' : 'objectEntries' };
    } else {
      value = compact(selected);
      if (bytes(value) > 30000) value = shortened(selected, parts);
      pagination = { recordsComplete: true };
    }
    output = { ...base, value, readView: { ...rootRead, fieldPath: request.fieldPath ?? '', ...pagination,
      complete: pagination.recordsComplete && partialFields === 0, partialFields } };
  } else {
    const section = request.section ?? 'nodes';
    const values = section === 'connections' ? (doc.connections ?? []) : nodes;
    const result = page(values, section === 'nodes' ? 21000 : 28000, (value, index) => {
      if (section === 'nodes') {
        rootRead.nodeId = value.id; delete rootRead.section;
        return compact(value);
      }
      rootRead.section = 'canvas'; delete rootRead.nodeId;
      return compact(value, ['connections', index]);
    }, request.offset ?? 0, (value, index) => shortened(value, section === 'nodes' ? [] : ['connections', index]));
    let edges, nodeIndex;
    if (section === 'nodes') {
      nodeIndex = page(nodes, 7000, node => ({ id: node.id, type: node.type,
        ...(typeof node.title === 'string' ? { title: node.title.slice(0, 120), titleComplete: node.title.length <= 120 } : {}) }));
      rootRead.section = 'canvas'; delete rootRead.nodeId;
      edges = page(doc.connections ?? [], 7000, (value, index) => compact(value, ['connections', index]), 0,
        (value, index) => shortened(value, ['connections', index]));
    }
    output = { canvasId: base.canvasId, canvas: { revision, [section]: result.items,
      ...(nodeIndex ? { nodeIndex: nodeIndex.items } : {}),
      ...(edges ? { connections: edges.items } : {}) },
      readView: { section, ...result.page, complete: result.page.recordsComplete && (!edges || edges.page.recordsComplete) && partialFields === 0,
        partialFields, ...(edges ? { connectionsPage: edges.page } : {}),
        ...(nodeIndex ? { nodeIndexPage: nodeIndex.page } : {}),
        canvasFields: Object.keys(doc), timelinePresent: doc.timeline != null } };
  }
  const response = { ...data, result: output };
  if (bytes(response) > MAX_BYTES) throw Error('canvas_read_field_too_large: 请按 nodeId/fieldPath 定位字段');
  return response;
}
