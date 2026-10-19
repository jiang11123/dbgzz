// Replay a local browser message capture, never log signed URLs or account data.
// Usage: node scripts/verify-chat-image-replay.mjs <capture.json> <output.png>
import fs from 'node:fs';
import https from 'node:https';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseEvent } = require('../dist/main/main/doubao-api.js');
const [capturePath, outputPath] = process.argv.slice(2);
assert.ok(capturePath && outputPath, 'capture and output paths required');
const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
const messages = capture.msgList.map(item => item.messageData);
const assistant = messages.find(message => message && message.sender === message.bot_id && message.ext?.creation_full_content);
assert.ok(assistant, 'assistant creation message missing');
const direct = parseEvent({ message: assistant }).mediaUrls;
const patch = parseEvent({ patch_op: [{ patch_object: 50, patch_value: { ext: { creation_full_content: assistant.ext.creation_full_content } } }] }).mediaUrls;
assert.equal(direct?.length, 1);
assert.deepEqual(patch, direct);
assert.ok(direct[0].includes('/rc_gen_image/'));
const bytes = await new Promise((resolve, reject) => {
  const request = https.get(direct[0], { headers: { Referer: 'https://www.doubao.com/', 'User-Agent': 'Mozilla/5.0' } }, response => {
    if (response.statusCode !== 200 || !response.headers['content-type']?.startsWith('image/')) {
      response.resume(); reject(new Error('image download failed: HTTP ' + response.statusCode)); return;
    }
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve(Buffer.concat(chunks)));
    response.on('error', reject);
  });
  request.setTimeout(30000, () => request.destroy(new Error('download timeout')));
  request.on('error', reject);
});
assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
fs.writeFileSync(outputPath, bytes);
console.log(JSON.stringify({ extractedOutputs: direct.length, directAndPatchAgree: true, bytes: bytes.length, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), outputPath }));
