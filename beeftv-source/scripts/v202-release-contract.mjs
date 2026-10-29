import { createHash } from 'node:crypto';
import { releaseAgentChecks } from './real-generation-release-contract.mjs';

export const V202_PULL_REQUESTS = [221, 222, 223, 224, 225, 226, 227, 228, 230, 231, 233];
export const V202_INSTRUCTION = '本版豁免完整十二次生成和整套助手验收；不新增付费生成，源码 review、专项回归、四平台包、升级回滚及签名检查通过后发布';

// This is an exact, single-release exception. Package flags require future
// workflow checks; they never assert that an unbuilt archive has passed.
export function validateV202Release(receipt, sourceDigest, proofs = {}) {
  const fail = message => { throw new Error('v2.0.2 targeted release: ' + message); };
  const text = value => typeof value === 'string' && value.trim() !== '';
  const evidence = value => Array.isArray(value) && value.length > 0 && value.every(text);
  const bound = value => value?.sourceDigest === sourceDigest && evidence(value.evidence);
  const exact = (value, expected) => Array.isArray(value) && new Set(value).size === value.length
    && JSON.stringify([...value].sort()) === JSON.stringify([...expected].sort());
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  if (receipt.version !== 'v2.0.2' || receipt.contractVersion !== 3
    || !/^[a-f0-9]{64}$/.test(sourceDigest) || receipt.sourceDigest !== sourceDigest
    || receipt.baseRelease !== 'v2.0.1' || receipt.baseCommit !== '5ae8e627508f0e77108c3f9b6526fcfa4faaf7a5'
    || receipt.includedMain !== 'd33ff1b7553cb938dc9e8f777c04a7e396a45d11'
    || !exact(receipt.includedPullRequests, V202_PULL_REQUESTS)) fail('exact release source and merged scope required');
  const bytes = proofs.authorizationBytes;
  const owner = receipt.ownerException;
  if (!bytes || owner?.authorizationSHA256 !== hash(bytes)) fail('authorization bytes must match');
  const authorization = JSON.parse(bytes);
  if (owner.approvedBy !== 'Ender' || owner.scope !== 'v2.0.2-targeted-no-paid-20261022'
    || owner.instruction !== V202_INSTRUCTION || !bound(owner)
    || authorization.version !== 'v2.0.2' || authorization.approvedBy !== 'Ender'
    || authorization.instruction !== V202_INSTRUCTION || authorization.includedMain !== receipt.includedMain
    || !exact(authorization.includedPullRequests, V202_PULL_REQUESTS)
    || authorization.waiveCompleteGenerationMatrix !== true || authorization.waiveCompleteAssistantAcceptance !== true
    || authorization.newPaidBudgetCNY !== 0) fail('explicit single-release authorization required');
  const ids = releaseAgentChecks('v2.0.2');
  const paths = ['text-image', 'image-image', 'image-video', 'text-video', 'video-video', 'multi-video'];
  const waived = receipt.deferredAcceptance;
  if (receipt.liveMatrixStatus !== 'not_run_owner_waived' || receipt.agentAcceptanceStatus !== 'not_run_owner_waived'
    || receipt.acceptanceComplete !== false || receipt.releasePublished !== false || receipt.releaseComplete !== false
    || !Array.isArray(receipt.cases) || receipt.cases.length !== 0
    || waived?.status !== 'not_run_owner_waived'
    || !exact(waived.caseKeys, [1, 2].flatMap(round => paths.map(path => round + '/' + path)))
    || !exact(waived.agentCheckIds, ids) || !exact(Object.keys(receipt.agentChecks || {}), ids)
    || Object.values(receipt.agentChecks).some(check => check.status !== 'not_run_owner_waived' || !bound(check))) fail('waived checks must remain unexecuted');
  if (['newPaidBudgetCNY', 'newPaidSubmissions', 'newSpentCNY', 'newPendingCNY'].some(key => receipt[key] !== 0)
    || !Array.isArray(receipt.billingAttempts) || receipt.billingAttempts.length !== 0
    || ['budgetCNY', 'spentCNY', 'pendingCNY'].some(key => receipt[key] !== null)
    || receipt.priorFinancialUncertainty?.status !== 'unresolved'
    || receipt.priorFinancialUncertainty.carriedFromVersion !== 'v2.0.1'
    || receipt.priorFinancialUncertainty.pendingCNY !== null
    || !evidence(receipt.priorFinancialUncertainty.evidence)) fail('no new paid attempts or clearing historical unknown bills');
  if (!proofs.priorReceiptBytes || receipt.priorReceiptSHA256 !== hash(proofs.priorReceiptBytes)
    || receipt.knownLimitations?.carriedFromVersion !== 'v2.0.1'
    || !exact(receipt.knownLimitations.inheritedFailedCheckIds, ['native_video', 'native_audio', 'media_film_review'])
    || !evidence(receipt.knownLimitations.evidence)) fail('retain prior receipt and known media failures');
  if (receipt.review?.result !== 'approved' || receipt.review.independent !== true || !text(receipt.review.reviewer)
    || !bound(receipt.review) || proofs.reviewedSourceDigest !== sourceDigest) fail('independent review must cover current source');
  for (const id of ['uploadAndDns', 'assistantRecovery', 'seedreamOutputs', 'desktopLinksAndMarkdown', 'publisher', 'ci']) {
    if (receipt.verification?.[id]?.status !== 'passed' || !bound(receipt.verification[id])) fail('missing current check: ' + id);
  }
  const local = receipt.verification?.localReleaseGate;
  if (!['passed', 'pending_release_workflow'].includes(local?.status) || local.method !== 'local-script'
    || local.beforeDraft !== true || !bound(local)
    || !local.evidence.includes('.github/workflows/release-desktop.yml')) fail('local gate must run before draft creation');
  if (receipt.upgrade?.status !== 'pending_release_workflow' || receipt.upgrade.preservedData !== null
    || receipt.upgrade.requiredBeforePublish !== true || !bound(receipt.upgrade)) fail('native data preservation remains mandatory and pending');
  const packages = receipt.packages;
  if (!exact(packages?.platforms, ['darwin-arm64', 'darwin-amd64', 'windows-amd64', 'linux-amd64'])
    || packages.status !== 'pending_release_workflow' || packages.archives !== null
    || !evidence(packages.workflowEvidence) || !packages.workflowEvidence.includes('.github/workflows/release-desktop.yml')
    || ['windowsReleasedUpgradeAndRollbackBeforeUpload', 'finalArchiveSmokeBeforeUpload', 'linuxNativeWindowBeforeUpload', 'signedManifestBeforePublish', 'publicReadbackAfterPublish'].some(key => packages[key] !== true)) fail('all four final-package safety checks remain mandatory');
}

