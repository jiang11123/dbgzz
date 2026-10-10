// Live regression: resolve the public share URL, not a hardcoded CDN download URL.
const { DoubaoShareService } = require('../dist/main/main/doubao-share');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const output = path.resolve(__dirname, '../exports/quality-compare/verified-download');
const expectedHash = '30476fb2f15797c17b2b190f7f4394ab6c9d7eb7360a6e681cc0df7620977c29';
(async () => {
  const service = new DoubaoShareService();
  const result = await service.parse('https://www.doubao.com/thread/xnA4b0RgYjx5HDLzi');
  const item = result.videos.find(video => video.vid === 'v0d69cg10004damem427dldb5p6cavg0');
  assert.ok(item, 'must resolve the same source video');
  const saved = await service.save(item.id, output);
  const bytes = fs.readFileSync(saved.path);
  const hash = createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash, expectedHash, 'resolved download must match the mini-program reference byte-for-byte');
  const metadata = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,nb_frames,bit_rate', '-of', 'json', saved.path], { encoding: 'utf8', windowsHide: true }));
  const report = { result: 'PASS', bytes: bytes.length, sha256: hash, video: metadata.streams[0], path: saved.path };
  fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
