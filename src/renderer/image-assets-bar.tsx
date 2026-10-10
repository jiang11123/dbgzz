import { useEffect, useState } from 'react';
import { BarResizer, useResizableBar } from './resizable-bar';
import type { ImageAsset } from '../shared/types';
import { useImageMarquee } from './use-image-marquee';
import { useImageReorder } from './use-image-reorder';

export function ImageAssetsBar({ accountId, message }: { accountId: number | null; message: (text: string) => void }) {
  const bar = useResizableBar('image', message);
  const height = bar.height;
  const [items, setItems] = useState<ImageAsset[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const marquee = useImageMarquee(selected, setSelected, busy);
  const reorder = useImageReorder(items, selected, busy, ids => {
    setBusy(true);
    void window.workspace.reorderQuickImages(ids).then(setItems)
      .catch(error => message(String(error))).finally(() => setBusy(false));
  });
  useEffect(() => {
    let active = true;
    const refresh = () => void window.workspace.listQuickImages().then(items => {
      if (!active) return;
      setItems(items); setSelected(old => old.filter(id => items.some(item => item.id === id)));
    }).catch(error => { if (active) message(String(error)); });
    refresh();
    const dispose = window.workspace.onImageAssetsChanged(refresh);
    return () => { active = false; dispose(); };
  }, []);
  const upload = async () => {
    if (!accountId || !selected.length || busy) return;
    setBusy(true);
    try { await window.workspace.useImageAssets(items.filter(item => selected.includes(item.id)).map(item => item.id), accountId); message(`已添加 ${selected.length} 张图片，请等待上传完成`); }
    catch (error) { message(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <section ref={marquee.region} className="image-assets-bar" aria-label="图片资产快捷栏" style={{ height, '--thumbnail-size': `${height - 20}px`, '--bar-scale': Math.max(0.8, Math.min(2.2, height / 76)) } as React.CSSProperties}>
    <div className="asset-bar-label"><b>快捷预览</b></div>
    <div className="asset-bar-thumbnails">{items.map(item => <div className={`asset-bar-thumb${selected.includes(item.id) ? ' selected' : ''}${reorder.moving.includes(item.id) ? ' sorting' : ''}${reorder.target?.id === item.id ? reorder.target.before ? ' insert-before' : ' insert-after' : ''}`} data-asset-id={item.id} key={item.id} title={item.name}>
      <img src={item.url} alt={item.name} draggable={false} />
      <input type="checkbox" aria-label={`选择 ${item.name}`} disabled={busy} checked={selected.includes(item.id)} onChange={event => setSelected(old => event.target.checked ? [...old, item.id] : old.filter(id => id !== item.id))} />
    </div>)}{!items.length && <span className="muted">点击右侧“选择图片资产”加入快捷预览</span>}</div>
    <div className="asset-bar-controls"><span>已选 {selected.length} 张</span><button className="outline" disabled={busy || !items.length} onClick={() => setSelected(items.map(item => item.id))}>全选</button><button className="outline" disabled={busy || !selected.length} onClick={() => setSelected([])}>取消选择</button>
      <button className="outline" title="仅移出快捷预览，保留图片资产" disabled={busy || !selected.length} onClick={() => {
        setBusy(true); void window.workspace.removeQuickImages(selected).then(items => {
          setItems(items); setSelected([]); message('已移出快捷预览，图片资产仍保留');
        }).catch(error => message(String(error))).finally(() => setBusy(false));
      }}>移出快捷预览</button>
      <button className="primary" disabled={busy || !accountId || !selected.length} onClick={() => void upload()}>{busy ? '导入中…' : '批量导入'}</button>
      <button className="outline" disabled={busy} onClick={() => {
        setBusy(true); void window.workspace.openImageAssets().catch(error => message(String(error))).finally(() => setBusy(false));
      }}>选择图片资产</button></div>
    <BarResizer bar={bar} />
    {marquee.box && <div className="image-selection-box" style={marquee.box} aria-hidden="true" />}
  </section>;
}
