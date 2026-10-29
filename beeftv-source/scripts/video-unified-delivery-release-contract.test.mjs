import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { releaseVideoProtocolIds, validateVideoUnifiedDeliveryRelease } from './video-unified-delivery-release-contract.mjs';

// Synthetic data is confined to tests; it is never a native acceptance receipt.
function fixture(sourceDigest, protocols = ['synthetic-video']) {
  const evidence = ['synthetic test only; not owner, native, billing or release evidence'];
  const bound = { sourceDigest, evidence };
  const item = {
    ...bound, executedSourceDigest: sourceDigest, method: 'native-original-task-retrieval', clientVersion: 'v1.7.22',
    retrievalMethod: 'current-downloader-original-task', originalStatus: 'succeeded', model: 'unlisted-video-model',
    taskId: 'original-local-task', originalTaskId: 'original-local-task', gatewayTaskId: 'original-gateway-task', originalGatewayTaskId: 'original-gateway-task',
    providerRequestId: 'original-provider-task', originalProviderRequestId: 'original-provider-task', resourceId: 'original-resource', platform: 'darwin-arm64',
    freshSubmission: false, submissionCount: 0, status: 'succeeded', bytes: 123456, artifactSHA256: 'b'.repeat(64),
    artifactIdentity: { method: 'existing-resource-sha256', referenceSHA256: 'b'.repeat(64), evidence },
    downloadExecution: { ...bound, method: 'current-downloader' },
    originalGeneration: { status: 'recorded', commit: 'c'.repeat(40), sourceDigest: 'c'.repeat(64), evidence },
    originalCreatedAt: '2026-10-13T01:00:00Z', retrievalStartedAt: '2026-10-14T07:00:00Z', downloadCompletedAt: '2026-10-14T07:00:02Z',
    savedAt: '2026-10-14T07:00:03Z', firstFrameObservedAt: '2026-10-14T07:00:05Z', reopenedAt: '2026-10-14T07:00:20Z',
    firstFrameTiming: 'observation_upper_bound', reopenedTaskId: 'original-local-task',
    downloaded: true, saved: true, canvasVerified: true, canvasFirstFrame: true, mediaDecoded: true, mediaOpened: true,
    playbackVerified: true, reopened: true, noDuplicateSubmission: true,
    billingBefore: { status: 'settled', costCNY: 0.4 }, billingAfter: { status: 'settled', costCNY: 0.4 },
    billingUnchanged: { ...bound, status: 'passed', method: 'readonly-reconciliation' },
  };
  return {
    version: 'v1.7.22', sourceDigest,
    ownerException: { ...bound, approvedBy: 'Ender', scope: 'video-unified-original-task-delivery-20261014', instruction: '原任务验收，不新增付费生成（推荐）' },
    releaseAuthorization: { ...bound, scope: 'v1.7.22 only', additionalHumanReplyRequired: false,
      instruction: '那你就统一做吧，所有视频模型都按这套策略走，别再按模型加限制了，跑通后review没问题就上线' },
    freshGeneration: false, newPaidSubmissions: 0, paidSubmissionLimit: 0, newBudgetCNY: 0, newSpentCNY: 0, newPendingCNY: 0, billingAttempts: [],
    liveMatrixStatus: 'not_run_owner_waived', agentAcceptanceStatus: 'not_run_owner_waived', acceptanceComplete: false,
    liveModelCoverage: 'limited_to_existing_original_tasks', allModelsLiveTested: false,
    budgetCNY: null, spentCNY: null, pendingCNY: null,
    priorFinancialUncertainty: { status: 'unresolved', carriedFromVersion: 'v1.7.21', pendingCNY: null, evidence: ['docs/release-evidence/v1.7.21.json'] },
    cases: [item], review: { ...bound, result: 'approved', independent: true, reviewer: 'synthetic independent reviewer' },
    upgrade: { ...bound, preservedData: true },
    verification: Object.fromEntries(Object.entries({ allVideoProtocols: 'test', directAndBackupDelivery: 'test', signedURLRefresh: 'test',
      providerAuthIsolation: 'test', cancelAndStall: 'test', noDuplicateSubmission: 'test', localReleaseGate: 'local-script', ci: 'github-actions' })
      .map(([id, method]) => [id, { ...bound, status: 'passed', method, ...(id === 'allVideoProtocols'
        ? { registeredProtocols: protocols, testedProtocols: protocols, handwrittenAndWorkflowDelivery: true } : {}) }])),
    packages: { platforms: ['darwin-arm64', 'darwin-amd64', 'windows-amd64', 'linux-amd64'], status: 'pending_release_workflow', archives: null,
      windowsReleasedUpgradeAndRollbackBeforeUpload: true, finalArchiveSmokeBeforeUpload: true, linuxNativeWindowBeforeUpload: true,
      signedManifestBeforePublish: true, publicReadbackAfterPublish: true, workflowEvidence: ['.github/workflows/release-desktop.yml'] },
    releasePublished: false, releaseComplete: false,
  };
}

