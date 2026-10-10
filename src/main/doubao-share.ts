import { createDecipheriv, createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ShareVideo, ShareParseResult } from '../shared/types';

type JsonObject = Record<string, any>;
export type SharedVideo = { vid: string; model: JsonObject };
const MAX_HTML = 12 * 1024 * 1024;
const MAX_VIDEO = 1024 * 1024 * 1024;

export function normalizeShareUrl(input: string): string {
  if (typeof input !== 'string' || input.length > 10000) throw new Error('请粘贴有效的豆包分享链接');
  const match = input.match(/https:\/\/(?:www\.)?doubao\.com\/thread\/[A-Za-z0-9_-]+(?=$|[\s/?#。，、）)\]」])/);
  if (!match) throw new Error('请使用豆包「分享」生成的 https://www.doubao.com/thread/… 链接');
  const url = new URL(match[0]);
  return `https://www.doubao.com${url.pathname}`;
}

function validateResource(value: string, kind: 'media' | 'playback'): URL {
  const url = new URL(value);
  const domains = kind === 'media' ? ['doubao.com', 'byteimg.com', 'ibytedtos.com', '365yg.com', 'douyinvod.com', 'douyin.com'] : ['snssdk.com'];
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !domains.some((domain) => url.hostname.endsWith(`.${domain}`))) {
    throw new Error('豆包返回了不受支持的资源地址');
  }
  if (kind === 'playback' && !url.pathname.startsWith('/video/fplay/')) throw new Error('视频播放信息格式已变化，请稍后重试');
  return url;
}

function unescapeHtml(value: string) {
  return value.replace(/&(?:quot|apos|amp|lt|gt|#\d+|#x[0-9a-f]+);/gi, (entity) => {
    const named: Record<string, string> = { '&quot;': '"', '&apos;': "'", '&amp;': '&', '&lt;': '<', '&gt;': '>' };
    const key = entity.toLowerCase();
    if (named[key]) return named[key];
    const code = key.startsWith('&#x') ? parseInt(key.slice(3, -1), 16) : parseInt(key.slice(2, -1), 10);
    return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

export function extractSharedVideos(html: string): SharedVideo[] {
  const found = new Map<string, SharedVideo>();
  let visited = 0;
  const walk = (value: unknown, depth = 0): void => {
    if (depth > 32 || ++visited > 80000) return;
    if (typeof value === 'string') {
      if (/^\s*[\[{]/.test(value)) { try { walk(JSON.parse(value), depth + 1); } catch { /* ordinary text */ } }
      return;
    }
    if (!value || typeof value !== 'object') return;
    const object = value as JsonObject;
    if (object.video_model) {
      try {
        const model = typeof object.video_model === 'string' ? JSON.parse(object.video_model) : object.video_model;
        const vid = String(object.vid || model.video_id || '');
        if (/^[\w-]{1,100}$/.test(vid) && typeof model.fallback_api === 'string') {
          found.set(vid, { vid, model });
        }
      } catch { /* malformed block; continue examining other videos */ }
    }
    for (const child of Object.values(object)) walk(child, depth + 1);
  };
  for (const match of html.matchAll(/data-fn-args="([^"]+)"/g)) {
    try { walk(JSON.parse(unescapeHtml(match[1]))); } catch { /* non-JSON attribute */ }
  }
  for (const match of html.matchAll(/(?:_ROUTER_DATA|_SSR_DATA)\s*=\s*({[\s\S]*?)<\/script>/g)) {
    try { walk(JSON.parse(match[1].trim().replace(/;$/, ''))); } catch { /* streamed shell */ }
  }
  if (!found.size) throw new Error('没有找到可解析的视频。请确认分享中包含已生成的视频，且链接未失效；目前支持 thread 视频分享。');
  if (found.size > 20) throw new Error('单次最多解析 20 个视频，请缩小分享范围');
  return [...found.values()];
}

// Playback URL envelope protocol: SHA512(SHA512(seed) || public protocol salt), AES-128-CBC.
// Protocol reference: catscarlet/Download-from-Doubao-Video-Sharing-without-Watermark.
// Independent Node implementation; no third-party script is executed or bundled.
export function decodePlaybackUrl(encoded: string, seed?: string): string {
  let bytes = Buffer.from(encoded, 'base64');
  if (!bytes.toString('utf8', 0, 8).startsWith('https://')) {
    if (!seed || bytes.length < 20) throw new Error('视频地址格式已变化');
    const hash = (input: Buffer) => createHash('sha512').update(input).digest();
    const salt = Buffer.from('TdTC5rgxYgkOUrPHpnM7pByyRiuCmrWKGWs521cXdST0m69/COjWjSanLjfBqVovHwWlGJKu8pSXMrYqOKrdWA==', 'base64');
    const material = hash(Buffer.concat([hash(Buffer.from(seed, 'base64')), salt]));
    const decoder = createDecipheriv('aes-128-cbc', material.subarray(0, 16), material.subarray(16, 32));
    bytes = Buffer.concat([decoder.update(bytes.subarray(4)), decoder.final()]);
  }
  const url = bytes.toString('utf8').replace(/[\x00-\x20]+$/g, '');
  return validateResource(url, 'media').toString();
}

export function selectCleanVideo(model: JsonObject) {
  const choices = Object.values(model.video_list || {}) as JsonObject[];
  const positive = (value: unknown) => { const number = Number(value); return Number.isFinite(number) && number > 0 ? number : 0; };
  choices.sort((a, b) => positive(b.vwidth) * positive(b.vheight) - positive(a.vwidth) * positive(a.vheight)
    || (positive(b.real_bitrate) || positive(b.bitrate)) - (positive(a.real_bitrate) || positive(a.bitrate))
    || positive(b.size) - positive(a.size));
  for (const entry of choices) {
    // New clean renditions may explicitly label logo_type instead of leaving it empty.
    const logoType = String(entry.logo_type ?? '').trim().toLowerCase();
    if ((logoType && logoType !== '0' && logoType !== 'unwatermarked') || entry.encryption_method || entry.vtype !== 'mp4') continue;
    for (const encoded of [entry.main_url, entry.backup_url_1]) {
      if (typeof encoded !== 'string' || !encoded) continue;
      try {
        const url = decodePlaybackUrl(encoded, model.key_seed);
        const watermarkLabel = (new URL(url).searchParams.get('lr') || '').trim().toLowerCase();
        if (watermarkLabel !== 'unwatermarked' && /watermark/i.test(watermarkLabel)) continue;
        return { url, width: Number(entry.vwidth) || 0, height: Number(entry.vheight) || 0, definition: String(entry.definition || '') };
      } catch { /* try backup or another rendition */ }
    }
  }
  throw new Error('暂未获得可下载的无水印视频，请重新解析或稍后重试；没有用带水印版本代替。');
}

async function request(url: string, kind: 'share' | 'media' | 'playback', signal: AbortSignal): Promise<Response> {
  for (let redirects = 0; redirects <= 4; redirects++) {
    if (kind === 'share') {
      const parsed = new URL(url);
      if (parsed.origin !== 'https://www.doubao.com' || !parsed.pathname.startsWith('/thread/')) throw new Error('分享链接跳转到了不支持的页面');
    } else validateResource(url, kind);
    const response = await fetch(url, { signal, redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.doubao.com/' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('豆包资源跳转异常');
      url = new URL(location, url).toString();
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`豆包资源暂时无法访问（HTTP ${response.status}），请重新解析`); }
    return response;
  }
  throw new Error('豆包资源跳转次数过多');
}

async function readText(response: Response): Promise<string> {
  if (!response.body) throw new Error('豆包返回了空内容，请稍后重试');
  const chunks: Uint8Array[] = []; let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_HTML) throw new Error('分享内容过大，请减少分享的视频数量');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}

export class DoubaoShareService {
  private items = new Map<string, { video: ShareVideo; expires: number; savedPath?: string }>();
  private active = new Set<string>();

  async resolveVideo(video: SharedVideo, name = '豆包视频', signal = AbortSignal.timeout(60000)): Promise<ShareVideo> {
    if (!/^[\w-]{1,100}$/.test(video.vid)) throw new Error('无法识别选中的视频');
    const api = validateResource(video.model.fallback_api.replace(/\\u002[fF]/g, '/'), 'playback');
    if (!api.searchParams.get('key_seed')) throw new Error('此视频暂不支持原文件解析');
    // Verified against the user's mini-program download: this rendition returns
    // the same high-quality file byte-for-byte. codec_type=1 selected a smaller HEVC stream.
    api.searchParams.set('logo_type', 'unwatermarked');
    api.searchParams.delete('force_fids');
    api.searchParams.set('channel', 'no');
    api.searchParams.set('codec_type', '8');
    const payload = JSON.parse(await readText(await request(api.toString(), 'playback', signal)));
    if (payload.code !== 0 || payload.video_info?.code !== 0) throw new Error('豆包暂未返回可用的播放信息');
    if (payload.video_info.data?.video_id && payload.video_info.data.video_id !== video.vid) throw new Error('视频信息不匹配，已停止下载，请重新右键选择视频');
    const selected = selectCleanVideo(payload.video_info.data);
    const item: ShareVideo = { id: randomUUID(), name, vid: video.vid, ...selected };
    for (const [id, cached] of this.items) if (cached.expires < Date.now()) this.items.delete(id);
    this.items.set(item.id, { video: item, expires: Date.now() + 15 * 60000 });
    while (this.items.size > 100) this.items.delete(this.items.keys().next().value!);
    return item;
  }

  async parse(input: string): Promise<ShareParseResult> {
    const shareUrl = normalizeShareUrl(input);
    const signal = AbortSignal.timeout(60000);
    try {
      const videos = extractSharedVideos(await readText(await request(shareUrl, 'share', signal)));
      for (const [id, item] of this.items) if (item.expires < Date.now()) this.items.delete(id);
      const result: ShareParseResult = { shareUrl, videos: [], warnings: [] };
      for (const [index, video] of videos.entries()) {
        try {
          result.videos.push(await this.resolveVideo(video, `豆包视频 ${index + 1}`, signal));
        } catch (error) {
          result.warnings.push(`视频 ${index + 1}：${error instanceof Error && !/https?:\/\//.test(error.message) ? error.message : '解析失败，请稍后重试'}`);
        }
      }
      while (this.items.size > 100) this.items.delete(this.items.keys().next().value!);
      if (!result.videos.length) throw new Error(result.warnings.join('\n') || '暂未找到可用的视频');
      return result;
    } catch (error) {
      if (signal.aborted) throw new Error('解析超时，请检查网络后重试');
      if (error instanceof TypeError || error instanceof SyntaxError) throw new Error('豆包暂时没有返回有效数据，请检查网络后重试');
      throw error;
    }
  }

  async save(id: string, directory: string): Promise<{ path: string; video: ShareVideo }> {
    const item = this.items.get(id);
    if (!item || item.expires < Date.now()) throw new Error('解析结果已过期，请重新解析后下载');
    if (this.active.has(id)) throw new Error('该视频正在保存，请稍候');
    if (item.savedPath && fs.existsSync(item.savedPath)) return { path: item.savedPath, video: item.video };
    this.active.add(id);
    const target = path.join(directory, `doubao-${item.video.vid}-${randomUUID().slice(0, 8)}.mp4`);
    const partial = `${target}.part`;
    const signal = AbortSignal.timeout(180000);
    try {
      fs.mkdirSync(directory, { recursive: true });
      const response = await request(item.video.url, 'media', signal);
      if (!response.body) throw new Error('视频文件为空');
      if (Number(response.headers.get('content-length')) > MAX_VIDEO) { await response.body.cancel(); throw new Error('视频超过 1 GB，暂不支持保存'); }
      let size = 0; let header = Buffer.alloc(0); let checked = false;
      const verify = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > MAX_VIDEO) return callback(new Error('视频超过 1 GB，已停止保存'));
        if (!checked) {
          header = Buffer.concat([header, chunk]);
          if (header.length < 12) return callback();
          if (header.toString('ascii', 4, 8) !== 'ftyp') return callback(new Error('返回内容不是 MP4 视频，请重新解析'));
          checked = true; callback(null, header); header = Buffer.alloc(0); return;
        }
        callback(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body as any), verify, fs.createWriteStream(partial, { flags: 'wx' }), { signal });
      if (!checked || size < 32) throw new Error('视频文件不完整，请重试');
      const expected = Number(response.headers.get('content-length'));
      if (expected && size !== expected) throw new Error('视频下载不完整，请重试');
      fs.renameSync(partial, target); item.savedPath = target;
      return { path: target, video: item.video };
    } catch (error) {
      fs.rmSync(partial, { force: true });
      if (signal.aborted) throw new Error('下载超时，请重新解析后重试');
      if (error instanceof TypeError) throw new Error('视频下载失败，请检查网络后重试');
      throw error;
    } finally { this.active.delete(id); }
  }
}
