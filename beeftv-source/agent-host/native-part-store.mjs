import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ID = /^[a-f0-9]{64}$/;
const MAX_BYTES = 8 * 1024 * 1024;
const MIME = new Set(['audio/wav', 'video/mp4']);
const error = reason => new Error(reason);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function sourceKey(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source) ||
      typeof source.resourceId !== 'string' || !source.resourceId || typeof source.version !== 'string' || !source.version ||
      JSON.stringify(source).length > 4096) throw error('missing_media_source');
  return JSON.stringify(Object.fromEntries(Object.entries(source).sort(([a], [b]) => a.localeCompare(b))));
}
function atomic(directory, file, bytes) {
  const temporary = path.join(directory, `.part-${crypto.randomUUID()}`);
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
  catch (cause) { fs.closeSync(fd); fs.rmSync(temporary, { force: true }); throw cause; }
  fs.closeSync(fd);
  try { fs.renameSync(temporary, file); } catch (cause) { fs.rmSync(temporary, { force: true }); throw cause; }
  // Directory fsync makes the rename durable on supported local filesystems.
  // Windows cannot open directories with this POSIX mode.
  if (process.platform !== 'win32') { const handle = fs.openSync(directory, 'r'); try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); } }
}

// These files are formal session media references, not disposable temp cache.
// Only a validated backend tool result is admitted; reads never create files.
export function createNativePartStore({ directory }) {
  if (!directory) throw error('native_part_directory_required');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  function manifest(id) {
    if (!ID.test(id)) throw error('invalid_native_part_reference');
    const file = path.join(directory, `${id}.json`);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw error('invalid_native_part_reference');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.version !== 1 || value.id !== id || value.sha256 !== id || !MIME.has(value.mimeType) ||
        !Number.isInteger(value.size) || value.size <= 0 || value.size > MAX_BYTES || !Array.isArray(value.sources) || !value.sources.length) throw error('native_part_manifest_changed');
    for (const source of value.sources) sourceKey(source);
    return value;
  }
  function read(reference) {
    const id = typeof reference === 'string' ? reference : reference?.id;
    const stored = manifest(id);
    const source = typeof reference === 'string' ? stored.sources[0] : reference.source;
    if (typeof reference !== 'string' && (reference.sha256 !== id || reference.mimeType !== stored.mimeType)) throw error('native_part_manifest_changed');
    if (!stored.sources.some(candidate => sourceKey(candidate) === sourceKey(source))) throw error('native_part_source_changed');
    const file = path.join(directory, `${id}.bin`);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw error('invalid_native_part_reference');
    if (stat.size !== stored.size || stat.size > MAX_BYTES) throw error('media_content_changed');
    const bytes = fs.readFileSync(file);
    if (sha(bytes) !== id) throw error('media_content_changed');
    return { type: 'media', mimeType: stored.mimeType, data: bytes.toString('base64'), sha256: id, source };
  }
  function write(part) {
    if (part?.type !== 'media' || !MIME.has(part.mimeType) || typeof part.data !== 'string' ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(part.data) || part.data.length > MAX_BYTES * 4 / 3 + 4 || !ID.test(part.sha256)) throw error('invalid_media_content');
    const bytes = Buffer.from(part.data, 'base64');
    if (!bytes.length || bytes.length > MAX_BYTES || bytes.toString('base64') !== part.data) throw error('invalid_media_content');
    if (sha(bytes) !== part.sha256) throw error('media_content_changed');
    const key = sourceKey(part.source), id = part.sha256;
    const file = path.join(directory, `${id}.json`);
    let value = { version: 1, id, sha256: id, mimeType: part.mimeType, size: bytes.length, sources: [part.source] };
    if (fs.existsSync(file)) {
      const previous = manifest(id);
      read(id); // Never repair over a tampered or missing formal reference.
      if (previous.mimeType !== part.mimeType) throw error('native_part_manifest_changed');
      value = previous;
      if (!value.sources.some(source => sourceKey(source) === key)) value.sources.push(part.source);
    } else atomic(directory, path.join(directory, `${id}.bin`), bytes);
    atomic(directory, file, JSON.stringify(value));
    return { id, sha256: id, mimeType: part.mimeType, source: part.source };
  }
  return { write, read };
}