test('exact version allows honest original-task retrieval while retaining current-source and formal package gates', () => {
  const digest = 'a'.repeat(64), protocols = ['synthetic-video'];
  const original = fixture(digest, protocols);
  validateVideoUnifiedDeliveryRelease(original, digest, protocols);
  const recovery = structuredClone(original);
  Object.assign(recovery.cases[0], { retrievalMethod: 'native-failed-task-recovery', originalStatus: 'failed', gatewayTaskId: null, originalGatewayTaskId: null,
    originalGeneration: { status: 'unknown', commit: null, sourceDigest: null, evidence: ['source was not recorded'] },
    artifactIdentity: { method: 'same-task-repeat-readback', referenceSHA256: 'b'.repeat(64), evidence: ['two actual original-task reads'] },
    downloadExecution: { ...recovery.cases[0].downloadExecution, method: 'native' },
    billingBefore: { status: 'unresolved', costCNY: null }, billingAfter: { status: 'unresolved', costCNY: null } });
  validateVideoUnifiedDeliveryRelease(recovery, digest, protocols);
  const rejected = {
    'future version waiver': r => r.version = 'v1.7.23',
    'v1.7.21 waiver': r => r.ownerException.instruction = '你跑一次生视频成功就可以了',
    'wrong owner': r => r.ownerException.approvedBy = 'agent',
    'wrong scope': r => r.ownerException.scope = 'all future video releases',
    'old owner source': r => r.ownerException.sourceDigest = 'd'.repeat(64),
    'old release source': r => r.releaseAuthorization.sourceDigest = 'd'.repeat(64),
    'wrong release instruction': r => r.releaseAuthorization.instruction = '直接发布',
    'future release scope': r => r.releaseAuthorization.scope = 'future releases',
    'fresh generation': r => r.freshGeneration = true,
    'new paid submission': r => r.newPaidSubmissions = 1,
    'new generation allowance': r => r.paidSubmissionLimit = 1,
    'new bill': r => r.billingAttempts.push({ costCNY: 1 }),
    'new spending': r => r.newSpentCNY = 0.4,
    'new pending unknown': r => r.newPendingCNY = null,
    'new budget': r => r.newBudgetCNY = 50,
    'unknown history reset': r => r.spentCNY = 0,
    'unknown prior pending reset': r => r.priorFinancialUncertainty.pendingCNY = 0,
    'wrong prior evidence': r => r.priorFinancialUncertainty.evidence = ['other receipt'],
    'full matrix claimed': r => r.liveMatrixStatus = 'passed',
    'assistant claimed': r => r.agentAcceptanceStatus = 'passed',
    'full acceptance claimed': r => r.acceptanceComplete = true,
    'all real models claimed': r => r.allModelsLiveTested = true,
    'empty cases': r => r.cases = [],
    'duplicate original task': r => r.cases.push(structuredClone(r.cases[0])),
    'old execution digest': r => r.cases[0].executedSourceDigest = 'd'.repeat(64),
    'old download code': r => r.cases[0].downloadExecution.sourceDigest = 'd'.repeat(64),
    'old native client': r => r.cases[0].clientVersion = 'v1.7.21',
    'fixture as native': r => r.cases[0].method = 'deterministic',
    'fixture as download': r => r.cases[0].downloadExecution.method = 'test',
    'pretend failure recovery': r => r.cases[0].retrievalMethod = 'native-failed-task-recovery',
    'changed original task': r => r.cases[0].originalTaskId = 'different-task',
    'changed provider task': r => r.cases[0].originalProviderRequestId = 'different-request',
    'changed gateway task': r => r.cases[0].originalGatewayTaskId = 'different-gateway',
    'create during recovery': r => r.cases[0].submissionCount = 1,
    'new task on reopen': r => r.cases[0].reopenedTaskId = 'new-task',
    'different original hash': r => r.cases[0].artifactIdentity.referenceSHA256 = 'd'.repeat(64),
    'no saved artifact': r => r.cases[0].bytes = 0,
    'no first frame': r => r.cases[0].canvasFirstFrame = false,
    'no playback': r => r.cases[0].playbackVerified = false,
    'new digest relabeled as original': r => r.cases[0].originalGeneration.sourceDigest = digest,
    'unknown original silently invented': r => r.cases[0].originalGeneration.status = 'unknown',
    'task created after retrieval': r => r.cases[0].originalCreatedAt = '2026-10-14T08:00:00Z',
    'frame before save': r => r.cases[0].firstFrameObservedAt = '2026-10-14T07:00:01Z',
    'missing timing': r => r.cases[0].retrievalStartedAt = '',
    'exact timing invented': r => r.cases[0].firstFrameTiming = 'exact',
    'billing amount changed': r => r.cases[0].billingAfter.costCNY = 0,
    'billing status changed': r => r.cases[0].billingAfter.status = 'refunded',
    'unknown costs assigned zero': r => r.cases[0].billingBefore = { status: 'unresolved', costCNY: 0 },
    'old billing readback': r => r.cases[0].billingUnchanged.sourceDigest = 'd'.repeat(64),
    'self review': r => r.review.independent = false,
    'old review': r => r.review.sourceDigest = 'd'.repeat(64),
    'lost old data': r => r.upgrade.preservedData = false,
    'missing auth tests': r => delete r.verification.providerAuthIsolation,
    'old stall tests': r => r.verification.cancelAndStall.sourceDigest = 'd'.repeat(64),
    'omitted shipped protocol': r => r.verification.allVideoProtocols.testedProtocols = [],
    'invented protocol roster': r => r.verification.allVideoProtocols.registeredProtocols = ['other'],
    'skipped workflow delivery': r => r.verification.allVideoProtocols.handwrittenAndWorkflowDelivery = false,
    'failed CI': r => r.verification.ci.status = 'failed',
    'missing platform': r => r.packages.platforms.pop(),
    'skip upgrade rollback': r => r.packages.windowsReleasedUpgradeAndRollbackBeforeUpload = false,
    'skip public readback': r => r.packages.publicReadbackAfterPublish = false,
    'premature package pass': r => r.packages.status = 'passed',
    'premature publication': r => r.releasePublished = true,
  };
  for (const [name, mutate] of Object.entries(rejected)) {
    const changed = structuredClone(original); mutate(changed);
    assert.throws(() => validateVideoUnifiedDeliveryRelease(changed, digest, protocols), undefined, name);
  }
  assert.throws(() => validateVideoUnifiedDeliveryRelease(original, digest, ['synthetic-video', 'new-protocol']));
});

