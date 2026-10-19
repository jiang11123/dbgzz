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
  const visible = n => n.getBoundingClientRect().width > 0 && n.getBoundingClientRect().height > 0;
  const input = [...document.querySelectorAll('[contenteditable=true],textarea')].find(n => visible(n) && !n.disabled);
  if (!input) return {mode:'chat'};
  const rect = input.getBoundingClientRect();
  const nearby = [...document.querySelectorAll('button,[role=button],[aria-selected=true],[aria-pressed=true],[data-state=active],div,span')].filter(n => visible(n) && Math.abs(n.getBoundingClientRect().bottom-rect.bottom)<260 && (n.innerText || '').trim().length<90);
  const labels = nearby.map(n => (n.innerText || n.getAttribute('aria-label') || '').trim());
  const rawModel = labels.filter(s=>/Seedance|即梦|视频.*模型|Video.*model|^\\d+\\.\\d+(?:\\s*(Fast|Mini|Pro|极速|标准))?$/i.test(s) && !/[\\n\\r]/.test(s) && s.length < 90).sort((a,b)=>a.length-b.length)[0];
  // The chip reads "模型 Seedance 2.0 Fast"; strip the prefix so verification compares names.
  const model = rawModel ? rawModel.replace(/^模型\\s*|^model\\s*/i, '').trim() : undefined;
  const modeName = /^(对话|聊天|视频生成|生成视频|图像生成|图片生成|生成图片|帮我写作|PPT\\s*生成|录音转写|解题答疑|Chat|Video generation|Image generation)$/i;
  const active = nearby.find(n=>modeName.test((n.innerText || '').trim()) && (n.matches('[aria-selected=true],[aria-pressed=true],[data-state=active],[aria-current=true]') || /(^|[ _-])(active|selected|checked)([ _-]|$)/i.test(n.className || '')));
  const activeText=(active?.innerText || '').trim();
  const video = Boolean(model) || /视频生成|生成视频|video/i.test(activeText) || labels.some(s => /^(?:📹\\s*)?视频生成/i.test(s));
  const image = !video && (/图像生成|图片生成|生成图片|画图|image/i.test(activeText) || labels.some(s => /^(?:🎨\\s*)?图像生成/i.test(s)));
  const ratio=labels.find(s=>/^\\d+\\s*[:：]\\s*\\d+$/.test(s))?.replace(/\\s+/g,'').replace('：',':');
  return {mode:video?'video':image?'image':activeText && !/对话|聊天|chat/i.test(activeText)?'other':'chat', modeLabel:activeText || undefined,
    model:model || undefined, ratio};
})()`;

export async function readComposerSettings(view: BrowserView): Promise<ComposerSettings> {
  if (view.webContents.isDestroyed()) throw new Error('账号窗口已关闭');
  return view.webContents.executeJavaScript(composerSettingsScript);
}

export async function waitForComposer(view: BrowserView) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (view.webContents.isDestroyed()) throw new Error('账号窗口已关闭');
    if (!view.webContents.isLoading() && await view.webContents.executeJavaScript(`Boolean([...document.querySelectorAll('[contenteditable=true],textarea')].find(n=>n.getBoundingClientRect().width>0 && !n.disabled))`)) return;
    await pause(250);
  }
  throw new Error('目标账号未出现输入框，请先登录或完成页面验证');
}

export async function ensureComposerMode(view: BrowserView, settings: ComposerSettings) {
  await waitForComposer(view);
  let current = await readComposerSettings(view);
  if (current.mode === settings.mode && (settings.mode !== 'other' || current.modeLabel === settings.modeLabel)) return;
  const label = settings.mode === 'video' ? '视频生成|生成视频|video generation|create video' : settings.mode === 'image' ? '图像生成|图片生成|生成图片|画图|image generation|create image' : settings.mode === 'chat' ? '对话|聊天|普通聊天|chat' : settings.modeLabel;
  if (!label) throw new Error('未识别到来源模式，请先在目标账号手动选择模式');

  for (let attempt = 0; attempt < 3; attempt++) {
    // 1. Try finding a direct button or toolbar item with trusted mouse click
    const point = await view.webContents.executeJavaScript(`(() => {
      const input = [...document.querySelectorAll('[contenteditable=true],textarea')].find(n => n.getBoundingClientRect().width > 0);
      const bottom = input?.getBoundingClientRect().bottom || window.innerHeight;
      const re = new RegExp(${JSON.stringify(`(?:${label})`)}, 'i');
      const nodes = [...document.querySelectorAll('button,[role=button],a,div,span')].filter(n => {
        const r = n.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && re.test((n.innerText || n.getAttribute('aria-label') || '').trim());
      }).sort((a,b) => Math.abs(a.getBoundingClientRect().bottom - bottom) - Math.abs(b.getBoundingClientRect().bottom - bottom));
      if (!nodes.length) return null;
      const r = nodes[0].getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);

    if (point) {
      await clickPoint(view, point);
      await pause(800);
      current = await readComposerSettings(view);
      if (current.mode === settings.mode && (settings.mode !== 'other' || current.modeLabel === settings.modeLabel)) return;
    }

    // 2. If direct click wasn't found or didn't switch, try clicking '+' button to open tool menu
    const plusPoint = await view.webContents.executeJavaScript(`(() => {
      const input = [...document.querySelectorAll('[contenteditable=true],textarea')].find(n => n.getBoundingClientRect().width > 0);
      const rect = input?.getBoundingClientRect();
      const buttons = [...document.querySelectorAll('button,[role=button]')].filter(n => {
        const r = n.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && (!rect || Math.abs(r.bottom - rect.bottom) < 260);
      });
      const plus = buttons.find(b => {
        const text = (b.innerText || b.getAttribute('aria-label') || '').trim();
        return /^[+＋]$/i.test(text) || /添加|更多|功能|插件/i.test(text) || Boolean(b.querySelector('svg path[d*="M12"]'));
      });
      if (!plus) return null;
      const r = plus.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);

    if (plusPoint) {
      await clickPoint(view, plusPoint);
      await pause(600);
      const menuPoint = await view.webContents.executeJavaScript(`(() => {
        const re = new RegExp(${JSON.stringify(`(?:${label})`)}, 'i');
        const nodes = [...document.querySelectorAll('[role=menuitem],[role=option],button,div,span')].filter(n => {
          const r = n.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && re.test((n.innerText || n.getAttribute('aria-label') || '').trim());
        });
        if (!nodes.length) return null;
        const r = nodes[nodes.length - 1].getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`);
      if (menuPoint) {
        await clickPoint(view, menuPoint);
        await pause(800);
        current = await readComposerSettings(view);
        if (current.mode === settings.mode && (settings.mode !== 'other' || current.modeLabel === settings.modeLabel)) return;
      }
    }
    await pause(300);
  }

  for (let attempt = 0; attempt < 12; attempt++) {
    await pause(250);
    const after = await readComposerSettings(view);
    if (after.mode === settings.mode && (settings.mode !== 'other' || after.modeLabel === settings.modeLabel)) return;
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
    const nodes = [...document.querySelectorAll('button,[role=button],div[role=button],span[role=button]')].filter(n => !n.disabled && n.getAttribute('aria-disabled') !== 'true');
    const named = nodes.find(n => /发送|send|submit|开始生成|立即生成|生成视频/i.test([n.innerText, n.getAttribute('aria-label'), n.getAttribute('title'), n.getAttribute('data-testid')].join(' ')));
    const nearby = (rect && rect.width > 0)
      ? nodes.filter(n => { const r = n.getBoundingClientRect(); return r.left >= rect.right - 140 && r.top >= rect.top - 80 && r.bottom <= rect.bottom + 120; }).sort((a,b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0]
      : null;
    const target = named || nearby || nodes.filter(n => /send|submit/i.test(n.className || '')).pop();
    if (!target) return { ok: false, reason: '未找到发送按钮' };

    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    target.click();

    const r = target.getBoundingClientRect();
    const point = (r.width > 0 && r.height > 0) ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null;
    return { ok: true, point };
  })()`);

  if (!outcome?.ok) throw new Error('目标账号发送按钮不可用，请检查登录、附件上传和生成参数');

  if (outcome.point) {
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
