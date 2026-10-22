import type { BrowserView } from 'electron';
import type { AccountCapabilities, ComposerSettings } from '../shared/account-send';
import { draftImageStateScript } from './chat-images';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Clicks a point with real (trusted) mouse events.
 *
 * The model / ratio / duration panels are React overlays that do not always react to a
 * synthetic el.click(); dispatching real input events at the element's centre is what a
 * human click actually does, so those panels open reliably.
 */
async function clickPoint(view: BrowserView, point: unknown) {
  const p = point as { x?: number; y?: number } | null;
  if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return;
  view.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
  view.webContents.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  view.webContents.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await pause(150);
}

export const composerSettingsScript = `(() => {
  try {
    const visible = n => {
      try {
        const r = n && typeof n.getBoundingClientRect === 'function' ? n.getBoundingClientRect() : null;
        return Boolean(r && r.width > 0 && r.height > 0);
      } catch { return false; }
    };
    const norm = s => (s || '').replace(/\\s+/g, ' ').trim();
    const getAttr = (n, attr) => {
      try { return (n && typeof n.getAttribute === 'function' ? n.getAttribute(attr) : '') || ''; }
      catch { return ''; }
    };
    const getText = n => {
      try { return norm(n ? (n.innerText || n.textContent || '') : ''); }
      catch { return ''; }
    };
    const input = [...document.querySelectorAll('[contenteditable=true],textarea')].find(n => visible(n) && !n.disabled);
    if (!input) return {mode:'chat'};
    // The active skill renders as an exit chip in the composer toolbar: <div data-testid=skill_input_exit_button>视频生成</div>.
    const chip = [...document.querySelectorAll('[data-testid=skill_input_exit_button]')].find(visible);
    const chipText = chip ? getText(chip) : '';
    const modeBtn = [...document.querySelectorAll('#chat_input_action_mode,[data-testid=chat_input_action_mode]')].find(visible);
    const modeBtnText = modeBtn ? getText(modeBtn) : '';
    const placeholder = getAttr(input, 'placeholder') || getAttr(input, 'data-placeholder');
    const chipRect = chip ? chip.getBoundingClientRect() : null;
    const near = chipRect
      ? [...document.querySelectorAll('button,[role=button]')].filter(n => visible(n) && Math.abs(n.getBoundingClientRect().bottom - chipRect.bottom) < 24)
      : [];
    const nearTexts = near.map(n => getText(n)).filter(Boolean);
    const modelRaw = nearTexts.find(s => /^模型\\s*\\S/.test(s)) || '';
    const model = modelRaw ? modelRaw.replace(/^模型\\s*/, '').trim() : undefined;
    const ratio = nearTexts.map(s => s.replace(/\\s+/g, '').replace('：', ':')).find(s => /^\\d+:\\d+$/.test(s));
    // 'auto · 10s' carries the duration the page will actually use.
    const durationRaw = nearTexts.find(s => /^(?:自动|auto)\\s*[·.]?\\s*\\d+\\s*s?$/i.test(s)) || '';
    const duration = (() => { const m = /(\\d+)\\s*s?$/i.exec(durationRaw); return m ? Number(m[1]) : undefined; })();
    const video = /视频生成|生成视频|video/i.test(chipText) || /视频生成|生成视频/i.test(modeBtnText) || (!chipText && /描述你想要的视频|视频/.test(placeholder));
    const image = !video && (/图像生成|图片生成|生成图片|画图|image/i.test(chipText) || /图像生成|图片生成/i.test(modeBtnText));
    const modeLabel = chipText || modeBtnText || undefined;
    const mode = video ? 'video' : image ? 'image' : chipText ? 'other' : 'chat';
    return {mode, modeLabel, model, ratio, duration: duration && duration > 0 ? duration : undefined};
  } catch (err) {
    return {mode:'chat'};
  }
})()`;

export async function readComposerSettings(view: BrowserView): Promise<ComposerSettings> {
  if (view.webContents.isDestroyed()) throw new Error('账号窗口已关闭');
  try {
    return await view.webContents.executeJavaScript(composerSettingsScript, true);
  } catch {
    return { mode: 'chat' };
  }
}

