import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateVideoDirectDeliveryRelease } from './video-direct-delivery-release-contract.mjs';

// Synthetic data exists only in this test. No production receipt is generated.
function fixture(sourceDigest) {
  const evidence = ['synthetic gate test; not native acceptance or owner evidence'];
  const bound = { sourceDigest, evidence };
  const item = {
    ...bound, executedSourceDigest: sourceDigest, path: 'text-video', method: 'native', clientVersion: 'v1.7.21',
    model: 'seedance-2.0-mini', seconds: 4, resolution: '480p', aspectRatio: '16:9',
    taskId: 'synthetic-local-task', gatewayTaskId: 'synthetic-gateway-task', providerRequestId: 'synthetic-request',
    resourceId: 'synthetic-resource', platform: 'darwin-arm64', freshSubmission: true, submissionCount: 1,
    createdAt: '2026-10-14T01:01:00Z', completedAt: '2026-10-14T01:02:00Z',
    status: 'succeeded', billing: 'settled', billingMarket: 'enterprise', costCNY: 0.4,
    bytes: 123456, artifactSHA256: 'b'.repeat(64), reopenedTaskId: 'synthetic-local-task',
    clientSubmitted: true, downloaded: true, saved: true, canvasVerified: true, canvasFirstFrame: true,
    mediaDecoded: true, mediaOpened: true, playbackVerified: true, reopened: true, noDuplicateSubmission: true,
  };
  return {
    version: 'v1.7.21', sourceDigest,
    ownerException: { ...bound, scope: 'video-direct-delivery-single-native-20261014', approvedBy: 'Ender', instruction: '你跑一次生视频成功就可以了' },
    releaseAuthorization: { ...bound, scope: 'v1.7.21 only', additionalHumanReplyRequired: false },
    paidSubmissionLimit: 1, liveMatrixStatus: 'not_run_owner_waived', agentAcceptanceStatus: 'not_run_owner_waived', acceptanceComplete: false,
    budgetCNY: null, spentCNY: null, pendingCNY: null, newBudgetCNY: 0.5, newSpentCNY: 0.4, newPendingCNY: 0,
    priorFinancialUncertainty: { status: 'unresolved', carriedFromVersion: 'v1.7.20', pendingCNY: null, evidence: ['docs/release-evidence/v1.7.20.json'] },
    pricePreflight: { ...bound, status: 'passed', method: 'price-quote', model: item.model, seconds: 4,
      resolution: '480p', aspectRatio: '16:9', checkedAt: '2026-10-14T01:00:00Z', maxCostCNY: 0.5 },
    cases: [item],
    billingAttempts: [{ id: 'synthetic-bill', kind: 'media', billing: 'settled', taskId: item.taskId,
      providerRequestId: item.providerRequestId, executedSourceDigest: sourceDigest, costCNY: 0.4, evidence }],
    review: { ...bound, result: 'approved', independent: true, reviewer: 'synthetic reviewer' },
    upgrade: { ...bound, preservedData: true },
    verification: Object.fromEntries(Object.entries({ directAndBackupDelivery: 'test', signedURLRefresh: 'test',
      cancelAndStall: 'test', noDuplicateSubmission: 'test', localReleaseGate: 'local-script', ci: 'github-actions' })
      .map(([id, method]) => [id, { ...bound, status: 'passed', method }])),
    packages: {
      platforms: ['darwin-arm64', 'darwin-amd64', 'windows-amd64', 'linux-amd64'], status: 'pending_release_workflow', archives: null,
      windowsReleasedUpgradeAndRollbackBeforeUpload: true, finalArchiveSmokeBeforeUpload: true, linuxNativeWindowBeforeUpload: true,
      signedManifestBeforePublish: true, publicReadbackAfterPublish: true, workflowEvidence: ['.github/workflows/release-desktop.yml'],
    },
    releasePublished: false, releaseComplete: false,
  };
}

