// One version only. This records a waived paid matrix, never a passed matrix.
export function validateImagePreparationRelease(receipt, sourceDigest, proofs = {}) {
  const fail = message => { throw new Error(`v1.7.26 targeted release: ${message}`); };
  const evidence = value => Array.isArray(value) && value.length > 0 && value.every(x => typeof x === 'string' && x.trim());
  const bound = value => value?.sourceDigest === sourceDigest && evidence(value.evidence);
  if (receipt.version !== 'v1.7.26' || !/^[a-f0-9]{64}$/.test(sourceDigest) || receipt.sourceDigest !== sourceDigest
    || receipt.ownerException?.scope !== 'combined-desktop-release-20261017'
    || receipt.ownerException.approvedBy !== 'Ender'
    || receipt.ownerException.instruction !== '本版豁免付费矩阵，专项回归、独立 review、CI 和四平台安装升级门禁通过后发布；历史未知账务继续保留（推荐）'
    || !bound(receipt.ownerException) || receipt.releaseAuthorization?.scope !== 'v1.7.26 only'
    || receipt.releaseAuthorization.additionalHumanReplyRequired !== false || !bound(receipt.releaseAuthorization)
    || receipt.releaseAuthorization.combinedScopeInstruction !== '一并发布 #182/#185：补齐它们的验收，再审查完整版本后发布'
    || receipt.baseRelease !== 'v1.7.25' || receipt.baseCommit !== '5f3c15c04c25eb4a786cfbe208091360c3eeb5e5'
    || JSON.stringify(receipt.includedPullRequests) !== '[182,183,185,186,188]') fail('exact authorization, base and combined release scope required');
  if (['paidSubmissionLimit', 'newBudgetCNY', 'newSpentCNY', 'newPendingCNY'].some(key => receipt[key] !== 0)
    || !Array.isArray(receipt.cases) || receipt.cases.length || !Array.isArray(receipt.billingAttempts) || receipt.billingAttempts.length
    || ['budgetCNY', 'spentCNY', 'pendingCNY'].some(key => receipt[key] !== null)
    || receipt.liveMatrixStatus !== 'not_run_owner_waived' || receipt.agentAcceptanceStatus !== 'not_run_owner_waived'
    || receipt.acceptanceComplete !== false) fail('paid matrix remains unexecuted; historical totals remain unknown');
  const prior = receipt.priorFinancialUncertainty;
  if (prior?.status !== 'unresolved' || prior.carriedFromVersion !== 'v1.7.25' || prior.pendingCNY !== null
    || !evidence(prior.evidence) || !prior.evidence.includes('docs/release-evidence/v1.7.25.json')) fail('retain historical uncertainty');
  if (receipt.review?.result !== 'approved' || receipt.review.independent !== true || !bound(receipt.review)
    || typeof receipt.review.reviewer !== 'string' || !receipt.review.reviewer.trim()
    || receipt.upgrade?.preservedData !== true || !bound(receipt.upgrade)) fail('current-source review and data preservation required');
  if (!/^[a-f0-9]{40}$/.test(receipt.review.reviewedHead || '')
    || proofs.reviewedHead !== receipt.review.reviewedHead || proofs.reviewedSourceDigest !== sourceDigest) fail('reviewed commit must contain this application and build source');
  const windows = proofs.windowsDepth;
  if (windows?.result !== 'passed' || windows.sourceFile !== 'backend/internal/depthcapture/process_windows.go'
    || !/^[a-f0-9]{64}$/.test(proofs.windowsSourceSHA256 || '') || windows.sourceSHA256 !== proofs.windowsSourceSHA256
    || windows.productionSourceCopiedWithoutChanges !== true || windows.normalExitConsoleWindow !== false
    || windows.positiveControlDetectedHiddenConsole !== true || windows.cancelParentConsoleWindow !== false
    || windows.cancelGrandchildConsoleWindow !== false || windows.matchingTopLevelWindows !== 0
    || windows.cancelledProcessTreeExited !== true || windows.remainingProcesses !== 0
    || windows.temporaryDirectoryRemoved !== true) fail('native Windows evidence must match the shipped process source');
  const mirrors = proofs.depthMirrors;
  if (mirrors?.result !== 'passed' || mirrors.windowsExistingSigningKeyVerified !== true
    || mirrors.githubDraftAssetsReadBackBeforePublication !== true || mirrors.componentBytesChanged !== false
    || !Array.isArray(mirrors.manifests) || mirrors.manifests.length !== 2) fail('published component evidence required');
  for (const [name, size, sha256] of [
    ['depth-runtime-manifest.json', 1033, '7b77ab681ac19a56d02ab1c6be1fc18bb4117537c0f2679c58ac76a7f88de201'],
    ['depth-runtime-manifest.v2.json', 3645, '1f027f6d34dc22ae3b80898c9adcd306f22eb2e729f31b994932e0287caef381'],
  ]) {
    const manifest = mirrors.manifests.find(item => item.name === name);
    if (manifest?.size !== size || manifest.sha256 !== sha256
      || ['COS', 'Cloudflare R2', 'GitHub'].some(source => !manifest.identicalPublicSources?.includes(source))) fail('component manifest readback mismatch');
  }
  for (const [id, method] of Object.entries({
    userScenario: 'synthetic-reference-and-fault-tests', generationAndRecovery: 'test',
    errorContract: 'test', noNewPaidGeneration: 'source-diff', ci: 'github-actions',
    depthMirrors: 'signed-manifest-and-public-readback', windowsDepthProcesses: 'native-windows',
    referenceTransport: 'test', midjourneyFourOutputs: 'test', uiCrossReview: 'human-review',
  })) {
    const item = receipt.verification?.[id];
    if (item?.status !== 'passed' || item.method !== method || !bound(item)) fail(`missing check: ${id}`);
  }
  if (!receipt.verification.depthMirrors.evidence.includes('docs/release-evidence/v1.7.26-depth-mirrors.json')
    || !receipt.verification.windowsDepthProcesses.evidence.includes('docs/release-evidence/v1.7.26-windows-depth.json')) fail('loaded proof files must be cited');
  const gate = receipt.verification?.localReleaseGate;
  if (!['passed', 'pending_release_workflow'].includes(gate?.status) || gate.method !== 'local-script'
    || gate.beforeDraft !== true || !bound(gate) || !gate.evidence.includes('.github/workflows/release-desktop.yml')) fail('local release gate must run before draft');
  const packages = receipt.packages;
  const platforms = ['darwin-arm64', 'darwin-amd64', 'windows-amd64', 'linux-amd64'];
  if (!Array.isArray(packages?.platforms) || packages.platforms.length !== 4
    || new Set(packages.platforms).size !== 4 || platforms.some(x => !packages.platforms.includes(x))
    || packages.status !== 'pending_release_workflow' || packages.archives !== null
    || receipt.releasePublished !== false || receipt.releaseComplete !== false
    || ['windowsReleasedUpgradeAndRollbackBeforeUpload', 'finalArchiveSmokeBeforeUpload', 'linuxNativeWindowBeforeUpload', 'signedManifestBeforePublish', 'publicReadbackAfterPublish'].some(key => packages[key] !== true)
    || !evidence(packages.workflowEvidence) || !packages.workflowEvidence.includes('.github/workflows/release-desktop.yml')) fail('all four package and readback gates remain mandatory');
}
