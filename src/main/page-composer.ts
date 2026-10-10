import type { BrowserView } from 'electron';
import type { AccountCapabilities, ComposerSettings } from '../shared/account-send';
import { draftImageStateScript } from './chat-images';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export const composerSettingsScript = `(() => {
  const visible = n => n.getBoundingClientRect().width > 0 && n.getBoundingClientRect().height > 0;
  const input = [...document.querySelectorAll('[contenteditable=true],textarea')].find(n => visible(n) && !n.disabled);
  if (!input) return {mode:'chat'};
  const rect = input.getBoundingClientRect();
  const nearby = [...document.querySelectorAll('button,[role=button],[aria-selected=true],[aria-pressed=true],[data-state=active],div,span')].filter(n => visible(n) && Math.abs(n.getBoundingClientRect().bottom-rect.bottom)<260 && (n.innerText || '').trim().length<90);
  const labels = nearby.map(n => (n.innerText || n.getAttribute('aria-label') || '').trim());
  const model = labels.filter(s=>/Seedance|即梦|视频.*模型|Video.*model|^\\d+\\.\\d+(?:\\s*(Fast|Mini|Pro|极速|标准))?$/i.test(s) && !/[\\n\\r]/.test(s) && s.length < 90).sort((a,b)=>a.length-b.length)[0];
  const modeName = /^(对话|聊天|视频生成|生成视频|图像生成|图片生成|生成图片|帮我写作|PPT\\s*生成|录音转写|解题答疑|Chat|Video generation|Image generation)$/i;
  const active = nearby.find(n=>modeName.test((n.innerText || '').trim()) && (n.matches('[aria-selected=true],[aria-pressed=true],[data-state=active],[aria-current=true]') || /(^|[ _-])(active|selected|checked)([ _-]|$)/i.test(n.className || '')));
  const activeText=(active?.innerText || '').trim();
  const video = Boolean(model) || /视频生成|生成视频|video/i.test(activeText);
  const image = !video && /图像生成|图片生成|生成图片|画图|image/i.test(activeText);
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
  const current = await readComposerSettings(view);
  if (current.mode === settings.mode && (settings.mode !== 'other' || current.modeLabel === settings.modeLabel)) return;
  const label = settings.mode === 'video' ? '视频生成|生成视频|video generation|create video' : settings.mode === 'image' ? '图像生成|图片生成|生成图片|画图|image generation|create image' : settings.mode === 'chat' ? '对话|聊天|普通聊天|chat' : settings.modeLabel;
  if (!label) throw new Error('未识别到来源模式，请先在目标账号手动选择模式');
  const clicked = await view.webContents.executeJavaScript(`(() => {
    const input=[...document.querySelectorAll('[contenteditable=true],textarea')].find(n=>n.getBoundingClientRect().width>0);
    const bottom=input?.getBoundingClientRect().bottom || 0;
    const target=[...document.querySelectorAll('button,[role=button],a,div,span')].filter(n=>n.getBoundingClientRect().width>0 && new RegExp('^(?:'+${JSON.stringify(label)}+')$','i').test((n.innerText || n.getAttribute('aria-label') || '').trim())).sort((a,b)=>Math.abs(a.getBoundingClientRect().bottom-bottom)-Math.abs(b.getBoundingClientRect().bottom-bottom) || a.getBoundingClientRect().width*a.getBoundingClientRect().height-b.getBoundingClientRect().width*b.getBoundingClientRect().height)[0];
    if (!target) return false; (target.closest('button,[role=button],a') || target).click(); return true;
  })()`);
  if (!clicked) throw new Error('目标账号没有找到对应模式，请在目标窗口选择后重试');
  for (let attempt=0;attempt<24;attempt++) {
    await pause(250);
    const after = await readComposerSettings(view);
    if (after.mode === settings.mode && (settings.mode !== 'other' || after.modeLabel === settings.modeLabel)) return;
  }
  throw new Error('无法确认目标账号已进入对应模式，已停止发送。请在目标窗口手动选择模式后重试');
}

export async function selectPageSetting(view: BrowserView, kind: 'model' | 'ratio', value: string | number) {
  const current = await readComposerSettings(view);
  if (String(current[kind]) === String(value)) return;
  const key = kind === 'model' ? '模型|model|Seedance|即梦' : '^\\d+\\s*[:：]\\s*\\d+$|比例|ratio';
  const clicked = await view.webContents.executeJavaScript(`(() => {
    const nodes=[...document.querySelectorAll('button,[role=button]')].filter(n=>n.getBoundingClientRect().width>0);
    const node=nodes.find(n=>new RegExp(${JSON.stringify(key)},'i').test((n.innerText || n.getAttribute('aria-label') || '').trim()));
    if (!node) return false; node.click();return true;
  })()`);
  if (!clicked) throw new Error(`目标账号无法识别${kind === 'model' ? '模型' : '比例'}设置，请在目标窗口手动选择`);
  await pause(250);
  const wanted = String(value).replace(/\s+/g, '').replace('：', ':');
  const selected = await view.webContents.executeJavaScript(`(() => {
    const nodes=[...document.querySelectorAll('[role=option],[role=menuitem],button,[data-radix-collection-item],li,div')].filter(n=>n.getBoundingClientRect().width>0 && n.getBoundingClientRect().height>0 && !n.disabled && !n.closest('[disabled],[aria-disabled=true]'));
    const target=nodes.filter(n=>{const text=(n.innerText || '').trim().replace(/\\s+/g,'').replace('：',':');
      return text===${JSON.stringify(wanted)};
    }).sort((a,b)=>a.getBoundingClientRect().width*a.getBoundingClientRect().height-b.getBoundingClientRect().width*b.getBoundingClientRect().height)[0];
    if (!target) return false; target.click(); return true;
  })()`);
  if (!selected) {
    view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    throw new Error(`目标账号当前没有可选的 ${value}，已停止发送。请读取目标账号可用选项`);
  }
  await pause(200);
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
    if (kind === 'model') capabilities.models = [...new Set([...capabilities.models, ...labels.filter(s => /^(Seedance|即梦|\d+\.\d+)/i.test(s) && !/模型/.test(s)).map(s=>s.split('\n')[0].trim())])];
    if (kind === 'ratio') capabilities.ratios = [...new Set([...capabilities.ratios, ...labels.filter(s => /^\d+\s*[:：]\s*\d+$/.test(s)).map(s => s.replace(/\s+/g, '').replace('：', ':'))])];
    view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' }); await pause(100);
  }
  return capabilities;
}

export async function assertEmptyDraft(view: BrowserView) {
  const text = await view.webContents.executeJavaScript(`(() => { const n=[...document.querySelectorAll('[contenteditable=true],textarea')].find(n=>n.getBoundingClientRect().width>0);return n?(n.value || n.innerText || '').trim():'';})()`);
  if (text) throw new Error('目标账号已有未发送草稿，已保留。请先处理该草稿');
}

export async function prepareText(view: BrowserView, prompt: string) {
  view.webContents.focus();
  await view.webContents.executeJavaScript(`(() => {
    const n=[...document.querySelectorAll('[contenteditable=true],textarea')].find(n=>n.getBoundingClientRect().width>0 && !n.disabled);
    if (!n) throw new Error('未找到目标输入框');n.focus();
  })()`);
  await view.webContents.insertText(prompt);
  await pause(150);
  const actual=await view.webContents.executeJavaScript(`(() => {
    const n=[...document.querySelectorAll('[contenteditable=true],textarea')].find(n=>n.getBoundingClientRect().width>0 && !n.disabled);
    return n?(n.value ?? n.innerText ?? '').trim():'';
  })()`);
  if(actual!==prompt.trim()) throw new Error('文字未成功进入目标输入框，已停止同步，请检查目标页面');
}

export async function clickComposerSend(view: BrowserView, prompt: string) {
  const point = await view.webContents.executeJavaScript(`(() => {
    const input=[...document.querySelectorAll('[contenteditable=true],textarea')].find(n=>n.getBoundingClientRect().width>0);
    if (!input) return null; const rect=input.getBoundingClientRect();
    const nodes=[...document.querySelectorAll('button,[role=button]')].filter(n=>!n.disabled && n.getAttribute('aria-disabled')!=='true' && n.getBoundingClientRect().width>0);
    const named=nodes.find(n=>/发送|send|submit|开始生成|立即生成/i.test([n.innerText,n.getAttribute('aria-label'),n.getAttribute('title'),n.getAttribute('data-testid')].join(' ')));
    const target=named || nodes.filter(n=>{const r=n.getBoundingClientRect();return r.left>=rect.right-120 && r.top>=rect.top-80 && r.bottom<=rect.bottom+120;}).sort((a,b)=>b.getBoundingClientRect().right-a.getBoundingClientRect().right)[0];
    if (!target) return null;const r=target.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
  })()`);
  if (!point) throw new Error('目标账号发送按钮不可用，请检查登录、附件上传和生成参数');
  view.webContents.send('account-send:bypass', true);
  try {
    view.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    view.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await pause(700);
    const pending = prompt.trim() ? await view.webContents.executeJavaScript(`(() => {const input=[...document.querySelectorAll('[contenteditable=true],textarea')].find(n=>n.getBoundingClientRect().width>0);return input ? (input.value || input.innerText || '').trim() === ${JSON.stringify(prompt.trim())}:false;})()`) : (await view.webContents.executeJavaScript(draftImageStateScript)).count>0;
    if (pending) throw new Error('目标账号未确认发送，内容已保留在输入框');
  } finally { if (!view.webContents.isDestroyed()) view.webContents.send('account-send:bypass', false); }
}
