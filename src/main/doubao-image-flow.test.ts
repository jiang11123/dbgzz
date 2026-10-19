import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

// generateImages() talks to Electron (ipcMain + a BrowserView). The orchestration is
// where UI-end-to-end failures hide: a lost push frame, a buffer that never flips
// `done`, or an error that arrives after the images were already collected. These
// tests drive that loop against a fake page so the contract is pinned offline.
type Frame = { requestId?: string; event?: string; error?: string; done?: boolean };

const listeners = new Set<(event: unknown, payload: Frame) => void>();
const fakeIpcMain = {
  on: (channel: string, listener: (event: unknown, payload: Frame) => void) => {
    assert.equal(channel, 'doubao:stream');
    listeners.add(listener);
  },
  removeListener: (_channel: string, listener: (event: unknown, payload: Frame) => void) => { listeners.delete(listener); },
};

const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: unknown[]) {
  if (request === 'electron') return { ipcMain: fakeIpcMain };
  return originalLoad.call(this, request, ...rest);
};

// Imported after the shim so the module binds the fake ipcMain.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { generateImages } = require('./doubao-image');
(Module as any)._load = originalLoad;

/** A fake account page: records scripts, serves scripted drain results. */
function makeView(script: {
  drains: Array<{ events: string[]; done: boolean; error: string | null } | null>;
  pushes?: Frame[];
  ready?: boolean;
}) {
  const executed: string[] = [];
  let drainIndex = 0;
  const view = {
    webContents: {
      isDestroyed: () => false,
      executeJavaScript: async (code: string) => {
        executed.push(code);
        // Cleanup script (runs last, in the finally block).
        if (code.includes('delete window.__DSBUF')) return true;
        // The drain script splices the buffer; the start script signs a fetch.
        if (!code.includes('buffer.events.splice')) return true;
        return script.drains[Math.min(drainIndex++, script.drains.length - 1)] ?? null;
      },
    },
  };
  return { view: view as any, executed, push: (frame: Frame) => { for (const l of listeners) l({}, frame); } };
}

const imageEvent = (url: string) => JSON.stringify({
  event_data: JSON.stringify({
    message: JSON.stringify({
      content_type: 2010,
      content: JSON.stringify({ data: [{ image_ori: { url, width: 2048, height: 2048, format: 'png' } }] }),
    }),
  }),
});

test('collects images from pushed frames and finishes when the stream ends', async () => {
  const url = 'https://p3-flow-imagex-sign.byteimg.com/a.png';
  const fake = makeView({
    drains: [null, { events: [imageEvent(url)], done: true, error: null }],
  });
  // The push bridge delivers frames before the poll loop drains the buffer.
  fake.push({ requestId: 'never-matches', event: '{}' });
  const images = await generateImages(fake.view, 'a cat', { timeoutMs: 5000 });
  assert.equal(images.length, 1);
  assert.equal(images[0].url, url);
  assert.equal(images[0].width, 2048);
  // The start script must carry the image payload and path.
  assert.ok(fake.executed.some(code => code.includes('/samantha/chat/completion') && code.includes('2009')));
});

test('turns a throttled text reply into a cool-down error, not no-images', async () => {
  const throttle = JSON.stringify({ event_data: { message: { content_type: 2001, content: JSON.stringify({ text: '当前服务访问频繁，请稍后重试' }) } } });
  const fake = makeView({ drains: [{ events: [throttle], done: true, error: null }] });
  await assert.rejects(() => generateImages(fake.view, 'x', { timeoutMs: 5000 }), /访问频繁|稍后重试/);
});

test('surfaces a risk-control error code with the verification hint', async () => {
  const fake = makeView({ drains: [{ events: [JSON.stringify({ error_code: 710022004, error_msg: 'verify' })], done: true, error: null }] });
  await assert.rejects(() => generateImages(fake.view, 'x', { timeoutMs: 5000 }), /人机验证/);
});

test('reports the stream error the page raised', async () => {
  const fake = makeView({ drains: [{ events: [], done: true, error: '页面未返回可用签名，请刷新账号页面后重试' }] });
  await assert.rejects(() => generateImages(fake.view, 'x', { timeoutMs: 5000 }), /签名/);
});

test('times out with the event count when the stream never ends', async () => {
  const fake = makeView({ drains: [null] });
  await assert.rejects(() => generateImages(fake.view, 'x', { timeoutMs: 300 }), /超时/);
});

test('rejects an empty prompt before touching the page', async () => {
  const fake = makeView({ drains: [] });
  await assert.rejects(() => generateImages(fake.view, '   ', { timeoutMs: 300 }), /提示词为空/);
  assert.equal(fake.executed.length, 0);
});

test('rejects a destroyed page before signing', async () => {
  const fake = makeView({ drains: [] });
  fake.view.webContents.isDestroyed = () => true;
  await assert.rejects(() => generateImages(fake.view, 'x'), /已关闭/);
});