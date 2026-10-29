import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { releaseAgentChecks } from './real-generation-release-contract.mjs';
import { V202_INSTRUCTION, V202_PULL_REQUESTS, validateV202Release } from './v202-release-contract.mjs';

const digest = 'a'.repeat(64);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const authorizationBytes = readFileSync(new URL('../docs/release-evidence/v2.0.2-owner-authorization.json', import.meta.url));
const priorReceiptBytes = Buffer.from('original v2.0.1 receipt');
const bound = () => ({ sourceDigest: digest, evidence: ['test-evidence'] });
const proofs = () => ({ authorizationBytes, priorReceiptBytes, reviewedSourceDigest: digest });
function fixture() {
  const ids = releaseAgentChecks('v2.0.2');
  return {
    version: 'v2.0.2', contractVersion: 3, sourceDigest: digest,
    baseRelease: 'v2.0.1', baseCommit: '5ae8e627508f0e77108c3f9b6526fcfa4faaf7a5',
    includedMain: 'd33ff1b7553cb938dc9e8f777c04a7e396a45d11', includedPullRequests: [...V202_PULL_REQUESTS],
    ownerException: { ...bound(), approvedBy: 'Ender', scope: 'v2.0.2-targeted-no-paid-20261022', instruction: V202_INSTRUCTION, authorizationSHA256: hash(authorizationBytes) },
    liveMatrixStatus: 'not_run_owner_waived', agentAcceptanceStatus: 'not_run_owner_waived',
    acceptanceComplete: false, releasePublished: false, releaseComplete: false, cases: [],
    deferredAcceptance: { status: 'not_run_owner_waived', caseKeys: [1, 2].flatMap(round => ['text-image', 'image-image', 'image-video', 'text-video', 'video-video', 'multi-video'].map(path => round + '/' + path)), agentCheckIds: ids },
    agentChecks: Object.fromEntries(ids.map(id => [id, { ...bound(), status: 'not_run_owner_waived' }])),
    newPaidBudgetCNY: 0, newPaidSubmissions: 0, newSpentCNY: 0, newPendingCNY: 0, billingAttempts: [],
    budgetCNY: null, spentCNY: null, pendingCNY: null,
    priorFinancialUncertainty: { status: 'unresolved', carriedFromVersion: 'v2.0.1', pendingCNY: null, evidence: ['prior-receipt'] },
    priorReceiptSHA256: hash(priorReceiptBytes),
    knownLimitations: { carriedFromVersion: 'v2.0.1', inheritedFailedCheckIds: ['native_video', 'native_audio', 'media_film_review'], evidence: ['prior-receipt'] },
    review: { ...bound(), result: 'approved', independent: true, reviewer: 'independent-reviewer' },
    verification: { ...Object.fromEntries(['uploadAndDns', 'assistantRecovery', 'seedreamOutputs', 'desktopLinksAndMarkdown', 'publisher', 'ci'].map(id => [id, { ...bound(), status: 'passed' }])),
      localReleaseGate: { sourceDigest: digest, evidence: ['.github/workflows/release-desktop.yml'], status: 'pending_release_workflow', method: 'local-script', beforeDraft: true } },
    upgrade: { ...bound(), status: 'pending_release_workflow', preservedData: null, requiredBeforePublish: true },
    packages: { platforms: ['darwin-arm64', 'darwin-amd64', 'windows-amd64', 'linux-amd64'], status: 'pending_release_workflow', archives: null, workflowEvidence: ['.github/workflows/release-desktop.yml'],
      windowsReleasedUpgradeAndRollbackBeforeUpload: true, finalArchiveSmokeBeforeUpload: true, linuxNativeWindowBeforeUpload: true, signedManifestBeforePublish: true, publicReadbackAfterPublish: true },
  };
}

test('only the authorized targeted release can proceed to package checks', () => assert.doesNotThrow(() => validateV202Release(fixture(), digest, proofs())));
for (const [name, mutate] of [
  ['later release cannot inherit this waiver', r => { r.version = 'v2.0.3'; }],
  ['extra application PR cannot enter the release', r => { r.includedPullRequests.push(236); }],
  ['duplicate PR does not satisfy the scope', r => { r.includedPullRequests[0] = r.includedPullRequests[1]; }],
  ['another source cannot inherit test evidence', r => { r.sourceDigest = 'b'.repeat(64); }],
  ['waived media cannot be labeled passed', r => { r.liveMatrixStatus = 'passed'; }],
  ['waived assistant cannot be labeled passed', r => { r.agentChecks.native_video.status = 'passed'; }],
  ['all twelve cases remain explicitly waived', r => { r.deferredAcceptance.caseKeys.pop(); }],
  ['all assistant checks remain explicitly waived', r => { delete r.agentChecks.canvas_read; }],
  ['no new paid generation budget', r => { r.newPaidBudgetCNY = 50; }],
  ['no hidden paid attempt', r => { r.billingAttempts.push({ id: 'paid' }); }],
  ['historical bills cannot be zeroed', r => { r.priorFinancialUncertainty.pendingCNY = 0; }],
  ['historical media failures remain visible', r => { r.knownLimitations.inheritedFailedCheckIds.pop(); }],
  ['unperformed independent review blocks release', r => { r.review.result = 'pending'; }],
  ['self review is insufficient', r => { r.review.independent = false; }],
  ['failed targeted check blocks release', r => { r.verification.uploadAndDns.status = 'failed'; }],
  ['pending CI blocks release', r => { r.verification.ci.status = 'pending'; }],
  ['a failed local gate cannot be relabeled pending', r => { r.verification.localReleaseGate.status = 'failed'; }],
  ['local gate must run before opening a draft', r => { r.verification.localReleaseGate.beforeDraft = false; }],
  ['four final platforms remain mandatory', r => { r.packages.platforms.pop(); }],
  ['unbuilt archive cannot be claimed', r => { r.packages.archives = {}; }],
  ['Windows upgrade and rollback remain mandatory', r => { r.packages.windowsReleasedUpgradeAndRollbackBeforeUpload = false; }],
  ['signature remains mandatory', r => { r.packages.signedManifestBeforePublish = false; }],
  ['public readback remains mandatory', r => { r.packages.publicReadbackAfterPublish = false; }],
  ['data preservation cannot be asserted before the package run', r => { r.upgrade.preservedData = true; }],
]) test(name, () => { const r = fixture(); mutate(r); assert.throws(() => validateV202Release(r, digest, proofs())); });
test('tampered owner authorization fails', () => assert.throws(() => validateV202Release(fixture(), digest, { ...proofs(), authorizationBytes: Buffer.from('{}') })));
test('changed prior receipt fails', () => assert.throws(() => validateV202Release(fixture(), digest, { ...proofs(), priorReceiptBytes: Buffer.from('changed') })));
test('reviewed source must match the candidate', () => assert.throws(() => validateV202Release(fixture(), digest, { ...proofs(), reviewedSourceDigest: 'b'.repeat(64) })));

