import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { UpscaleJob, UpscaleTarget } from '../shared/types';

type Size = { width: number; height: number };
export function targetResolution(size: Size, target: UpscaleTarget): Size {
  if (target !== '2k' && target !== '4k') throw new Error('无效的超分目标');
  if (![size.width, size.height].every(v => Number.isFinite(v) && v > 0)) throw new Error('视频尺寸无效');
  const scale = (target === '2k' ? 2560 : 3840) / Math.max(size.width, size.height);
  return { width: Math.max(2, Math.round(size.width * scale / 2) * 2), height: Math.max(2, Math.round(size.height * scale / 2) * 2) };
}
export function makeUpscalePlan(inputPath: string, target: UpscaleTarget, size: Size) {
  const dimensions = targetResolution(size, target);
  if (Math.max(size.width, size.height) >= Math.max(dimensions.width, dimensions.height)) throw new Error('原视频已达到目标尺寸，无需超分');
  const parsed = path.parse(inputPath);
  return { inputPath, outputPath: path.join(parsed.dir, '超分视频', `${parsed.name}-${target.toUpperCase()}.mp4`), ...dimensions };
}
export function buildVideo2xArgs(plan: { inputPath: string; outputPath: string }): string[] {
  return ['-i', plan.inputPath, '-o', plan.outputPath, '-p', 'realesrgan', '-s', '4', '--realesrgan-model', 'realesrgan-plus', '--max-b-frames', '0', '-e', 'crf=17'];
}
export function validateEligiblePaths(requested: string[], allowed: string[]) {
  if (!Array.isArray(requested) || !requested.length) throw new Error('请至少选择一个视频');
  if (requested.some(p => typeof p !== 'string' || !allowed.includes(p))) throw new Error('只能处理视频库内的视频');
  return [...new Set(requested)];
}

