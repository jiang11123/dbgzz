import { useEffect, useRef, useState } from 'react';

export function useResizableBar(kind: 'image' | 'account', message: (text: string) => void) {
  const initial = kind === 'image' ? 76 : 58;
  const min = kind === 'image' ? 56 : 42;
  const max = kind === 'image' ? 360 : 160;
  const selector = kind === 'image' ? '.image-assets-bar' : '.topbar';
  const handleClass = `${kind}-bar-resizer`;
  const [height, setHeight] = useState(initial);
  const current = useRef(initial);
  const dragging = useRef(false);
  const touched = useRef(false);
  const frame = useRef<number | null>(null);
  const commit = (value: number, save: boolean) => {
    const setter = kind === 'image' ? window.workspace.setImageBarHeight : window.workspace.setAccountBarHeight;
    void setter(value, save).catch(error => message(String(error)));
  };
  const resize = (value: number, save = false) => {
    const other = document.querySelector(kind === 'image' ? '.topbar' : '.image-assets-bar')?.getBoundingClientRect().height || (kind === 'image' ? 58 : 76);
    const next = Math.round(Math.max(min, Math.min(max, window.innerHeight - other - 200, value)));
    touched.current = true; current.current = next; setHeight(next);
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (save) commit(next, true);
    else frame.current = requestAnimationFrame(() => { frame.current = null; commit(current.current, false); });
  };
  useEffect(() => {
    let active = true;
    void window.workspace.load().then(data => {
      if (active && !touched.current) { const value = data[kind === 'image' ? 'imageBarHeight' : 'accountBarHeight'] || initial; current.current = value; setHeight(value); }
    }).catch(error => message(String(error)));
    const down = (event: PointerEvent) => {
      const handle = (event.target as Element).closest?.(`.${handleClass}`);
      if (!handle || event.button !== 0) return;
      event.preventDefault(); dragging.current = true; touched.current = true;
      try { handle.setPointerCapture(event.pointerId); } catch { /* Global listeners continue tracking. */ }
    };
    const move = (event: PointerEvent) => {
      if (!dragging.current) return;
      const bar = document.querySelector(selector);
      if (bar) resize(event.clientY - bar.getBoundingClientRect().top + 3);
    };
    const end = () => { if (dragging.current) { dragging.current = false; resize(current.current, true); } };
    window.addEventListener('pointerdown', down); window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
    return () => {
      active = false;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      window.removeEventListener('pointerdown', down); window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end);
    };
  }, []);
  return { height, min, max, initial, resize, handleClass, kind };
}

export function BarResizer({ bar }: { bar: ReturnType<typeof useResizableBar> }) {
  return <div className={`bar-resizer ${bar.handleClass}`} role="separator" aria-label={bar.kind === 'image' ? '调整图片栏高度' : '调整账号栏高度'} aria-orientation="horizontal" aria-valuemin={bar.min} aria-valuemax={bar.max} aria-valuenow={bar.height} tabIndex={0}
    title="上下拖动调整大小，双击恢复默认"
    onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); bar.resize(bar.height + (event.key === 'ArrowUp' ? -10 : 10), true); } }}
    onDoubleClick={() => bar.resize(bar.initial, true)}><span /></div>;
}
