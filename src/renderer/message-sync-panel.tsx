import {useEffect,useState} from 'react';
type State=Awaited<ReturnType<Window['workspace']['messageSyncState']>>;
export function MessageSyncPanel(){
  const [state,setState]=useState<State|null>(null);
  const [order,setOrder]=useState<string[]>([]);
  const [target,setTarget]=useState(0);
  const [notice,setNotice]=useState('');
  const [busy,setBusy]=useState(false);
  const refresh=async()=>{const next=await window.workspace.messageSyncState();setState(next);setOrder(next.draft?.assetIds || []);setTarget(next.draft?.targetId || 0);if(next.draft?.warning)setNotice(next.draft.warning);};
  useEffect(()=>{void refresh().catch(e=>setNotice(String(e)));},[]);
  const run=async(fn:()=>Promise<void>)=>{if(busy)return;setBusy(true);setNotice('');try{await fn();}catch(e){setNotice(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
  const move=(index:number,offset:number)=>{const next=[...order];[next[index],next[index+offset]]=[next[index+offset],next[index]];setOrder(next);};
  return <main className="message-sync-panel"><h1>按顺序重新导入聊天图片</h1><p>读取来源窗口的图片，按下方编号逐张重新上传。目标窗口确认出现每张图片后，才继续下一张。</p>
    <div className="message-sync-row">{([['draft','读取输入框图片'],['latest','读取最近含图消息'],['loaded','读取已加载聊天图片']] as const).map(([kind,label])=><button className="outline" disabled={busy} key={kind} onClick={()=>void run(async()=>{await window.workspace.readMessageImages(kind);await refresh();})}>{label}</button>)}</div>
    <p>共 {order.length} 张 · 从左到右按编号导入。网页只提供缩略图时，会使用可读取的网页图片。</p>
    <div className="message-sync-images">{order.map((id,index)=>{const image=state?.images.find(a=>a?.id===id);return <article key={index}><strong>第 {index+1} 张</strong><img src={image?.url} alt={image?.name || '聊天图片'}/><div><button className="outline" disabled={busy || !index} onClick={()=>move(index,-1)}>前移</button><button className="outline" disabled={busy || index===order.length-1} onClick={()=>move(index,1)}>后移</button><button className="outline" disabled={busy} onClick={()=>setOrder(order.filter((_,i)=>i!==index))}>移除</button></div></article>;})}</div>
    {!order.length && <p>没有读到图片。请返回来源账号打开含图聊天，加载图片后点击上面的读取按钮；顶部快捷预览中的图片需要先导入聊天框。</p>}
    <label>目标账号<select disabled={busy} value={target} onChange={e=>setTarget(Number(e.target.value))}>{state?.accounts.filter(a=>a.id!==state.draft?.sourceAccountId).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
    <details><summary>本次同步的文字</summary><pre className="message-sync-preview">{state?.draft?.prompt || '无文字'}</pre></details>
    <div className="message-sync-row">{[false,true].map(send=><button key={String(send)} className={send?'outline':'primary'} disabled={busy || !order.length || !state?.draft || !target} onClick={()=>void run(async()=>{await window.workspace.submitMessageImages({id:state!.draft!.id,targetId:target,assetIds:order,send});setNotice(send?'图片已按顺序重新导入并发送':'图片和文字已按顺序放入目标输入框，请检查后发送');})}>{busy?'正在逐张导入…':send?'重新导入并发送':'按顺序重新导入到输入框'}</button>)}</div>
    {notice && <p className="image-assets-notice" role="status">{notice}</p>}
  </main>;
}
