import fs from 'node:fs';
import path from 'node:path';
import type { Account } from '../shared/types';

/**
 * Account health in the shared pool.
 * - healthy: usable right now
 * - cooling: temporary failure (rate limit / transient); recovers when cooldown expires
 * - quota_exhausted: daily generation quota used up; recovers at the next local midnight
 * - captcha: blocked by human verification; requires manual action, never auto-recovers
 * - logged_out: session invalid; requires re-login, never auto-recovers
 */
export type AccountHealth = 'healthy' | 'cooling' | 'quota_exhausted' | 'captcha' | 'logged_out';

export type FailureKind = 'rate_limit' | 'quota' | 'captcha' | 'logged_out' | 'transient';

export interface AccountPoolEntry {
  accountId: number;
  health: AccountHealth;
  weight: number;
  cooldownUntil: number | null;
  dailyUsed: number;
  dailyResetAt: number;
  consecutiveFailures: number;
  lastOkAt: string | null;
  lastError: string | null;
}

export interface AccountPoolSnapshot extends AccountPoolEntry {
  available: boolean;
  cooldownRemainingMs: number;
}

const BASE_COOLDOWN_MS = 30_000;
/** How long a captcha-blocked account waits before the pool probes it again. */
const CAPTCHA_REARM_MS = 5 * 60 * 1000;
const MAX_COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_WEIGHT = 1;

export function nextLocalMidnight(now: number): number {
  const date = new Date(now);
  date.setHours(24, 0, 0, 0);
  return date.getTime();
}

function emptyEntry(accountId: number, now: number): AccountPoolEntry {
  return {
    accountId,
    health: 'healthy',
    weight: DEFAULT_WEIGHT,
    cooldownUntil: null,
    dailyUsed: 0,
    dailyResetAt: nextLocalMidnight(now),
    consecutiveFailures: 0,
    lastOkAt: null,
    lastError: null,
  };
}

/**
 * Runtime state for the multi-account pool: health, cooldown, daily usage and
 * weighted selection. Pure logic with an injectable clock so it is unit-testable
 * without Electron, and persisted so quota/cooldown survive a restart.
 */
export class AccountPool {
  private entries = new Map<number, AccountPoolEntry>();
  private readonly storePath: string | null;

  constructor(storePath: string | null = null, private readonly now: () => number = Date.now, private readonly rng: () => number = Math.random) {
    this.storePath = storePath;
    this.restore();
  }

  private restore() {
    if (!this.storePath) return;
    try {
      const persisted = JSON.parse(fs.readFileSync(this.storePath, 'utf8')) as AccountPoolEntry[];
      for (const entry of persisted) {
        if (!entry || !Number.isSafeInteger(entry.accountId)) continue;
        this.entries.set(entry.accountId, { ...emptyEntry(entry.accountId, this.now()), ...entry });
      }
    } catch {
      // No persisted pool state is normal on a first launch.
    }
  }

