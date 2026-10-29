import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { releaseAgentChecks } from './real-generation-release-contract.mjs';
import { validateV201Release } from './v201-release-contract.mjs';

const digest = 'a'.repeat(64);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const authorizationBytes = readFileSync(new URL('../docs/release-evidence/v2.0.1-owner-authorization.json', import.meta.url));
const priorReceiptBytes = Buffer.from('original prior receipt');
const bound = () => ({ sourceDigest: digest, evidence: ['test-evidence'] });
function fixture() {
  return {
    version: 'v2.0.1', contractVersion: 3, sourceDigest: digest,
    baseRelease: 'v2.0.0', baseCommit: 'd8bcdbe2480777147ac7c38f68793dc9bb366171',
    includedMain: 'd870963556d9a057449cc4db91e0a08e8fc1851f', includedPullRequests: [214, 215, 216, 217, 218, 219],
    ownerException: { ...bound(), approvedBy: 'Ender', scope: 'v2.0.1-publish-before-testing-20261021', instruction: '直接发吧 发布后在测试', authorizationSHA256: hash(authorizationBytes) },
    liveMatrixStatus: 'pending_after_release', agentAcceptanceStatus: 'pending_after_release',
    acceptanceComplete: false, releaseComplete: false, releasePublished: false, cases: [],
    deferredAcceptance: { status: 'pending_after_release', caseKeys: [1, 2].flatMap(round => ['text-image', 'image-image', 'image-video', 'text-video', 'video-video', 'multi-video'].map(path => `${round}/${path}`)), agentCheckIds: releaseAgentChecks('v2.0.1') },
    agentChecks: Object.fromEntries(releaseAgentChecks('v2.0.1').map(id => [id, { ...bound(), status: 'pending_after_release' }])),
    newPaidBudgetCNY: 0, newPaidSubmissions: 0, newSpentCNY: 0, billingAttempts: [],
    priorFinancialUncertainty: { status: 'unresolved', pendingCNY: null, evidence: ['prior-receipt'] },
    priorReceiptSHA256: hash(priorReceiptBytes),
    knownLimitations: { carriedFromVersion: 'v2.0.0', inheritedFailedCheckIds: ['native_video', 'native_audio', 'media_film_review'], evidence: ['prior-receipt'] },
    review: { ...bound(), result: 'approved', independent: true, reviewer: 'independent-reviewer' },
    upgrade: { ...bound(), status: 'pending_release_workflow', preservedData: null, requiredBeforePublish: true },
    verification: Object.fromEntries(['localReleaseGate', 'workflowAndUpscale', 'diagnostics', 'skills', 'publisher', 'ci'].map(id => [id, { ...bound(), status: 'passed' }])),
    packages: { platforms: ['darwin-arm64', 'darwin-amd64', 'windows-amd64', 'linux-amd64'], status: 'pending_release_workflow', archives: null, workflowEvidence: ['.github/workflows/release-desktop.yml'], windowsReleasedUpgradeAndRollbackBeforeUpload: true, finalArchiveSmokeBeforeUpload: true, linuxNativeWindowBeforeUpload: true, signedManifestBeforePublish: true, publicReadbackAfterPublish: true },
  };
}
const proofs = () => ({ authorizationBytes, priorReceiptBytes, reviewedSourceDigest: digest });
test('authorized pending release retains package safety checks', () => assert.doesNotThrow(() => validateV201Release(fixture(), digest, proofs())));
for (const [name, mutate] of [
  ['later version cannot inherit authorization', r => { r.version = 'v2.0.2'; }],
  ['different source cannot inherit evidence', r => { r.sourceDigest = 'b'.repeat(64); }],
  ['missing deferred case', r => { r.deferredAcceptance.caseKeys.pop(); }],
  ['duplicate deferred case', r => { r.deferredAcceptance.caseKeys[0] = r.deferredAcceptance.caseKeys[1]; }],
  ['missing assistant check', r => { r.deferredAcceptance.agentCheckIds.pop(); }],
  ['historical pass cannot become current', r => { r.agentChecks.native_audio.status = 'passed'; }],
  ['no new paid budget', r => { r.newPaidBudgetCNY = 50; }],
  ['no omitted paid attempt', r => { r.billingAttempts.push({ id: 'unapproved' }); }],
  ['prior unknown bills cannot become zero', r => { r.priorFinancialUncertainty.pendingCNY = 0; }],
  ['known failures cannot disappear', r => { r.knownLimitations.inheritedFailedCheckIds.pop(); }],
  ['self review cannot approve', r => { r.review.independent = false; }],
  ['CI remains mandatory', r => { r.verification.ci.status = 'pending'; }],
  ['native data preservation cannot pass before the release build', r => { r.upgrade.preservedData = true; }],
  ['native data preservation remains mandatory', r => { r.upgrade.requiredBeforePublish = false; }],
  ['Windows rollback remains mandatory', r => { r.packages.windowsReleasedUpgradeAndRollbackBeforeUpload = false; }],
  ['four platforms remain mandatory', r => { r.packages.platforms.pop(); }],
  ['cannot claim unbuilt packages', r => { r.packages.archives = {}; }],
  ['cannot claim completed acceptance', r => { r.acceptanceComplete = true; }],
]) test(name, () => { const r = fixture(); mutate(r); assert.throws(() => validateV201Release(r, digest, proofs())); });
test('tampered authorization fails', () => assert.throws(() => validateV201Release(fixture(), digest, { ...proofs(), authorizationBytes: Buffer.from('{}') })));
test('changed prior receipt fails', () => assert.throws(() => validateV201Release(fixture(), digest, { ...proofs(), priorReceiptBytes: Buffer.from('changed') })));
test('review of another source fails', () => assert.throws(() => validateV201Release(fixture(), digest, { ...proofs(), reviewedSourceDigest: 'b'.repeat(64) })));
