import { useEffect, useState } from 'react';
import type { UpscaleJob } from '../shared/types';

export function UpscaleNotice() {
  const [jobs, setJobs] = useState<UpscaleJob[]>([]);
  const [dismissed, setDismissed] = useState<string[]>([]);
  useEffect(() => {
    let disposed = false;
    const refresh = () => { void window.workspace.listUpscales().then(value => { if (!disposed) setJobs(value); }).catch(() => {}); };
    const unsubscribe = window.workspace.onUpscaleChanged(refresh); refresh();
    return () => { disposed = true; unsubscribe(); };
  }, []);
  const visible = jobs.filter(job => !dismissed.includes(job.id));
  const job = visible.find(job => job.state === 'running') || visible.find(job => job.state === 'queued') || visible.at(-1);
  if (!job) return null;
  const complete = job.state === 'completed';
  const ai = job.state === 'running' && job.stage.includes('AI 超分');
  return <div className={`download-notice upscale-notice ${job.state}`} role="status" aria-label="超分实时进度">
    <div><b>{complete ? '超分完成，视频已保存' : job.state === 'failed' ? '超分失败' : job.state === 'cancelled' ? '超分已取消' : job.stage} · {job.target.toUpperCase()}</b>
      <span>{job.inputPath.split(/[\\/]/).pop()}{visible.length > 1 ? ` · 共 ${visible.length} 项任务` : ''}</span>
      {ai && <><progress max={100} value={job.progress?.percent} /><span>{job.progress ? `${job.progress.percent.toFixed(1)}% · ${job.progress.frame}/${job.progress.total} 帧 · ${job.progress.fps.toFixed(2)} 帧/秒 · 已用 ${job.progress.elapsed} · 预计剩余 ${job.progress.fps > 0 ? job.progress.remaining : '计算中'}` : '引擎启动中，等待实际帧进度…'}</span></>}
      {!ai && job.state === 'running' && <span>正在处理，完成后自动保存超分视频</span>}
      {job.error && <span>{job.error}</span>}
    </div>
    {complete && job.outputPath && <button className="download-location" onClick={() => void window.workspace.openFolder(job.outputPath!)}>打开下载位置</button>}
    {!['queued', 'running'].includes(job.state) && <button className="download-dismiss" aria-label="关闭超分提示" onClick={() => setDismissed(old => [...old, job.id])}>×</button>}
  </div>;
}