export async function waitForComposer(view: BrowserView) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (view.webContents.isDestroyed()) throw new Error('账号窗口已关闭');
    try {
      if (!view.webContents.isLoading()) {
        const hasInput = await view.webContents.executeJavaScript(`(() => {
          try {
            return Boolean([...document.querySelectorAll('[contenteditable=true],textarea')].find(n => {
              try { return n.getBoundingClientRect().width > 0 && !n.disabled; } catch { return false; }
            }));
          } catch { return false; }
        })()`, true);
        if (hasInput) return;
      }
    } catch {}
    await pause(250);
  }
  throw new Error('目标账号未出现输入框，请打开执行账号检查页面加载状态');
}

/** Centre point of the first visible element matching the given skill label inside the composer toolbar. */
const skillButtonPointScript = (label: string) => `(() => {
  try {
    const visible = n => {
      try {
        const r = n && typeof n.getBoundingClientRect === 'function' ? n.getBoundingClientRect() : null;
        return Boolean(r && r.width > 0 && r.height > 0);
      } catch { return false; }
    };
    const want = ${JSON.stringify(label)};
    const norm = s => (s || '').replace(/\\s+/g, ' ').trim();
    const getAttr = (n, attr) => {
      try { return (n && typeof n.getAttribute === 'function' ? n.getAttribute(attr) : '') || ''; }
      catch { return ''; }
    };
    const getText = n => {
      try { return norm(n ? (n.innerText || n.textContent || '') : ''); }
      catch { return ''; }
    };
    const isMatch = s => {
      const text = norm(s);
      if (!text) return false;
      if (text === want) return true;
      if (want === '视频生成' || want === '生成视频') {
        return /^(?:AI\\s*)?(?:视频生成|生成视频)/i.test(text) || text.includes('视频生成');
      }
      if (want === '图像生成' || want === '图片生成') {
        return /^(?:AI\\s*)?(?:图像生成|图片生成|生成图片)/i.test(text) || text.includes('图像生成') || text.includes('图片生成');
      }
      return text.includes(want);
    };
    const input = [...document.querySelectorAll('[contenteditable=true],textarea')].find(n => visible(n));
    const rect = input ? input.getBoundingClientRect() : null;
    const nodes = [...document.querySelectorAll('[data-testid^=skill_bar_button_],button,[role=button],[role=menuitem],[role=option]')]
      .filter(n => visible(n) && isMatch(getText(n) || getAttr(n, 'aria-label') || getAttr(n, 'title')))
      .filter(n => !rect || n.getBoundingClientRect().bottom > rect.top - 200);
    if (!nodes.length) return null;
    const target = nodes[nodes.length - 1];
    const r = target.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) return null;
    const pt = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    const opts = { bubbles: true, cancelable: true, clientX: pt.x, clientY: pt.y };
    try {
      target.dispatchEvent(new PointerEvent('pointerdown', opts));
      target.dispatchEvent(new MouseEvent('mousedown', opts));
      target.dispatchEvent(new PointerEvent('pointerup', opts));
      target.dispatchEvent(new MouseEvent('mouseup', opts));
      target.dispatchEvent(new MouseEvent('click', opts));
      if (typeof target.click === 'function') target.click();
    } catch (_) {}
    return pt;
  } catch (err) {
    return null;
  }
})()`;

/** Makes the composer's skill bar visible: it only renders once the editor has been focused/expanded. */
async function expandSkillBar(view: BrowserView) {
  const count = () => view.webContents.executeJavaScript(
    `(() => { try { return document.querySelectorAll('[data-testid^=skill_bar_button_]').length; } catch { return 0; } })()`, true).catch(() => 0);
  if (await count() > 0) return true;
  if (!view.webContents.isDestroyed()) view.webContents.focus();
  const clickCoords = await view.webContents.executeJavaScript(`(() => {
    try {
      const all = [...document.querySelectorAll('[contenteditable=true],textarea')].filter(n => {
        try {
          const r = n.getBoundingClientRect();
          return r.width > 0 && !n.disabled;
        } catch { return false; }
      });
      const ed = all.find(n => n.getAttribute('contenteditable') === 'true') || all[all.length - 1];
      if (!ed) return null;
      ed.focus();
      const rect = ed.getBoundingClientRect();
      const pt = { x: Math.round(rect.left + Math.min(50, rect.width / 2)), y: Math.round(rect.top + rect.height / 2) };
      const opts = { bubbles: true, cancelable: true, clientX: pt.x, clientY: pt.y };
      try {
        ed.dispatchEvent(new PointerEvent('pointerdown', opts));
        ed.dispatchEvent(new MouseEvent('mousedown', opts));
        ed.dispatchEvent(new PointerEvent('pointerup', opts));
        ed.dispatchEvent(new MouseEvent('mouseup', opts));
        ed.dispatchEvent(new MouseEvent('click', opts));
      } catch (_) {}
      return pt;
    } catch { return null; }
  })()`, true).catch(() => null);
  if (clickCoords) {
    await clickPoint(view, clickCoords);
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    await pause(250);
    if (await count() > 0) return true;
  }
  return false;
}

