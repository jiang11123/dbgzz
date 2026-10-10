import { useState } from 'react';
import { accountShortcut, normalizeAccountShortcut, shortcutFromKey } from '../shared/account-shortcuts';

type Props = {refresh: () => Promise<void>; message: (text:string) => void};
export function AccountShortcutInput({index, custom, refresh, message}: Props & {index: number; custom: Record<string,string>}) {
  const [saving, setSaving] = useState(false);
  const [recording, setRecording] = useState(false);
  const save = async (shortcut: string) => {
    setSaving(true);
    try { await window.workspace.setAccountShortcut(index, shortcut); await refresh(); setRecording(false); }
    catch (error) { message(String(error)); }
    finally { setSaving(false); }
  };
  return <div className="account-shortcut-control"><input aria-label={`第${index+1}个账号快捷键`} title="点击后按下新快捷键；Esc 取消" readOnly disabled={saving}
    value={recording ? '请按快捷键…' : accountShortcut(index, custom) || '未设置'} onFocus={() => setRecording(true)} onBlur={() => setRecording(false)}
    onKeyDown={event => {
      event.preventDefault(); event.stopPropagation();
      if(event.key === 'Escape') { event.currentTarget.blur(); return; }
      if(event.nativeEvent.isComposing || event.repeat) return;
      const shortcut = shortcutFromKey(event); if(!shortcut) return;
      try { void save(normalizeAccountShortcut(shortcut)); } catch(error) { message(String(error)); }
    }} /><button className="shortcut-clear" title="清除快捷键" aria-label={`清除第${index+1}个账号快捷键`} disabled={saving || !accountShortcut(index, custom)} onClick={() => void save('')}>×</button></div>;
}
export function ResetAccountShortcuts({refresh, message}: Props) {
  const [saving, setSaving] = useState(false);
  return <button className="outline reset-account-shortcuts" disabled={saving} onClick={async () => {
    setSaving(true); try { await window.workspace.resetAccountShortcuts(); await refresh(); } catch(error) { message(String(error)); } finally { setSaving(false); }
  }}>恢复默认快捷键</button>;
}
