import { useSyncExternalStore } from 'react';
import { Moon, Sun } from 'lucide-react';

type Theme = 'light' | 'dark';
const storageKey = 'workspace-theme';
const listeners = new Set<() => void>();
function readTheme(): Theme {
  try { return localStorage.getItem(storageKey) === 'dark' ? 'dark' : 'light'; }
  catch { return 'light'; }
}
let theme = readTheme();
function applyTheme(next: Theme) {
  theme = next;
  document.documentElement.dataset.theme = next;
  listeners.forEach(listener => listener());
}
applyTheme(theme);
// Keep existing secondary windows in sync as well as windows opened later.
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('workspace-theme');
channel?.addEventListener('message', event => {
  if (event.data === 'dark' || event.data === 'light') applyTheme(event.data);
});
window.addEventListener('storage', event => {
  if (event.key === storageKey || event.key === null) applyTheme(readTheme());
});
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function ThemeToggle() {
  const current = useSyncExternalStore(subscribe, () => theme);
  const dark = current === 'dark';
  return <button className="browser-size-toggle theme-toggle" aria-pressed={dark}
    title={dark ? '切换到日间模式' : '切换到夜间模式'}
    onClick={() => {
      const next = dark ? 'light' : 'dark';
      applyTheme(next);
      try { localStorage.setItem(storageKey, next); } catch { /* The current window can still switch. */ }
      channel?.postMessage(next);
    }}>
    {dark ? <Sun size={15} /> : <Moon size={15} />}{dark ? '日间模式' : '夜间模式'}
  </button>;
}