export async function ensureComposerMode(view: BrowserView, settings: ComposerSettings) {
  await waitForComposer(view);
  const matches = (state: ComposerSettings) => state.mode === settings.mode && (settings.mode !== 'other' || state.modeLabel === settings.modeLabel);
  let current = await readComposerSettings(view);
  if (matches(current)) return;
  const label = settings.mode === 'video' ? '视频生成' : settings.mode === 'image' ? '图像生成' : settings.mode === 'chat' ? '对话' : settings.modeLabel;
  if (!label) throw new Error('未识别到来源模式，请先在目标账号手动选择模式');

  if (!view.webContents.isDestroyed()) view.webContents.focus();
  for (let attempt = 0; attempt < 4; attempt++) {
    await expandSkillBar(view);
    // 1. The skill bar exposes the mode directly as a chip button (视频生成 / PPT 生成 / 图像生成 ...).
    let point = await view.webContents.executeJavaScript(skillButtonPointScript(label), true).catch(() => null);
    if (!point) {
      // 2. Otherwise open the composer menu through the mode button or the '+' tool button.
      const opener = await view.webContents.executeJavaScript(`(() => {
        try {
          const visible = n => {
            try {
              const r = n && typeof n.getBoundingClientRect === 'function' ? n.getBoundingClientRect() : null;
              return Boolean(r && r.width > 0 && r.height > 0);
            } catch { return false; }
          };
          const norm = s => (s || '').replace(/\\s+/g, ' ').trim();
          const getAttr = (n, attr) => {
            try { return (n && typeof n.getAttribute === 'function' ? n.getAttribute(attr) : '') || ''; }
            catch { return ''; }
          };
          const getText = n => {
            try { return norm(n ? (n.innerText || n.textContent || '') : ''); }
            catch { return ''; }
          };
          const input = [...document.querySelectorAll('[contenteditable=true],textarea')].find(n => visible(n));
          const rect = input ? input.getBoundingClientRect() : null;
          const candidates = [...document.querySelectorAll('button,[role=button]')].filter(n => visible(n));
          const target = candidates.find(n => n.id === 'chat_input_action_mode' || getAttr(n, 'data-testid') === 'chat_input_action_mode')
            || candidates.find(n => /^(?:更多|More|Tools)$/i.test(getText(n)))
            || candidates.find(n => getAttr(n, 'data-testid') === 'upload_file_button')
            || candidates.find(n => /^[+＋]$/.test(getText(n)) && (!rect || Math.abs(n.getBoundingClientRect().bottom - rect.bottom) < 120));
          if (!target) return null;
          const r = target.getBoundingClientRect();
          if (!r || r.width <= 0 || r.height <= 0) return null;
          const pt = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          const opts = { bubbles: true, cancelable: true, clientX: pt.x, clientY: pt.y };
          try {
            target.dispatchEvent(new PointerEvent('pointerdown', opts));
            target.dispatchEvent(new MouseEvent('mousedown', opts));
            target.dispatchEvent(new PointerEvent('pointerup', opts));
            target.dispatchEvent(new MouseEvent('mouseup', opts));
            target.dispatchEvent(new MouseEvent('click', opts));
            if (typeof (target as any).click === 'function') (target as any).click();
          } catch (_) {}
          return pt;
        } catch { return null; }
      })()`, true).catch(() => null);
      if (opener) {
        await clickPoint(view, opener);
        await pause(700);
        point = await view.webContents.executeJavaScript(skillButtonPointScript(label), true).catch(() => null);
      }
    }
    if (point) {
      await clickPoint(view, point);
      // Entering a video skill re-renders the composer; give it time to settle.
      for (let wait = 0; wait < 20; wait++) {
        await pause(400);
        current = await readComposerSettings(view);
        if (matches(current)) return;
      }
    }
    await pause(300);
  }

  for (let attempt = 0; attempt < 12; attempt++) {
    await pause(250);
    current = await readComposerSettings(view);
    if (matches(current)) return;
  }
  throw new Error(`无法确认目标账号已进入【${settings.mode === 'video' ? '视频生成' : settings.mode === 'image' ? '图像生成' : settings.mode}】模式，已停止发送。请在目标窗口手动选择模式后重试`);
}

