/// <reference lib="dom" />
import { Menu, clipboard, type BrowserWindow, type WebContents, type MenuItemConstructorOptions } from 'electron';
import type { SharedVideo } from './doubao-share';

// Serialized into the selected page. Must remain self-contained and return only video metadata.
export function captureVideoAtPoint(point: { x: number; y: number }): SharedVideo | null {
  const clicked = document.elementFromPoint(point.x, point.y);
  if (!clicked) return null;
  let media: HTMLImageElement | HTMLVideoElement | null = clicked.closest('video,img');
  if (!media) {
    // The play button often covers the actual image/video element.
    let scope: Element | null = clicked;
    for (let level = 0; scope && level < 4; level++, scope = scope.parentElement) {
      const matches = [...scope.querySelectorAll<HTMLImageElement | HTMLVideoElement>('video,img')].filter((element) => {
        const rect = element.getBoundingClientRect();
        return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
      });
      if (matches.length === 1) { media = matches[0]; break; }
      const videos = matches.filter(element => element.tagName === 'VIDEO');
      if (matches.length === 2 && videos.length === 1) { media = videos[0]; break; }
      if (matches.length > 1 || scope.hasAttribute('data-message-id')) break;
    }
  }
  if (!media) return null;
  const mediaElement = media;
  const identity = (value: string) => { try { const url = new URL(value, location.href); return url.origin + url.pathname; } catch { return value; } };
  const source = identity(media.currentSrc || media.src || '');
  const poster = media instanceof HTMLVideoElement && media.poster ? identity(media.poster) : '';
  let scope: Element | null = media;
  for (let level = 0; scope && level < 9; level++, scope = scope.parentElement) {
    if (scope === document.body || scope === document.documentElement) break;
    const candidates = new Map<string, { video: SharedVideo; matches: boolean }>();
    const seen = new WeakSet<object>(); let visited = 0;
    const walk = (value: unknown, depth: number): void => {
      if (++visited > 12000 || depth > 15 || !value) return;
      if (typeof value === 'string') {
        if (value.length < 2 * 1024 * 1024 && /^\s*[\[{]/.test(value)) { try { walk(JSON.parse(value), depth + 1); } catch { /* plain text */ } }
        return;
      }
      if (typeof value !== 'object' || value instanceof Node || seen.has(value)) return;
      seen.add(value);
      const object = value as Record<string, any>;
      const raw = object.video_model || object.videoModel;
      if (raw) {
        try {
          const model = typeof raw === 'string' ? JSON.parse(raw) : raw;
          const vid = String(object.vid || model.video_id || '');
          if (/^[\w-]{1,100}$/.test(vid) && typeof model.fallback_api === 'string') {
            const refs: string[] = [];
            const urls = (value: unknown, depth: number) => {
              if (depth > 5 || !value) return;
              if (typeof value === 'string' && /^https?:/.test(value)) refs.push(identity(value));
              else if (typeof value === 'object' && !(value instanceof Node)) {
                for (const [key, child] of Object.entries(value)) if (!['_owner', 'return', 'video_model', 'videoModel'].includes(key)) urls(child, depth + 1);
              }
            };
            urls(object, 0);
            candidates.set(vid, {
              video: { vid, model: { video_id: vid, fallback_api: model.fallback_api } },
              matches: candidates.get(vid)?.matches || refs.some(ref => ref === source || (poster && ref === poster)) || false,
            });
          }
        } catch { /* malformed player data */ }
      }
      for (const [key, child] of Object.entries(object)) {
        if (!['_owner', 'return', 'stateNode', 'video_model', 'videoModel'].includes(key)) walk(child, depth + 1);
      }
    };
    for (const key of Object.keys(scope)) {
      if (key.startsWith('__reactProps$')) walk((scope as any)[key], 0);
      if (key.startsWith('__reactFiber$')) walk((scope as any)[key]?.memoizedProps, 0);
    }
    const exact = [...candidates.values()].filter(candidate => candidate.matches);
    if (exact.length === 1) return exact[0].video;
    const mediaCount = scope.matches('video,img') ? 1 : scope.querySelectorAll('video,img').length;
    const visibleMedia = [...scope.querySelectorAll('video,img')].filter(element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; });
    // A hovered player contains both the poster image and its video at the same position.
    // Treat that pair as one player, but never collapse multiple video elements.
    const onePlayer = scope.querySelectorAll('video').length === 1 && visibleMedia.length <= 2 && visibleMedia.every(element => {
      const rect = element.getBoundingClientRect();
      return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
    });
    if (candidates.size === 1 && (mediaCount === 1 || onePlayer) && scope.contains(mediaElement)) return [...candidates.values()][0].video;
    if (candidates.size > 1 || scope.hasAttribute('data-message-id')) return null;
  }
  return null;
}

// Serialized into the page to extract the latest generated video's SharedVideo metadata for HD download
export function captureLatestVideo(): SharedVideo | null {
  const elements = Array.from(document.querySelectorAll<HTMLVideoElement | HTMLElement>('video, [data-message-id] video, .video-card, [class*="video"]'));
  const videos = elements.reverse();
  for (const media of videos) {
    let scope: Element | null = media;
    for (let level = 0; scope && level < 10; level++, scope = scope.parentElement) {
      if (scope === document.body || scope === document.documentElement) break;
      const candidates = new Map<string, SharedVideo>();
      const seen = new WeakSet<object>(); let visited = 0;
      const walk = (value: unknown, depth: number): void => {
        if (++visited > 12000 || depth > 15 || !value) return;
        if (typeof value === 'string') {
          if (value.length < 2 * 1024 * 1024 && /^\s*[\[{]/.test(value)) { try { walk(JSON.parse(value), depth + 1); } catch { /* ignore */ } }
          return;
        }
        if (typeof value !== 'object' || value instanceof Node || seen.has(value)) return;
        seen.add(value);
        const object = value as Record<string, any>;
        const raw = object.video_model || object.videoModel;
        if (raw) {
          try {
            const model = typeof raw === 'string' ? JSON.parse(raw) : raw;
            const vid = String(object.vid || model.video_id || '');
            if (/^[\w-]{1,100}$/.test(vid) && typeof model.fallback_api === 'string') {
              candidates.set(vid, { vid, model: { video_id: vid, fallback_api: model.fallback_api } });
            }
          } catch { /* malformed */ }
        }
        for (const [key, child] of Object.entries(object)) {
          if (!['_owner', 'return', 'stateNode', 'video_model', 'videoModel'].includes(key)) walk(child, depth + 1);
        }
      };
      for (const key of Object.keys(scope)) {
        if (key.startsWith('__reactProps$')) walk((scope as any)[key], 0);
        if (key.startsWith('__reactFiber$')) walk((scope as any)[key]?.memoizedProps, 0);
      }
      if (candidates.size > 0) return [...candidates.values()][candidates.size - 1];
    }
  }
  return null;
}

export function attachVideoContextMenu(contents: WebContents, owner: () => BrowserWindow | null, download: (video: SharedVideo) => Promise<void>) {
  type ContextPoint = { x: number; y: number; mediaType: string; isEditable?: boolean; selectionText?: string; linkURL?: string };
  let requestNumber = 0;
  const showMenu = async (params: ContextPoint) => {
    if (contents.isDestroyed() || !Number.isFinite(params.x) || !Number.isFinite(params.y) || params.x < 0 || params.y < 0 || params.x > 20000 || params.y > 20000) return;
    const request = ++requestNumber;
    const pageUrl = contents.getURL();
    let supported = false;
    try { supported = new URL(pageUrl).hostname === 'www.doubao.com'; } catch { /* not a web page */ }
    if (!supported) return;
    let target: SharedVideo | null = null;
    try {
      target = await contents.executeJavaScript(`(${captureVideoAtPoint.toString()})(${JSON.stringify({ x: params.x, y: params.y })})`);
    } catch { /* page may be navigating */ }
    const window = owner();
    if (!window || window.isDestroyed() || contents.isDestroyed() || contents.getURL() !== pageUrl || request !== requestNumber) return;
    const selected = target;
    const template: MenuItemConstructorOptions[] = [];
    if (selected || params.mediaType === 'video' || params.mediaType === 'image') {
      template.push({ label: selected ? '高清下载' : '高清下载（请先打开视频后重试）', enabled: Boolean(selected), click: () => { if (selected) void download(selected).catch(() => {}); } });
    }
    if (selected) {
      Menu.buildFromTemplate(template).popup({ window });
      return;
    }
    if (params.isEditable) template.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
    else if (params.selectionText) template.push({ role: 'copy' });
    if (params.linkURL) template.push({ label: '复制链接地址', click: () => clipboard.writeText(params.linkURL!) });
    if (params.mediaType === 'image') template.push({ label: '复制图片', click: () => contents.copyImageAt(params.x, params.y) });
    if (!template.length) return;
    Menu.buildFromTemplate(template).popup({ window });
  };
  contents.on('context-menu', (event, params) => {
    event.preventDefault();
    void showMenu(params).catch(() => {});
  });
  contents.on('ipc-message', (event, channel, value) => {
    if (channel !== 'doubao:video-context' || event.senderFrame !== contents.mainFrame || !value || typeof value !== 'object') return;
    if (value.mediaType !== 'video' && value.mediaType !== 'image') return;
    void showMenu({ x: value.x, y: value.y, mediaType: value.mediaType }).catch(() => {});
  });
}
