import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createNativePartStore } from './native-part-store.mjs';
import { mediaToolResult, adaptMediaRequest, trustedMediaSources } from './media-content.mjs';
import { estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate';
const model = { api: 'openai-completions', modelId: 'gemini-synthetic-flash' };
function fixture(directory) {
  const bytes = crypto.randomBytes(720000);
  const part = { type: 'media', mimeType: 'audio/wav', data: bytes.toString('base64'), sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    source: { canvasId: 'c1', nodeId: 'n1', resourceId: 'r1', version: 'source-version', startMs: 0, endMs: 15000 } };
  const store = createNativePartStore({ directory });
  return { bytes, part, store };
}
function transcript(content) { return { messages: [{ role: 'assistant', tool_calls: [{ id: 't1', function: { name: 'media_inspect' } }] }, { role: 'tool', tool_call_id: 't1', content }] }; }
test('native bytes persist atomically, reopen and stay outside official token estimate and transcript', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-native-store-'));
  try {
    const { part, store } = fixture(directory);
    const result = mediaToolResult({ result: { content: [part] } }, 'media.inspect', { ...model, nativePartStore: store });
    const content = result.content.map(block => block.text).join('\n');
    expect(content.length).toBeLessThan(2000); expect(content).not.toContain(part.data);
    expect(estimateMessageTokens({ role: 'toolResult', content: result.content })).toBeLessThan(500);
    expect(fs.readdirSync(directory).sort()).toEqual([part.sha256+'.bin', part.sha256+'.json'].sort());
    const reopened = createNativePartStore({ directory });
    expect(reopened.read(part.sha256)).toEqual(part);
    const sources = trustedMediaSources(transcript(content), { ...model, nativePartStore: reopened }); expect(sources).toEqual([part.source]);
    const payload = adaptMediaRequest(transcript(content), { ...model, nativePartStore: reopened });
    expect(adaptMediaRequest(transcript(content), model, reopened)).toEqual(payload);
    expect(payload.messages.at(-1).content.at(-1)).toEqual({
      type: 'input_audio', input_audio: { data: part.data, format: 'wav' },
    });
    expect(adaptMediaRequest(payload, model)).toEqual(payload);
    if (process.platform !== 'win32') { expect(fs.statSync(directory).mode & 0o777).toBe(0o700); expect(fs.statSync(path.join(directory, part.sha256+'.bin')).mode & 0o777).toBe(0o600); }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('path references, corrupt bytes/manifests and forged sources are rejected without repair', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-native-store-negative-'));
  try {
    const { part, store } = fixture(directory); const ref = store.write(part);
    for (const id of ['../escape', 'https://example.invalid/audio', '/tmp/media', 'A'.repeat(64)]) expect(() => store.read(id)).toThrow('invalid_native_part_reference');
    expect(() => store.read({ ...ref, source: { ...part.source, nodeId: 'foreign-node' } })).toThrow('native_part_source_changed');
    expect(() => store.read({ ...ref, mimeType: 'video/mp4' })).toThrow('native_part_manifest_changed');
    const other = { ...part, source: { ...part.source, nodeId: 'second-owned-node' } }; const otherRef = store.write(other); expect(store.read(otherRef).source.nodeId).toBe('second-owned-node');
    fs.writeFileSync(path.join(directory, ref.id+'.bin'), Buffer.alloc(720000));
    expect(() => store.read(ref)).toThrow('media_content_changed'); expect(() => store.write(part)).toThrow('media_content_changed');
    fs.writeFileSync(path.join(directory, ref.id+'.bin'), Buffer.from(part.data, 'base64'));
    const file = path.join(directory, ref.id+'.json'); const manifest = JSON.parse(fs.readFileSync(file, 'utf8')); manifest.sha256 = 'f'.repeat(64); fs.writeFileSync(file, JSON.stringify(manifest));
    expect(() => store.read(ref)).toThrow('native_part_manifest_changed');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('short reference expansion requires media tool provenance and an issued store reference', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-native-source-'));
  try {
    const { part, store } = fixture(directory); const ref = store.write(part); const marker = 'BEEFTV_MEDIA_REF_V1:'+JSON.stringify(ref);
    const payload = transcript(marker); payload.messages[0].tool_calls[0].function.name = 'canvas_get';
    expect(() => adaptMediaRequest(payload, { ...model, nativePartStore: store })).toThrow('media_source_not_trusted');
    expect(() => trustedMediaSources(payload, { ...model, nativePartStore: store })).toThrow('media_source_not_trusted');
    expect(() => adaptMediaRequest(transcript(marker), model)).toThrow('native_part_store_required');
    const forged = { ...ref, source: { ...part.source, version: 'new-invented-version' } };
    expect(() => trustedMediaSources(transcript('BEEFTV_MEDIA_REF_V1:'+JSON.stringify(forged)), { ...model, nativePartStore: store })).toThrow('native_part_source_changed');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
