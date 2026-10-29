import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateMusic3Release } from './music3-release-contract.mjs';

const digest = 'a'.repeat(64);
const bound = () => ({ sourceDigest: digest, evidence: ['synthetic-test-fixture'] });
function fixture() {
  return {
    version: 'v1.7.27', sourceDigest: digest, baseRelease: 'v1.7.26',
    baseCommit: 'ddaf5f9abc64b16567c28ea5399d8f2069c47832', includedPullRequests: [196, 202],
    ownerException: { ...bound(), approvedBy: 'Ender', scope: 'music-only-post-release-20261019', instruction: '允许本版 Music 专项验收（推荐）' },
    releaseAuthorization: { ...bound(), scope: 'v1.7.27 only', instruction: '上线 然后实测吧' },
    liveMatrixStatus: 'not_run_owner_waived', agentAcceptanceStatus: 'not_run_owner_waived',
    acceptanceComplete: false, releasePublished: false, releaseComplete: false, cases: [],
    priorFinancialUncertainty: { status: 'unresolved', carriedFromVersion: 'v1.7.26', pendingCNY: null, evidence: ['docs/release-evidence/v1.7.26.json'] },
    postReleaseAcceptance: { status: 'pending', model: 'minimax-music-v3.0', authorizedBudgetCNY: 20, priorConservativeEstimateCNY: 14, maximumNewPaidSubmissions: 2, maximumAdditionalCostCNY: 2, supplierFinalBillVerified: false, evidence: ['synthetic-test-fixture'] },
    candidateTestedHead: 'b'.repeat(40),
    candidateAcceptance: { ...bound(), evidenceRole: 'historical-reference-only', environment: 'isolated-desktop-backend-and-web-preview', productionWalletTested: false, installedWailsShellTested: false, apiElapsedSeconds: 180.29, heartbeatIntervalSeconds: 15, beefTVTaskId: '73f2816635112244477e47af022e699d', beefTVAttempts: 1, sampleRate: 44100, bitrate: 256000, format: 'mp3', saved: true, reopened: true, exportEqualsResource: true },
    review: { ...bound(), result: 'approved', independent: true, reviewer: 'synthetic reviewer', reviewedHead: 'c'.repeat(40) },
    verification: {
      ...Object.fromEntries(['musicContracts', 'transportSafety', 'officialAudioPlugin', 'ci'].map(id => [id, { ...bound(), status: 'passed' }])),
      uiCrossReview: { ...bound(), status: 'not_run_owner_waived', method: 'explicit-owner-waiver', reviewer: 'Ender', instruction: '撤回吧 这个直接上线 上线了再和Lucas说', notifyLucasAfterRelease: true },
      localReleaseGate: { ...bound(), evidence: ['.github/workflows/release-desktop.yml'], status: 'pending_release_workflow', beforeDraft: true },
    },
    packages: { platforms: ['darwin-arm64', 'darwin-amd64', 'windows-amd64', 'linux-amd64'], status: 'pending_release_workflow', archives: null, windowsReleasedUpgradeAndRollbackBeforeUpload: true, finalArchiveSmokeBeforeUpload: true, linuxNativeWindowBeforeUpload: true, signedManifestBeforePublish: true, publicReadbackAfterPublish: true, workflowEvidence: ['.github/workflows/release-desktop.yml'] },
  };
}
const proofs = () => ({ reviewedSourceDigest: digest, candidateProductDigest: digest, currentProductDigest: digest });
test('one-version targeted authorization leaves live acceptance pending and package gates mandatory', () => {
  assert.doesNotThrow(() => validateMusic3Release(fixture(), digest, proofs()));
});
for (const [name, mutate] of Object.entries({
  'other version': r => r.version = 'v1.7.28',
  'unrelated PR': r => r.includedPullRequests.push(199),
  'missing scope approval': r => r.ownerException.instruction = '上线',
  'missing post-release order': r => r.releaseAuthorization.instruction = 'local test only',
  'invented full matrix': r => r.liveMatrixStatus = 'passed',
  'invented native client': r => r.candidateAcceptance.installedWailsShellTested = true,
  'invented wallet test': r => r.candidateAcceptance.productionWalletTested = true,
  'unknown history reset': r => r.priorFinancialUncertainty.pendingCNY = 0,
  'extra paid submission': r => r.postReleaseAcceptance.maximumNewPaidSubmissions = 3,
  'expanded budget': r => r.postReleaseAcceptance.authorizedBudgetCNY = 21,
  'spent history reset': r => r.postReleaseAcceptance.priorConservativeEstimateCNY = 0,
  'invented production success': r => r.postReleaseAcceptance.status = 'passed',
  'stale review': r => r.review.sourceDigest = 'd'.repeat(64),
  'missing independent review': r => r.review.result = 'pending',
  'missing owner waiver': r => r.verification.uiCrossReview.status = 'pending',
  'wrong UI reviewer': r => r.verification.uiCrossReview.reviewer = 'agent',
  'generic release order is not a human-review waiver': r => r.verification.uiCrossReview.instruction = '上线',
  'missing Lucas notification': r => r.verification.uiCrossReview.notifyLucasAfterRelease = false,
  'missing CI': r => r.verification.ci.status = 'pending',
  'missing local gate': r => r.verification.localReleaseGate.beforeDraft = false,
  'missing platform': r => r.packages.platforms.pop(),
  'duplicate platform': r => r.packages.platforms[0] = 'windows-amd64',
  'disabled upgrade check': r => r.packages.windowsReleasedUpgradeAndRollbackBeforeUpload = false,
  'disabled final smoke': r => r.packages.finalArchiveSmokeBeforeUpload = false,
  'unsigned publication': r => r.packages.signedManifestBeforePublish = false,
  'missing public readback': r => r.packages.publicReadbackAfterPublish = false,
})) {
  test(`reject ${name}`, () => {
    const r = fixture(); mutate(r);
    assert.throws(() => validateMusic3Release(r, digest, proofs()));
  });
}
test('historical candidate cannot be presented as final-source acceptance', () => {
  const r = fixture(); r.candidateAcceptance.evidenceRole = 'current-release-passed';
  assert.throws(() => validateMusic3Release(r, digest, proofs()));
});
test('review must cover the complete current release source', () => {
  assert.throws(() => validateMusic3Release(fixture(), digest, { ...proofs(), reviewedSourceDigest: 'f'.repeat(64) }));
});
