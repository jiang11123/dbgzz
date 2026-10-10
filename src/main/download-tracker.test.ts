import test from 'node:test';
import assert from 'node:assert/strict';
import { DownloadTracker } from './download-tracker';

test('confirmed duplicate remains tracked until both downloads finish', () => {
  const tracker = new DownloadTracker();
  assert.equal(tracker.begin(1, 'same-video'), true);
  assert.equal(tracker.begin(1, 'same-video', true), true);
  tracker.finish(1, 'same-video');
  assert.equal(tracker.begin(1, 'same-video'), false);
  tracker.finish(1, 'same-video');
  assert.equal(tracker.begin(1, 'same-video'), true);
});

test('prevents a duplicate download while the same account video is active', () => {
  const tracker = new DownloadTracker();

  assert.equal(tracker.begin(3, 'https://video.example.com/asset.mp4'), true);
  assert.equal(tracker.begin(3, 'https://video.example.com/asset.mp4'), false);
});

test('allows the same account video after the prior download finishes', () => {
  const tracker = new DownloadTracker();
  const source = 'https://video.example.com/asset.mp4';

  tracker.begin(3, source);
  tracker.finish(3, source);

  assert.equal(tracker.begin(3, source), true);
});
