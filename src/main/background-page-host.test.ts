import test from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserView, BrowserWindow } from 'electron';
import { BackgroundPageHost } from './background-page-host';

function fixture() {
  const windows: { views: BrowserView[]; destroyed: boolean }[] = [];
  const host = new BackgroundPageHost(() => {
    const state = { views: [] as BrowserView[], destroyed: false }; windows.push(state);
    return { isDestroyed: () => state.destroyed, getBrowserViews: () => state.views,
      addBrowserView: (view: BrowserView) => state.views.push(view),
      removeBrowserView: (view: BrowserView) => state.views.splice(state.views.indexOf(view), 1),
      destroy: () => { state.destroyed = true; state.views.length = 0; },
    } as unknown as BrowserWindow;
  });
  const bounds: unknown[] = [];
  const makeView = () => ({ webContents: { isDestroyed: () => false }, setBounds: (value: unknown) => bounds.push(value), setAutoResize: () => {} } as unknown as BrowserView);
  return { host, windows, bounds, makeView };
}

test('reuses a dedicated host for the same account', () => {
  const f = fixture(), view = f.makeView();
  assert.equal(f.host.attach(view), view); f.host.attach(view);
  assert.equal(f.windows.length, 1); assert.deepEqual(f.windows[0].views, [view]);
  assert.deepEqual(f.bounds.at(-1), { x: 0, y: 0, width: 1280, height: 900 });
});

test('account two polling never covers account one uploading in its host', () => {
  const f = fixture(), one = f.makeView(), two = f.makeView();
  f.host.attach(two); f.host.attach(one);
  for (let i = 0; i < 12; i++) { f.host.attach(two); f.host.attach(one); }
  assert.equal(f.windows.length, 2);
  assert.deepEqual(f.windows[0].views, [two]); assert.deepEqual(f.windows[1].views, [one]);
  f.host.detach(one);
  assert.equal(f.windows[1].destroyed, true); assert.equal(f.windows[0].destroyed, false);
  assert.deepEqual(f.windows[0].views, [two]);
  f.host.attach(one); assert.equal(f.windows.length, 3);
  f.host.destroy(); f.host.destroy();
  assert.ok(f.windows.every(window => window.destroyed));
});

test('does not create a host for a destroyed page', () => {
  const f = fixture();
  assert.throws(() => f.host.attach({ webContents: { isDestroyed: () => true } } as unknown as BrowserView), /账号窗口已关闭/);
  assert.equal(f.windows.length, 0);
});
