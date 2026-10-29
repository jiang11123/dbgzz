import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { composerSettingsScript, videoDurationPanelScript, selectDoubaoVideoSettings, clickComposerSend } from './page-composer';

for (const accepts of [true, false]) {
  test(`send chooses the real button over a sidebar title; accepted=${accepts}`, async () => {
    let draft = '让兔子站起来';
    let sidebarClicks = 0, sendClicks = 0, nativeClicks = 0;
    const rect = { left: 300, right: 1200, top: 700, bottom: 724, width: 900, height: 24 };
    const editor = { disabled: false, get innerText() { return draft; }, value: undefined,
      getAttribute: (key: string) => key === 'contenteditable' ? 'true' : null,
      closest: () => null, getBoundingClientRect: () => rect };
    const button = (title: string, testid: string, click: () => void) => ({ innerText: title, disabled: false,
      className: '', closest: () => null, dispatchEvent: () => true, click,
      getAttribute: (key: string) => key === 'data-testid' ? testid : null,
      getBoundingClientRect: () => ({ left: 1164, right: 1200, top: 738, bottom: 774, width: 36, height: 36 }) });
    const sidebar = button('生成视频：兔子站立', '', () => { sidebarClicks++; });
    const send = button('', 'chat_input_send_button', () => { sendClicks++; if (accepts) draft = ''; });
    const context = { document: { querySelectorAll: (selector: string) => selector.startsWith('button') ? [sidebar, send] : [editor] },
      MouseEvent: class { constructor(..._args: unknown[]) {} } };
    const view = { webContents: { executeJavaScript: async (script: string) => vm.runInNewContext(script, context),
      send: () => {}, isDestroyed: () => false, sendInputEvent: () => { nativeClicks++; } } };
    const result = clickComposerSend(view as any, draft);
    if (accepts) await result;
    else await assert.rejects(result, /未确认发送/);
    assert.equal(sidebarClicks, 0);
    assert.equal(sendClicks, 1);
    assert.equal(nativeClicks, accepts ? 0 : 2);
  });
}

type FakeButton = { text: string; bottom?: number };

/**
 * Runs the composer probe against a fake DOM shaped like the real Doubao composer:
 * an editor, an optional skill exit chip (data-testid=skill_input_exit_button),
 * the 对话 mode button (id=chat_input_action_mode) and the toolbar chip buttons.
 */
function settings(options: {
  chip?: string;
  modeButton?: string;
  placeholder?: string;
  buttons?: FakeButton[];
}) {
  const rect = (bottom = 600) => ({ width: 800, height: 24, bottom, left: 0, right: 800, top: bottom - 24 });
  const element = (text: string, bottom: number) => ({
    innerText: text,
    className: '',
    getAttribute: (name: string) => (name === 'placeholder' ? (options.placeholder ?? '') : null),
    matches: () => false,
    getBoundingClientRect: () => rect(bottom),
  });
  const input = element('', 600);
  const chip = options.chip ? element(options.chip, 640) : null;
  const modeButton = options.modeButton ? element(options.modeButton, 600) : null;
  const buttons = (options.buttons ?? []).map(b => element(b.text, b.bottom ?? 640));
  const document = {
    querySelectorAll: (selector: string) => {
      if (selector === '[contenteditable=true],textarea') return [input];
      if (selector === '[data-testid=skill_input_exit_button]') return chip ? [chip] : [];
      if (selector === '#chat_input_action_mode,[data-testid=chat_input_action_mode]') return modeButton ? [modeButton] : [];
      if (selector === 'button,[role=button]') return buttons;
      return [];
    },
  };
  return vm.runInNewContext(composerSettingsScript, { document });
}

test('a home toolbar shortcut is not an active video composer', () => {
  const state = settings({ modeButton: '对话', buttons: [{ text: '视频生成' }, { text: '图像生成' }, { text: 'PPT 生成' }] });
  assert.equal(state.mode, 'chat');
});

test('an explicit chat selection wins over an inactive video model label', () => {
  const state = settings({ modeButton: '对话', buttons: [{ text: '模型 Seedance 2.0 Fast' }] });
  assert.equal(state.mode, 'chat');
  assert.equal(state.model, undefined);
});

test('recognizes video mode from the real skill exit chip', () => {
  const state = settings({ chip: '视频生成', buttons: [{ text: '模型 Seedance 2.0 Mini' }, { text: '自动 · 10s' }] });
  assert.equal(state.mode, 'video');
  assert.equal(state.modeLabel, '视频生成');
  assert.equal(state.model, 'Seedance 2.0 Mini');
  assert.equal(state.duration, 10);
});

test('recognizes image mode and keeps its label', () => {
  const state = settings({ chip: '图像生成', buttons: [{ text: '16:9' }] });
  assert.equal(state.mode, 'image');
  assert.equal(state.modeLabel, '图像生成');
  assert.equal(state.ratio, '16:9');
});

test('an unknown skill chip reports other instead of guessing video', () => {
  const state = settings({ chip: 'PPT 生成' });
  assert.equal(state.mode, 'other');
  assert.equal(state.modeLabel, 'PPT 生成');
});

test('video placeholder counts as video mode only without a skill chip', () => {
  assert.equal(settings({ placeholder: '描述你想要的视频' }).mode, 'video');
  assert.equal(settings({ chip: '图像生成', placeholder: '描述你想要的视频' }).mode, 'image');
});


test('reads duration and ratio from a combined native video toolbar label', () => {
  const result = settings({chip:'视频生成',buttons:[{text:'16:9 · 5s'},{text:'模型 Seedance 2.0 Fast'}]});
  assert.equal(result.duration,5); assert.equal(result.ratio,'16:9');
});

for (const ignoresKeys of [false,true]) {
  test('native indexed slider applies and verifies 5 seconds; ignored='+ignoresKeys, async () => {
    let index=6; const keys:string[]=[];
    const view={webContents:{isDestroyed:()=>false,
      executeJavaScript:async(script:string)=>{
        if(script===videoDurationPanelScript)return {minSec:4,maxSec:15,minIndex:0,maxIndex:11,index,currentSec:index+4};
        if(script===composerSettingsScript)return {mode:'video',duration:index+4,ratio:'16:9'};
        return true;
      },sendInputEvent:(event:{type:string;keyCode:string})=>{
        if(event.type!=='keyDown')return;keys.push(event.keyCode);
        if(!ignoresKeys&&event.keyCode==='Home')index=0;
        if(!ignoresKeys&&event.keyCode==='Right')index++;
      },
    }};
    const result=selectDoubaoVideoSettings(view as any,{duration:5});
    if(ignoresKeys)await assert.rejects(result,/要求 5 秒，豆包实际为 10 秒/);
    else {await result;assert.equal(index,1);}
    assert.deepEqual(keys,['Home','Right','Escape']);
  });
}

test('unsupported native duration stops rather than silently clamping', async () => {
  const keys:string[]=[];
  const view={webContents:{isDestroyed:()=>false,executeJavaScript:async()=>({minSec:4,maxSec:15,minIndex:0,maxIndex:11,index:6,currentSec:10}),
    sendInputEvent:(e:{type:string;keyCode:string})=>{if(e.type==='keyDown')keys.push(e.keyCode);}}};
  await assert.rejects(selectDoubaoVideoSettings(view as any,{duration:20}),/不支持 20 秒/);
  assert.deepEqual(keys,['Escape']);
});
