import test from 'node:test';
import assert from 'node:assert/strict';
import { captureLatestVideo } from './video-context';

test('captureLatestVideo extracts SharedVideo from element fiber with video_model', () => {
  const originalDocument = globalThis.document;
  const originalNode = (globalThis as any).Node;
  try {
    (globalThis as any).Node = class FakeNode {};
    const fakeScope: any = {
      tagName: 'IMG',
      parentElement: {
        tagName: 'DIV',
        parentElement: null,
      },
      __reactFiber$test: {
        memoizedProps: {
          video_model: JSON.stringify({
            video_id: 'vid-123456',
            fallback_api: 'https://snssdk.com/video/fplay/?key_seed=abcdef',
          }),
        },
      },
    };
    fakeScope.parentElement.parentElement = {
      tagName: 'BODY',
    };

    (globalThis as any).document = {
      querySelectorAll: (selector: string) => {
        if (selector.includes('img') || selector.includes('video')) {
          return [fakeScope];
        }
        return [];
      },
      body: fakeScope.parentElement.parentElement,
      documentElement: {},
    };

    const result = captureLatestVideo();
    assert.ok(result);
    assert.equal(result.vid, 'vid-123456');
    assert.equal(result.model.fallback_api, 'https://snssdk.com/video/fplay/?key_seed=abcdef');
  } finally {
    globalThis.document = originalDocument;
    (globalThis as any).Node = originalNode;
  }
});

test('captureLatestVideo extracts SharedVideo when fallback_api is directly on object', () => {
  const originalDocument = globalThis.document;
  const originalNode = (globalThis as any).Node;
  try {
    (globalThis as any).Node = class FakeNode {};
    const fakeScope: any = {
      tagName: 'DIV',
      className: 'video-card',
      parentElement: null,
      __reactProps$test: {
        vid: 'vid-direct-789',
        fallback_api: 'https://snssdk.com/video/fplay/?key_seed=direct123',
      },
    };
    fakeScope.parentElement = {
      tagName: 'BODY',
    };

    (globalThis as any).document = {
      querySelectorAll: () => [fakeScope],
      body: fakeScope.parentElement,
      documentElement: {},
    };

    const result = captureLatestVideo();
    assert.ok(result);
    assert.equal(result.vid, 'vid-direct-789');
    assert.equal(result.model.video_id, 'vid-direct-789');
    assert.equal(result.model.fallback_api, 'https://snssdk.com/video/fplay/?key_seed=direct123');
  } finally {
    globalThis.document = originalDocument;
    (globalThis as any).Node = originalNode;
  }
});
