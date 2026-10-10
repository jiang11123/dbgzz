import test from 'node:test';
import assert from 'node:assert/strict';
import { platformConfig } from './account-platform';

test('opens a Dola account on the international Dola entry with its own session', () => {
  assert.deepEqual(platformConfig('dola', 12), {
    label: 'Dola',
    homeUrl: 'https://www.dola.com/',
    sessionName: 'persist:dola_12',
  });
});

test('keeps a Doubao account on the domestic Doubao entry with its own session', () => {
  assert.deepEqual(platformConfig('doubao', 12), {
    label: '豆包',
    homeUrl: 'https://www.doubao.com/',
    sessionName: 'persist:doubao_12',
  });
});
