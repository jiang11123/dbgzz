import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { composerSettingsScript } from './page-composer';

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
