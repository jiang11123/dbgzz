import { createHash } from 'node:crypto';
import { releaseAgentChecks } from './real-generation-release-contract.mjs';

// Ender's publication-before-testing instruction applies only to this release.
export function validateV201Release(receipt, sourceDigest, proofs = {}) {
  const fail = message => { throw new Error(`v2.0.1 release: ${message}`); };
  const evidence = value => Array.isArray(value) && value.length > 0 && value.every(x => typeof x === 'string' && x.trim());
  const bound = value => value?.sourceDigest === sourceDigest && evidence(value.evidence);
  const exact = (value, expected) => Array.isArray(value) && JSON.stringify([...value].sort()) === JSON.stringify([...expected].sort());
  if (receipt.version !== 'v2.0.1' || receipt.contractVersion !== 3
    || !/^[a-f0-9]{64}$/.test(sourceDigest) || receipt.sourceDigest !== sourceDigest
    || receipt.baseRelease !== 'v2.0.0' || receipt.baseCommit !== 'd8bcdbe2480777147ac7c38f68793dc9bb366171'
    || receipt.includedMain !== 'd870963556d9a057449cc4db91e0a08e8fc1851f'
    || !exact(receipt.includedPullRequests, [214, 215, 216, 217, 218, 219])) fail('exact release source and merged scope required');
  const owner = receipt.ownerException;
  const authorization = proofs.authorizationBytes;
  if (!authorization || owner?.authorizationSHA256 !== createHash('sha256').update(authorization).digest('hex')) fail('authorization bytes must match');
  const approved = JSON.parse(authorization);
  if (owner.approvedBy !== 'Ender' || owner.scope !== 'v2.0.1-publish-before-testing-20261021'
    || owner.instruction !== '直接发吧 发布后在测试' || !bound(owner)
    || approved.version !== 'v2.0.1' || approved.instruction !== owner.instruction
    || approved.platformInstruction !== '四平台打包并正式发布'
    || approved.newPaidBudgetCNY !== 0 || approved.deferredAcceptance !== true) fail('explicit single-release authorization required');
  if (receipt.liveMatrixStatus !== 'pending_after_release' || receipt.agentAcceptanceStatus !== 'pending_after_release'
    || receipt.acceptanceComplete !== false || receipt.releaseComplete !== false || receipt.releasePublished !== false
    || !Array.isArray(receipt.cases) || receipt.cases.length !== 0) fail('unexecuted acceptance stays pending');
  const paths = ['text-image', 'image-image', 'image-video', 'text-video', 'video-video', 'multi-video'];
  const deferred = receipt.deferredAcceptance;
  if (deferred?.status !== 'pending_after_release'
    || !exact(deferred.caseKeys, [1, 2].flatMap(round => paths.map(path => `${round}/${path}`)))
    || !exact(deferred.agentCheckIds, releaseAgentChecks('v2.0.1'))) fail('all twelve cases and 23 assistant checks remain deferred');
  if (!exact(Object.keys(receipt.agentChecks || {}), releaseAgentChecks('v2.0.1'))
    || Object.values(receipt.agentChecks).some(check => check.status !== 'pending_after_release' || !bound(check))) fail('do not relabel historical assistant checks as current passes');
  if (receipt.newPaidBudgetCNY !== 0 || receipt.newPaidSubmissions !== 0 || receipt.newSpentCNY !== 0
    || !Array.isArray(receipt.billingAttempts) || receipt.billingAttempts.length !== 0
    || receipt.priorFinancialUncertainty?.status !== 'unresolved'
    || receipt.priorFinancialUncertainty.pendingCNY !== null
    || !evidence(receipt.priorFinancialUncertainty.evidence)) fail('no new paid authorization or clearing historical unknown bills');
  const prior = proofs.priorReceiptBytes;
  if (!prior || receipt.priorReceiptSHA256 !== createHash('sha256').update(prior).digest('hex')
    || !exact(receipt.knownLimitations?.inheritedFailedCheckIds, ['native_video', 'native_audio', 'media_film_review'])
    || receipt.knownLimitations?.carriedFromVersion !== 'v2.0.0'
    || !evidence(receipt.knownLimitations.evidence)) fail('retain original receipt and known media failures');
  if (receipt.review?.result !== 'approved' || receipt.review.independent !== true || !receipt.review.reviewer
    || !bound(receipt.review) || proofs.reviewedSourceDigest !== sourceDigest) fail('independent review must cover current source');
  // Native installation runs only on disposable CI hosts, after preflight.
  // Require that execution without claiming its future result as a pass.
  if (receipt.upgrade?.status !== 'pending_release_workflow' || receipt.upgrade.preservedData !== null
    || receipt.upgrade.requiredBeforePublish !== true || !bound(receipt.upgrade)) fail('native data preservation must remain mandatory and pending');
  for (const id of ['localReleaseGate', 'workflowAndUpscale', 'diagnostics', 'skills', 'publisher', 'ci']) {
    if (receipt.verification?.[id]?.status !== 'passed' || !bound(receipt.verification[id])) fail(`missing current check: ${id}`);
  }
  const packages = receipt.packages;
  if (!exact(packages?.platforms, ['darwin-arm64', 'darwin-amd64', 'windows-amd64', 'linux-amd64'])
    || packages.status !== 'pending_release_workflow' || packages.archives !== null
    || !evidence(packages.workflowEvidence) || !packages.workflowEvidence.includes('.github/workflows/release-desktop.yml')
    || ['windowsReleasedUpgradeAndRollbackBeforeUpload', 'finalArchiveSmokeBeforeUpload', 'linuxNativeWindowBeforeUpload', 'signedManifestBeforePublish', 'publicReadbackAfterPublish'].some(key => packages[key] !== true)) fail('all four final-package safety checks remain mandatory');
}
