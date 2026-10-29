// Ender's explicit October 13 family-release instruction applies only to v1.7.20.
// Historic calls retain their real source; replaying results is not generation.
export function validateH3FamilyRelease(receipt, sourceDigest) {
  const fail = message => { throw new Error(`v1.7.20 H3 family acceptance: ${message}`); };
  const text = value => typeof value === 'string' && value.trim() !== '';
  const hash = value => /^[a-f0-9]{64}$/.test(value || '');
  const evidence = value => Array.isArray(value) && value.length > 0 && value.every(text);
  const bound = value => value?.sourceDigest === sourceDigest && evidence(value.evidence);
  const exact = (actual, expected) => Array.isArray(actual) && new Set(actual).size === actual.length
    && JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
  if (receipt.version !== 'v1.7.20' || receipt.sourceDigest !== sourceDigest
    || receipt.ownerException?.approvedBy !== 'Ender' || receipt.ownerException.instruction !== '直接上线吧'
    || receipt.ownerException.scope !== 'fal-h3-family-20261013' || !evidence(receipt.ownerException.evidence)
    || receipt.releaseAuthorization?.scope !== 'v1.7.20 only' || receipt.releaseAuthorization.additionalHumanReplyRequired !== false
    || receipt.liveMatrixStatus !== 'not_run_owner_waived' || receipt.agentAcceptanceStatus !== 'not_run_owner_waived'
    || receipt.acceptanceComplete !== false || receipt.cases?.length !== 0 || receipt.billingAttempts?.length !== 0) fail('exact family-only owner instruction required');
  if (['budgetCNY', 'spentCNY', 'pendingCNY', 'newSpentCNY', 'newPendingCNY'].some(k => receipt[k] !== null)
    || receipt.priorFinancialUncertainty?.status !== 'unresolved' || receipt.priorFinancialUncertainty.carriedFromVersion !== 'v1.7.19'
    || receipt.priorFinancialUncertainty.pendingCNY !== null || !evidence(receipt.priorFinancialUncertainty.evidence)) fail('unresolved historic money must remain unknown');
  const funding = receipt.h3Funding;
  if (funding?.budgetCNY !== 20 || funding.reservedUpperCNY !== 19.241966 || receipt.paidSubmissionLimit !== 8
    || funding.supplierInvoiceConfirmed !== false || funding.supplierBillingReadHTTPStatus !== 403 || !evidence(funding.evidence)) fail('shared CNY20 budget and supplier uncertainty required');
  const prior = receipt.priorH3Inference;
  if (prior?.version !== 'v1.7.18' || prior.count !== 5 || prior.reservedUpperCNY !== 7.10326
    || !evidence(prior.evidence) || prior.providerRequestIds?.length !== 5 || new Set(prior.providerRequestIds).size !== 5
    || !prior.providerRequestIds.every(text)) fail('all five earlier calls required without source relabeling');
  const executedCommit = '2a9b19963bccb370a788014306fd417c6f31e4ed';
  const executedDigest = 'b9894d787af35a5eb09aa46425a09f2e6451ff22d1a9b3fcf643d482c0261952';
  const required = { 'max-text-768p': ['minimax-h3-max', 3, '768p', 1.464782],
    'base-reference-480p': ['minimax-h3', 5, '480p', 3.356792],
    'base-native-2k-keyframes': ['minimax-h3', 5, '2k', 6.611864] };
  const ids = [...prior.providerRequestIds];
  if (receipt.familyCalls?.length !== 3) fail('exactly three new real calls required');
  for (const [id, [model, seconds, resolution, cost]] of Object.entries(required)) {
    const item = receipt.familyCalls.find(call => call.id === id);
    if (!item || item.executedCommit !== executedCommit || item.executedSourceDigest !== executedDigest || !evidence(item.evidence)
      || item.model !== model || item.seconds !== seconds || item.resolution !== resolution || item.status !== 'succeeded'
      || item.billing !== 'settled' || item.billingMarket !== 'enterprise' || Math.abs(item.costCNY - cost) > 0.000001
      || !Number.isFinite(item.costCNY) || !hash(item.artifactSHA256) || ![item.gatewayTaskId, item.providerRequestId].every(text)
      || item.saved !== true || item.mediaDecoded !== true || item.noDuplicateSubmission !== true
      || item.method !== (id === 'base-native-2k-keyframes' ? 'native-cli' : 'production-go-test')) fail(`invalid real call: ${id}`);
    if (id === 'base-reference-480p' && (item.referenceImages !== 6 || item.referenceVideos !== 1 || item.referenceAudios !== 1 || item.freeReferenceImages !== 5)) fail('charged sixth reference image required');
    if (id === 'base-native-2k-keyframes' && (item.clientVersion !== 'v1.7.19' || !text(item.taskId) || item.canvasVerified !== true || item.reopened !== true)) fail('native task identity and actual tested version required');
    ids.push(item.providerRequestId);
  }
  if (new Set(ids).size !== 8 || !exact(funding.inferenceRequestIds, ids)) fail('all eight unique supplier requests must be accounted for');
  if (receipt.review?.result !== 'approved' || receipt.review.independent !== true || !text(receipt.review.reviewer) || !bound(receipt.review)
    || receipt.upgrade?.preservedData !== true || !bound(receipt.upgrade)) fail('final-source review and data preservation required');
  for (const id of ['h3FamilyCatalog', 'keyframesAndReferences', 'actualCNYSettlement', 'candidateReopenPlayback', 'noDuplicateSubmission', 'localReleaseGate', 'ci']) {
    if (receipt.verification?.[id]?.status !== 'passed' || !bound(receipt.verification[id])) fail(`missing final-source verification: ${id}`);
  }
  const reopen = receipt.candidateReopen;
  if (!bound(reopen) || reopen.clientVersion !== 'v1.7.20' || reopen.originalTaskId !== receipt.familyCalls.find(x => x.id === 'base-native-2k-keyframes').taskId
    || reopen.byteExact !== true || reopen.nativePlayback !== true || reopen.newPaidSubmissions !== 0 || reopen.h3ExecutionUnchanged !== true) fail('final candidate must reopen and play original results without regeneration');
  const packages = receipt.packages;
  if (!exact(packages?.platforms, ['darwin-arm64', 'darwin-amd64', 'windows-amd64', 'linux-amd64'])
    || packages.status !== 'pending_release_workflow' || packages.archives != null || receipt.releasePublished !== false || receipt.releaseComplete !== false
    || ['windowsReleasedUpgradeAndRollbackBeforeUpload', 'finalArchiveSmokeBeforeUpload', 'linuxNativeWindowBeforeUpload', 'signedManifestBeforePublish', 'publicReadbackAfterPublish'].some(k => packages[k] !== true)
    || !evidence(packages.workflowEvidence)) fail('all final-package and public readback gates remain required');
}
