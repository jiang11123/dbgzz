import { useEffect, useState } from 'react';
import type { ImageAsset } from '../shared/types';

export function ImageAssetsPanel() {
  const [items, setItems] = useState<ImageAsset[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [account, setAccount] = useState<{ id: number; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const refresh = async () => {
    const [library, data] = await Promise.all([window.workspace.listImageAssets(), window.workspace.load()]);
    setItems(library.items);
    setSelected(old => old.filter(id => library.items.some(item => item.id === id)));
    const current = data.accounts.find((a: { id: number }) => a.id === library.accountId);
    setAccount(current ? { id: current.id, name: current.name } : null);
  };
  useEffect(() => {
    void refresh().catch(e => setNotice(String(e)));
    const handler = () => void refresh().catch(e => setNotice(String(e)));
    window.addEventListener('focus', handler);
    const dispose = window.workspace.onImageAssetsChanged(handler);
    return () => { window.removeEventListener('focus', handler); dispose(); };
  }, []);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setNotice('');
    try { await action(); } catch (e) { setNotice(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <main className="image-assets-window">
    <div className="page-heading"><div><p className="eyebrow">所有账号共享 · 本地保存</p><h1>图片资产</h1></div>
      <button className="primary" disabled={busy} onClick={() => void run(async () => { setItems(await window.workspace.importImageAssets()); })}>导入图片</button></div>
    <p className="muted">导入一次，切换账号后继续使用。图片会保存副本，移动原图也不会影响资产。支持 PNG、JPG、WEBP、GIF，每张最多 30 MB。</p>
    <div className="image-assets-actions"><span>当前账号：{account?.name || '请先在主窗口打开账号'} · 已选 {selected.length} 张</span>
      <button className="outline" disabled={busy || !items.length} onClick={() => setSelected(items.map(item => item.id))}>全选</button>
      <button className="outline image-assets-delete" disabled={busy || !selected.length} onClick={() => {
        if (!window.confirm(`从资产库删除选中的 ${selected.length} 张图片？原图不会删除。`)) return;
        const ids = [...selected];
        void run(async () => {
          try {
            for (const id of ids) await window.workspace.removeImageAsset(id);
            setNotice(`已删除 ${ids.length} 张图片资产。`);
          } finally {
            await refresh();
          }
        });
      }}>删除所选</button>
      <button className="primary" disabled={busy || !selected.length} onClick={() => void run(async () => {
        await window.workspace.addQuickImages(selected);
        setNotice('已加入顶部快捷预览，可返回主窗口勾选、拖动或批量导入。');
      })}>加入快捷预览</button>
      <button className="primary" disabled={busy || !account || !selected.length} onClick={() => void run(async () => {
        await window.workspace.useImageAssets(selected, account!.id);
        setNotice('已加入当前账号的输入框，请等待豆包上传完成后查看。');
      })}>{busy ? '处理中…' : '添加到当前账号'}</button></div>
    {notice && <p className="image-assets-notice" role="status">{notice}</p>}
    {!items.length && <div className="drop-zone"><h2>还没有图片资产</h2><p>点击右上角“导入图片”开始添加。</p></div>}
    <div className="image-assets-grid">{items.map(item => <article className="image-asset-card" key={item.id}>
      <label><input type="checkbox" disabled={busy} checked={selected.includes(item.id)} onChange={e => setSelected(e.target.checked ? [...selected, item.id] : selected.filter(id => id !== item.id))} />
        <img src={item.url} alt={item.name} /><span title={item.name}>{item.name}</span></label>
      <div><small>{(item.size / 1024 / 1024).toFixed(2)} MB</small><button disabled={busy} onClick={() => {
        if (!window.confirm(`从资产库删除“${item.name}”？原图不会删除。`)) return;
        void run(async () => { setItems(await window.workspace.removeImageAsset(item.id)); setSelected(selected.filter(id => id !== item.id)); });
      }}>删除</button></div></article>)}</div>
  </main>;
}
