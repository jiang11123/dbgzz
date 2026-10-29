import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Protocol coverage follows the shipped manifests, never a model allowlist.
export function releaseVideoProtocolIds(directory) {
  return [...new Set(readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory())
    .flatMap(entry => JSON.parse(readFileSync(join(directory, entry.name, 'manifest.json'), 'utf8'))
      .contributes?.providers?.filter(provider => provider.capabilities?.includes('video')).map(provider => provider.id) || []))].sort();
}

// This exception permits original-task retrieval in v1.7.22, not new generation.
export function validateVideoUnifiedDeliveryRelease(receipt, sourceDigest, expectedProtocols) {
  const fail = message => { throw new Error(`v1.7.22 unified video delivery acceptance: ${message}`); };
  const text = value => typeof value === 'string' && value.trim() !== '';
  const hash = value => /^[a-f0-9]{64}$/.test(value || '');
  const evidence = value => Array.isArray(value) && value.length > 0 && value.every(text);
  const bound = value => value?.sourceDigest === sourceDigest && evidence(value.evidence);
  const exact = (actual, expected) => evidence(actual) && evidence(expected) && new Set(actual).size === actual.length
    && JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
  const time = value => text(value) && /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : NaN;
  const bill = value => ['settled', 'refunded', 'unresolved'].includes(value?.status)
    && (value.status === 'unresolved' ? value.costCNY === null : Number.isFinite(value.costCNY) && value.costCNY >= 0);

  if (receipt.version !== 'v1.7.22' || !hash(sourceDigest) || receipt.sourceDigest !== sourceDigest
    || receipt.ownerException?.approvedBy !== 'Ender'
    || receipt.ownerException.instruction !== '原任务验收，不新增付费生成（推荐）'
    || receipt.ownerException.scope !== 'video-unified-original-task-delivery-20261014' || !bound(receipt.ownerException)
    || receipt.releaseAuthorization?.instruction !== '那你就统一做吧，所有视频模型都按这套策略走，别再按模型加限制了，跑通后review没问题就上线'
    || receipt.releaseAuthorization.scope !== 'v1.7.22 only'
    || receipt.releaseAuthorization.additionalHumanReplyRequired !== false || !bound(receipt.releaseAuthorization)
    || receipt.liveTestWaiver || receipt.financialEvidenceException
    || receipt.liveMatrixStatus !== 'not_run_owner_waived' || receipt.agentAcceptanceStatus !== 'not_run_owner_waived'
    || receipt.acceptanceComplete !== false || receipt.freshGeneration !== false
    || receipt.liveModelCoverage !== 'limited_to_existing_original_tasks' || receipt.allModelsLiveTested !== false
    || ['paidSubmissionLimit', 'newPaidSubmissions', 'newBudgetCNY', 'newSpentCNY', 'newPendingCNY'].some(key => receipt[key] !== 0)
    || !Array.isArray(receipt.billingAttempts) || receipt.billingAttempts.length !== 0) fail('exact version authorization, truthful limited coverage and zero new paid submissions required');

  const prior = receipt.priorFinancialUncertainty;
  if (['budgetCNY', 'spentCNY', 'pendingCNY'].some(key => receipt[key] !== null)
    || prior?.status !== 'unresolved' || prior.carriedFromVersion !== 'v1.7.21' || prior.pendingCNY !== null
    || !evidence(prior.evidence) || !prior.evidence.includes('docs/release-evidence/v1.7.21.json')) fail('historic financial uncertainty must remain unknown');

  if (!Array.isArray(receipt.cases) || receipt.cases.length === 0
    || new Set(receipt.cases.map(item => item.taskId)).size !== receipt.cases.length) fail('distinct actual original-task retrieval cases required');
  for (const item of receipt.cases) {
    const origin = item.originalGeneration;
    const knownOrigin = origin?.status === 'recorded' && /^[a-f0-9]{40}$/.test(origin.commit || '')
      && hash(origin.sourceDigest) && origin.sourceDigest !== sourceDigest;
    const unknownOrigin = origin?.status === 'unknown' && origin.commit === null && origin.sourceDigest === null;
    const identity = item.artifactIdentity;
    const sequence = ['retrievalStartedAt', 'downloadCompletedAt', 'savedAt', 'firstFrameObservedAt', 'reopenedAt'].map(key => time(item[key]));
    if (item.method !== 'native-original-task-retrieval' || item.clientVersion !== 'v1.7.22'
      || item.executedSourceDigest !== sourceDigest || !bound(item)
      || !['native-failed-task-recovery', 'current-downloader-original-task'].includes(item.retrievalMethod)
      || !['model', 'taskId', 'providerRequestId', 'resourceId', 'platform'].every(key => text(item[key]))
      || item.originalTaskId !== item.taskId || item.originalProviderRequestId !== item.providerRequestId
      || !(item.gatewayTaskId === null || text(item.gatewayTaskId)) || item.originalGatewayTaskId !== item.gatewayTaskId
      || item.reopenedTaskId !== item.taskId || item.freshSubmission !== false || item.submissionCount !== 0
      || item.status !== 'succeeded' || !['downloaded', 'saved', 'canvasVerified', 'canvasFirstFrame', 'mediaDecoded', 'mediaOpened', 'playbackVerified', 'reopened', 'noDuplicateSubmission'].every(key => item[key] === true)
      || !hash(item.artifactSHA256) || !Number.isSafeInteger(item.bytes) || item.bytes <= 0
      || !['existing-resource-sha256', 'same-task-repeat-readback'].includes(identity?.method)
      || identity.referenceSHA256 !== item.artifactSHA256 || !evidence(identity.evidence)
      || !['native', 'current-downloader'].includes(item.downloadExecution?.method) || !bound(item.downloadExecution)
      || (item.retrievalMethod === 'native-failed-task-recovery' && (item.originalStatus !== 'failed' || item.downloadExecution.method !== 'native'))
      || (item.retrievalMethod === 'current-downloader-original-task' && item.originalStatus !== 'succeeded')
      || (!knownOrigin && !unknownOrigin) || !evidence(origin?.evidence)
      || !Number.isFinite(time(item.originalCreatedAt)) || time(item.originalCreatedAt) >= sequence[0]
      || sequence.some((value, index) => !Number.isFinite(value) || (index > 0 && value < sequence[index - 1]))
      || item.firstFrameTiming !== 'observation_upper_bound'
      || !bill(item.billingBefore) || !bill(item.billingAfter)
      || item.billingBefore.status !== item.billingAfter.status || item.billingBefore.costCNY !== item.billingAfter.costCNY
      || item.billingUnchanged?.status !== 'passed' || item.billingUnchanged.method !== 'readonly-reconciliation' || !bound(item.billingUnchanged)) fail('final-source original task download, native display, same artifact and unchanged billing required');
  }

  if (receipt.review?.result !== 'approved' || receipt.review.independent !== true || !text(receipt.review.reviewer) || !bound(receipt.review)
    || receipt.upgrade?.preservedData !== true || !bound(receipt.upgrade)) fail('current-source independent review and preserved data required');
  for (const [id, method] of Object.entries({ allVideoProtocols: 'test', directAndBackupDelivery: 'test',
    signedURLRefresh: 'test', providerAuthIsolation: 'test', cancelAndStall: 'test', noDuplicateSubmission: 'test',
    localReleaseGate: 'local-script', ci: 'github-actions' })) {
    const check = receipt.verification?.[id];
    if (check?.status !== 'passed' || check.method !== method || !bound(check)) fail(`missing current-source verification: ${id}`);
  }
  const protocols = receipt.verification.allVideoProtocols;
  if (!exact(protocols.registeredProtocols, expectedProtocols) || !exact(protocols.testedProtocols, expectedProtocols)
    || protocols.handwrittenAndWorkflowDelivery !== true) fail('all shipped video protocol manifests plus handwritten and workflow delivery require deterministic coverage');

  const packages = receipt.packages;
  if (!exact(packages?.platforms, ['darwin-arm64', 'darwin-amd64', 'windows-amd64', 'linux-amd64'])
    || packages.status !== 'pending_release_workflow' || packages.archives !== null
    || receipt.releasePublished !== false || receipt.releaseComplete !== false
    || ['windowsReleasedUpgradeAndRollbackBeforeUpload', 'finalArchiveSmokeBeforeUpload', 'linuxNativeWindowBeforeUpload', 'signedManifestBeforePublish', 'publicReadbackAfterPublish'].some(key => packages[key] !== true)
    || !evidence(packages.workflowEvidence) || !packages.workflowEvidence.includes('.github/workflows/release-desktop.yml')) fail('all four final-package and public-readback gates remain required');
}
