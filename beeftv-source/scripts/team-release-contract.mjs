// Ender's one-release waiver. Paid acceptance remains explicitly unexecuted.
export function validateTeamRelease(receipt, sourceDigest) {
  const fail = message => { throw new Error(`v1.7.25 targeted release: ${message}`); };
  const text = value => typeof value === 'string' && value.trim() !== '';
  const evidence = value => Array.isArray(value) && value.length > 0 && value.every(text);
  const bound = value => value?.sourceDigest === sourceDigest && evidence(value.evidence);
  const exact = (actual, expected) => Array.isArray(actual) && new Set(actual).size === actual.length
    && JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
  if (receipt.version !== 'v1.7.25' || !/^[a-f0-9]{64}$/.test(sourceDigest) || receipt.sourceDigest !== sourceDigest
    || receipt.ownerException?.scope !== 'team-targeted-defer-skills-20261017'
    || receipt.ownerException.approvedBy !== 'Ender'
    || receipt.ownerException.instruction !== '本版豁免重跑付费矩阵，专项验收后发布（推荐）'
    || !bound(receipt.ownerException)
    || receipt.releaseAuthorization?.scope !== 'v1.7.25 only'
    || receipt.releaseAuthorization.additionalHumanReplyRequired !== false || !bound(receipt.releaseAuthorization)
    || receipt.baseRelease !== 'v1.7.24' || receipt.baseCommit !== '2fe2311198f82ad8904a5d4c5dcbed7fbd7c8dd2'
    || !exact(receipt.includedPullRequests, [160, 161, 162, 163, 167, 168, 169, 171, 172, 174, 175, 177, 178, 179])
    || !exact(receipt.deferredPullRequests, [176])
    || receipt.revertedCommit !== 'e2e278a7e71f9f4d25ae02b5b51b6ea2e6f6cf57'
    || receipt.liveMatrixStatus !== 'not_run_owner_waived' || receipt.agentAcceptanceStatus !== 'not_run_owner_waived'
    || receipt.acceptanceComplete !== false || receipt.liveTestWaiver || receipt.financialEvidenceException) fail('exact owner instruction, release scope and deferred PR required');
  if (['paidSubmissionLimit', 'newBudgetCNY', 'newSpentCNY', 'newPendingCNY'].some(key => receipt[key] !== 0)
    || !Array.isArray(receipt.cases) || receipt.cases.length !== 0
    || !Array.isArray(receipt.billingAttempts) || receipt.billingAttempts.length !== 0
    || ['budgetCNY', 'spentCNY', 'pendingCNY'].some(key => receipt[key] !== null)) fail('no new paid attempts; historical totals remain unknown');
  const prior = receipt.priorFinancialUncertainty;
  if (prior?.status !== 'unresolved' || prior.carriedFromVersion !== 'v1.7.24' || prior.pendingCNY !== null
    || !evidence(prior.evidence) || !prior.evidence.includes('docs/release-evidence/v1.7.24.json')) fail('retain prior financial uncertainty');
  if (receipt.review?.result !== 'approved' || receipt.review.independent !== true
    || !text(receipt.review.reviewer) || !bound(receipt.review)
    || receipt.upgrade?.preservedData !== true || !bound(receipt.upgrade)) fail('current-source independent review and data preservation required');
  for (const [id, method] of Object.entries({
    generationAndRecovery: 'test', canvasAndDiagnostics: 'test', assistantAndSkillDeferral: 'test',
    installers: 'test', noNewPaidGeneration: 'source-diff', ci: 'github-actions',
  })) {
    const check = receipt.verification?.[id];
    if (check?.status !== 'passed' || check.method !== method || !bound(check)) fail(`missing source-bound check: ${id}`);
  }
  // The official workflow runs this script before opening a draft. A local
  // failure must not be relabeled passed just to prepare its preflight receipt.
  const localGate = receipt.verification?.localReleaseGate;
  if (!['passed', 'pending_release_workflow'].includes(localGate?.status)
    || localGate.method !== 'local-script' || localGate.beforeDraft !== true || !bound(localGate)
    || !localGate.evidence.includes('.github/workflows/release-desktop.yml')) fail('local release script must run before draft creation');
  const packages = receipt.packages;
  if (!exact(packages?.platforms, ['darwin-arm64', 'darwin-amd64', 'windows-amd64', 'linux-amd64'])
    || packages.status !== 'pending_release_workflow' || packages.archives !== null
    || receipt.releasePublished !== false || receipt.releaseComplete !== false
    || ['windowsReleasedUpgradeAndRollbackBeforeUpload', 'finalArchiveSmokeBeforeUpload', 'linuxNativeWindowBeforeUpload', 'signedManifestBeforePublish', 'publicReadbackAfterPublish'].some(key => packages[key] !== true)
    || !evidence(packages.workflowEvidence) || !packages.workflowEvidence.includes('.github/workflows/release-desktop.yml')) fail('all four final-package and public-readback gates remain required');
}
