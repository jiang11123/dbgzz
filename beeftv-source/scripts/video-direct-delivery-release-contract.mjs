// This owner-authorized exception covers v1.7.21 only. The native task must
// execute on the final candidate; replaying an older result is not generation.
export function validateVideoDirectDeliveryRelease(receipt, sourceDigest) {
  const fail = message => { throw new Error(`v1.7.21 video delivery acceptance: ${message}`); };
  const text = value => typeof value === 'string' && value.trim() !== '';
  const hash = value => /^[a-f0-9]{64}$/.test(value || '');
  const evidence = value => Array.isArray(value) && value.length > 0 && value.every(text);
  const bound = value => value?.sourceDigest === sourceDigest && evidence(value.evidence);
  const exact = (actual, expected) => Array.isArray(actual) && new Set(actual).size === actual.length
    && JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
  const time = value => text(value) && /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : NaN;

  if (receipt.version !== 'v1.7.21' || !hash(sourceDigest) || receipt.sourceDigest !== sourceDigest
    || receipt.ownerException?.approvedBy !== 'Ender'
    || receipt.ownerException.instruction !== '你跑一次生视频成功就可以了'
    || receipt.ownerException.scope !== 'video-direct-delivery-single-native-20261014'
    || !bound(receipt.ownerException)
    || receipt.releaseAuthorization?.scope !== 'v1.7.21 only'
    || receipt.releaseAuthorization.additionalHumanReplyRequired !== false || !bound(receipt.releaseAuthorization)
    || receipt.liveTestWaiver || receipt.financialEvidenceException
    || receipt.liveMatrixStatus !== 'not_run_owner_waived' || receipt.agentAcceptanceStatus !== 'not_run_owner_waived'
    || receipt.acceptanceComplete !== false || receipt.paidSubmissionLimit !== 1) fail('exact single-video owner instruction and version required');

  const prior = receipt.priorFinancialUncertainty;
  if (['budgetCNY', 'spentCNY', 'pendingCNY'].some(key => receipt[key] !== null)
    || prior?.status !== 'unresolved' || prior.carriedFromVersion !== 'v1.7.20' || prior.pendingCNY !== null
    || !evidence(prior.evidence) || !prior.evidence.includes('docs/release-evidence/v1.7.20.json')) fail('historic financial uncertainty must remain unknown');

  const quote = receipt.pricePreflight;
  if (quote?.status !== 'passed' || quote.method !== 'price-quote' || !bound(quote)
    || quote.model !== 'seedance-2.0-mini' || quote.seconds !== 4 || quote.resolution !== '480p'
    || quote.aspectRatio !== '16:9' || !Number.isFinite(time(quote.checkedAt))
    || !Number.isFinite(quote.maxCostCNY) || quote.maxCostCNY <= 0
    || receipt.newBudgetCNY !== quote.maxCostCNY) fail('one video requires its actual bounded price preflight');

  if (!Array.isArray(receipt.cases) || receipt.cases.length !== 1
    || !Array.isArray(receipt.billingAttempts) || receipt.billingAttempts.length !== 1) fail('exactly one native video and one media bill required');
  const item = receipt.cases[0];
  if (item.path !== 'text-video' || item.method !== 'native' || item.clientVersion !== 'v1.7.21'
    || item.executedSourceDigest !== sourceDigest || !bound(item)
    || item.model !== 'seedance-2.0-mini' || item.seconds !== 4 || item.resolution !== '480p' || item.aspectRatio !== '16:9'
    || item.status !== 'succeeded' || item.billing !== 'settled' || item.billingMarket !== 'enterprise'
    || item.freshSubmission !== true || item.submissionCount !== 1
    || !['taskId', 'gatewayTaskId', 'providerRequestId', 'resourceId', 'platform'].every(key => text(item[key]))
    || !['clientSubmitted', 'downloaded', 'saved', 'canvasVerified', 'canvasFirstFrame', 'mediaDecoded', 'mediaOpened', 'playbackVerified', 'reopened', 'noDuplicateSubmission'].every(key => item[key] === true)
    || item.reopenedTaskId !== item.taskId || !hash(item.artifactSHA256)
    || !Number.isSafeInteger(item.bytes) || item.bytes <= 0
    || !Number.isFinite(time(item.createdAt)) || !Number.isFinite(time(item.completedAt))
    || time(item.createdAt) < time(quote.checkedAt) || time(item.completedAt) < time(item.createdAt)
    || !Number.isFinite(item.costCNY) || item.costCNY <= 0 || item.costCNY > receipt.newBudgetCNY) fail('fresh final-candidate native task, saved playable resource and settlement required');

  const bill = receipt.billingAttempts[0];
  if (!text(bill.id) || bill.kind !== 'media' || bill.billing !== 'settled' || bill.taskId !== item.taskId
    || bill.providerRequestId !== item.providerRequestId || bill.executedSourceDigest !== sourceDigest || !evidence(bill.evidence)
    || bill.costCNY !== item.costCNY || receipt.newSpentCNY !== item.costCNY || receipt.newPendingCNY !== 0) fail('the sole media bill must reconcile without additional paid attempts');

  if (receipt.review?.result !== 'approved' || receipt.review.independent !== true || !text(receipt.review.reviewer) || !bound(receipt.review)
    || receipt.upgrade?.preservedData !== true || !bound(receipt.upgrade)) fail('current-source independent review and preserved data required');
  for (const [id, method] of Object.entries({
    directAndBackupDelivery: 'test', signedURLRefresh: 'test', cancelAndStall: 'test',
    noDuplicateSubmission: 'test', localReleaseGate: 'local-script', ci: 'github-actions',
  })) {
    const check = receipt.verification?.[id];
    if (check?.status !== 'passed' || check.method !== method || !bound(check)) fail(`missing current-source verification: ${id}`);
  }

  const packages = receipt.packages;
  if (!exact(packages?.platforms, ['darwin-arm64', 'darwin-amd64', 'windows-amd64', 'linux-amd64'])
    || packages.status !== 'pending_release_workflow' || packages.archives !== null
    || receipt.releasePublished !== false || receipt.releaseComplete !== false
    || ['windowsReleasedUpgradeAndRollbackBeforeUpload', 'finalArchiveSmokeBeforeUpload', 'linuxNativeWindowBeforeUpload', 'signedManifestBeforePublish', 'publicReadbackAfterPublish'].some(key => packages[key] !== true)
    || !evidence(packages.workflowEvidence) || !packages.workflowEvidence.includes('.github/workflows/release-desktop.yml')) fail('all four final-package and public-readback gates remain required');
}
