// Real Video2X smoke test. Uses only generated fixtures under exports/upscale-check.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { UpscaleQueue, probeVideo, runCommand } = require('../dist/main/main/video-upscale');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'exports/upscale-check');
const tools = { video2x: path.join(root, 'tools/video2x/video2x.exe'), ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
const archived = [];
const stages = new Map();
const queue = new UpscaleQueue(() => tools, () => {
  for (const job of queue.list()) if (stages.get(job.id) !== job.stage) { stages.set(job.id, job.stage); console.log(path.basename(job.inputPath), job.stage, job.error || ''); }
}, (job) => archived.push({ ...job }));
async function wait() {
  const deadline = Date.now() + 300000;
  while (queue.list().some(j => ['queued', 'running'].includes(j.state))) {
    if (Date.now() > deadline) { queue.cancel(); throw new Error('Video2X smoke timeout'); }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}
(async () => {
  fs.mkdirSync(directory, { recursive: true });
  const portrait = path.join(directory, 'portrait.mp4');
  const landscape = path.join(directory, 'landscape.mp4');
  if (!fs.existsSync(portrait)) await runCommand('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=480x640:rate=2:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', portrait]);
  if (!fs.existsSync(landscape)) await runCommand('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=960x540:rate=2:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', landscape]);
  const outputDir = path.join(directory, '超分视频');
  const previous = fs.existsSync(outputDir) ? fs.readdirSync(outputDir).filter(p => p.endsWith('.mp4')).map(p => [p, fs.readFileSync(path.join(outputDir, p))]) : [];
  const originalSize = fs.statSync(portrait).size;
  queue.enqueue([path.join(directory, 'missing.mp4'), portrait], '2k');
  queue.enqueue([portrait], '2k');
  queue.enqueue([landscape], '4k');
  assert.equal(queue.list().length, 3, 'duplicate active request is ignored');
  await wait();
  assert.equal(queue.list()[0].state, 'failed', 'missing input reports failure');
  assert.equal(archived.length, 2, 'batch continues after failure');
  for (const job of archived) {
    const output = await probeVideo(job.outputPath, tools.ffprobe);
    assert.deepEqual({ width: output.width, height: output.height }, job.target === '2k' ? { width: 1920, height: 2560 } : { width: 3840, height: 2160 });
    assert.ok(Math.abs(output.duration - 1) < 0.15);
  }
  const audio = await runCommand('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'json', archived[0].outputPath]);
  assert.equal(JSON.parse(audio).streams.length, 1, 'source audio is retained');
  assert.equal(fs.statSync(portrait).size, originalSize, 'original file untouched');
  previous.forEach(([file, bytes]) => assert.deepEqual(fs.readFileSync(path.join(outputDir, file)), bytes, 'existing output is not overwritten'));
  assert.ok(!fs.readdirSync(path.join(directory, '超分视频')).some(p => p.startsWith('.upscale-')), 'temporary files cleaned');
  queue.enqueue([portrait, landscape], '4k'); queue.cancel(); await wait();
  assert.ok(queue.list().slice(-2).every(j => j.state === 'cancelled'), 'active and waiting work can be cancelled');
  console.log('PASS: real GPU 2K portrait + 4K landscape, audio, failed item isolation, deduplication, cancellation and cleanup');
  fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify(archived.map(item => ({ ...item, ...queue.list().find(j => j.id === item.id) })), null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