test('entrypoint derives video protocol roster and rejects stale source or next-version reuse', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beeftv-original-video-gate-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    mkdirSync(join(dir, 'scripts')); mkdirSync(join(dir, 'docs/release-evidence'), { recursive: true });
    for (const name of ['verify-real-generation-release.mjs', 'real-generation-release-contract.mjs', 'h3-family-release-contract.mjs',
      'video-direct-delivery-release-contract.mjs', 'video-unified-delivery-release-contract.mjs', 'team-release-contract.mjs', 'image-preparation-release-contract.mjs']) {
      writeFileSync(join(dir, 'scripts', name), readFileSync(new URL(`./${name}`, import.meta.url)));
    }
    const manifest = (name, capabilities) => {
      mkdirSync(join(dir, 'plugin-packages', name), { recursive: true });
      writeFileSync(join(dir, 'plugin-packages', name, 'manifest.json'), JSON.stringify({ contributes: { providers: [{ id: name, capabilities }] } }));
    };
    manifest('synthetic-video', ['video']); manifest('synthetic-image', ['image']);
    assert.deepEqual(releaseVideoProtocolIds(join(dir, 'plugin-packages')), ['synthetic-video']);
    git('init'); writeFileSync(join(dir, 'VERSION'), 'v1.7.22\n');
    const commit = () => { git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'synthetic source'); };
    commit();
    const run = (...args) => execFileSync(process.execPath, ['scripts/verify-real-generation-release.mjs', ...args], { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
    assert.throws(() => run(), /./, 'no passed receipt placeholder');
    const digest = run('--fingerprint').trim(), receipt = fixture(digest);
    const save = (value, version = 'v1.7.22') => writeFileSync(join(dir, 'docs/release-evidence', `${version}.json`), JSON.stringify(value));
    save(receipt); assert.match(run(), /zero new paid submissions/);
    commit(); assert.equal(run('--fingerprint').trim(), digest, 'evidence-only commit preserves source identity');
    manifest('new-video-protocol', ['video']); commit();
    assert.throws(() => run(), /receipt does not match this release source/);
    const changedSource = { ...receipt, sourceDigest: run('--fingerprint').trim() };
    save(changedSource); assert.throws(() => run(), /./, 'changing top digest cannot rebind old execution evidence');
    writeFileSync(join(dir, 'VERSION'), 'v1.7.23\n'); commit();
    save({ ...receipt, version: 'v1.7.23', sourceDigest: run('--fingerprint').trim() }, 'v1.7.23');
    assert.throws(() => run(), /./, 'this exception cannot authorize the next version');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
