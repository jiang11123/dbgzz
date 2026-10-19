/**
 * Uploads a local image to Doubao and returns the attachment descriptor its
 * /chat/completion payload expects.
 *
 * Verified against the live site: the page exposes a hidden <input type=file>; setting it
 * makes the site itself call /alice/resource/prepare_upload and then PUT the bytes to TOS
 * (tos-*-x.snssdk.com/upload/v1/tos-cn-i-<service>/<uuid>.<ext>). Reproducing that signing
 * (STS + JWT) in the main process would be fragile, so we let the page do it and read back
 * the resulting object key, which is exactly what the completion request carries as `uri`.
 */
import type { BrowserView } from 'electron';
import { waitForPageReady } from './doubao-api';

export type DoubaoAttachment = {
  /** Object key inside Doubao's bucket, e.g. tos-cn-i-a9rns2rl98/<uuid>.png */
  uri: string;
  name: string;
  /** Pixel size for images; 0 for non-image files. */
  width: number;
  height: number;
  /** File extension, e.g. png / pdf / txt. */
  format: string;
  /** True for images (they carry image_ori in the payload); false for other files. */
  isImage: boolean;
  /** File size in bytes, sent for non-image files. */
  size: number;
};

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Installs a page-side recorder for the TOS upload URL. Idempotent. */
function installRecorderScript(): string {
  return [
    '(() => {',
    '  window.__DS_UPLOADS__ = window.__DS_UPLOADS__ || [];',
    '  if (window.__DS_UPLOAD_PATCHED__) return "already";',
    '  window.__DS_UPLOAD_PATCHED__ = true;',
    '  const record = (u, ok) => {',
    '    if (typeof u === "string" && u.indexOf("/upload/v1/tos-cn-i-") >= 0) {',
    '      const key = u.split("/upload/v1/")[1].split("?")[0];',
    '      if (!key) return;',
    '      if (ok === false) { window.__DS_UPLOAD_FAILED__ = key; return; }',
    '      if (ok === true && window.__DS_UPLOADS__.indexOf(key) < 0) window.__DS_UPLOADS__.push(key);',
    '    }',
    '  };',
    '  const of = window.fetch;',
    '  window.fetch = function() {',
    '    const a = arguments;',
    '    const u = typeof a[0] === "string" ? a[0] : (a[0] && a[0].url) || "";',
    '    return of.apply(this, a).then(function(res) { record(u, res && res.ok); return res; })',
    '      .catch(function(err) { record(u, false); throw err; });',
    '  };',
    '  const oo = XMLHttpRequest.prototype.open;',
    '  XMLHttpRequest.prototype.open = function(m, u) { this.__u = String(u); return oo.apply(this, arguments); };',
    '  const os = XMLHttpRequest.prototype.send;',
    '  XMLHttpRequest.prototype.send = function() {',
    '    const xhr = this;',
    '    xhr.addEventListener("load", function() { record(xhr.__u, xhr.status >= 200 && xhr.status < 300); });',
    '    xhr.addEventListener("error", function() { record(xhr.__u, false); });',
    '    return os.apply(this, arguments);',
    '  };',
    '  return "patched";',
    '})()',
  ].join('\n');
}

/**
 * Pushes one local file through the page's own uploader.
 *
 * Returns the object key the site assigned, which is what the completion payload needs.
 */
