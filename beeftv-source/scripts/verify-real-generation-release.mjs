import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { validateH3FamilyRelease } from './h3-family-release-contract.mjs';
import { validateVideoDirectDeliveryRelease } from './video-direct-delivery-release-contract.mjs';
import { validateTeamRelease } from './team-release-contract.mjs';
import { validateImagePreparationRelease } from './image-preparation-release-contract.mjs';
import { validateMusic3Release } from './music3-release-contract.mjs';
import { validateV201Release } from './v201-release-contract.mjs';
import { validateV202Release } from './v202-release-contract.mjs';
import {
  REQUIRED_AGENT_CHECK_IDS,
  DETERMINISTIC_FAULT_CHECK_IDS,
  requiresThemeAgentContract,
  inspectFixtureManifest,
  findCopiedPriorTheme,
  compareReleaseVersions,
  releaseContractVersion,
  releaseAgentChecks,
  releaseDeterministicChecks,
  validateDeferredV1713,
  validateTargetedV200,
  targetedV200SourceProof,
} from './real-generation-release-contract.mjs';

// Tree identities survive squash/merge commits, but change whenever shipped
// code, protocol packages, release scripts, dependencies or VERSION change.
const sourcePaths = ['backend', 'web', 'agent-host', 'plugin-packages', 'scripts', 'assets/app-icon.png', 'VERSION', '.github/workflows'];
const sourceTree = execFileSync('git', ['ls-tree', '-r', 'HEAD', '--', ...sourcePaths], { encoding: 'utf8' });
const sourceDigest = createHash('sha256').update(sourceTree).digest('hex');
if (process.argv.includes('--fingerprint')) {
  console.log(sourceDigest);
  process.exit(0);
}
const version = readFileSync('VERSION', 'utf8').trim();
const receipt = JSON.parse(readFileSync(`docs/release-evidence/${version}.json`, 'utf8'));
const fail = message => { throw new Error(`Real generation release gate: ${message}`); };
const nonempty = value => typeof value === 'string' && value.trim() !== '';
if (receipt.version !== version || receipt.sourceDigest !== sourceDigest) fail('receipt does not match this release source');
if (version === 'v2.0.2') {
  const reviewedTree = execFileSync('git', ['ls-tree', '-r', receipt.review?.reviewedHead, '--', ...sourcePaths], { encoding: 'utf8' });
  execFileSync('git', ['merge-base', '--is-ancestor', 'd33ff1b7553cb938dc9e8f777c04a7e396a45d11', 'HEAD']);
  validateV202Release(receipt, sourceDigest, {
    authorizationBytes: readFileSync('docs/release-evidence/v2.0.2-owner-authorization.json'),
    priorReceiptBytes: readFileSync('docs/release-evidence/v2.0.1.json'),
    reviewedSourceDigest: createHash('sha256').update(reviewedTree).digest('hex'),
  });
  console.log('v2.0.2 targeted release: complete media/assistant acceptance NOT run by owner waiver; no new paid generation; four-platform package safety checks remain mandatory.');
  process.exit(0);
}
if (version === 'v2.0.1') {
  const reviewedTree = execFileSync('git', ['ls-tree', '-r', receipt.review?.reviewedHead, '--', ...sourcePaths], { encoding: 'utf8' });
  execFileSync('git', ['merge-base', '--is-ancestor', 'd870963556d9a057449cc4db91e0a08e8fc1851f', 'HEAD']);
  validateV201Release(receipt, sourceDigest, {
    authorizationBytes: readFileSync('docs/release-evidence/v2.0.1-owner-authorization.json'),
    priorReceiptBytes: readFileSync('docs/release-evidence/v2.0.0.json'),
    reviewedSourceDigest: createHash('sha256').update(reviewedTree).digest('hex'),
  });
  console.log('v2.0.1 publication authorized before testing: 12 media cases and 23 assistant checks PENDING after release; no new paid budget. Four-platform final-package safety gates remain mandatory.');
  process.exit(0);
}
if (['v2.0.0-wand-audio-targeted-retest-20261021', 'v2.0.0-owner-release-with-postchecks-20261021'].includes(receipt.ownerException?.scope)) {
  const originalBytes = readFileSync('docs/release-evidence/v2.0.0-original-execution.json');
  const deferred = receipt.ownerException.scope === 'v2.0.0-owner-release-with-postchecks-20261021';
  const postchecksBytes = deferred ? readFileSync('docs/release-evidence/v2.0.0-owner-postchecks-snapshot.json') : undefined;
  const result = validateTargetedV200(receipt, sourceDigest, { originalBytes, sourceProof: targetedV200SourceProof(sourceTree), postchecksBytes });
  console.log(deferred
    ? `v2.0.0 owner release with postchecks: 12 original media cases; 16 historical checks passed, 7 remain failed/pending. Acceptance NOT complete. Cash CNY ${receipt.spentCNY}, unresolved full holds CNY ${receipt.pendingCNY}, cap 50; final packages ${receipt.packages.status}.`
    : `v2.0.0 targeted acceptance: ${result.retainedCases} media cases and ${result.retainedChecks} checks retain their original execution source; ${result.currentChecks} checks verified on current source. CNY ${receipt.spentCNY}/50; final packages ${receipt.packages.status}.`);
  process.exit(0);
}
if (version === 'v1.7.27') {
  const treeDigest = (ref, paths) => createHash('sha256').update(execFileSync('git', ['ls-tree', '-r', ref, '--', ...paths], { encoding: 'utf8' })).digest('hex');
  validateMusic3Release(receipt, sourceDigest, {
    reviewedSourceDigest: treeDigest(receipt.review?.reviewedHead, sourcePaths),
  });
  console.log('v1.7.27 Music-only release; full matrix NOT run; public API and installed-client acceptance PENDING; four-platform package gates remain mandatory.');
  process.exit(0);
}
if (version === 'v1.7.26') {
  const reviewedHead = receipt.review?.reviewedHead;
  if (!/^[a-f0-9]{40}$/.test(reviewedHead || '')) fail('reviewed commit is required');
  const reviewedTree = execFileSync('git', ['ls-tree', '-r', reviewedHead, '--', ...sourcePaths], { encoding: 'utf8' });
  validateImagePreparationRelease(receipt, sourceDigest, {
    reviewedHead,
    reviewedSourceDigest: createHash('sha256').update(reviewedTree).digest('hex'),
    windowsSourceSHA256: createHash('sha256').update(readFileSync('backend/internal/depthcapture/process_windows.go')).digest('hex'),
    windowsDepth: JSON.parse(readFileSync('docs/release-evidence/v1.7.26-windows-depth.json', 'utf8')),
    depthMirrors: JSON.parse(readFileSync('docs/release-evidence/v1.7.26-depth-mirrors.json', 'utf8')),
  });
  console.log('v1.7.26 combined desktop release; no new paid generation; paid matrix NOT run; four-platform package gates pending.');
  process.exit(0);
}
if (version === 'v1.7.25') {
  validateTeamRelease(receipt, sourceDigest);
  console.log('v1.7.25 targeted team release; PR #176 deferred; no new paid generation; full matrix NOT run; four-platform package gates pending.');
  process.exit(0);
}
if (version === 'v1.7.24') {
  const evidence = value => Array.isArray(value) && value.length > 0 && value.every(nonempty);
  const bound = value => value?.sourceDigest === sourceDigest && evidence(value.evidence);
  if (receipt.ownerException?.scope !== 'cross-reviewed-prs-and-byteplus-tls-20261015'
    || receipt.ownerException.approvedBy !== 'Ender'
    || receipt.ownerException.instruction !== '把已 commit 的 codex/byteplus-compat 和 fix/tls-submission-20261015 合进 main 后一起发 v1.7.24（未 commit 的 4 个工作区留下一版）'
    || !evidence(receipt.ownerException.evidence)
    || receipt.releaseAuthorization?.additionalHumanReplyRequired !== false
    || receipt.releaseAuthorization.scope !== 'v1.7.24 only'
    || receipt.baseRelease !== 'v1.7.23'
    || receipt.baseCommit !== 'cabdbdd116530feaac04bb93d940162d586413d4'
    || JSON.stringify(receipt.includedPullRequests) !== JSON.stringify([147, 154, 157, 153, 155, 156, 158, 159])
    || receipt.paidSubmissionPathChanged !== false
    || receipt.liveMatrixStatus !== 'not_run_owner_waived'
    || receipt.agentAcceptanceStatus !== 'not_run_owner_waived'
    || receipt.acceptanceComplete !== false) fail('v1.7.24 requires exact owner release authorization and v1.7.23 base');
  if (receipt.paidSubmissionLimit !== 0 || receipt.newBudgetCNY !== 0
    || receipt.newSpentCNY !== 0 || receipt.newPendingCNY !== 0
    || !Array.isArray(receipt.cases) || receipt.cases.length !== 0
    || !Array.isArray(receipt.billingAttempts) || receipt.billingAttempts.length !== 0
    || [receipt.budgetCNY, receipt.spentCNY, receipt.pendingCNY].some(value => value !== null)) fail('v1.7.24 must not add paid generation or zero historical totals');
  if (receipt.priorFinancialUncertainty?.status !== 'unresolved'
    || receipt.priorFinancialUncertainty.carriedFromVersion !== 'v1.7.23'
    || receipt.priorFinancialUncertainty.pendingCNY !== null
    || !evidence(receipt.priorFinancialUncertainty.evidence)) fail('v1.7.24 must retain v1.7.23 financial uncertainty');
  if (receipt.review?.result !== 'approved' || receipt.review.independent !== true
    || !nonempty(receipt.review.reviewer) || !bound(receipt.review)
    || receipt.upgrade?.preservedData !== true || !bound(receipt.upgrade)) fail('v1.7.24 requires current-source review and data preservation');
  for (const [id, method] of Object.entries({
    canvasAndWebviewFixes: 'test',
    externalVideoAndBytePlus: 'test',
    updaterAndSubmissionDiagnostics: 'test',
    noNewPaidGeneration: 'source-diff',
    localReleaseGate: 'local-script',
    ci: 'github-actions',
  })) {
    const item = receipt.verification?.[id];
    if (item?.status !== 'passed' || item.method !== method || !bound(item)) fail(`v1.7.24 missing targeted evidence: ${id}`);
  }
  const packages = receipt.packages;
  const platforms = ['darwin-arm64', 'darwin-amd64', 'windows-amd64', 'linux-amd64'];
  if (!Array.isArray(packages?.platforms) || JSON.stringify([...packages.platforms].sort()) !== JSON.stringify([...platforms].sort())
    || packages.status !== 'pending_release_workflow' || packages.archives != null
    || receipt.releasePublished !== false || receipt.releaseComplete !== false
    || packages.windowsReleasedUpgradeAndRollbackBeforeUpload !== true || packages.finalArchiveSmokeBeforeUpload !== true
    || packages.linuxNativeWindowBeforeUpload !== true || packages.signedManifestBeforePublish !== true
    || packages.publicReadbackAfterPublish !== true || !evidence(packages.workflowEvidence)) fail('v1.7.24 must enforce all four final-package gates');
  console.log('v1.7.24 cross-reviewed canvas, updater, external video and BytePlus/TLS package; no new paid generation; full matrix NOT run; four-platform package gates pending.');
  process.exit(0);
}
if (version === 'v1.7.23') {
  const evidence = value => Array.isArray(value) && value.length > 0 && value.every(nonempty);
  const bound = value => value?.sourceDigest === sourceDigest && evidence(value.evidence);
  if (receipt.ownerException?.scope !== 'late-merged-installer-canvas-bind-20261015'
    || receipt.ownerException.approvedBy !== 'Ender'
    || receipt.ownerException.instruction !== '把那两个lucas没review的群里在提醒一遍lucas 然后发版吧 发版后告诉lucas这版更新了什么'
    || !evidence(receipt.ownerException.evidence)
    || receipt.releaseAuthorization?.additionalHumanReplyRequired !== false
    || receipt.releaseAuthorization.scope !== 'v1.7.23 only'
    || receipt.baseRelease !== 'v1.7.22'
    || receipt.baseCommit !== 'a99c0c41c0bbb71a4b2b2479e5e5c14f14c3151a'
    || JSON.stringify(receipt.includedPullRequests) !== JSON.stringify([151])
    || receipt.paidSubmissionPathChanged !== false
    || receipt.liveMatrixStatus !== 'not_run_owner_waived'
    || receipt.agentAcceptanceStatus !== 'not_run_owner_waived'
    || receipt.acceptanceComplete !== false) fail('v1.7.23 requires exact owner release authorization and v1.7.22 base');
  if (receipt.paidSubmissionLimit !== 0 || receipt.newBudgetCNY !== 0
    || receipt.newSpentCNY !== 0 || receipt.newPendingCNY !== 0
    || !Array.isArray(receipt.cases) || receipt.cases.length !== 0
    || !Array.isArray(receipt.billingAttempts) || receipt.billingAttempts.length !== 0
    || [receipt.budgetCNY, receipt.spentCNY, receipt.pendingCNY].some(value => value !== null)) fail('v1.7.23 must not add paid generation or zero historical totals');
  if (receipt.priorFinancialUncertainty?.status !== 'unresolved'
    || receipt.priorFinancialUncertainty.carriedFromVersion !== 'v1.7.22'
    || receipt.priorFinancialUncertainty.pendingCNY !== null
    || !evidence(receipt.priorFinancialUncertainty.evidence)) fail('v1.7.23 must retain v1.7.22 financial uncertainty');
  if (receipt.review?.result !== 'approved' || receipt.review.independent !== true
    || !nonempty(receipt.review.reviewer) || !bound(receipt.review)
    || receipt.upgrade?.preservedData !== true || !bound(receipt.upgrade)) fail('v1.7.23 requires current-source review and data preservation');
  for (const [id, method] of Object.entries({
    windowsInstallerUX: 'test',
    canvasMediaBindAndRetry: 'test',
    noNewPaidGeneration: 'source-diff',
    localReleaseGate: 'local-script',
    ci: 'github-actions',
  })) {
    const item = receipt.verification?.[id];
    if (item?.status !== 'passed' || item.method !== method || !bound(item)) fail(`v1.7.23 missing targeted evidence: ${id}`);
  }
  const packages = receipt.packages;
  const platforms = ['darwin-arm64', 'darwin-amd64', 'windows-amd64', 'linux-amd64'];
  if (!Array.isArray(packages?.platforms) || JSON.stringify([...packages.platforms].sort()) !== JSON.stringify([...platforms].sort())
    || packages.status !== 'pending_release_workflow' || packages.archives != null
    || receipt.releasePublished !== false || receipt.releaseComplete !== false
    || packages.windowsReleasedUpgradeAndRollbackBeforeUpload !== true || packages.finalArchiveSmokeBeforeUpload !== true
    || packages.linuxNativeWindowBeforeUpload !== true || packages.signedManifestBeforePublish !== true
    || packages.publicReadbackAfterPublish !== true || !evidence(packages.workflowEvidence)) fail('v1.7.23 must enforce all four final-package gates');
  console.log('v1.7.23 Windows installer and canvas media bind package; no new paid generation; full matrix NOT run; four-platform package gates pending.');
  process.exit(0);
}
if (version === 'v1.7.22') {
  const { validateVideoUnifiedDeliveryRelease, releaseVideoProtocolIds } = await import('./video-unified-delivery-release-contract.mjs');
  validateVideoUnifiedDeliveryRelease(receipt, sourceDigest, releaseVideoProtocolIds('plugin-packages'));
  console.log('v1.7.22 original-task video retrieval acceptance; zero new paid submissions, current-source native display, review and protocol checks; full matrix and assistant suite NOT run; four-platform package gates pending.');
  process.exit(0);
}
if (version === 'v1.7.21') {
  validateVideoDirectDeliveryRelease(receipt, sourceDigest);
  console.log('v1.7.21 single native video delivery acceptance; one settled generation, current-source review and recovery checks; full matrix and assistant suite NOT run; four-platform package gates pending.');
  process.exit(0);
}
if (version === 'v1.7.20') {
  validateH3FamilyRelease(receipt, sourceDigest);
  // Release Actions checks out a shallow squash commit, so the executed branch
  // commit need not exist locally. Compare its recorded immutable blobs instead.
  const h3Tree = execFileSync('git', ['ls-tree', '-r', 'HEAD', '--',
    'backend/internal/generation', 'backend/internal/beefapi', 'backend/internal/modelcatalog',
    'backend/internal/providerpreset', 'backend/internal/app/provider_task_recovery.go',
    'web/src/lib/seedance-portrait.ts', 'web/src/services/api/video-provider-newapi.ts'], { encoding: 'utf8' });
  if (createHash('sha256').update(h3Tree).digest('hex') !== '43bcd27d778ecb6ca338413b971f8b474011751d2c5cb8fd9e2c246bfefcbbe9') fail('H3 execution differs from its real paid acceptance');
  console.log('v1.7.20 H3 family targeted acceptance; eight shared-budget calls, final candidate replay, full matrix NOT run; four-platform package gates pending.');
  process.exit(0);
}
// v1.7.19 only: package the installer and settings fixes that merged after
// v1.7.18 was pinned. This does not rerun or waive a future paid matrix.
if (version === 'v1.7.19') {
  const evidence = value => Array.isArray(value) && value.length > 0 && value.every(nonempty);
  const bound = value => value?.sourceDigest === sourceDigest && evidence(value.evidence);
  if (receipt.ownerException?.scope !== 'late-merged-installer-ui-20261013'
    || receipt.ownerException.approvedBy !== 'Ender'
    || receipt.ownerException.instruction !== '继续打包有两项pr晚于这次打包但是合了'
    || !evidence(receipt.ownerException.evidence)
    || receipt.releaseAuthorization?.additionalHumanReplyRequired !== false
    || receipt.releaseAuthorization.scope !== 'v1.7.19 only'
    || receipt.baseRelease !== 'v1.7.18'
    || receipt.baseCommit !== '3df73e4da93e30b4fdf394e6ed317ed7d90dcdd0'
    || JSON.stringify(receipt.includedPullRequests) !== JSON.stringify([136, 137, 135])
    || receipt.paidSubmissionPathChanged !== false
    || receipt.liveMatrixStatus !== 'not_run_owner_waived'
    || receipt.agentAcceptanceStatus !== 'not_run_owner_waived'
    || receipt.acceptanceComplete !== false) fail('v1.7.19 requires the exact late-package authorization and the three merged pull requests');
  if (receipt.paidSubmissionLimit !== 0 || receipt.newBudgetCNY !== 0
    || receipt.newSpentCNY !== 0 || receipt.newPendingCNY !== 0
    || !Array.isArray(receipt.cases) || receipt.cases.length !== 0
    || !Array.isArray(receipt.billingAttempts) || receipt.billingAttempts.length !== 0
    || [receipt.budgetCNY, receipt.spentCNY, receipt.pendingCNY].some(value => value !== null)) fail('v1.7.19 must not add paid generation or zero historical totals');
  if (receipt.priorFinancialUncertainty?.status !== 'unresolved'
    || receipt.priorFinancialUncertainty.carriedFromVersion !== 'v1.7.18'
    || receipt.priorFinancialUncertainty.pendingCNY !== null
    || !evidence(receipt.priorFinancialUncertainty.evidence)) fail('v1.7.19 must retain v1.7.18 financial uncertainty');
  if (receipt.review?.result !== 'approved' || receipt.review.independent !== true
    || !nonempty(receipt.review.reviewer) || !bound(receipt.review)
    || receipt.upgrade?.preservedData !== true || !bound(receipt.upgrade)) fail('v1.7.19 requires current-source review and data preservation');
  for (const [id, method] of Object.entries({
    singleExtractProgress: 'test',
    reducedMotionModelMenu: 'test',
    installSaveAndRetry: 'test',
    noNewPaidGeneration: 'source-diff',
    localReleaseGate: 'local-script',
    ci: 'github-actions',
  })) {
    const item = receipt.verification?.[id];
    if (item?.status !== 'passed' || item.method !== method || !bound(item)) fail(`v1.7.19 missing targeted evidence: ${id}`);
  }
  const packages = receipt.packages;
  const platforms = ['darwin-arm64', 'darwin-amd64', 'windows-amd64', 'linux-amd64'];
  if (!Array.isArray(packages?.platforms) || JSON.stringify([...packages.platforms].sort()) !== JSON.stringify([...platforms].sort())
    || packages.status !== 'pending_release_workflow' || packages.archives != null
    || receipt.releasePublished !== false || receipt.releaseComplete !== false
    || packages.windowsReleasedUpgradeAndRollbackBeforeUpload !== true || packages.finalArchiveSmokeBeforeUpload !== true
    || packages.linuxNativeWindowBeforeUpload !== true || packages.signedManifestBeforePublish !== true
    || packages.publicReadbackAfterPublish !== true || !evidence(packages.workflowEvidence)) fail('v1.7.19 must enforce all four final-package gates');
  console.log('v1.7.19 late installer and settings package; no new paid generation; full matrix NOT run; four-platform package gates pending.');
  process.exit(0);
}
// Exact H3-only authorization. Prior backend canaries and the current native
// production client have different evidence and must never be relabeled.
if (version === 'v1.7.18') {
  const evidence = value => Array.isArray(value) && value.length > 0 && value.every(nonempty);
  const bound = value => value?.sourceDigest === sourceDigest && evidence(value.evidence);
  if (receipt.ownerException?.scope !== 'fal-h3-targeted-20261013'
    || receipt.ownerException.approvedBy !== 'Ender'
    || receipt.ownerException.instruction !== '本版采用 H3 专项验收（推荐）'
    || !evidence(receipt.ownerException.evidence)
    || receipt.releaseAuthorization?.additionalHumanReplyRequired !== false
    || receipt.releaseAuthorization.scope !== 'v1.7.18 only'
    || receipt.liveMatrixStatus !== 'not_run_owner_waived'
    || receipt.agentAcceptanceStatus !== 'not_run_owner_waived'
    || receipt.acceptanceComplete !== false) fail('v1.7.18 requires exact owner H3-only and cross-review authorization');
  if (!Array.isArray(receipt.cases) || receipt.cases.length !== 0
    || !Array.isArray(receipt.billingAttempts) || receipt.billingAttempts.length !== 0
    || [receipt.budgetCNY, receipt.spentCNY, receipt.pendingCNY, receipt.newSpentCNY, receipt.newPendingCNY].some(value => value !== null)) fail('v1.7.18 must not add a generic paid matrix or zero unresolved financial totals');
  const priorDigest = '1eca0cde63aaa9d09431465f997c9959d523ca2cda60cb8dcf00e132a6f55f50';
  const requiredCases = { 'text-768p': '768p', 'first-last-480p': '480p', 'last-only-1080p': '1080p', 'pinned-audio-768p': '768p' };
  if (receipt.priorH3Canaries?.length !== 4) fail('v1.7.18 requires exactly four recorded backend canaries');
  const ids = new Set();
  for (const [id, resolution] of Object.entries(requiredCases)) {
    const item = receipt.priorH3Canaries.find(item => item.id === id);
    if (!item || item.method !== 'production-go-test' || item.executedSourceDigest !== priorDigest
      || item.model !== 'minimax-h3-max-turbo' || item.resolution !== resolution || item.seconds !== 3
      || item.status !== 'succeeded' || !nonempty(item.providerRequestId) || ids.has(item.providerRequestId)
      || !/^[a-f0-9]{64}$/.test(item.artifactSHA256 || '') || !evidence(item.evidence)) fail(`v1.7.18 invalid historical H3 case: ${id}`);
    ids.add(item.providerRequestId);
  }
  const funding = receipt.h3Funding;
  if (funding?.budgetCNY !== 20 || !Number.isFinite(funding.reservedUpperCNY)
    || funding.reservedUpperCNY < 7.10326 || funding.reservedUpperCNY > 20
    || funding.supplierInvoiceConfirmed !== false || funding.supplierBillingReadHTTPStatus !== 403
    || !evidence(funding.evidence) || receipt.paidSubmissionLimit !== 5) fail('v1.7.18 must bound five H3 creates within CNY 20 and preserve supplier invoice uncertainty');
  const item = receipt.productionH3;
  if (!bound(item) || item.method !== 'native-cli' || item.clientVersion !== version
    || item.model !== 'minimax-h3-max-turbo' || item.resolution !== '768p' || item.seconds !== 3
    || item.status !== 'succeeded' || item.billing !== 'settled' || item.billingMarket !== 'enterprise'
    || !Number.isFinite(item.costCNY) || Math.abs(item.costCNY - 0.7323912) > 0.000002
    || item.canvasVerified !== true || item.saved !== true || item.reopened !== true
    || item.mediaDecoded !== true || item.mediaOpened !== true || item.noDuplicateSubmission !== true
    || ![item.taskId, item.gatewayTaskId, item.providerRequestId].every(nonempty)
    || ids.has(item.providerRequestId) || !/^[a-f0-9]{64}$/.test(item.artifactSHA256 || '')) fail('v1.7.18 requires a current native production task, CNY settlement and saved playable canvas');
  ids.add(item.providerRequestId);
  if (!Array.isArray(funding.inferenceRequestIds) || funding.inferenceRequestIds.length !== 5
    || new Set(funding.inferenceRequestIds).size !== 5
    || funding.inferenceRequestIds.some(id => !ids.has(id))) fail('v1.7.18 must account for exactly the five recorded H3 inference requests');
  if (receipt.priorFinancialUncertainty?.status !== 'unresolved'
    || receipt.priorFinancialUncertainty.carriedFromVersion !== 'v1.7.17'
    || receipt.priorFinancialUncertainty.pendingCNY !== null
    || !evidence(receipt.priorFinancialUncertainty.evidence)) fail('v1.7.18 must retain historical financial uncertainty');
  if (receipt.review?.result !== 'approved' || receipt.review.independent !== true
    || !nonempty(receipt.review.reviewer) || !bound(receipt.review)
    || receipt.upgrade?.preservedData !== true || !bound(receipt.upgrade)) fail('v1.7.18 requires final-source review and data preservation');
  for (const id of ['h3Catalog', 'h3KeyframesAudio', 'nativeCanvasDelivery', 'noDuplicateSubmission', 'localReleaseGate', 'ci']) {
    if (receipt.verification?.[id]?.status !== 'passed' || !bound(receipt.verification[id])) fail(`v1.7.18 missing targeted evidence: ${id}`);
  }
  const packages = receipt.packages;
  const platforms = ['darwin-arm64', 'darwin-amd64', 'windows-amd64', 'linux-amd64'];
  if (!Array.isArray(packages?.platforms) || JSON.stringify([...packages.platforms].sort()) !== JSON.stringify([...platforms].sort())
    || packages.status !== 'pending_release_workflow' || packages.archives != null
    || receipt.releasePublished !== false || receipt.releaseComplete !== false
    || packages.windowsReleasedUpgradeAndRollbackBeforeUpload !== true || packages.finalArchiveSmokeBeforeUpload !== true
    || packages.linuxNativeWindowBeforeUpload !== true || packages.signedManifestBeforePublish !== true
    || packages.publicReadbackAfterPublish !== true || !evidence(packages.workflowEvidence)) fail('v1.7.18 must enforce all four final-package gates');
  console.log('v1.7.18 H3 targeted acceptance; prior backend canaries recorded separately; native production CNY settlement verified; full matrix NOT run; four-platform package gates pending.');
  process.exit(0);
}
// Ender's October 13 acceptance replaces the paid rerun authorization.
// Historical native tests remain bound to the builds actually tested.
if (version === 'v1.7.17') {
  if (receipt.ownerException?.scope !== 'generation-delivery-owner-accepted-20261013') fail('v1.7.17 paid rerun authorization was superseded by owner acceptance');
  const evidence = value => Array.isArray(value) && value.length > 0 && value.every(nonempty);
  const bound = value => value?.sourceDigest === sourceDigest && evidence(value.evidence);
  const testedDigests = {
    generationDelivery: 'd8024f245c9fdbb054a1f4adc705e783caed2e5e6b4fb07ea43e9c043aea9b3c',
    videoFullscreen: 'a25801431e4bf791ee0ef8679fbc6ba1ddae717ac737fc0feeec730225ab6870',
  };
  if (receipt.ownerException.approvedBy !== 'Ender'
    || receipt.ownerException.instruction !== '采用本次实测，不重复付费（推荐）'
    || !evidence(receipt.ownerException.evidence)
    || receipt.paidSubmissionLimit !== 0 || receipt.newBudgetCNY !== 0
    || receipt.newSpentCNY !== 0 || receipt.newPendingCNY !== 0
    || !Array.isArray(receipt.cases) || receipt.cases.length !== 0
    || receipt.liveMatrixStatus !== 'not_run_owner_waived'
    || receipt.agentAcceptanceStatus !== 'not_run_owner_waived'
    || receipt.acceptanceComplete !== false) fail('v1.7.17 owner acceptance forbids new paid generation and full-suite claims');
  for (const [id, testedDigest] of Object.entries(testedDigests)) {
    const item = receipt.ownerAcceptance?.[id];
    if (item?.confirmedBy !== 'Ender' || item.method !== 'native' || item.status !== 'passed'
      || item.testedSourceDigest !== testedDigest || item.testedSourceDigest === sourceDigest
      || !nonempty(item.instruction) || !evidence(item.evidence)) fail(`v1.7.17 missing owner native acceptance: ${id}`);
  }
  if (receipt.budgetCNY !== null || receipt.spentCNY !== null || receipt.pendingCNY !== null
    || receipt.priorFinancialUncertainty?.status !== 'unresolved'
    || receipt.priorFinancialUncertainty.carriedFromVersion !== 'v1.7.16'
    || receipt.priorFinancialUncertainty.pendingCNY !== null
    || !evidence(receipt.priorFinancialUncertainty.evidence)) fail('v1.7.17 must retain historical financial uncertainty');
  if (receipt.review?.result !== 'approved' || receipt.review.independent !== true
    || !nonempty(receipt.review.reviewer) || !bound(receipt.review)
    || receipt.upgrade?.preservedData !== true || !bound(receipt.upgrade)) fail('v1.7.17 requires current-source review and data preservation');
  for (const id of ['generationDelivery', 'imageRecoveryBudget', 'noDuplicateSubmission', 'localReleaseGate', 'ci', 'videoFullscreen']) {
    if (receipt.verification?.[id]?.status !== 'passed' || !bound(receipt.verification[id])) fail(`v1.7.17 missing targeted evidence: ${id}`);
  }
  const packages = receipt.packages;
  const platforms = ['darwin-arm64', 'darwin-amd64', 'windows-amd64', 'linux-amd64'];
  if (!Array.isArray(packages?.platforms) || JSON.stringify([...packages.platforms].sort()) !== JSON.stringify([...platforms].sort())
    || packages.status !== 'pending_release_workflow' || packages.archives != null
    || receipt.releasePublished !== false || receipt.releaseComplete !== false
    || packages.windowsReleasedUpgradeAndRollbackBeforeUpload !== true || packages.finalArchiveSmokeBeforeUpload !== true
    || packages.linuxNativeWindowBeforeUpload !== true || packages.signedManifestBeforePublish !== true
    || packages.publicReadbackAfterPublish !== true || !evidence(packages.workflowEvidence)) fail('v1.7.17 must enforce all four final-package gates');
  console.log('v1.7.17 owner native acceptance; no new paid generation; full matrix and assistant suite NOT run; four-platform package gates pending.');
  process.exit(0);
}
// One native ASR acceptance only. This does not certify the image/video matrix
// or the assistant suite, and never authorizes an additional paid attempt.
if (version === 'v1.7.16' && receipt.ownerException?.scope === 'asr-transcription-targeted-20261011') {
  const evidence = value => Array.isArray(value) && value.length > 0 && value.every(nonempty);
  const bound = value => value?.sourceDigest === sourceDigest && evidence(value.evidence);
  if (receipt.ownerException.approvedBy !== 'Ender'
    || receipt.ownerException.instruction !== '按建议专项验收后发布，本版豁免完整矩阵'
    || !evidence(receipt.ownerException.evidence) || receipt.paidSubmissionLimit !== 1
    || receipt.newBudgetCNY !== 1 || !Array.isArray(receipt.cases) || receipt.cases.length !== 1
    || receipt.liveMatrixStatus !== 'not_run_owner_waived'
    || receipt.agentAcceptanceStatus !== 'not_run_owner_waived'
    || receipt.acceptanceComplete !== false) fail('v1.7.16 requires exact one-ASR owner authorization and unexecuted full suites');
  const item = receipt.cases[0];
  if (item.path !== 'audio-transcription' || item.model !== 'hy-asr-3.0-preview'
    || item.attempts !== 1 || item.status !== 'succeeded' || item.method !== 'native'
    || item.clientSubmitted !== true || item.subtitleTextVerified !== true || item.subtitleTimingVerified !== true
    || item.subtitleSaved !== true || item.subtitleReopened !== true || item.srtExported !== true
    || item.billing !== 'settled' || !Number.isFinite(item.costCNY) || item.costCNY <= 0 || item.costCNY > 1
    || item.executedSourceDigest !== sourceDigest || item.clientVersion !== version
    || !nonempty(item.taskId) || !nonempty(item.providerRequestId)
    || !/^[a-f0-9]{64}$/.test(item.artifactSHA256 || '') || !evidence(item.evidence)
    || receipt.newSpentCNY !== item.costCNY || receipt.newPendingCNY !== 0) fail('v1.7.16 requires one native saved/reopened ASR subtitle with settled cost at most CNY 1');
  if (receipt.budgetCNY !== null || receipt.spentCNY !== null || receipt.pendingCNY !== null
    || receipt.priorFinancialUncertainty?.status !== 'unresolved'
    || receipt.priorFinancialUncertainty.carriedFromVersion !== 'v1.7.15'
    || receipt.priorFinancialUncertainty.pendingCNY !== null
    || !evidence(receipt.priorFinancialUncertainty.evidence)) fail('v1.7.16 must retain historical financial uncertainty');
  if (receipt.review?.result !== 'approved' || receipt.review.independent !== true
    || !nonempty(receipt.review.reviewer) || !bound(receipt.review)
    || receipt.upgrade?.preservedData !== true || !bound(receipt.upgrade)) fail('v1.7.16 requires current-source review and data preservation');
  for (const id of ['asrCatalog', 'nativeSubtitleSave', 'scopeIsolation', 'noDuplicateSubmission', 'localReleaseGate', 'ci']) {
    if (receipt.verification?.[id]?.status !== 'passed' || !bound(receipt.verification[id])) fail(`v1.7.16 missing targeted evidence: ${id}`);
  }
  if (receipt.verification.nativeSubtitleSave.method !== 'native') fail('v1.7.16 requires native subtitle save verification');
  const packages = receipt.packages;
  const platforms = ['darwin-arm64', 'darwin-amd64', 'windows-amd64', 'linux-amd64'];
  if (!Array.isArray(packages?.platforms) || JSON.stringify([...packages.platforms].sort()) !== JSON.stringify([...platforms].sort())
    || packages.status !== 'pending_release_workflow' || packages.archives != null
    || receipt.releasePublished !== false || receipt.releaseComplete !== false
    || packages.windowsReleasedUpgradeAndRollbackBeforeUpload !== true || packages.finalArchiveSmokeBeforeUpload !== true
    || packages.linuxNativeWindowBeforeUpload !== true || packages.signedManifestBeforePublish !== true
    || packages.publicReadbackAfterPublish !== true || !evidence(packages.workflowEvidence)) fail('v1.7.16 must enforce all four final-package gates');
  console.log('v1.7.16 native ASR saved and settled within CNY 1; full matrix and assistant suite NOT run; four-platform package gates pending.');
  process.exit(0);
}
// Exact owner authorization for this release; package gates remain mandatory.
if (version === 'v1.7.15' && receipt.ownerException?.scope === 'workspace-media-domestic-targeted-20261010') {
  const evidence = value => Array.isArray(value) && value.length > 0 && value.every(nonempty);
  const bound = value => value?.sourceDigest === sourceDigest && evidence(value.evidence);
  if (receipt.ownerException.approvedBy !== 'Ender'
    || receipt.ownerException.instruction !== '一起合入并发布，本版豁免付费矩阵（推荐）'
    || !evidence(receipt.ownerException.evidence)) fail('v1.7.15 requires exact owner authorization');
  if (receipt.newSpentCNY !== 0 || receipt.newPendingCNY !== 0
    || receipt.liveMatrixStatus !== 'not_run_owner_waived' || !Array.isArray(receipt.cases)
    || receipt.cases.length !== 0 || receipt.acceptanceComplete !== false) fail('v1.7.15 must not claim paid matrix acceptance');
  if (receipt.priorFinancialUncertainty?.status !== 'unresolved'
    || receipt.priorFinancialUncertainty.pendingCNY !== null
    || !evidence(receipt.priorFinancialUncertainty.evidence)) fail('v1.7.15 must retain historical financial uncertainty');
  if (receipt.review?.result !== 'approved' || receipt.review.independent !== true
    || !nonempty(receipt.review.reviewer) || !bound(receipt.review)
    || receipt.upgrade?.preservedData !== true || !bound(receipt.upgrade)) fail('v1.7.15 requires current-source review and data-preservation evidence');
  for (const id of ['workspaceRegression', 'videoRecovery', 'networkPolicy', 'localReleaseGate', 'ci']) {
    if (receipt.verification?.[id]?.status !== 'passed' || !bound(receipt.verification[id])) fail(`v1.7.15 missing targeted evidence: ${id}`);
  }
  const packages = receipt.packages;
  const platforms = ['darwin-arm64', 'darwin-amd64', 'windows-amd64', 'linux-amd64'];
  if (!Array.isArray(packages?.platforms) || JSON.stringify([...packages.platforms].sort()) !== JSON.stringify([...platforms].sort())
    || packages.status !== 'pending_release_workflow' || packages.archives != null
    || receipt.releasePublished !== false || receipt.releaseComplete !== false
    || packages.windowsReleasedUpgradeAndRollbackBeforeUpload !== true || packages.finalArchiveSmokeBeforeUpload !== true
    || packages.linuxNativeWindowBeforeUpload !== true || packages.signedManifestBeforePublish !== true
    || packages.publicReadbackAfterPublish !== true || !evidence(packages.workflowEvidence)) fail('v1.7.15 must enforce all four final-package gates');
  console.log('v1.7.15 owner-authorized targeted release; paid matrix NOT run; new generation expense 0; four-platform package gates pending.');
  process.exit(0);
}
// Explicit 2026-10-08 authorization changes release order for v1.7.13 only.
if (receipt.ownerException?.scope === 'release-before-remaining-acceptance-20261008') {
  const pending = validateDeferredV1713(receipt, sourceDigest);
  if (pending.complete) console.log(`v1.7.13 post-release acceptance COMPLETE: 12/12 cases, 23/23 checks; CNY ${receipt.spentCNY}/100; published packages verified.`);
  else console.log(`v1.7.13 owner authorized publish before remaining tests; acceptance PENDING (${pending.pendingCases}/12 cases, ${pending.pendingChecks}/23 checks); CNY ${receipt.spentCNY}/100; final package gates ${receipt.releasePublished ? 'verified' : 'pending'}.`);
  process.exit(0);
}
// This exact waiver applies only to the unified Seedance presentation release.
if (version === 'v1.7.12' && receipt.liveTestWaiver?.scope === 'seedance-unified-display') {
  const evidence = value => Array.isArray(value) && value.length > 0 && value.every(nonempty);
  const bound = value => value?.sourceDigest === sourceDigest && evidence(value.evidence);
  if (receipt.liveTestWaiver.approvedBy !== 'Ender'
    || receipt.liveTestWaiver.instruction !== '上线吧 豁免了 飞书文档你再看看还要不要更新'
    || !evidence(receipt.liveTestWaiver.evidence)) fail('v1.7.12 requires exact owner waiver');
  if (receipt.newSpentCNY !== 0 || receipt.newPendingCNY !== 0
    || receipt.liveMatrixStatus !== 'not_run_owner_waived' || !Array.isArray(receipt.cases)
    || receipt.cases.length !== 0) fail('v1.7.12 must record no new paid calls and an unexecuted matrix');
  if (receipt.budgetCNY !== null || receipt.spentCNY !== null || receipt.pendingCNY !== null
    || receipt.priorFinancialUncertainty?.status !== 'unresolved'
    || receipt.priorFinancialUncertainty.carriedFromVersion !== 'v1.7.11'
    || receipt.priorFinancialUncertainty.pendingCNY !== null
    || !evidence(receipt.priorFinancialUncertainty.evidence)) fail('v1.7.12 must retain historical financial uncertainty');
  if (receipt.review?.result !== 'approved' || receipt.review.independent !== true
    || !nonempty(receipt.review.reviewer) || !bound(receipt.review)
    || receipt.upgrade?.preservedData !== true || !bound(receipt.upgrade)) fail('v1.7.12 requires source-bound independent review and preserved data');
  for (const id of ['displayNames', 'nativeNames', 'localReleaseGate', 'ci']) {
    if (receipt.verification?.[id]?.status !== 'passed' || !bound(receipt.verification[id])) fail(`v1.7.12 missing targeted evidence: ${id}`);
  }
  if (receipt.verification.nativeNames.method !== 'native') fail('v1.7.12 requires native name acceptance');
  const packages = receipt.packages;
  if (packages?.status !== 'pending_release_workflow' || packages.archives != null || receipt.releaseComplete !== false
    || packages.windowsReleasedUpgradeAndRollbackBeforeUpload !== true || packages.finalArchiveSmokeBeforeUpload !== true
    || !evidence(packages.workflowEvidence)) fail('v1.7.12 final package gates must remain enforced');
  console.log('v1.7.12 unified Seedance release; paid matrix NOT run; new expense 0; historical uncertainty retained; final packages pending.');
  process.exit(0);
}
// One-image regression authorized for this version only; no matrix carry-forward.
if (version === 'v1.7.11' && receipt.ownerException?.scope === 'canvas-image-bind-regression-20261007') {
  const evidence = value => Array.isArray(value) && value.length > 0 && value.every(nonempty);
  const bound = value => value?.sourceDigest === sourceDigest && evidence(value.evidence);
  if (receipt.ownerException.approvedBy !== 'Ender'
    || receipt.ownerException.instruction !== '只复测一次生成图片看看会不会复现报错即可上线'
    || !evidence(receipt.ownerException.evidence) || receipt.liveMatrixStatus !== 'not_run_owner_limited_to_one_image'
    || receipt.paidSubmissionLimit !== 1 || receipt.cases?.length !== 1) fail('v1.7.11 requires exact one-image owner authorization');
  const item = receipt.cases[0];
  if (!['text-image', 'image-image'].includes(item.path) || !/gpt-image-2\.5/.test(item.model || '')
    || item.attempts !== 1 || item.status !== 'succeeded' || item.clientSubmitted !== true
    || item.canvasVerified !== true || item.mediaDecoded !== true || item.mediaOpened !== true
    || item.billing !== 'settled' || !Number.isFinite(item.costCNY) || item.costCNY <= 0
    || item.executedSourceDigest !== sourceDigest || item.clientVersion !== version
    || !nonempty(item.taskId) || !nonempty(item.providerRequestId)
    || !/^[a-f0-9]{64}$/.test(item.artifactSHA256 || '') || !evidence(item.evidence)
    || receipt.newSpentCNY !== item.costCNY || receipt.newPendingCNY !== 0) fail('v1.7.11 requires one settled image from the current native client and bound canvas');
  const prior = receipt.priorFinancialUncertainty;
  if (prior?.status !== 'unresolved' || prior.carriedFromVersion !== 'v1.7.10'
    || prior.pendingCNY !== null || !evidence(prior.evidence)
    || receipt.budgetCNY !== null || receipt.spentCNY !== null || receipt.pendingCNY !== null
    || receipt.financialUncertainty?.status !== 'unresolved' || !evidence(receipt.financialUncertainty.evidence)) fail('v1.7.11 must retain historical financial uncertainty');
  if (receipt.review?.result !== 'approved' || receipt.review.independent !== true
    || !nonempty(receipt.review.reviewer) || !bound(receipt.review)
    || receipt.upgrade?.preservedData !== true || !bound(receipt.upgrade)) fail('v1.7.11 requires source-bound independent review and preserved data');
  for (const id of ['saveBarrier', 'resultRecovery', 'scopeIsolation', 'localReleaseGate', 'ci']) {
    if (receipt.verification?.[id]?.status !== 'passed' || !bound(receipt.verification[id])) fail(`v1.7.11 missing targeted evidence: ${id}`);
  }
  const packages = receipt.packages;
  if (packages?.status !== 'pending_release_workflow' || packages.archives != null || receipt.releaseComplete !== false
    || packages.windowsReleasedUpgradeAndRollbackBeforeUpload !== true || packages.finalArchiveSmokeBeforeUpload !== true
    || !evidence(packages.workflowEvidence)) fail('v1.7.11 final package gates must remain enforced');
  console.log('v1.7.11 owner-authorized single-image regression passed; full matrix NOT run; independent review and targeted checks passed; final package gates pending.');
  process.exit(0);
}
// Exact one-release authorization; a naming change does not prove generation.
if (version === 'v1.7.10' && receipt.liveTestWaiver?.scope === 'seedance-display-names-only') {
  const evidence = value => Array.isArray(value) && value.length > 0 && value.every(nonempty);
  if (receipt.liveTestWaiver.approvedBy !== 'Ender'
    || receipt.liveTestWaiver.instruction !== 'beeftv本次豁免 直接上线'
    || !evidence(receipt.liveTestWaiver.evidence)) fail('v1.7.10 requires exact owner waiver');
  if (receipt.budgetCNY !== 0 || receipt.spentCNY !== 0 || receipt.newSpentCNY !== 0 || receipt.pendingCNY !== 0
    || receipt.liveMatrixStatus !== 'not_run_owner_waived' || !Array.isArray(receipt.cases) || receipt.cases.length !== 0) fail('v1.7.10 must record no new paid calls and an unexecuted matrix');
  if (receipt.priorFinancialUncertainty?.status !== 'unresolved'
    || receipt.priorFinancialUncertainty.carriedFromVersion !== 'v1.7.9'
    || receipt.priorFinancialUncertainty.pendingCNY !== null
    || !evidence(receipt.priorFinancialUncertainty.evidence)) fail('v1.7.10 must retain historical uncertainty');
  if (receipt.review?.result !== 'approved' || receipt.review.independent !== true
    || receipt.review.sourceDigest !== sourceDigest || !nonempty(receipt.review.reviewer) || !evidence(receipt.review.evidence)
    || receipt.upgrade?.preservedData !== true || receipt.upgrade.sourceDigest !== sourceDigest
    || !evidence(receipt.upgrade.evidence)) fail('v1.7.10 requires current independent review and data preservation');
  for (const id of ['displayNames', 'nativeNames', 'localReleaseGate', 'ci']) {
    const check = receipt.verification?.[id];
    if (check?.status !== 'passed' || check.sourceDigest !== sourceDigest || !evidence(check.evidence)) fail(`v1.7.10 missing targeted evidence: ${id}`);
  }
  if (receipt.verification.nativeNames.method !== 'native') fail('v1.7.10 requires native name acceptance');
  const packages = receipt.packages;
  if (packages?.status !== 'pending_release_workflow' || packages.archives != null || receipt.releaseComplete !== false
    || packages.windowsReleasedUpgradeAndRollbackBeforeUpload !== true || packages.finalArchiveSmokeBeforeUpload !== true
    || !evidence(packages.workflowEvidence)) fail('v1.7.10 final package gates must remain enforced');
  console.log('Owner authorized v1.7.10 display-name release; paid matrix NOT run; new expense 0; historical gaps retained; final packages pending.');
  process.exit(0);
}
// v1.7.9 only: Ender accepted the disclosed evidence carry-forward and gaps.
// The original execution identities and unknown finances must remain explicit.
if (version === 'v1.7.9' && receipt.ownerException?.scope === 'portrait-release-evidence-20261007') {
  const evidence = value => Array.isArray(value) && value.length > 0 && value.every(nonempty);
  const exception = receipt.ownerException;
  const priorDigest = '914efc252b2f83c023aca42634930f544d206c561264ea16e90e7b5e594f181e';
  const nativeDigest = '3f2489a9fa52e45d0e0f0771c22c2430e939ad1f14443b3ecb5a6e0475f5e40c';
  const creationDigest = '1e2eac4b8ada72c080b02e101b96b4726fba6869a5c0ff445d4ba094109a9326';
  if (exception.approvedBy !== 'Ender' || exception.instruction !== '上线吧'
    || !evidence(exception.evidence) || exception.carryForward !== true
    || exception.financialGaps !== true || exception.assetTrayDrag !== 'unverified'
    || exception.cleanMacFirstLaunch !== 'unverified') fail('v1.7.9 exact owner exception missing');
  if (receipt.budgetCNY !== null || receipt.spentCNY !== null || receipt.pendingCNY !== null
    || receipt.financialUncertainty?.status !== 'unresolved' || !evidence(receipt.financialUncertainty.evidence)) fail('v1.7.9 unknown historical finances must not become zero or a fabricated budget');
  const paid = receipt.portraitAcceptance;
  if (paid?.budgetCNY !== 20 || paid.spentCNY !== 15.231452 || paid.pendingCNY !== 0
    || paid.executedSourceDigest !== nativeDigest || paid.cases?.length !== 2) fail('v1.7.9 portrait budget or execution binding invalid');
  const expectedPortraits = [['seedance-2.0-portrait', 'f63c892df105ba844535ef2e9723ccd6', 6.022112], ['seedance-2.5-portrait', '4a253b28b201a461ca1fbaefdddccbf3', 9.209340]];
  for (const [model, taskId, cost] of expectedPortraits) {
    const item = paid.cases.find(item => item.model === model);
    if (!item || item.taskId !== taskId || item.costCNY !== cost || item.attempts !== 1
      || item.status !== 'succeeded' || item.billing !== 'settled' || item.mediaOpened !== true
      || item.mediaDecoded !== true || !/^[a-f0-9]{64}$/.test(item.artifactSHA256 || '')
      || !evidence(item.evidence)) fail('v1.7.9 requires both settled native portrait cases');
  }
  if (receipt.liveMatrixStatus !== 'passed_on_prior_candidate_owner_accepted' || receipt.cases?.length !== 12) fail('v1.7.9 prior matrix must remain explicitly carried forward');
  const ids = new Set();
  for (const round of [1, 2]) for (const path of ['text-image', 'image-image', 'text-video', 'image-video', 'video-video', 'multi-video']) {
    const item = receipt.cases.find(item => item.round === round && item.path === path);
    if (!item || !nonempty(item.taskId) || ids.has(item.taskId) || item.executedSourceDigest !== priorDigest
      || item.status !== 'succeeded' || item.clientSubmitted !== true || item.canvasVerified !== true
      || item.mediaDecoded !== true || item.mediaOpened !== true || item.billing !== 'settled'
      || !Number.isFinite(item.costCNY) || item.costCNY < 0 || !/^[a-f0-9]{64}$/.test(item.artifactSHA256 || '')
      || item.entrypoint !== 'assistant' || item.confirmed !== true
      || ![item.sessionId, item.turnId, item.proposalId, item.operationId, item.providerRequestId].every(nonempty)) fail(`v1.7.9 incomplete original matrix evidence: ${round}/${path}`);
    ids.add(item.taskId);
  }
  if (Math.abs(receipt.cases.reduce((sum, item) => sum + item.costCNY, 0) - 11.421368) > 0.000001) fail('v1.7.9 matrix charges changed');
  for (const id of REQUIRED_AGENT_CHECK_IDS) {
    const check = receipt.agentChecks?.[id];
    const expected = id === 'session_restart' ? nativeDigest : id === 'canvas_mutation' ? creationDigest : priorDigest;
    if (check?.status !== 'passed' || check.executedSourceDigest !== expected || !evidence(check.evidence)
      || !(check.method === 'native' || (check.method === 'deterministic' && DETERMINISTIC_FAULT_CHECK_IDS.includes(id)))) fail(`v1.7.9 missing original agent evidence: ${id}`);
  }
  if (receipt.review?.result !== 'approved' || receipt.review.independent !== true
    || receipt.review.sourceDigest !== sourceDigest || !nonempty(receipt.review.reviewer) || !evidence(receipt.review.evidence)
    || receipt.upgrade?.preservedData !== true || receipt.upgrade.executedSourceDigest !== nativeDigest
    || !evidence(receipt.upgrade.evidence)) fail('v1.7.9 requires independent final-source review and native restart');
  // Only release bookkeeping may differ from the installed, tested candidate.
  const testedTree = execFileSync('git', ['ls-tree', '-r', 'HEAD', '--', 'backend', 'web', 'agent-host', 'plugin-packages', 'assets/app-icon.png', 'VERSION', '.github/workflows'], { encoding: 'utf8' });
  if (createHash('sha256').update(testedTree).digest('hex') !== '6f1fa51c6770ef60b24511d4b65e39e268f096f57b18b5c9351588185194eb7a') fail('v1.7.9 application differs from the owner-accepted tested candidate');
  for (const path of ['backend', 'web', 'agent-host', 'plugin-packages', 'assets/app-icon.png', 'VERSION', '.github/workflows']) {
    const actual = execFileSync('git', ['rev-parse', `HEAD:${path}`], { encoding: 'utf8' }).trim();
    if (receipt.testedSourceObjects?.[path] !== actual) fail(`v1.7.9 tested application changed: ${path}`);
  }
  const packages = receipt.packages;
  if (packages?.status !== 'pending_release_workflow' || packages.archives != null || receipt.releaseComplete !== false
    || packages.windowsReleasedUpgradeAndRollbackBeforeUpload !== true || packages.finalArchiveSmokeBeforeUpload !== true
    || !evidence(packages.workflowEvidence)) fail('v1.7.9 final package checks must remain enforced before publication');
  console.log('v1.7.9 owner-authorized evidence carry-forward; 12 prior-candidate cases and 2 native portrait cases settled; historical financial and limited native coverage gaps retained; final package gates pending.');
  process.exit(0);
}
const downloadOnlyWaiver = version === 'v1.6.20' && receipt.liveTestWaiver?.approvedBy === 'Ender' && receipt.liveTestWaiver?.instruction === '本版豁免付费生成矩阵，review 通过就发布（推荐）';
// Owner accepted only these two failed-chat receipt gaps for v1.6.23.
// Keep unknown pending as null; this does not waive any paid media case.
const financialException = receipt.financialEvidenceException;
const acceptedFailedRequests = ['202610020816334239151708268d9d6eZ5lRPwt', '202610021242434383740578268d9d6BAoXA1u1'];
// Exact, separately approved release exceptions; never carry one forward.
const targetedWaivers = {
  'v1.7.3': ['本版豁免付费矩阵，专项验收、独立复审和 CI 通过后发布', 'byok-updater-targeted-acceptance'],
  'v1.7.5': ['合了一起发布吧', 'byok-download-resume-targeted-acceptance'],
  'v1.7.6': ['本版豁免付费矩阵，专项验收、独立复审和 CI 通过后发布', 'workspace-assets-targeted-acceptance'],
  'v1.7.7': ['本版豁免付费矩阵，专项验收、review 和 CI 通过后发布', 'reference-media-targeted-acceptance'],
  'v1.7.8': ['豁免  你只要复现并且保证修复  同时你现在让一个子agent去看看还有没有这类bug 审计一下', 'video-preview-audio-targeted-acceptance'],
};
const targetedWaiver = targetedWaivers[version];
if (targetedWaiver && receipt.liveTestWaiver?.approvedBy === 'Ender'
  && receipt.liveTestWaiver?.instruction === targetedWaiver[0]
  && receipt.liveTestWaiver?.scope === targetedWaiver[1]) {
  const evidence = value => Array.isArray(value) && value.length > 0 && value.every(nonempty);
  if (receipt.budgetCNY !== 0 || receipt.spentCNY !== 0 || receipt.newSpentCNY !== 0 || receipt.pendingCNY !== 0
    || receipt.liveMatrixStatus !== 'not_run_owner_waived' || !Array.isArray(receipt.cases) || receipt.cases.length !== 0) fail('v1.7.3 requires zero new paid calls and explicitly unexecuted media matrix');
  const prior = receipt.priorFinancialUncertainty;
  if (prior?.status !== 'unresolved' || prior?.carriedFromVersion !== 'v1.7.2' || prior.pendingCNY !== null
    || JSON.stringify([...(prior.failedRequestIds || [])].sort()) !== JSON.stringify([...acceptedFailedRequests].sort())
    || !evidence(prior.evidence)) fail('v1.7.3 must retain prior unresolved refund evidence separately from this zero-spend release');
  if (receipt.review?.result !== 'approved' || receipt.review?.independent !== true
    || receipt.review?.sourceDigest !== sourceDigest || !nonempty(receipt.review?.reviewer) || !evidence(receipt.review?.evidence)
    || receipt.upgrade?.preservedData !== true || receipt.upgrade?.sourceDigest !== sourceDigest || !evidence(receipt.upgrade?.evidence)) fail('v1.7.3 requires independent review and upgrade evidence for the current source');
  const requiredChecks = version === 'v1.7.8'
    ? ['previewRegression', 'configRecovery', 'typeAudit', 'localReleaseGate', 'ci']
    : version === 'v1.7.7'
    ? ['mediaAdmission', 'referenceLinks', 'preparationStage', 'configScalars', 'localReleaseGate', 'ci']
    : version === 'v1.7.6'
    ? ['uploadLifecycle', 'deleteConfirmation', 'archivedRecovery', 'mediaPreview', 'localReleaseGate', 'ci']
    : ['modelServiceFlow', 'credentialPersistence', 'saveBarrier', 'localReleaseGate', 'ci'];
  for (const id of requiredChecks) {
    const check = receipt.verification?.[id];
    if (check?.status !== 'passed' || check.sourceDigest !== sourceDigest || !evidence(check.evidence)) fail(`v1.7.3 missing source-bound targeted evidence: ${id}`);
  }
  if (version === 'v1.7.5') {
    for (const id of ['fullReferenceContract', 'relativeDownload', 'nativePlaybackAndSave', 'updaterResume', 'privacyScan']) {
      const check = receipt.verification?.[id];
      if (check?.status !== 'passed' || check.sourceDigest !== sourceDigest || !evidence(check.evidence)) fail(`v1.7.5 missing source-bound targeted evidence: ${id}`);
    }
    if (receipt.verification.nativePlaybackAndSave.method !== 'native') fail('v1.7.5 requires native playback and save acceptance');
  }
  const packages = receipt.packages;
  if (packages?.windowsReleasedUpgradeAndRollbackBeforeUpload !== true || packages?.finalArchiveSmokeBeforeUpload !== true
    || !evidence(packages?.workflowEvidence)) fail('v1.7.3 requires final archive and released Windows upgrade gates');
  if (packages.status === 'passed') {
    for (const platform of ['darwin-arm64', 'darwin-amd64', 'windows-amd64']) {
      const item = packages.archives?.[platform];
      if (item?.sourceDigest !== sourceDigest || !/^[a-f0-9]{64}$/.test(item.sha256 || '') || !evidence(item.evidence)) fail(`v1.7.3 missing final package: ${platform}`);
    }
  } else if (packages.status !== 'pending_release_workflow' || packages.archives != null || receipt.releaseComplete === true) {
    fail('v1.7.3 final packages must remain pending until the release workflow completes');
  }
  console.log(`Owner authorized ${version} targeted BYOK/updater release; paid matrix NOT run; new expense 0; historical refund uncertainty retained; final packages: ${packages.status}.`);
  process.exit(0);
}
// v1.7.2 only: the owner waived paid generation, not targeted acceptance or
// prior unknown refunds. Final release archives are built after this preflight.
if (version === 'v1.7.2' && receipt.liveTestWaiver?.approvedBy === 'Ender'
  && receipt.liveTestWaiver?.instruction === '本版豁免付费生成，专项验收通过后上线'
  && receipt.liveTestWaiver?.scope === 'mcp-assistant-targeted-acceptance') {
  const evidence = value => Array.isArray(value) && value.length > 0 && value.every(nonempty);
  const exact = (value, expected) => Array.isArray(value) && JSON.stringify([...value].sort()) === JSON.stringify([...expected].sort());
  if (receipt.budgetCNY !== 100 || receipt.spentCNY !== 43.74479 || receipt.newSpentCNY !== 0
    || receipt.pendingCNY !== null || receipt.knownPendingCNY !== 0
    || receipt.financialUncertainty?.status !== 'unresolved'
    || receipt.financialUncertainty?.carriedFromVersion !== 'v1.7.1'
    || !exact(receipt.financialUncertainty?.failedRequestIds, acceptedFailedRequests)
    || !evidence(receipt.financialUncertainty?.evidence)) fail('v1.7.2 requires carried prior financial uncertainty and no new paid calls');
  if (receipt.review?.result !== 'approved' || receipt.review?.sourceDigest !== sourceDigest
    || receipt.review?.independent !== true || !nonempty(receipt.review?.reviewer) || !evidence(receipt.review?.evidence)
    || receipt.upgrade?.preservedData !== true || receipt.upgrade?.sourceDigest !== sourceDigest || !evidence(receipt.upgrade?.evidence)
    || !Array.isArray(receipt.cases) || receipt.cases.length !== 0
    || receipt.liveMatrixStatus !== 'not_run_owner_waived') fail('v1.7.2 requires independent source review, preserved data evidence and an explicitly unexecuted matrix');
  for (const id of ['mcpStartup', 'assistantRuntime', 'windowsNativeRuntime', 'packagedCLI', 'localReleaseGate', 'ci']) {
    const check = receipt.verification?.[id];
    if (check?.status !== 'passed' || check.sourceDigest !== sourceDigest || !evidence(check.evidence)) fail(`v1.7.2 missing source-bound targeted evidence: ${id}`);
  }
  if (receipt.verification.windowsNativeRuntime.method !== 'native') fail('v1.7.2 Windows runtime acceptance must be native');
  const packaged = receipt.verification.packagedCLI;
  const platforms = ['darwin-arm64', 'darwin-amd64', 'windows-amd64'];
  if (packaged.method !== 'package-validator' || !exact(packaged.platforms, platforms)
    || packaged.finalArchiveSmokeBeforeUpload !== true || !evidence(packaged.releaseWorkflowEvidence)) fail('v1.7.2 requires three-platform package validation and mandatory release archive smoke before upload');
  if (packaged.finalArchivesStatus === 'passed') {
    for (const platform of platforms) {
      const archive = packaged.finalArchives?.[platform];
      if (archive?.status !== 'passed' || archive.sourceDigest !== sourceDigest || !evidence(archive.evidence)
        || !/^[a-f0-9]{64}$/.test(archive.sha256 || '')) fail(`v1.7.2 missing final archive evidence: ${platform}`);
    }
  } else if (packaged.finalArchivesStatus !== 'pending_release_workflow' || packaged.finalArchives != null || receipt.releaseComplete === true) {
    fail('v1.7.2 final archives must remain pending until release workflow verification');
  }
  console.log(`Owner authorized v1.7.2 targeted MCP/assistant release; media matrix NOT run; new expense 0; two prior refund terminal states remain unknown; final archives: ${packaged.finalArchivesStatus}.`);
  process.exit(0);
}
// Ender selected the reviewed model-picker release and renamed it v1.7.1.
// Only this version may use targeted acceptance instead of another media matrix.
if (version === 'v1.7.1' && receipt.liveTestWaiver?.approvedBy === 'Ender'
  && receipt.liveTestWaiver?.instruction === '上线吧 1.7.1 值得一个大版本'
  && receipt.liveTestWaiver?.scope === 'model-picker-targeted-acceptance') {
  const evidence = value => Array.isArray(value) && value.length > 0 && value.every(nonempty);
  const exactRequests = value => Array.isArray(value) && JSON.stringify([...value].sort()) === JSON.stringify(acceptedFailedRequests);
  if (receipt.budgetCNY !== 100 || receipt.spentCNY !== 43.74479 || receipt.newSpentCNY !== 0
    || receipt.pendingCNY !== null || receipt.knownPendingCNY !== 0
    || receipt.financialUncertainty?.status !== 'unresolved'
    || !exactRequests(receipt.financialUncertainty?.failedRequestIds)
    || financialException?.approvedBy !== 'Ender'
    || financialException?.instruction !== receipt.liveTestWaiver.instruction
    || financialException?.scope !== 'two-failed-chat-refund-evidence-only'
    || !exactRequests(financialException?.requestIds) || !evidence(financialException?.evidence)) fail('v1.7.1 requires the exact disclosed prior financial gaps and no new paid calls');
  if (receipt.review?.result !== 'approved' || receipt.review?.sourceDigest !== sourceDigest
    || !nonempty(receipt.review?.reviewer) || !evidence(receipt.review?.evidence)
    || !receipt.upgrade?.preservedData || !Array.isArray(receipt.cases) || receipt.cases.length !== 0
    || receipt.liveMatrixStatus !== 'not_run_owner_waived') fail('v1.7.1 requires independent source review, preserved data and an explicitly unexecuted matrix');
  for (const id of ['modelPicker', 'authorizationDefaultRecovery', 'saveBarrier', 'localReleaseGate', 'ci']) {
    const check = receipt.verification?.[id];
    if (check?.status !== 'passed' || !evidence(check.evidence)) fail(`v1.7.1 missing targeted evidence: ${id}`);
  }
  console.log('Owner authorized v1.7.1 targeted model-picker release; media matrix NOT run; new expense 0; two prior refund terminal states remain unknown.');
  process.exit(0);
}
const financialEvidenceWaiver = version === 'v1.6.23'
  && financialException?.approvedBy === 'Ender' && financialException?.instruction === '上线吧'
  && financialException?.scope === 'two-failed-chat-refund-evidence-only'
  && Array.isArray(financialException?.requestIds)
  && JSON.stringify([...financialException.requestIds].sort()) === JSON.stringify(acceptedFailedRequests)
  && Array.isArray(financialException?.evidence) && financialException.evidence.length > 0 && financialException.evidence.every(nonempty)
  && receipt.pendingCNY === null && receipt.knownPendingCNY === 0
  && receipt.financialUncertainty?.status === 'unresolved'
  && Array.isArray(receipt.financialUncertainty?.failedRequestIds)
  && JSON.stringify([...receipt.financialUncertainty.failedRequestIds].sort()) === JSON.stringify(acceptedFailedRequests);
