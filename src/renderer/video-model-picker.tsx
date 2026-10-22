import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronUp } from 'lucide-react';

const models = ['Seedance 2.0 Fast', 'Seedance 2.5', 'Seedance 2.0', 'Seedance 2.0 Mini'];

export function VideoModelPicker({ value, onChange }: { value: string; onChange: (model: string) => void }) {
  return <UpwardSelect label="视频模型" value={value} onChange={onChange}
    options={models.map(model => ({ value: model, label: model }))} />;
}

/** Custom popup keeps composer choices above the input, including on Windows. */
export function UpwardSelect({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const selected = options.find(option => option.value === value);
  return <div className="video-model-picker upward-select" ref={root} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  }}>
    <button type="button" ref={trigger} className="video-model-trigger" title={label} aria-label={`${label}：${selected?.label ?? value}`}
      aria-haspopup="menu" aria-expanded={open} aria-controls={menuId}
      onClick={() => setOpen(current => !current)} onKeyDown={event => {
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); }
      }}><span>{selected?.label ?? value}</span><ChevronUp size={14} /></button>
    {open && <div className="video-model-menu" id={menuId} role="menu" aria-label={label} onKeyDown={event => {
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    }}>
      {options.map(option => <button type="button" role="menuitemradio" aria-checked={value === option.value} key={option.value}
        onClick={() => { onChange(option.value); setOpen(false); trigger.current?.focus(); }}>
        <span>{option.label}</span>{value === option.value && <Check size={14} />}
      </button>)}
    </div>}
  </div>;
}