  private persist() {
    if (!this.storePath) return;
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      fs.writeFileSync(this.storePath, JSON.stringify([...this.entries.values()], null, 2), 'utf8');
    } catch {
      // Losing pool state must never break task dispatch.
    }
  }

  /** Rolls daily counters forward and lets quota_exhausted accounts recover at midnight. */
  private rollDay(entry: AccountPoolEntry) {
    const current = this.now();
    if (current < entry.dailyResetAt) return;
    entry.dailyUsed = 0;
    entry.dailyResetAt = nextLocalMidnight(current);
    if (entry.health === 'quota_exhausted') {
      entry.health = 'healthy';
      entry.consecutiveFailures = 0;
      entry.lastError = null;
    }
  }

  private entry(accountId: number): AccountPoolEntry {
    let found = this.entries.get(accountId);
    if (!found) {
      found = emptyEntry(accountId, this.now());
      this.entries.set(accountId, found);
    }
    this.rollDay(found);
    return found;
  }

  /** A cooling account becomes healthy again as soon as its cooldown expires. */
  private recover(entry: AccountPoolEntry) {
    if (entry.health === 'cooling' && entry.cooldownUntil !== null && this.now() >= entry.cooldownUntil) {
      entry.health = 'healthy';
      entry.cooldownUntil = null;
      entry.lastError = null;
    }
  }

  /**
   * Puts a captcha-blocked account back into rotation so the next request probes it.
   *
   * A captcha account is never picked, so it can never succeed and can never clear
   * itself — the console would show "需人机验证" forever even after the user finished
   * the verification in the Doubao window. Re-arming it periodically lets one request
   * find out: it either succeeds (markOk) or fails again and stays blocked.
   */
  private rearmCaptcha(entry: AccountPoolEntry) {
    if (entry.health !== 'captcha') return;
    if (entry.cooldownUntil === null) {
      // First rearm: give the user a moment to finish the verification.
      entry.cooldownUntil = this.now() + CAPTCHA_REARM_MS;
      return;
    }
    if (this.now() < entry.cooldownUntil) return;
    // Re-arm straight to healthy: the very next request is the probe. Going through
    // 'cooling' would need a second pass to become pickable, and recover() runs before
    // this in isAvailable(), so the account would stay unavailable one call too long.
    entry.health = 'healthy';
    entry.consecutiveFailures = 0;
    entry.lastError = null;
    entry.cooldownUntil = this.now() + CAPTCHA_REARM_MS;
  }

  isAvailable(account: Account, busyAccountIds: ReadonlySet<number> = new Set()): boolean {
    if (!account.isLoggedIn) return false;
    if (busyAccountIds.has(account.id)) return false;
    const entry = this.entry(account.id);
    this.recover(entry);
    this.rearmCaptcha(entry);
    return entry.health === 'healthy';
  }

  /**
   * Weighted random pick among available accounts. Accounts blocked by captcha,
   * an invalid session or an active cooldown are never returned.
   */
  pick(accounts: Account[], busyAccountIds: ReadonlySet<number> = new Set()): Account | null {
    const candidates = accounts.filter(account => this.isAvailable(account, busyAccountIds));
    if (!candidates.length) return null;
    const weights = candidates.map(account => Math.max(1, Math.floor(this.entry(account.id).weight)));
    const total = weights.reduce((sum, value) => sum + value, 0);
    let target = Math.floor(this.rng() * total);
    for (let index = 0; index < candidates.length; index += 1) {
      target -= weights[index];
      if (target < 0) return candidates[index];
    }
    return candidates[candidates.length - 1];
  }

  markOk(accountId: number) {
    const entry = this.entry(accountId);
    entry.health = 'healthy';
    entry.cooldownUntil = null;
    entry.consecutiveFailures = 0;
    entry.lastOkAt = new Date(this.now()).toISOString();
    entry.lastError = null;
    entry.dailyUsed += 1;
    this.persist();
  }

  markFailure(accountId: number, kind: FailureKind, message = '') {
    const entry = this.entry(accountId);
    entry.lastError = message || kind;
    entry.consecutiveFailures += 1;
    const current = this.now();
    switch (kind) {
      case 'quota':
        entry.health = 'quota_exhausted';
        entry.cooldownUntil = null;
        break;
      case 'captcha':
        entry.health = 'captcha';
        // Restart the re-arm grace period so a repeated block is not probed again
        // on the very next request.
        entry.cooldownUntil = current + CAPTCHA_REARM_MS;
        break;
      case 'logged_out':
        entry.health = 'logged_out';
        entry.cooldownUntil = null;
        break;
      default: {
        const backoff = Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * 2 ** (entry.consecutiveFailures - 1));
        entry.health = 'cooling';
        entry.cooldownUntil = current + backoff;
        break;
      }
    }
    this.persist();
  }

  /** Manual recovery from the console: clears cooldown and marks the account healthy again. */
  clearCooldown(accountId: number) {
    const entry = this.entry(accountId);
    entry.health = 'healthy';
    entry.cooldownUntil = null;
    entry.consecutiveFailures = 0;
    entry.lastError = null;
    this.persist();
  }

  setWeight(accountId: number, weight: number) {
    const entry = this.entry(accountId);
    entry.weight = Number.isFinite(weight) && weight > 0 ? Math.floor(weight) : DEFAULT_WEIGHT;
    this.persist();
  }

  forget(accountId: number) {
    if (this.entries.delete(accountId)) this.persist();
  }

  snapshot(accounts: Account[], busyAccountIds: ReadonlySet<number> = new Set()): AccountPoolSnapshot[] {
    return accounts.map(account => {
      const entry = this.entry(account.id);
      this.recover(entry);
      const cooldownRemainingMs = entry.cooldownUntil === null ? 0 : Math.max(0, entry.cooldownUntil - this.now());
      return { ...entry, available: this.isAvailable(account, busyAccountIds), cooldownRemainingMs };
    });
  }

  health(accountId: number): AccountHealth {
    const entry = this.entry(accountId);
    this.recover(entry);
    return entry.health;
  }
}
