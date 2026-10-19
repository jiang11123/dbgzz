import test from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserView, BrowserWindow } from 'electron';
import { BackgroundPageHost } from './background-page-host';

function fixture() {
  const views: BrowserView[] = [];
  let destroyed = false;
  let created = 0;
  const window = { isDestroyed: () => destroyed, getBrowserViews: () => views,
    addBrowserView: (view: BrowserView) => views.push(view),
    removeBrowserView: (view: BrowserView) => views.splice(views.indexOf(view), 1),
    destroy: () => { destroyed = true; views.length = 0; },
  } as unknown as BrowserWindow;
  const bounds: unknown[] = [];
  const view = { webContents: { isDestroyed: () => false }, setBounds: (value: unknown) => bounds.push(value), setAutoResize: () => {} } as unknown as BrowserView;
  const host = new BackgroundPageHost(() => { created++; return window; });
  return { host, window, view, views, bounds, created: () => created };
}

test('hosts a DOM page at usable dimensions without recreating or showing its window', () => {
  const f = fixture();
  assert.equal(f.host.attach(f.view), f.view);
  f.host.attach(f.view);
  assert.equal(f.created(), 1);
  assert.deepEqual(f.views, [f.view]);
  assert.deepEqual(f.bounds.at(-1), { x: 0, y: 0, width: 1280, height: 900 });
});

test('detaches for foreground transfer and destroys the hidden host on shutdown', () => {
  const f = fixture();
  f.host.attach(f.view);
  f.host.detach(f.view);
  f.host.detach(f.view);
  assert.equal(f.views.length, 0);
  f.host.attach(f.view);
  f.host.destroy();
  f.host.destroy();
  assert.equal(f.window.isDestroyed(), true);
});

test('does not create a host for a destroyed page', () => {
  const f = fixture();
  const dead = { webContents: { isDestroyed: () => true } } as unknown as BrowserView;
  assert.throws(() => f.host.attach(dead), /账号窗口已关闭/);
  assert.equal(f.created(), 0);
});
