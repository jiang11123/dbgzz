import test from 'node:test';
import assert from 'node:assert/strict';
import { toIpcAttachments, toStagedGeneratedImage } from './gateway-chat';

test('normalizes empty, single and multiple staged attachments for IPC', () => {
  assert.deepEqual(toIpcAttachments([]), []);
  assert.deepEqual(toIpcAttachments([{ id: 'a', name: 'a.png' }]), [{
    id: 'a', assetId: 'a', name: 'a.png', mimeType: 'image/png', url: undefined,
  }]);
  assert.deepEqual(toIpcAttachments([
    { id: 'a', assetId: 'asset-a', name: 'a.png', mimeType: 'image/png', url: 'file:///a.png' },
    { id: 'b', name: 'notes.txt' },
  ]), [
    { id: 'a', assetId: 'asset-a', name: 'a.png', mimeType: 'image/png', url: 'file:///a.png' },
    { id: 'b', assetId: 'b', name: 'notes.txt', mimeType: 'application/octet-stream', url: undefined },
  ]);
});

test('maps a generated local image back into the staged attachment shape', () => {
  assert.deepEqual(toStagedGeneratedImage(
    { id: 'generated-1', kind: 'image', url: 'file:///gateway-media/generated.png', name: 'generated.png', path: 'C:/gateway-media/generated.png' },
    { id: 'asset-1', name: 'generated.png', url: 'file:///image-assets/asset-1' },
  ), {
    id: 'generated-1', assetId: 'asset-1', name: 'generated.png', mimeType: 'image/png', url: 'file:///image-assets/asset-1',
  });
});
