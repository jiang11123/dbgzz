import { describe, expect, test } from 'bun:test';
import { canvasReadView } from './canvas-read-view.mjs';

const fixture = (count = 23) => ({ result: { canvasId: 'canvas', canvas: {
  nodes: Array.from({ length: count }, (_, i) => ({ id: `node-${i}`, type: 'video', title: `shot-${i}`, metadata: {
    prompt: `real prompt ${i}`, model: 'real-model', seconds: '5', assetId: `asset-${i}`,
    storageKey: `resource:resource-${i}`, taskId: `task-${i}`,
    taskFailureDiagnostics: { repeated: 'diagnostic'.repeat(10000) },
  } })), connections: [{ id: 'edge', source: 'node-0', target: 'node-22' }], revision: 399,
} } });

describe('bounded authenticated canvas read view', () => {
  test('one oversized record stays discoverable and every original small field can be read', () => {
    const data = fixture(2);
    data.result.canvas.nodes[0].metadata = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`field-${i}`, 'x'.repeat(1900)]));
    const original = JSON.stringify(data);
    const first = canvasReadView(data);
    expect(first.result.canvas.revision).toBe(399);
    expect(first.result.canvas.nodeIndex.map(n => n.id)).toEqual(['node-0', 'node-1']);
    expect(first.result.canvas.nodes[0].id).toBe('node-0');
    expect(first.result.canvas.nodes[0].complete).toBe(false);
    expect(first.result.canvas.nodes[0].readView).toEqual({ nodeId: 'node-0', fieldPath: '', expectedRevision: 399 });
    expect(first.result.readView.complete).toBe(false);
    const array = canvasReadView(data, { section: 'canvas', fieldPath: '/nodes', expectedRevision: 399 });
    expect(array.result.value[0].key).toBe(0);
    expect(array.result.value[0].value.id).toBe('node-0');
    expect(array.result.value[0].value.complete).toBe(false);
    const node = canvasReadView(data, first.result.canvas.nodes[0].readView);
    expect(node.result.value.find(entry => entry.key === 'metadata').value.complete).toBe(false);
    expect(node.result.readView.complete).toBe(false);
    for (let i = 0; i < 20; i++) {
      const field = canvasReadView(data, { nodeId: 'node-0', fieldPath: `/metadata/field-${i}`, expectedRevision: 399 });
      expect(field.result.value).toBe('x'.repeat(1900));
      expect(field.result.readView.complete).toBe(true);
    }
    const metadata = canvasReadView(data, { nodeId: 'node-0', fieldPath: '/metadata', expectedRevision: 399 });
    expect(metadata.result.readView.nextOffset).toBeGreaterThan(0);
    expect(metadata.result.readView.complete).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(40000);
    expect(Buffer.byteLength(JSON.stringify(array))).toBeLessThan(40000);
    expect(JSON.stringify(data)).toBe(original);
  });
  test('all 23 real IDs, configuration, references and trailing revision survive noisy metadata', () => {
    const input = fixture(), original = JSON.stringify(input), result = canvasReadView(input);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(40000);
    expect(result.result.canvas.revision).toBe(399);
    expect(result.result.canvas.nodes.map(n => n.id)).toEqual(input.result.canvas.nodes.map(n => n.id));
    expect(result.result.canvas.nodeIndex.map(n => n.id)).toEqual(input.result.canvas.nodes.map(n => n.id));
    expect(result.result.canvas.nodes[22].metadata.prompt).toBe('real prompt 22');
    expect(result.result.canvas.nodes[22].metadata.storageKey).toBe('resource:resource-22');
    expect(result.result.canvas.nodes[22].metadata.taskId).toBe('task-22');
    expect(result.result.readView.recordsComplete).toBe(true);
    expect(result.result.readView.complete).toBe(false);
    expect(result.result.canvas.nodes[22].metadata.taskFailureDiagnostics.complete).toBe(false);
    expect(JSON.stringify(input)).toBe(original);
  });
  test('large canvas is explicitly paged; node and long original field remain addressable', () => {
    const data = fixture(1000); data.result.canvas.nodes[999].metadata.prompt = '真实原文'.repeat(40000);
    const first = canvasReadView(data);
    expect(first.result.readView.complete).toBe(false);
    expect(first.result.readView.nextOffset).toBeGreaterThan(0);
    expect(first.result.readView.nodeIndexPage.recordsComplete).toBe(false);
    const last = canvasReadView(data, { offset: 999, expectedRevision: 399 });
    expect(last.result.canvas.nodes[0].id).toBe('node-999');
    const field = canvasReadView(data, { nodeId: 'node-999', fieldPath: '/metadata/prompt', textOffset: 6000, expectedRevision: 399 });
    expect(field.result.value).toBe(data.result.canvas.nodes[999].metadata.prompt.slice(6000, field.result.readView.nextTextOffset));
    expect(field.result.readView.complete).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(field))).toBeLessThan(40000);
    expect(() => canvasReadView(data, { expectedRevision: 398 })).toThrow('canvas_read_revision_changed');
    expect(() => canvasReadView(data, { nodeId: 'foreign' })).toThrow('canvas_read_node_missing');
    expect(() => canvasReadView(data, { nodeId: 'node-999', fieldPath: '/__proto__/constructor' })).toThrow('canvas_read_field_missing');
    expect(() => canvasReadView(data, { offset: -1 })).toThrow('invalid_canvas_read_view');
    expect(() => canvasReadView(data, { limit: 999 })).toThrow('invalid_canvas_read_view');
    const object = canvasReadView(data, { nodeId: 'node-999', fieldPath: '/metadata', limit: 2 });
    expect(object.result.readView.type).toBe('objectEntries');
    expect(object.result.readView.nextOffset).toBe(2);
  });
});
