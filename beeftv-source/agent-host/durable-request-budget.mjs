import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLifetimeBudget, spendLifetimeRequest } from './request-budget.mjs';

// Single host owns this counter. Synchronous reservation serializes fetch callbacks;
// persist before dispatch, never refund an uncertain dispatch (including a crash).
export function createDurableRequestBudget({ limit, file }) {
  const budget = createLifetimeBudget({ limit });
  let failure;
  const unavailable = () => ({
    allowed: false,
    reason: 'request_budget_storage_unavailable',
    message: '无法安全保存模型请求总预算，已停止调用。请检查数据目录的可写权限和剩余空间；若计数文件损坏，请恢复有效备份后重启，勿删除文件清零。',
  });
  if (budget.limit > 0) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Number.isSafeInteger(saved?.used) || saved.used < 0) throw new Error('Invalid request count');
      budget.used = saved.used;
    } catch (error) {
      if (error.code !== 'ENOENT') failure = unavailable();
    }
  }
  return {
    get limit() { return budget.limit; },
    get used() { return budget.used; },
    reserve() {
      if (budget.limit <= 0) return { allowed: true };
      if (failure) return failure;
      const next = { ...budget };
      const verdict = spendLifetimeRequest(next);
      if (!verdict.allowed) return verdict;
      const temporary = `${file}.${randomUUID()}.tmp`;
      let fd;
      try {
        fd = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify(next));
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(temporary, file);
        // Windows does not support opening directories for fsync via Node.
        if (process.platform !== 'win32') {
          fd = fs.openSync(path.dirname(file), 'r');
          fs.fsyncSync(fd);
          fs.closeSync(fd);
          fd = undefined;
        }
        budget.used = next.used;
        return verdict;
      } catch {
        // Rename may already have committed: never retry with the stale counter.
        failure = unavailable();
        return failure;
      } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
        try { fs.unlinkSync(temporary); } catch {}
      }
    },
  };
}
