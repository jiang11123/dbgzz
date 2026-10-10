import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DoubaoShareService, extractSharedVideos, normalizeShareUrl, decodePlaybackUrl, selectCleanVideo } from './doubao-share';

test('accepts pasted share text, rejects lookalike domains and private addresses', () => {
  assert.equal(normalizeShareUrl('看看这个 https://www.doubao.com/thread/abc123。'), 'https://www.doubao.com/thread/abc123');
  for (const value of ['https://www.doubao.com.evil.test/thread/a', 'http://127.0.0.1/thread/a', 'https://www.doubao.com/chat/a']) {
    assert.throws(() => normalizeShareUrl(value));
  }
});

test('saves a parsed MP4 once, rejects arbitrary IDs and removes invalid downloads', async () => {
  const fetchOriginal = globalThis.fetch;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-share-test-'));
  const source = { vid: 'v123', duration: 4, video_model: JSON.stringify({ fallback_api: 'https://vas-lf-x.snssdk.com/video/fplay/1/test/v123?key_seed=test&logo_type=watermark&force_fids=old' }) };
  const html = `<script data-fn-args="${JSON.stringify(source).replace(/"/g, '&quot;')}"></script>`;
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 32]), Buffer.from('ftypisom'), Buffer.alloc(32)]);
  let downloaded = 0; let valid = true;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith('/thread/')) return new Response(html);
    if (url.pathname.startsWith('/video/fplay/')) {
      assert.equal(url.searchParams.get('logo_type'), 'unwatermarked');
      assert.equal(url.searchParams.get('codec_type'), '8');
      assert.equal(url.searchParams.get('channel'), 'no');
      assert.equal(url.searchParams.get('force_fids'), null);
      return Response.json({ code: 0, video_info: { code: 0, data: { video_list: { video_1: { main_url: Buffer.from('https://v11-vdl.doubao.com/test.mp4').toString('base64'), vtype: 'mp4', vwidth: 720, vheight: 960 } } } } });
    }
    downloaded++;
    return new Response(valid ? mp4 : '<html>blocked</html>');
  };
  try {
    const service = new DoubaoShareService();
    await assert.rejects(service.save('untrusted-id', directory), /过期/);
    const result = await service.parse('https://www.doubao.com/thread/test');
    const first = await service.save(result.videos[0].id, directory);
    assert.deepEqual(fs.readFileSync(first.path), mp4);
    assert.equal((await service.save(result.videos[0].id, directory)).path, first.path);
    assert.equal(downloaded, 1);
    valid = false;
    const next = await service.parse('https://www.doubao.com/thread/test');
    await assert.rejects(service.save(next.videos[0].id, directory), /MP4/);
    assert.equal(fs.readdirSync(directory).length, 1);
  } finally {
    globalThis.fetch = fetchOriginal;
    for (const file of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, file));
    fs.rmdirSync(directory);
  }
});

test('prefers higher bitrate among equal-resolution clean renditions, using size as a tie-breaker', () => {
  const stream = (name: string, bitrate: number, size: number) => ({ main_url: Buffer.from(`https://v11-vdl.doubao.com/${name}.mp4`).toString('base64'), vwidth: 720, vheight: 1280, vtype: 'mp4', bitrate, size });
  const selected = selectCleanVideo({ video_list: { low: stream('low', 687021, 2580540), high: stream('high', 8014892, 30103935) } });
  assert.match(selected.url, /\/high\.mp4$/);
  assert.match(selectCleanVideo({ video_list: { small: stream('small', 0, 10), large: stream('large', 0, 100) } }).url, /\/large\.mp4$/);
  assert.match(selectCleanVideo({ video_list: { clean: stream('clean', 600000, 2000000), watermark: { ...stream('watermark', 9000000, 30000000), logo_type: 'watermark' } } }).url, /\/clean\.mp4$/);
});

test('reads nested SSR JSON without running page scripts and deduplicates videos', () => {
  const video = { vid: 'v123', duration: 4.065, video_model: JSON.stringify({ video_id: 'v123', fallback_api: 'https://vas-lf-x.snssdk.com/video/fplay/1/test/v123?key_seed=abc' }) };
  const data = JSON.stringify(['page', [{ routerDataFnArgs: [JSON.stringify({ video, content: JSON.stringify({ video }) })] }]]).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const videos = extractSharedVideos(`<script data-fn-args="${data}">throw new Error('do not run')</script>`);
  assert.equal(videos.length, 1);
  assert.equal(videos[0].vid, 'v123');
  assert.equal('duration' in videos[0], false);
  assert.throws(() => extractSharedVideos('<html>expired</html>'), /视频/);
});

test('decodes playback addresses and rejects untrusted hosts', () => {
  const url = 'https://v11-vdl.doubao.com/video/test.mp4';
  assert.equal(decodePlaybackUrl(Buffer.from(url).toString('base64')), url);
  const seed = Buffer.from('test-only-seed').toString('base64');
  const sha = (b: Buffer) => createHash('sha512').update(b).digest();
  const key = sha(Buffer.concat([sha(Buffer.from(seed, 'base64')), Buffer.from('TdTC5rgxYgkOUrPHpnM7pByyRiuCmrWKGWs521cXdST0m69/COjWjSanLjfBqVovHwWlGJKu8pSXMrYqOKrdWA==', 'base64')]));
  const cipher = createCipheriv('aes-128-cbc', key.subarray(0, 16), key.subarray(16, 32));
  const encoded = Buffer.concat([Buffer.alloc(4), cipher.update(url), cipher.final()]).toString('base64');
  assert.equal(decodePlaybackUrl(encoded, seed), url);
  assert.throws(() => decodePlaybackUrl(Buffer.from('https://127.0.0.1/secret').toString('base64')));
});

test('chooses highest clean MP4 and never silently returns a watermarked or encrypted stream', () => {
  const stream = (width: number, extra = {}) => ({ main_url: Buffer.from('https://v11-vdl.doubao.com/video/test.mp4').toString('base64'), vwidth: width, vheight: 960, vtype: 'mp4', codec_type: 'h264', ...extra });
  assert.equal(selectCleanVideo({ video_list: { low: stream(360), high: stream(720) } }).width, 720);
  assert.throws(() => selectCleanVideo({ video_list: { a: stream(720, { logo_type: 'video_gen_watermark_dyn' }) } }), /无水印/);
  assert.throws(() => selectCleanVideo({ video_list: { a: stream(720, { encryption_method: 'aes' }) } }), /无水印/);
  assert.throws(() => selectCleanVideo({ video_list: { a: stream(720, { main_url: Buffer.from('https://v11-vdl.doubao.com/video/test.mp4?lr=watermark').toString('base64') }) } }), /无水印/);
  assert.match(selectCleanVideo({ video_list: { a: stream(720, { main_url: Buffer.from('https://v11-vdl.doubao.com/video/test.mp4?lr=unwatermarked').toString('base64') }) } }).url, /lr=unwatermarked/);
});