if ((financialException || receipt.financialUncertainty?.status === 'unresolved') && !financialEvidenceWaiver) fail('unresolved billing requires the exact owner exception with null total pending');
if (!Number.isFinite(receipt.budgetCNY) || !Number.isFinite(receipt.spentCNY) || !((receipt.budgetCNY > 0 || (downloadOnlyWaiver && receipt.budgetCNY === 0)) && receipt.spentCNY >= 0 && receipt.spentCNY <= receipt.budgetCNY) || (receipt.pendingCNY !== 0 && !financialEvidenceWaiver)) fail('billing not reconciled within budget');
// Ender waived only v1.6.20 paid generation after the Windows download smoke.
// This release still requires the native download regression and independent review.
if (downloadOnlyWaiver) {
  if (receipt.verification?.windowsDownloads !== 'passed' || receipt.verification?.ci !== 'passed' || receipt.review?.result !== 'approved' || !receipt.upgrade?.preservedData || receipt.spentCNY !== 0) fail('download waiver requires reviewed Windows save and upgrade evidence with no paid generation');
  console.log(`Real generation release gate waived by owner: ${version}; live matrix NOT completed; Windows downloads verified; no paid generation`);
  process.exit(0);
}
// One release only: Ender explicitly waived further live testing on 2026-10-01.
// Source binding and settled-cost checks above still apply; later releases use
// the normal twelve-case gate. Never represent this exception as a passed test.
if (version === 'v1.6.18' && receipt.liveTestWaiver?.approvedBy === 'Ender' && receipt.liveTestWaiver?.instruction === '没事 这轮就不用实测了') {
  if (receipt.verification?.windowsNativeRegression !== 'passed' || receipt.review?.result !== 'approved') fail('waiver requires reviewed Windows regression evidence');
  console.log(`Real generation release gate waived by owner: ${version}; live matrix NOT completed; CNY ${receipt.spentCNY}/${receipt.budgetCNY}`);
  process.exit(0);
}
// Ender selected direct publication after being offered the v1.6.19 matrix
// waiver. This exception does not carry forward to any later version.
if (version === 'v1.6.19' && receipt.liveTestWaiver?.approvedBy === 'Ender' && receipt.liveTestWaiver?.instruction === '发布吧') {
  if (receipt.verification?.localReleaseGate !== 'passed' || receipt.verification?.errorRegression !== 'passed' || receipt.review?.result !== 'approved' || !receipt.upgrade?.preservedData) fail('waiver requires reviewed error regression and upgrade evidence');
  console.log(`Real generation release gate waived by owner: ${version}; live matrix NOT completed; CNY ${receipt.spentCNY}/${receipt.budgetCNY}`);
  process.exit(0);
}
let themeAgent = false;
try { themeAgent = requiresThemeAgentContract(version); }
catch { fail('unparseable VERSION'); }
let scenarioDigest = '';
if (themeAgent) {
  const contractVersion = releaseContractVersion(version);
  if (!Number.isInteger(receipt.contractVersion) || receipt.contractVersion !== contractVersion) fail(`explicit contractVersion=${contractVersion} is required`);
  if (contractVersion === 3) {
    if (receipt.liveTestWaiver || receipt.ownerException || receipt.financialEvidenceException) fail('contract 3 cannot use historical release waivers');
    if (receipt.budgetCNY > 50 || receipt.review?.independent !== true) fail('contract 3 requires budget <= CNY 50 and independent review');
    const attempts = receipt.billingAttempts;
    if (!Array.isArray(attempts) || !attempts.length) fail('contract 3 requires all media/chat billing attempts');
    const ids = new Set();
    for (const item of attempts) {
      if (!nonempty(item.id) || ids.has(item.id) || !['media', 'chat', 'other'].includes(item.kind)
        || !['settled', 'refunded'].includes(item.billing) || !Number.isFinite(item.costCNY) || item.costCNY < 0
        || !Array.isArray(item.evidence) || !item.evidence.length || !item.evidence.every(nonempty)) fail('invalid or unresolved billing attempt');
      ids.add(item.id);
    }
    if (!attempts.some(item => item.kind === 'chat') || Math.abs(attempts.reduce((sum, item) => sum + item.costCNY, 0) - receipt.spentCNY) > 0.000001) fail('all media/chat costs must reconcile to spentCNY');
    for (const item of receipt.cases || []) {
      const matching = attempts.filter(attempt => attempt.kind === 'media' && attempt.taskId === item.taskId);
      if (matching.length !== 1 || matching[0].billing !== 'settled' || Math.abs(matching[0].costCNY - item.costCNY) > 0.000001) fail('each accepted task requires its settled billing attempt');
    }
  }
  const review = receipt.review;
  if (!review || review.result !== 'approved' || review.sourceDigest !== sourceDigest || !nonempty(review.reviewer) || !Array.isArray(review.evidence) || !review.evidence.length || review.evidence.some(item => !nonempty(item))) fail('independent review must approve this release source with reviewer and evidence');
  if (receipt.agentChecks === true || receipt.agentChecks === false) fail('boolean-only agent coverage is not accepted');
  const scenario = receipt.scenario;
  if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario) || !nonempty(scenario.id) || !nonempty(scenario.title) || !nonempty(scenario.source) || !nonempty(scenario.queryDate) || !/^https?:\/\/\S+$/.test(scenario.source.trim()) || !/^\d{4}-\d{2}-\d{2}$/.test(scenario.queryDate.trim())) fail('scenario must include nonempty id, title, source URL and query date');
  const inspected = inspectFixtureManifest(scenario.fixtures, contractVersion);
  if (!inspected.ok) fail(`fixture manifest must include at least two image and one video SHA256${contractVersion === 3 ? ' and one WAV audio SHA256' : ''}`);
  scenarioDigest = inspected.digest;
  const checks = receipt.agentChecks;
  if (!checks || typeof checks !== 'object' || Array.isArray(checks)) fail('boolean-only agent coverage is not accepted');
  const allowedDeterministic = new Set(releaseDeterministicChecks(version));
  for (const id of releaseAgentChecks(version)) {
    const check = checks[id];
    if (check === true || check === false) fail('boolean-only agent coverage is not accepted');
    if (!check || typeof check !== 'object' || Array.isArray(check) || check.status !== 'passed' || (check.method !== 'native' && check.method !== 'deterministic') || !Array.isArray(check.evidence) || !check.evidence.length || check.evidence.some(item => !nonempty(item))) fail(`agentChecks must include ${id} with passed native or deterministic evidence`);
    if (check.sourceDigest !== sourceDigest) fail(`agent check ${id} sourceDigest does not match this release source`);
    if (check.method === 'deterministic' && !allowedDeterministic.has(id)) fail(`agent check ${id} must use native method`);
  }
}
if (!Array.isArray(receipt.cases) || receipt.cases.length !== 12) fail('expected exactly twelve successful cases');
const paths = ['text-image', 'image-image', 'image-video', 'text-video', 'video-video', 'multi-video'];
const taskIDs = new Set();
const caseDigests = new Set();
for (const round of [1, 2]) for (const path of paths) {
  const matches = receipt.cases.filter(item => item.round === round && item.path === path);
  if (matches.length !== 1) fail(`missing or duplicate ${round}/${path}`);
  const item = matches[0];
  if (!item.taskId || taskIDs.has(item.taskId)) fail(`missing or reused task for ${round}/${path}`);
  taskIDs.add(item.taskId);
  if (!item.providerRequestId || item.clientVersion !== version || !item.platform || !/^[a-f0-9]{64}$/.test(item.fixtureDigest || '') || !item.model) fail(`incomplete provenance for ${round}/${path}`);
  if (item.status !== 'succeeded' || !item.clientSubmitted || !item.canvasVerified || !item.mediaDecoded || !item.mediaOpened || item.billing !== 'settled' || !(item.costCNY >= 0) || !/^[a-f0-9]{64}$/.test(item.artifactSHA256 || '')) fail(`incomplete acceptance for ${round}/${path}`);
  if (themeAgent) {
    if (item.entrypoint !== 'assistant' || !nonempty(item.sessionId) || !nonempty(item.turnId) || !nonempty(item.proposalId) || !nonempty(item.operationId) || item.confirmed !== true) fail(`incomplete assistant provenance for ${round}/${path}`);
    caseDigests.add(item.fixtureDigest);
  }
}
if (themeAgent) {
  if (caseDigests.size !== 1 || [...caseDigests][0] !== scenarioDigest) fail('cases must share the scenario fixtureDigest');
  let names = [];
  try { names = readdirSync('docs/release-evidence'); } catch { names = []; }
  const priors = [];
  for (const name of names) {
    const matched = /^(v\d+\.\d+\.\d+)\.json$/.exec(name);
    if (!matched || compareReleaseVersions(matched[1], version) >= 0) continue;
    try { priors.push(JSON.parse(readFileSync(`docs/release-evidence/${name}`, 'utf8'))); }
    catch { /* missing or unrelated historical files are not a current-release error */ }
  }
  if (findCopiedPriorTheme(receipt.scenario, scenarioDigest, priors)) fail('copied preceding release scenario or fixtures');
}
if (receipt.cases.reduce((sum, item) => sum + item.costCNY, 0) > receipt.spentCNY + 0.000001) fail('case costs exceed reported spend');
if (!receipt.upgrade?.preservedData || !receipt.upgrade?.generationVerified) fail('existing database upgrade unverified');
console.log(`Real generation release gate passed: ${version}, 12/12, CNY ${receipt.spentCNY}/${receipt.budgetCNY}`);
if (financialEvidenceWaiver) console.log('Owner accepted two failed-chat refund-evidence gaps for v1.6.23 only; total pending remains unknown, all twelve media cases settled.');
