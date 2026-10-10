export function defaultAccountShortcut(index: number) {
  return index < 9 ? `Alt+${index + 1}` : index === 9 ? 'Alt+0' : '';
}
export function normalizeAccountShortcut(value: string) {
  if (!value) return '';
  const parts = value.split('+');
  const key = parts.pop()!.toUpperCase();
  const modifiers = ['Ctrl', 'Alt', 'Shift'].filter(mod => parts.includes(mod));
  if (parts.some(part => !['Ctrl', 'Alt', 'Shift'].includes(part)) || new Set(parts).size !== parts.length
    || !/^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|LEFT|RIGHT|UP|DOWN|HOME|END|PAGEUP|PAGEDOWN)$/.test(key)
    || (!modifiers.length && !/^F\d+$/.test(key))) throw new Error('请使用 Ctrl、Alt 或 Shift 搭配字母、数字或方向键');
  const result = [...modifiers, key].join('+');
  if (['Alt+F4', 'Ctrl+W', 'Ctrl+Q', 'Ctrl+R', 'Ctrl+Shift+R'].includes(result)) throw new Error('该快捷键用于关闭或刷新窗口，请换一个组合');
  return result;
}
export function shortcutFromKey(input: {key: string; code?: string; control?: boolean; ctrlKey?: boolean; alt?: boolean; altKey?: boolean; shift?: boolean; shiftKey?: boolean; meta?: boolean; metaKey?: boolean}) {
  if (input.meta || input.metaKey || /^(Control|Alt|Shift|Meta|AltGraph)$/i.test(input.key)) return '';
  const key = /^(?:Digit|Numpad)\d$/.test(input.code || '') ? input.code!.slice(-1) : input.key.replace(/^Arrow/, '');
  return [...(input.control || input.ctrlKey ? ['Ctrl'] : []), ...(input.alt || input.altKey ? ['Alt'] : []), ...(input.shift || input.shiftKey ? ['Shift'] : []), key.toUpperCase()].join('+');
}
export function accountShortcut(index: number, custom: Record<string, string>) {
  return custom[String(index)] ?? defaultAccountShortcut(index);
}
