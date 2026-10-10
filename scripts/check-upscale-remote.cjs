const { UpscaleQueue } = require('../dist/main/main/video-upscale');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'upscale-remote-check-'));
const outputDirectory = path.join(root, 'exports/upscale-check/remote-results');
const source = path.join(cache, 'cached-source.mp4');
let archived = false, progressEvents = 0, cleaned = false;
const queue = new UpscaleQueue(() => ({ video2x: path.join(root, 'tools/video2x/video2x.exe'), ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }), () => {
  const job = queue.list()[0];
  if (job?.progress?.frame > 0 && job.state === 'running') { progressEvents++; console.log('Real progress:', job.progress.frame, '/', job.progress.total, job.progress.percent); }
}, job => { assert.ok(fs.statSync(job.outputPath).size > 0); archived = true; });
(async () => {
  queue.enqueueRemote('网页视频', '2k', async () => {
    assert.equal(archived, false);
    fs.copyFileSync(path.join(root, 'exports/upscale-check/portrait.mp4'), source);
    return { inputPath: source, outputDirectory, cleanup: () => { fs.unlinkSync(source); fs.rmdirSync(cache); cleaned = true; } };
  });
  const deadline = Date.now() + 120000;
  while (queue.list().some(j => ['queued', 'running'].includes(j.state))) {
    if (Date.now() > deadline) { queue.cancel(); throw new Error('Timeout'); }
    await new Promise(r => setTimeout(r, 200));
  }
  const job = queue.list()[0];
  assert.equal(job.state, 'completed', job.error);
  assert.ok(progressEvents > 0, 'must receive real streamed Video2X progress');
  assert.ok(archived && cleaned);
  assert.equal(path.dirname(job.outputPath), outputDirectory);
  console.log('PASS: remote source cached privately, real frame progress streamed, final output archived, cached source cleaned');
})().catch(e => { console.error(e); process.exitCode = 1; });