test('single-video exception requires native final-source delivery, one settled bill and retained release gates', () => {
  const digest = 'a'.repeat(64);
  const original = fixture(digest);
  validateVideoDirectDeliveryRelease(original, digest);
  const rejected = {
    'future version': r => r.version = 'v1.7.22',
    'old source': r => r.sourceDigest = 'c'.repeat(64),
    'wrong owner': r => r.ownerException.approvedBy = 'agent',
    'wrong quote': r => r.ownerException.instruction = '直接上线吧',
    'wrong scope': r => r.ownerException.scope = 'fal-h3-family-20261013',
    'unbound owner': r => r.ownerException.sourceDigest = 'c'.repeat(64),
    'forward release scope': r => r.releaseAuthorization.scope = 'future releases',
    'claimed full matrix': r => r.liveMatrixStatus = 'passed',
    'claimed full assistant suite': r => r.agentAcceptanceStatus = 'passed',
    'claimed full acceptance': r => r.acceptanceComplete = true,
    'additional submission allowance': r => r.paidSubmissionLimit = 2,
    'additional native generation': r => r.cases.push(structuredClone(r.cases[0])),
    'extra paid attempt': r => r.billingAttempts.push({ ...r.billingAttempts[0], id: 'extra-bill' }),
    'reset unknown historical spend': r => r.spentCNY = 0,
    'reset unknown historical pending': r => r.priorFinancialUncertainty.pendingCNY = 0,
    'missing historical receipt': r => r.priorFinancialUncertainty.evidence = ['other-version'],
    'invented budget': r => r.newBudgetCNY = 50,
    'pending quote': r => r.pricePreflight.status = 'pending',
    'missing quote evidence': r => r.pricePreflight.evidence = [],
    'invalid quote date': r => r.pricePreflight.checkedAt = 'unknown',
    'old execution digest': r => r.cases[0].executedSourceDigest = 'c'.repeat(64),
    'old client version': r => r.cases[0].clientVersion = 'v1.7.20',
    'fixture instead of native': r => r.cases[0].method = 'deterministic',
    'replayed task': r => r.cases[0].freshSubmission = false,
    'duplicate submission': r => r.cases[0].submissionCount = 2,
    'task predates price preflight': r => r.cases[0].createdAt = '2026-10-13T23:00:00Z',
    'unsettled video': r => r.cases[0].billing = 'reserved',
    'unsettled bill': r => r.billingAttempts[0].billing = 'reserved',
    'wrong wallet': r => r.cases[0].billingMarket = 'global',
    'wrong model': r => r.cases[0].model = 'seedance-2.0-fast',
    'wrong generation path': r => r.cases[0].path = 'image-video',
    'no first frame': r => r.cases[0].canvasFirstFrame = false,
    'no actual playback': r => r.cases[0].playbackVerified = false,
    'empty resource': r => r.cases[0].bytes = 0,
    'new task on reopen': r => r.cases[0].reopenedTaskId = 'new-task',
    'missing hash': r => r.cases[0].artifactSHA256 = '',
    'different bill task': r => r.billingAttempts[0].taskId = 'old-task',
    'different bill request': r => r.billingAttempts[0].providerRequestId = 'old-request',
    'different bill amount': r => r.billingAttempts[0].costCNY = 0.3,
    'unreconciled new spend': r => r.newSpentCNY = 0.3,
    'pending new money': r => r.newPendingCNY = null,
    'self approval': r => r.review.independent = false,
    'old review source': r => r.review.sourceDigest = 'c'.repeat(64),
    'missing preserved data': r => r.upgrade.preservedData = false,
    'missing stall checks': r => delete r.verification.cancelAndStall,
    'fake CI method': r => r.verification.ci.method = 'test',
    'failed CI': r => r.verification.ci.status = 'failed',
    'old fallback verification': r => r.verification.directAndBackupDelivery.sourceDigest = 'c'.repeat(64),
    'missing Linux package': r => r.packages.platforms.pop(),
    'skipped upgrade rollback': r => r.packages.windowsReleasedUpgradeAndRollbackBeforeUpload = false,
    'skipped manifest signing': r => r.packages.signedManifestBeforePublish = false,
    'premature package success': r => r.packages.status = 'passed',
    'premature publication': r => r.releasePublished = true,
  };
  for (const [name, mutate] of Object.entries(rejected)) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.throws(() => validateVideoDirectDeliveryRelease(changed, digest), undefined, name);
  }
});

test('release entrypoint binds the exception to committed source and never carries it to the next version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beeftv-single-video-gate-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    mkdirSync(join(dir, 'scripts'));
    mkdirSync(join(dir, 'docs/release-evidence'), { recursive: true });
    for (const name of ['verify-real-generation-release.mjs', 'real-generation-release-contract.mjs', 'h3-family-release-contract.mjs', 'video-direct-delivery-release-contract.mjs', 'team-release-contract.mjs', 'image-preparation-release-contract.mjs']) {
      writeFileSync(join(dir, 'scripts', name), readFileSync(new URL(`./${name}`, import.meta.url)));
    }
    git('init');
    writeFileSync(join(dir, 'VERSION'), 'v1.7.21\n');
    const commit = () => { git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'synthetic candidate'); };
    commit();
    const run = (...args) => execFileSync(process.execPath, ['scripts/verify-real-generation-release.mjs', ...args], { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
    assert.throws(() => run(), /./, 'missing real receipt must not pass');
    const digest = run('--fingerprint').trim();
    const receipt = fixture(digest);
    const save = (value, version = 'v1.7.21') => writeFileSync(join(dir, 'docs/release-evidence', `${version}.json`), JSON.stringify(value));
    save(receipt);
    assert.match(run(), /single native video delivery acceptance/);
    commit();
    assert.equal(run('--fingerprint').trim(), digest, 'receipt-only commit preserves candidate fingerprint');
    writeFileSync(join(dir, 'scripts', 'shipped-change.mjs'), '// a different shipped candidate\n');
    commit();
    assert.notEqual(run('--fingerprint').trim(), digest);
    assert.throws(() => run(), /receipt does not match this release source/);
    writeFileSync(join(dir, 'VERSION'), 'v1.7.22\n');
    commit();
    save({ ...receipt, version: 'v1.7.22', sourceDigest: run('--fingerprint').trim() }, 'v1.7.22');
    assert.throws(() => run(), /./, 'single-video waiver must not pass a future version');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
