import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// The existing synchronous spend* functions reserve through these setters.
// Persist before dispatch; a crash never gives the turn another full budget.
export function createDurableTurnBudget(entry, { maxRequests = 0, maxToolSteps = 0 } = {}) {
  if (!entry.budgetDirectory || !entry.turn.turnId) throw new Error('durable_budget_identity_missing');
  const file = path.join(entry.budgetDirectory, `${crypto.createHash('sha256').update(entry.turn.turnId).digest('hex')}.json`);
  let used = { version: 1, sessionId: entry.sessionId, turnId: entry.turn.turnId, requests: 0, toolSteps: 0 };
  try {
    used = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (used.version !== 1 || used.sessionId !== entry.sessionId || used.turnId !== entry.turn.turnId ||
      !['requests', 'toolSteps'].every((key) => Number.isSafeInteger(used[key]) && used[key] >= 0)) throw new Error('invalid budget');
  } catch (error) { if (error.code !== 'ENOENT') throw Object.assign(new Error('durable_budget_corrupt'), { reason: 'durable_budget_corrupt' }); }
  const budget = { maxRequests, maxToolSteps, generation: entry.generation };
  function save(key, value) {
    if (key !== 'failure' && (!Number.isSafeInteger(value) || value < 0)) throw new Error('invalid durable budget count');
    const next = { ...used, [key]: value };
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, file);
      if (process.platform !== 'win32') {
        fd = fs.openSync(entry.budgetDirectory, 'r'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      }
      used = next;
    } catch (error) {
      throw Object.assign(new Error('durable_budget_storage_unavailable'), { reason: 'durable_budget_storage_unavailable', cause: error });
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(temporary); } catch {}
    }
  }
  for (const key of ['requests', 'toolSteps']) Object.defineProperty(budget, key, {
    enumerable: true, get: () => used[key], set: (value) => save(key, value),
  });
  Object.defineProperty(budget, 'failure', { enumerable: true, get: () => used.failure,
    set: (value) => save('failure', value ? { allowed: false, reason: String(value.reason || 'budget_exhausted'),
      message: String(value.message || '').slice(0, 4096) } : null) });
  return budget;
}