/**
 * Sets video ratio and duration through Doubao's native panel (4s-30s slider + ratio grid).
 */
export async function selectDoubaoVideoSettings(view: BrowserView, options: { ratio?: string; duration?: number }) {
  const { ratio, duration } = options;
  if (!ratio && (!duration || duration <= 0)) return;

  const triggerKey = '自动|时长|比例|·|\\d+\\s*[:：]\\s*\\d+|\\d+\\s*s$';
  const openTrigger = async () => {
    const isOpen = await view.webContents.executeJavaScript(`(() => {
      const text = document.body ? (document.body.innerText || '') : '';
      return text.includes('比例') && (text.includes('时长') || text.includes('30s'));
    })()`);
    if (isOpen) return true;

    const point = await view.webContents.executeJavaScript(`(() => {
      const input = [...document.querySelectorAll('[contenteditable=true],textarea')].find(n => n.getBoundingClientRect().width > 0);
      const bottom = input?.getBoundingClientRect().bottom || window.innerHeight;
      const nodes = [...document.querySelectorAll('button,[role=button]')].filter(n => {
        const r = n.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && Math.abs(r.bottom - bottom) < 260;
      });
      const re = new RegExp(${JSON.stringify(triggerKey)}, 'i');
      const target = nodes.find(n => re.test((n.innerText || n.getAttribute('aria-label') || '').trim()));
      if (!target) return null;
      const r = target.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    if (!point) return false;
    await clickPoint(view, point);
    await pause(600);
    return true;
  };

  const opened = await openTrigger();
  if (!opened) throw new Error('目标账号未找到比例与时长设置入口');

  // 1. Select Ratio if specified
  if (ratio) {
    const wantedRatio = ratio.replace(/\s+/g, '').replace('：', ':');
    const ratioPoint = await view.webContents.executeJavaScript(`(() => {
      const nodes = [...document.querySelectorAll('button,[role=button],div,span')].filter(n => {
        const r = n.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      const target = nodes.find(n => {
        const t = (n.innerText || '').trim().replace(/\\s+/g, '').replace('：', ':');
        return t === ${JSON.stringify(wantedRatio)};
      });
      if (!target) return null;
      const r = target.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    if (ratioPoint) {
      await clickPoint(view, ratioPoint);
      await pause(400);
    }
  }

  // 2. Select Duration if specified
  if (duration && duration > 0) {
    const targetSec = Math.min(30, Math.max(4, Math.round(duration)));
    const durationApplied = await view.webContents.executeJavaScript(`(() => {
      const range = [...document.querySelectorAll('input[type=range]')].find(n => n.getBoundingClientRect().width > 0 || n.offsetWidth > 0);
      if (range) {
        const proto = Object.getPrototypeOf(range);
        Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(range, String(${targetSec}));
        range.dispatchEvent(new Event('input', { bubbles: true }));
        range.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      return false;
    })()`);

    if (!durationApplied) {
      const clickResult = await view.webContents.executeJavaScript(`(() => {
        const dots = [...document.querySelectorAll('[class*="dot"], [class*="mark"], [class*="step"]')].filter(n => {
          const r = n.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        const dotIndex = ${targetSec} - 4;
        if (dots.length > dotIndex && dotIndex >= 0) {
          const r = dots[dotIndex].getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
        const tracks = [...document.querySelectorAll('[class*="track"], [class*="rail"], [role="slider"]')].filter(n => {
          const r = n.getBoundingClientRect();
          return r.width > 50 && r.height > 0;
        });
        if (tracks.length) {
          const r = tracks[0].getBoundingClientRect();
          const ratio = (${targetSec} - 4) / (30 - 4);
          return { x: Math.round(r.left + r.width * ratio), y: Math.round(r.top + r.height / 2) };
        }
        return null;
      })()`);

      if (clickResult) {
        await clickPoint(view, clickResult);
        await pause(400);
      }
    }
  }

  // Close the popup by pressing Escape
  view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await pause(300);
}

/**
 * Sets the video duration through doubao's slider (4s-30s, step 1).
 */
export async function selectVideoDuration(view: BrowserView, seconds: number) {
  return selectDoubaoVideoSettings(view, { duration: seconds });
}

export async function selectPageSetting(view: BrowserView, kind: 'model' | 'ratio', value: string | number) {
  if (kind === 'ratio') {
    return selectDoubaoVideoSettings(view, { ratio: String(value) });
  }
  const current = await readComposerSettings(view);
  if (String(current[kind]) === String(value)) return;
  const key = '模型|model|Seedance|即梦';
  const clicked = await view.webContents.executeJavaScript(`(() => {
    const nodes=[...document.querySelectorAll('button,[role=button]')].filter(n=>n.getBoundingClientRect().width>0);
    const node=nodes.find(n=>new RegExp(${JSON.stringify(key)},'i').test((n.innerText || n.getAttribute('aria-label') || '').trim()));
    if (!node) return false; const r=node.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
  })()`);
  if (!clicked) throw new Error(`目标账号无法识别${kind === 'model' ? '模型' : '比例'}设置，请在目标窗口手动选择`);
  await clickPoint(view, clicked);
  await pause(800);
  const wanted = String(value).replace(/\s+/g, '').replace('：', ':');
  const selected = await view.webContents.executeJavaScript(`(() => {
    const nodes=[...document.querySelectorAll('[role=option],[role=menuitem],button,[data-radix-collection-item],li,div')].filter(n=>(n.getBoundingClientRect().width>0 || n.offsetWidth>0 || n.isConnected) && !n.disabled && !n.closest('[disabled],[aria-disabled=true]'));
    const norm=s=>(s||'').trim().split(String.fromCharCode(10))[0].replace(/\\s+/g,'').replace('：',':');
    const target=nodes.filter(n=>{const text=norm(n.innerText);
      return text===${JSON.stringify(wanted)};
    }).sort((a,b)=>a.getBoundingClientRect().width*a.getBoundingClientRect().height-b.getBoundingClientRect().width*b.getBoundingClientRect().height)[0];
    if (!target) return false; const r=target.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
  })()`);
  if (!selected) {
    view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    throw new Error(`目标账号当前没有可选的 ${value}，已停止发送。请读取目标账号可用选项`);
  }
  await clickPoint(view, selected);
  await pause(400);
  const after = await readComposerSettings(view);
  if (String(after[kind]) !== String(value)) throw new Error(`未确认目标账号已选择 ${value}，已停止发送`);
}

export async function probeAccountCapabilities(view: BrowserView, expand = true): Promise<AccountCapabilities> {
  await waitForComposer(view);
  const settings = await readComposerSettings(view);
  const capabilities: AccountCapabilities = { ...settings, models: settings.model ? [settings.model] : [], ratios: settings.ratio ? [settings.ratio] : [], accountInfo: [] };
  capabilities.accountInfo = await view.webContents.executeJavaScript(`(() => {
    const labels=[...document.querySelectorAll('button,[role=button],[data-testid*=member],[data-testid*=quota]')].filter(n=>n.getBoundingClientRect().width>0).map(n=>(n.innerText || n.getAttribute('aria-label') || '').trim());
    return [...new Set(labels.filter(s=>s.length<100 && !/^(开通|升级|购买)|立即开通|广告|subscribe/i.test(s) && /我的会员|会员有效|已开通会员|超级会员|高级会员|VIP|SVIP|剩余.*(额度|秒|次|积分)|可用.*(额度|秒|次|积分)/i.test(s)))].slice(0,5);
  })()`);
  if (!expand || settings.mode !== 'video') return capabilities;
  for (const kind of ['model', 'ratio'] as const) {
    const key = kind === 'model' ? '模型|model|Seedance|即梦' : '^\\d+\\s*[:：]\\s*\\d+$|比例|ratio';
    const opened = await view.webContents.executeJavaScript(`(() => {
      const node=[...document.querySelectorAll('button,[role=button]')].find(n=>n.getBoundingClientRect().width>0 && new RegExp(${JSON.stringify(key)},'i').test((n.innerText || n.getAttribute('aria-label') || '').trim()));
      if (!node) return false;node.click();return true;
    })()`);
    if (!opened) continue;
    await pause(180);
    const labels: string[] = await view.webContents.executeJavaScript(`[...document.querySelectorAll('[role=option],[role=menuitem],button,[data-radix-collection-item],li,div')].filter(n=>n.getBoundingClientRect().width>0 && !n.disabled && !n.closest('[disabled],[aria-disabled=true]') && (n.tagName!=='DIV' || getComputedStyle(n).cursor==='pointer')).map(n=>(n.innerText || '').trim()).filter(s=>s.length<100)`);
    if (kind === 'model') capabilities.models = [...new Set([...capabilities.models, ...labels.filter(s => /^(Seedance|即梦|\\d+\\.\\d+)/i.test(s) && !/模型/.test(s)).map(s=>s.split(String.fromCharCode(10))[0].trim())])];
    if (kind === 'ratio') capabilities.ratios = [...new Set([...capabilities.ratios, ...labels.filter(s => /^\\d+\\s*[:：]\\s*\\d+$/.test(s)).map(s => s.replace(/\\s+/g, '').replace('：', ':'))])];
    view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' }); await pause(100);
  }
  return capabilities;
}

export async function assertEmptyDraft(view: BrowserView) {
  const text = await view.webContents.executeJavaScript(`(() => { const n=[...document.querySelectorAll('[contenteditable=true],textarea')].find(n=>n.getBoundingClientRect().width>0);return n?(n.value || n.innerText || '').trim():'';})()`);
  if (text) throw new Error('目标账号已有未发送草稿，已保留。请先处理该草稿');
}

/**
 * Picks the composer the site actually accepts input in.
 *
 * Doubao renders the editor as two stacked elements of identical size: a
 * contenteditable DIV plus a TEXTAREA shim (accounts differ in which one exists).
 * Typing into the shim leaves the visible editor empty, so the send never happens.
 * The contenteditable DIV is the real editor and is preferred whenever present.
 */
export const COMPOSER_PICK_SCRIPT = `(() => {
  const all = [...document.querySelectorAll('[contenteditable=true],textarea')]
    .filter(n => n.getBoundingClientRect().width > 0 && !n.disabled);
  if (!all.length) return null;
  const editor = all.filter(n => n.getAttribute('contenteditable') === 'true');
  return (editor.length ? editor[editor.length - 1] : all[all.length - 1]);
})()`;

export const LAST_COMPOSER_SCRIPT = COMPOSER_PICK_SCRIPT;

export async function prepareText(view: BrowserView, prompt: string) {
  view.webContents.focus();
  const focused = await view.webContents.executeJavaScript(`(() => {
    const n = ${COMPOSER_PICK_SCRIPT};
    if (!n) return false;
    n.focus();
    return true;
  })()`);
  if (!focused) throw new Error('未找到目标输入框');
  await view.webContents.insertText(prompt);
  await pause(200);

  let actual = await view.webContents.executeJavaScript(`(() => {
    const n = ${COMPOSER_PICK_SCRIPT};
    return n ? (n.value ?? n.innerText ?? '').trim() : '';
  })()`);

  if (actual !== prompt.trim()) {
    // Typing through the debugger input path can land in the textarea shim that
    // Doubao renders under its contenteditable editor, after which the page discards
    // the text. Writing through the editor's own DOM and input events is the fix.
    await view.webContents.executeJavaScript(`(() => {
      const n = ${COMPOSER_PICK_SCRIPT};
      if (!n) return false;
      n.focus();
      if (n instanceof HTMLTextAreaElement || n instanceof HTMLInputElement) {
        const proto = n instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(n, ${JSON.stringify(prompt)});
      } else {
        n.textContent = ${JSON.stringify(prompt)};
        // Move the caret to the end so the editor treats it as a typed value.
        const range = document.createRange();
        range.selectNodeContents(n);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
      n.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: ${JSON.stringify(prompt)} }));
      n.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await pause(250);
    actual = await view.webContents.executeJavaScript(`(() => {
      const n = ${COMPOSER_PICK_SCRIPT};
      return n ? (n.value ?? n.innerText ?? '').trim() : '';
    })()`);
  }

  if (actual !== prompt.trim()) throw new Error('文字未成功进入目标输入框，已停止同步，请检查目标页面');
}

export async function clickComposerSend(view: BrowserView, prompt: string) {
  const outcome = await view.webContents.executeJavaScript(`(() => {
    const inputs = [...document.querySelectorAll('[contenteditable=true],textarea,[role=textbox]')].filter(n => !n.disabled && !n.closest('[hidden],[aria-hidden=true],template'));
    const input = inputs.find(n => n.getBoundingClientRect().width > 0 || n.offsetWidth > 0) || inputs[0];
    const rect = input ? input.getBoundingClientRect() : null;
    const nodes = [...document.querySelectorAll('button,[role=button],div[role=button],span[role=button]')].filter(n => !n.disabled && n.getAttribute('aria-disabled') !== 'true' && !n.closest('[hidden],[aria-hidden=true],template') && n.getBoundingClientRect().width > 0 && n.getBoundingClientRect().height > 0);
    const named = nodes.find(n => /发送|send|submit|开始生成|立即生成|生成视频/i.test([n.innerText, n.getAttribute('aria-label'), n.getAttribute('title'), n.getAttribute('data-testid')].join(' ')));
    const nearby = (rect && rect.width > 0)
      ? nodes.filter(n => { const r = n.getBoundingClientRect(); return r.left >= rect.right - 140 && r.top >= rect.top - 80 && r.bottom <= rect.bottom + 120; }).sort((a,b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0]
      : null;
    // Sidebar conversation titles can contain "生成视频" too. The site's exact
    // send control must win over any label or geometric fallback.
    const explicit = nodes.find(n => n.getAttribute('data-testid') === 'chat_input_send_button');
    const target = explicit || nearby || named || nodes.filter(n => /send|submit/i.test(n.className || '')).pop();
    if (!target) return { ok: false, reason: '未找到发送按钮' };

    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    target.click();

    const r = target.getBoundingClientRect();
    const point = (r.width > 0 && r.height > 0) ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null;
    return { ok: true, point };
  })()`);

  if (!outcome?.ok) throw new Error('目标账号发送按钮不可用，请检查登录、附件上传和生成参数');

  await pause(250);
  const stillPending = prompt.trim() ? await view.webContents.executeJavaScript(`(() => {
    const n = ${COMPOSER_PICK_SCRIPT};
    return n ? (n.value ?? n.innerText ?? '').trim() === ${JSON.stringify(prompt.trim())} : false;
  })()`) : (await view.webContents.executeJavaScript(draftImageStateScript)).count > 0;
  if (outcome.point && stillPending) {
    view.webContents.send('account-send:bypass', true);
    try {
      view.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...outcome.point });
      view.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...outcome.point });
    } finally {
      if (!view.webContents.isDestroyed()) view.webContents.send('account-send:bypass', false);
    }
  }

  await pause(700);
  const pending = prompt.trim() ? await view.webContents.executeJavaScript(`(() => {
    const inputs = [...document.querySelectorAll('[contenteditable=true],textarea,[role=textbox]')].filter(n => !n.disabled);
    const input = inputs.find(n => n.getBoundingClientRect().width > 0 || n.offsetWidth > 0) || inputs[0];
    return input ? (input.value || input.innerText || '').trim() === ${JSON.stringify(prompt.trim())} : false;
  })()`) : (await view.webContents.executeJavaScript(draftImageStateScript)).count > 0;
  if (pending) throw new Error('目标账号未确认发送，内容已保留在输入框');
}
