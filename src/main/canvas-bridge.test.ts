import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRecoverTaskPage } from './canvas-bridge';

test('only recovers a lost Doubao task page once', () => {
  assert.equal(shouldRecoverTaskPage('https://www.doubao.com/', 'https://www.doubao.com/chat/local_1', 0), true);
  assert.equal(shouldRecoverTaskPage('https://www.doubao.com/', 'https://www.doubao.com/chat/local_1', 1), false);
});

test('does not recover when already on the expected task page', () => {
  assert.equal(shouldRecoverTaskPage('https://www.doubao.com/chat/local_1', 'https://www.doubao.com/chat/local_1', 0), false);
});
