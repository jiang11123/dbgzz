import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountPool, nextLocalMidnight } from './account-pool';
import type { Account } from '../shared/types';

const account = (id: number, name = `账号${id}`, isLoggedIn = true): Account => ({
  id, name, platform: 'doubao', note: '', sessionName: `persist:doubao_${id}`, isLoggedIn,
});

const store = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'account-pool-')), 'account-pool.json');

test('never prefers an account by its display name', () => {
  const pool = new AccountPool(null, () => Date.now(), () => 0);
  const accounts = [account(1, '普通号'), account(2, '旺仔一号')];
  // The old implementation hardcoded "旺仔" first; the pool must be name-agnostic.
  assert.equal(pool.pick(accounts, new Set())?.id, 1);
});

test('skips logged-out accounts and busy accounts', () => {
  const pool = new AccountPool(null);
  const accounts = [account(1, '未登录', false), account(2, '忙'), account(3, '可用')];
  assert.equal(pool.pick(accounts, new Set([2]))?.id, 3);
  assert.equal(pool.pick([account(1, '未登录', false)], new Set()), null);
});

test('cools a transiently failing account and recovers it after the cooldown', () => {
  let now = 1_000_000;
  const pool = new AccountPool(null, () => now);
  const accounts = [account(1), account(2)];
  pool.markFailure(1, 'transient', '网络抖动');
  assert.equal(pool.health(1), 'cooling');
  assert.equal(pool.pick(accounts, new Set())?.id, 2);
  now += 31_000;
  assert.equal(pool.health(1), 'healthy');
});

test('quota exhaustion parks the account until the next local midnight', () => {
  let now = new Date('2026-10-14T10:00:00+08:00').getTime();
  const pool = new AccountPool(null, () => now);
  const accounts = [account(1), account(2)];
  pool.markFailure(1, 'quota', '额度不足');
  assert.equal(pool.health(1), 'quota_exhausted');
  assert.equal(pool.pick(accounts, new Set())?.id, 2);
  now = new Date('2026-10-14T23:59:00+08:00').getTime();
  assert.equal(pool.health(1), 'quota_exhausted');
  now = new Date('2026-10-15T00:01:00+08:00').getTime();
  assert.equal(pool.health(1), 'healthy');
  assert.equal(pool.pick(accounts, new Set([2]))?.id, 1);
});

test('logged_out never auto-recovers, and captcha only through its re-arm', () => {
  // logged_out means the session cookie is gone: only the user can fix it, so it must
  // stay blocked no matter how much time passes.
  let now = 1_000_000;
  const pool = new AccountPool(null, () => now);
  pool.markFailure(1, 'captcha', '710022004');
  pool.markFailure(2, 'logged_out', '会话失效');

  // Still blocked during the captcha re-arm grace period.
  now += 60_000;
  assert.equal(pool.health(1), 'captcha');
  assert.equal(pool.health(2), 'logged_out');
  assert.equal(pool.pick([account(1), account(2)], new Set()), null);

  // After a week logged_out is still blocked.
  now += 7 * 24 * 60 * 60 * 1000;
  assert.equal(pool.health(2), 'logged_out');
  assert.equal(pool.pick([account(2)], new Set()), null);

  // Manual recovery still works for both.
  pool.clearCooldown(1);
  pool.clearCooldown(2);
  // Both are healthy again, so the weighted pick returns one of them.
  assert.ok([1, 2].includes(pool.pick([account(1), account(2)], new Set())?.id ?? 0));
});

test('weighted selection follows the configured weights', () => {
  const pool = new AccountPool(null, () => 0, () => 0.99);
  const accounts = [account(1), account(2)];
  pool.setWeight(1, 1);
  pool.setWeight(2, 9);
  const counts = new Map<number, number>();
  for (let i = 0; i < 2000; i += 1) {
    const rng = i / 2000;
    const local = new AccountPool(null, () => 0, () => rng);
    local.setWeight(1, 1); local.setWeight(2, 9);
    const picked = local.pick(accounts, new Set())!;
    counts.set(picked.id, (counts.get(picked.id) ?? 0) + 1);
  }
  assert.ok((counts.get(2) ?? 0) > (counts.get(1) ?? 0) * 3, JSON.stringify([...counts]));
});

test('pool state survives a restart', () => {
  const file = store();
  const now = new Date('2026-10-14T12:00:00+08:00').getTime();
  const first = new AccountPool(file, () => now);
  first.markFailure(7, 'quota', '额度不足');
  first.markOk(8);
  const second = new AccountPool(file, () => now);
  assert.equal(second.health(7), 'quota_exhausted');
  const snapshot = second.snapshot([account(7), account(8)], new Set());
  assert.equal(snapshot.find(item => item.accountId === 8)?.dailyUsed, 1);
  assert.equal(snapshot.find(item => item.accountId === 7)?.available, false);
});

test('next local midnight is strictly after the given instant', () => {
  const now = new Date('2026-10-14T23:59:59+08:00').getTime();
  const midnight = nextLocalMidnight(now);
  assert.ok(midnight > now);
  assert.equal(new Date(midnight).getHours(), 0);
});

test('a captcha account is re-armed so it can recover on its own', () => {
  // A captcha account is never picked, so without a rearm it could never succeed and
  // the console would show 需人机验证 forever — even after the user verified in Doubao.
  let now = 2_000_000;
  const pool = new AccountPool(null, () => now);
  const only = account(7);
  pool.markFailure(7, 'captcha', '豆包要求人机验证');
  assert.equal(pool.pick([only], new Set()), null);

  // Still blocked while the grace period runs.
  now += 60_000;
  assert.equal(pool.pick([only], new Set()), null);

  // After the grace period the pool probes it again instead of ignoring it forever.
  now += 5 * 60 * 1000;
  assert.equal(pool.pick([only], new Set())?.id, 7);

  // A success clears the block for good.
  pool.markOk(7);
  now += 60 * 60 * 1000;
  assert.equal(pool.pick([only], new Set())?.id, 7);
});

test('a captcha account that fails again stays blocked', () => {
  let now = 3_000_000;
  const pool = new AccountPool(null, () => now);
  const only = account(9);
  pool.markFailure(9, 'captcha', '需要验证');
  now += 6 * 60 * 1000;
  assert.equal(pool.pick([only], new Set())?.id, 9);
  // The probe failed, so the account is blocked again for another round.
  pool.markFailure(9, 'captcha', '仍需验证');
  now += 60_000;
  assert.equal(pool.pick([only], new Set()), null);
});