export type UpscaleTools = { video2x: string; ffmpeg: string; ffprobe: string };
export class Video2xProgressParser {
  private buffer = '';
  constructor(private update: (progress: NonNullable<UpscaleJob['progress']>) => void) {}
  push(chunk: string) {
    this.buffer = (this.buffer + chunk).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    const pattern = /frame=(\d+)\/(\d+)\s*\(([\d.]+)%\);\s*fps=([\d.]+);\s*elapsed=(\d+:\d+:\d+);\s*remaining=(\d+:\d+:\d+)/g;
    let match: RegExpExecArray | null, end = 0;
    while ((match = pattern.exec(this.buffer))) {
      end = pattern.lastIndex;
      const frame = Number(match[1]), total = Number(match[2]);
      if (total > 0) this.update({ frame, total, percent: Math.min(100, frame / total * 100), fps: Number(match[4]), elapsed: match[5], remaining: match[6] });
    }
    this.buffer = this.buffer.slice(end).slice(-4000);
  }
}
export class ProcessExitError extends Error {
  constructor(executable: string, readonly code: number | null, readonly stdout: string, stderr: string) {
    super(`${path.basename(executable)} 运行失败 (${code})：${(stderr || stdout).slice(-1800)}`);
  }
}
export function isCompletedTeardownError(error: unknown, expectedFrames: number) {
  if (!(error instanceof ProcessExitError) || error.code !== 3221225477 || !(expectedFrames > 0)) return false;
  return error.stdout.includes('Video processed successfully') && Number(error.stdout.match(/Total frames processed:\s*(\d+)/)?.[1]) === expectedFrames;
}
export function runCommand(executable: string, args: string[], signal?: AbortSignal, onOutput?: (chunk: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false, signal });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-64000); onOutput?.(String(chunk)); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    let processError: Error | undefined;
    child.on('error', error => { processError = error; });
    // Wait for closed file handles before callers remove temporary outputs on cancellation.
    child.on('close', code => processError ? reject(processError) : code === 0 ? resolve(stdout) : reject(new ProcessExitError(executable, code, stdout, stderr)));
  });
}
export async function probeVideo(file: string, executable: string, signal?: AbortSignal) {
  const metadata = JSON.parse(await runCommand(executable, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,sample_aspect_ratio,nb_frames,duration:stream_side_data=rotation:format=duration', '-of', 'json', file], signal));
  const stream = metadata.streams?.[0];
  if (!stream) throw new Error('文件中没有视频轨道');
  const [num, den] = String(stream.sample_aspect_ratio || '1:1').split(':').map(Number);
  let width = Number(stream.width) * (num > 0 && den > 0 ? num / den : 1), height = Number(stream.height);
  const rotation = Number(stream.side_data_list?.find((item: { rotation?: number }) => item.rotation !== undefined)?.rotation || 0);
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  targetResolution({ width, height }, '2k');
  return { width, height, frameCount: Number(stream.nb_frames) || 0, duration: Number(stream.duration) || Number(metadata.format?.duration) || 0 };
}

// Only this process owns the queue; one GPU job runs at a time.
export class UpscaleQueue {
  private preparations = new Map<string, () => Promise<{ inputPath: string; outputDirectory: string; cleanup: () => void }>>();
  private jobs: UpscaleJob[] = [];
  private busy = false;
  private controller?: AbortController;
  constructor(private tools: () => UpscaleTools, private notify: () => void,
    private archive: (job: UpscaleJob) => void) {}
  list() { return this.jobs.map(job => ({ ...job })); }
  enqueueRemote(name: string, target: UpscaleTarget, prepare: () => Promise<{ inputPath: string; outputDirectory: string; cleanup: () => void }>) {
    targetResolution({ width: 1, height: 1 }, target);
    const job: UpscaleJob = { id: randomUUID(), inputPath: name, target, state: 'queued', stage: '等待超分' };
    this.preparations.set(job.id, prepare); this.jobs.push(job);
    this.notify(); void this.drain(); return job.id;
  }
  enqueue(paths: string[], target: UpscaleTarget) {
    targetResolution({ width: 1, height: 1 }, target);
    for (const inputPath of paths) {
      if (this.jobs.some(j => j.inputPath === inputPath && j.target === target && ['queued', 'running'].includes(j.state))) continue;
      this.jobs.push({ id: randomUUID(), inputPath, target, state: 'queued', stage: '等待处理' });
    }
    this.notify(); void this.drain(); return this.list();
  }
  cancel() {
    for (const job of this.jobs) if (job.state === 'queued') { job.state = 'cancelled'; job.stage = '已取消'; this.preparations.delete(job.id); }
    this.controller?.abort(); this.notify();
  }
  private async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const job of this.jobs) {
        if (job.state !== 'queued') continue;
        this.controller = new AbortController();
        const signal = this.controller.signal;
        let temp = '';
        let cleanup: (() => void) | undefined;
        try {
          job.state = 'running'; job.stage = '读取视频信息'; this.notify();
          let outputDirectory: string | undefined;
          const prepare = this.preparations.get(job.id);
          if (prepare) {
            job.stage = '准备超分视频'; this.notify();
            const prepared = await prepare();
            cleanup = prepared.cleanup; outputDirectory = prepared.outputDirectory; job.inputPath = prepared.inputPath;
            if (signal.aborted) throw new Error('已取消');
          }
          const tools = this.tools();
          const source = await probeVideo(job.inputPath, tools.ffprobe, signal);
          const plan = makeUpscalePlan(job.inputPath, job.target, source);
          if (outputDirectory) plan.outputPath = path.join(outputDirectory, path.basename(plan.outputPath));
          fs.mkdirSync(path.dirname(plan.outputPath), { recursive: true });
          temp = fs.mkdtempSync(path.join(path.dirname(plan.outputPath), '.upscale-'));
          // Normalize display rotation and non-square pixels before AI processing.
          let input = job.inputPath;
          const normalized = path.join(temp, 'normalized.mp4');
          job.stage = '准备画面与方向'; this.notify();
          const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
          // Video2X 6.4 does not flush delayed B-frames reliably at EOF.
          await runCommand(tools.ffmpeg, ['-nostdin', '-v', 'error', '-i', input, '-map', '0:v:0', '-an', '-vf', `scale=${even(source.width)}:${even(source.height)},setsar=1`, '-c:v', 'libx264', '-bf', '0', '-crf', '16', '-preset', 'fast', normalized], signal);
          input = normalized;
          const expected = await probeVideo(normalized, tools.ffprobe, signal);
          let edge = Math.max(source.width, source.height), pass = 0;
          while (edge < Math.max(plan.width, plan.height)) {
            const output = path.join(temp, `ai-${++pass}.mp4`);
            job.stage = `Video2X AI 超分（第 ${pass} 轮）`; this.notify();
            job.progress = undefined;
            const parser = new Video2xProgressParser(progress => {
              const previous = job.progress;
              job.progress = progress;
              if (previous?.frame !== progress.frame || previous?.elapsed !== progress.elapsed) this.notify();
            });
            try { await runCommand(tools.video2x, buildVideo2xArgs({ inputPath: input, outputPath: output }), signal, chunk => parser.push(chunk)); }
            catch (error) {
              // This driver/runtime can fault during teardown after successful muxing.
              // Never accept arbitrary nonzero exits, incomplete summaries, or partial files.
              if (signal.aborted || !isCompletedTeardownError(error, expected.frameCount)) throw error;
              job.stage = '引擎退出异常，正在逐帧校验'; this.notify();
              await runCommand(tools.ffmpeg, ['-nostdin', '-v', 'error', '-xerror', '-i', output, '-map', '0:v:0', '-f', 'null', '-'], signal);
              const verified = await probeVideo(output, tools.ffprobe, signal);
              if (verified.frameCount !== expected.frameCount || Math.abs(verified.duration - expected.duration) > 0.1) throw new Error('引擎异常且输出不完整');
            }
            input = output; edge *= 4;
          }
          job.stage = '等比例输出并保留音频'; this.notify();
          const final = path.join(temp, 'final.mp4');
          await runCommand(tools.ffmpeg, ['-nostdin', '-v', 'error', '-i', input, '-i', job.inputPath, '-map', '0:v:0', '-map', '1:a?', '-vf', `scale=${plan.width}:${plan.height}:flags=lanczos,setsar=1`, '-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', final], signal);
          const result = await probeVideo(final, tools.ffprobe, signal);
          if (result.width !== plan.width || result.height !== plan.height || !fs.statSync(final).size) throw new Error('超分输出尺寸验证失败');
          if (!expected.frameCount || result.frameCount !== expected.frameCount) throw new Error('超分输出帧数不完整，未归档');
          if (source.duration > 0 && Math.abs(result.duration - source.duration) > Math.max(0.15, source.duration * 0.01)) throw new Error('超分输出时长异常，未归档');
          let destination = plan.outputPath, suffix = 1;
          for (;;) {
            try { fs.copyFileSync(final, destination, fs.constants.COPYFILE_EXCL); break; }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; destination = plan.outputPath.replace(/\.mp4$/, `-${++suffix}.mp4`); }
          }
          job.outputPath = destination;
          this.archive(job);
          job.state = 'completed'; job.stage = '已完成';
        } catch (error) {
          job.state = signal.aborted ? 'cancelled' : 'failed'; job.stage = signal.aborted ? '已取消' : '处理失败';
          job.error = signal.aborted ? undefined : error instanceof Error ? error.message : String(error);
        } finally {
          this.preparations.delete(job.id);
          if (cleanup) { try { cleanup(); } catch { /* only internal cached source; never remove user files */ } }
          if (temp) { try { fs.rmSync(temp, { recursive: true, force: true }); } catch { job.error = `${job.error || ''}\n临时目录未能清理：${temp}`.trim(); } }
          this.controller = undefined; this.notify();
        }
      }
    } finally { this.busy = false; }
  }
}
