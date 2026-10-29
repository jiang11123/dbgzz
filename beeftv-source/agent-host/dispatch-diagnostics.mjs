// A bounded projection of the existing dispatch ledger. This is not a request
// budget or execution journal; a diagnostic write failure cannot stop a model.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const safe = value => typeof value === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9._:@-]{0,159}$/.test(value)
  && !/secret|token|password|bearer|api.?key|sk-|:\/\//i.test(value) ? value : undefined;

export function createDispatchDiagnostics(file, launchId, { maxBytes = 1024 * 1024, segments = 4, maxAgeMs = 48 * 3600000 } = {}) {
  let writeErrors = 0;
  const record = entry => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      for (let i = 0; i < segments; i++) {
        const part = i ? `${file}.${i}` : file;
        try { if (Date.now() - fs.statSync(part).mtimeMs > maxAgeMs) fs.unlinkSync(part); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const value = { id: crypto.randomUUID(), launchId: safe(launchId), at: new Date().toISOString(),
        turnId: safe(entry.turnId), canvasId: safe(entry.canvasId), sessionId: safe(entry.sessionId),
        requestId: safe(entry.requestId), model: safe(entry.model), dispatchIndex: Number.isSafeInteger(entry.dispatchIndex) ? entry.dispatchIndex : undefined };
      const line = JSON.stringify(value) + '\n';
      let size = 0;
      try { size = fs.statSync(file).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (size + Buffer.byteLength(line) > maxBytes) {
        for (let i = segments - 1; i >= 1; i--) {
          const source = i === 1 ? file : `${file}.${i - 1}`;
          const target = `${file}.${i}`;
          fs.rmSync(target, { force: true });
          try { fs.renameSync(source, target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
      fs.appendFileSync(file, line, { mode: 0o600 });
      return true;
    } catch {
      writeErrors++;
      // Only a fixed reason: never print a local path or provider request.
      console.error('agent-host: diagnostic_ledger_write_failed');
      return false;
    }
  };
  return { record, writeErrors: () => writeErrors };
}
