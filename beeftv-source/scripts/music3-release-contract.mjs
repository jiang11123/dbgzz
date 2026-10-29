// These owner instructions are limited to v1.7.27. Production Music acceptance
// and the Lucas notification follow publication; package safety still precedes it.
export function validateMusic3Release(receipt, sourceDigest, proofs = {}) {
  const fail = message => { throw new Error(`v1.7.27 Music release: ${message}`); };
  const evidence = value => Array.isArray(value) && value.length > 0 && value.every(x => typeof x === 'string' && x.trim());
  const bound = value => value?.sourceDigest === sourceDigest && evidence(value.evidence);
  if (receipt.version !== 'v1.7.27' || !/^[a-f0-9]{64}$/.test(sourceDigest) || receipt.sourceDigest !== sourceDigest
    || receipt.baseRelease !== 'v1.7.26' || receipt.baseCommit !== 'ddaf5f9abc64b16567c28ea5399d8f2069c47832'
    || JSON.stringify(receipt.includedPullRequests) !== '[196,202]') fail('exact version, base and release scope required');
  const owner = receipt.ownerException;
  if (owner?.approvedBy !== 'Ender' || owner.scope !== 'music-only-post-release-20261019'
    || owner.instruction !== '允许本版 Music 专项验收（推荐）' || !bound(owner)
    || receipt.releaseAuthorization?.instruction !== '上线 然后实测吧'
    || receipt.releaseAuthorization.scope !== 'v1.7.27 only' || !bound(receipt.releaseAuthorization)) fail('explicit one-version targeted and post-release authorization required');
  if (receipt.liveMatrixStatus !== 'not_run_owner_waived' || receipt.agentAcceptanceStatus !== 'not_run_owner_waived'
    || receipt.acceptanceComplete !== false || receipt.releasePublished !== false || receipt.releaseComplete !== false
    || !Array.isArray(receipt.cases) || receipt.cases.length !== 0) fail('do not claim an unexecuted full matrix or completed release');
  const prior = receipt.priorFinancialUncertainty;
  if (prior?.status !== 'unresolved' || prior.carriedFromVersion !== 'v1.7.26' || prior.pendingCNY !== null
    || !evidence(prior.evidence) || !prior.evidence.includes('docs/release-evidence/v1.7.26.json')) fail('retain historical financial uncertainty');
  const pending = receipt.postReleaseAcceptance;
  if (pending?.status !== 'pending' || pending.model !== 'minimax-music-v3.0'
    || pending.authorizedBudgetCNY !== 20 || pending.priorConservativeEstimateCNY !== 14
    || pending.maximumNewPaidSubmissions !== 2 || pending.maximumAdditionalCostCNY !== 2
    || pending.supplierFinalBillVerified !== false || !evidence(pending.evidence)) fail('production acceptance remains pending with at most two Music calls inside CNY20');
  if (!/^[a-f0-9]{40}$/.test(receipt.candidateTestedHead || '')
    || receipt.candidateAcceptance?.evidenceRole !== 'historical-reference-only') fail('historical candidate evidence must not claim final-release acceptance');
  if (receipt.review?.result !== 'approved' || receipt.review.independent !== true || !bound(receipt.review)
    || !/^[a-f0-9]{40}$/.test(receipt.review.reviewedHead || '') || !receipt.review.reviewer
    || proofs.reviewedSourceDigest !== sourceDigest) fail('independent review must cover this final application and release source');
  const ui = receipt.verification?.uiCrossReview;
  if (ui?.status !== 'not_run_owner_waived' || ui.method !== 'explicit-owner-waiver' || ui.reviewer !== 'Ender' || !bound(ui)
    || ui.instruction !== '撤回吧 这个直接上线 上线了再和Lucas说'
    || ui.notifyLucasAfterRelease !== true) fail('exact owner waiver and post-release Lucas notification required');
  for (const id of ['musicContracts', 'transportSafety', 'officialAudioPlugin', 'ci']) {
    if (receipt.verification?.[id]?.status !== 'passed' || !bound(receipt.verification[id])) fail(`missing check: ${id}`);
  }
  const candidate = receipt.candidateAcceptance;
  if (!candidate || !bound(candidate) || candidate.environment !== 'isolated-desktop-backend-and-web-preview'
    || candidate.productionWalletTested !== false || candidate.installedWailsShellTested !== false
    || candidate.apiElapsedSeconds !== 180.29 || candidate.heartbeatIntervalSeconds !== 15
    || candidate.beefTVTaskId !== '73f2816635112244477e47af022e699d' || candidate.beefTVAttempts !== 1
    || candidate.sampleRate !== 44100 || candidate.bitrate !== 256000 || candidate.format !== 'mp3'
    || candidate.saved !== true || candidate.reopened !== true || candidate.exportEqualsResource !== true) fail('retain the actual candidate evidence and its limits');
  const local = receipt.verification?.localReleaseGate;
  if (!['passed', 'pending_release_workflow'].includes(local?.status) || !bound(local)
    || local.beforeDraft !== true || !local.evidence.includes('.github/workflows/release-desktop.yml')) fail('local release gate must run before draft');
  const packages = receipt.packages;
  const platforms = ['darwin-arm64', 'darwin-amd64', 'windows-amd64', 'linux-amd64'];
  if (!Array.isArray(packages?.platforms) || packages.platforms.length !== 4 || new Set(packages.platforms).size !== 4
    || platforms.some(x => !packages.platforms.includes(x)) || packages.status !== 'pending_release_workflow'
    || packages.archives !== null || !evidence(packages.workflowEvidence) || !packages.workflowEvidence.includes('.github/workflows/release-desktop.yml')
    || ['windowsReleasedUpgradeAndRollbackBeforeUpload', 'finalArchiveSmokeBeforeUpload', 'linuxNativeWindowBeforeUpload', 'signedManifestBeforePublish', 'publicReadbackAfterPublish'].some(key => packages[key] !== true)) fail('all four final-package, upgrade, rollback and readback gates remain mandatory');
}