export async function uploadImageToDoubao(view: BrowserView, filePath: string, name: string): Promise<DoubaoAttachment> {
  if (view.webContents.isDestroyed()) throw new Error('账号页面已关闭');
  // A freshly warmed background view may still be on about:blank; the file input only
  // exists once the doubao app bundle has booted.
  const ready = await waitForPageReady(view).catch(() => false);
  if (!ready) throw new Error('账号页面尚未就绪，请稍后重试');
  await view.webContents.executeJavaScript(installRecorderScript(), true).catch(() => 'noop');
  // Remember how many uploads we have seen, so we can tell ours apart from earlier ones.
  const before = await view.webContents.executeJavaScript('(window.__DS_UPLOADS__ || []).length', true).catch(() => 0) as number;
  const fileSize = (() => { try { return require('node:fs').statSync(filePath).size; } catch { return 0; } })();

  const debuggerClient = view.webContents.debugger;
  const owned = !debuggerClient.isAttached();
  try {
    if (owned) debuggerClient.attach('1.3');
    const { root } = await debuggerClient.sendCommand('DOM.getDocument');
    const { nodeIds } = await debuggerClient.sendCommand('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type=file]' });
    if (!nodeIds.length) throw new Error('豆包页面没有图片上传入口，请打开账号页面后重试');
    // Clear first: reusing the same input value does not re-trigger the site's handler.
    await view.webContents.executeJavaScript('(() => { document.querySelectorAll("input[type=file]").forEach(i => { try { i.value = ""; } catch (e) {} }); return true; })()', true).catch(() => undefined);
    await debuggerClient.sendCommand('DOM.setFileInputFiles', { files: [filePath], nodeId: nodeIds[0] });
  } finally { if (owned && debuggerClient.isAttached()) debuggerClient.detach(); }

  // The upload is a prepare_upload round trip plus a TOS PUT; give it room.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await pause(500);
    if (view.webContents.isDestroyed()) throw new Error('账号页面已关闭');
    const list = await view.webContents.executeJavaScript('window.__DS_UPLOADS__ || []', true).catch(() => [] as string[]) as string[];
    const fresh = list.slice(before);
    if (fresh.length) {
      const uri = fresh[fresh.length - 1];
      const format = (uri.split('.').pop() || 'png').toLowerCase();
      // The site sends real pixel dimensions; 0 makes doubao treat the image as unreadable.
      const size = readImageSize(filePath);
      const isImage = size.width > 0 && size.height > 0;
      return { uri, name, width: size.width, height: size.height, format, isImage, size: fileSize };
    }
  }
  const failed = await view.webContents.executeJavaScript('window.__DS_UPLOAD_FAILED__ || ""', true).catch(() => '') as string;
  if (failed) throw new Error('图片上传失败（' + failed + '），请稍后重试');
  throw new Error('图片上传超时，请在账号页面重试');
}


/** Reads pixel dimensions from a PNG/JPEG/GIF header (0 when unknown). */
export function readImageSize(filePath: string): { width: number; height: number } {
  try {
    const buffer = require('node:fs').readFileSync(filePath) as Buffer;
    // PNG: IHDR width/height sit at bytes 16 and 20.
    if (buffer.length > 24 && buffer.toString('ascii', 1, 4) === 'PNG') {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    // GIF: little-endian at bytes 6 and 8.
    if (buffer.length > 10 && buffer.toString('ascii', 0, 3) === 'GIF') {
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }
    // JPEG: walk the segment markers until the SOF frame.
    if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) { offset += 1; continue; }
        const marker = buffer[offset + 1];
        const length = buffer.readUInt16BE(offset + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
        }
        offset += 2 + length;
      }
    }
  } catch { /* unknown size */ }
  return { width: 0, height: 0 };
}

/** Builds the attachment_block message Doubao expects alongside the text message. */
export type DoubaoAttachmentMessage = {
  local_message_id: string;
  content_block: Array<{
    block_type: number;
    content: { attachment_block: { attachments: unknown[] }; pc_event_block: string };
    block_id: string;
    parent_id: string;
    meta_info: unknown[];
    extra_info: Record<string, unknown>;
    append_fields: unknown[];
  }>;
  message_status: number;
};

export function buildAttachmentMessage(attachments: DoubaoAttachment[]): DoubaoAttachmentMessage {
  const uuid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : Math.random().toString(16).slice(2));
  return {
    local_message_id: uuid(),
    content_block: [{
      block_type: 10052,
      content: {
        attachment_block: {
          attachments: attachments.map(item => ({
            type: item.isImage ? 1 : 3,
            identifier: uuid(),
            // Images carry image_ori with pixel size; other files carry the file shape.
            // Both verified against live captures: image type=1 parse_state=0,
            // file type=3 parse_state=1 file_type=0. Getting these wrong makes doubao
            // accept the message but claim it cannot read the file.
            ...(item.isImage
              ? { image: {
                  name: item.name,
                  uri: item.uri,
                  image_ori: { url: '', width: item.width, height: item.height, format: item.format, url_formats: {} },
                } }
              : { file: {
                  uri: item.uri,
                  url: '',
                  file_type: 0,
                  name: item.name,
                  size: item.size,
                } }),
            parse_state: item.isImage ? 0 : 1,
            review_state: 1,
            upload_status: 1,
            progress: 100,
            src: '',
          })),
        },
        pc_event_block: '',
      },
      block_id: uuid(),
      parent_id: '',
      meta_info: [],
      extra_info: {},
      append_fields: [],
    }],
    message_status: 0,
  };
}
