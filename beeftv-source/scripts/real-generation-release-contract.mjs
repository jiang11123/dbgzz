import { createHash } from 'node:crypto';

// Completeness contract only. The reporter still has to prove the evidence is true.
// Contract 2 is historical; contract 3 applies from v1.7.13. Unknown versions fail closed.
// Theme identity uses v2 receipts; fixture digests also inspect historical cases
// so the first v2 release cannot reuse the old fixed material set.
export const THEME_AGENT_CONTRACT_VERSION = 2;
export const THEME_AGENT_SINCE = 'v1.6.23';
export const DURABLE_AGENT_SINCE = 'v1.7.13';
export const DURABLE_AGENT_CONTRACT_VERSION = 3;
export const DURABLE_AGENT_CHECK_IDS = Object.freeze([
  'durable_resume', 'native_video', 'native_audio', 'skill_version', 'skill_files',
  'permission_modes', 'external_business', 'media_film_review',
]);
export function releaseContractVersion(version) {
  const comparison = compareReleaseVersions(version, DURABLE_AGENT_SINCE);
  if (comparison == null) throw new Error('unparseable VERSION');
  return comparison >= 0 ? DURABLE_AGENT_CONTRACT_VERSION : THEME_AGENT_CONTRACT_VERSION;
}
export function releaseAgentChecks(version) {
  return releaseContractVersion(version) === 3 ? [...REQUIRED_AGENT_CHECK_IDS, ...DURABLE_AGENT_CHECK_IDS] : [...REQUIRED_AGENT_CHECK_IDS];
}
export function releaseDeterministicChecks(version) {
  return releaseContractVersion(version) === 3 ? [...DETERMINISTIC_FAULT_CHECK_IDS, 'durable_resume'] : [...DETERMINISTIC_FAULT_CHECK_IDS];
}
export const REQUIRED_AGENT_CHECK_IDS = Object.freeze([
  'canvas_read',
  'asset_reference',
  'canvas_mutation',
  'multi_turn',
  'proposal_decline',
  'proposal_stale',
  'proposal_idempotency',
  'session_history',
  'session_restart',
  'cancel',
  'conflict_undo',
  'host_recovery',
  'scope_isolation',
  'budget',
  'cli_mcp',
]);
export const DETERMINISTIC_FAULT_CHECK_IDS = Object.freeze([
  'budget',
  'scope_isolation',
  'host_recovery',
  'conflict_undo',
]);

const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE = /\.(?:jpe?g|png|webp|gif)$/i;
const VIDEO = /\.(?:mp4|mov|webm|m4v)$/i;
const AUDIO = /\.wav$/i;

export function parseReleaseVersion(version) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(String(version || ''));
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : null;
}

export function compareReleaseVersions(left, right) {
  const a = parseReleaseVersion(left);
  const b = parseReleaseVersion(right);
  if (!a || !b) return null;
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function requiresThemeAgentContract(version) {
  const cmp = compareReleaseVersions(version, THEME_AGENT_SINCE);
  if (cmp == null) throw new Error('unparseable VERSION');
  return cmp >= 0;
}

export function fixtureDigestFromManifest(manifest) {
  const sorted = Object.fromEntries(Object.entries(manifest).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

export function inspectFixtureManifest(manifest, contractVersion = 2) {
  if (![2, 3].includes(contractVersion)) return { ok: false, digest: '', images: 0, videos: 0, audios: 0 };
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { ok: false, digest: '', images: 0, videos: 0 };
  const names = Object.keys(manifest);
  if (!names.length) return { ok: false, digest: '', images: 0, videos: 0 };
  const seen = new Set();
  let images = 0;
  let videos = 0;
  let audios = 0;
  for (const name of names) {
    const digest = manifest[name];
    if (!name || !SHA256.test(digest) || seen.has(digest)) return { ok: false, digest: '', images, videos };
    seen.add(digest);
    if (IMAGE.test(name)) images += 1;
    else if (VIDEO.test(name)) videos += 1;
    else if (contractVersion === 3 && AUDIO.test(name)) audios += 1;
    else return { ok: false, digest: '', images, videos };
  }
  const digest = fixtureDigestFromManifest(manifest);
  return { ok: images >= 2 && videos >= 1 && (contractVersion !== 3 || audios >= 1), digest, images, videos, audios };
}

export function findCopiedPriorTheme(scenario, digest, priors) {
  const id = typeof scenario?.id === 'string' ? scenario.id.trim() : '';
  for (const prior of priors) {
    if (Array.isArray(prior?.cases) && prior.cases.some(item => item?.fixtureDigest === digest)) return prior;
    if (![2, 3].includes(prior?.contractVersion) || !prior.scenario || typeof prior.scenario !== 'object') continue;
    const priorId = typeof prior.scenario.id === 'string' ? prior.scenario.id.trim() : '';
    const sameId = Boolean(id && priorId && priorId === id);
    const inspected = inspectFixtureManifest(prior.scenario.fixtures, prior.contractVersion);
    if (sameId || (inspected.ok && inspected.digest === digest)) return prior;
  }
  return null;
}

const TARGETED_V200_SOURCE_PATHS = ['agent-host/media-content.mjs', 'agent-host/operation-descriptors.fixture.json', 'agent-host/operation-policy.test.mjs',
  'backend/internal/app/operations_media_review.go', 'backend/internal/app/operations_media_review_audio_test.go', 'backend/internal/operations/media_review.go',
  'scripts/real-generation-release-contract.mjs', 'scripts/verify-real-generation-release.mjs', 'scripts/verify-real-generation-release.test.mjs'];

// Only current HEAD is needed. A shallow release checkout need not contain the
// original PR commit: its unchanged tree digest and nine original blobs are frozen.
export function targetedV200SourceProof(sourceTree) {
  const entries = String(sourceTree).split('\n').filter(Boolean).map(line => [line.slice(line.indexOf('\t') + 1), line.slice(0, line.indexOf('\t'))]);
  const all = new Map(entries);
  const unchanged = entries.filter(([path]) => !TARGETED_V200_SOURCE_PATHS.includes(path)).map(([path, entry]) => `${entry}\t${path}\n`).join('');
  return { unchangedSourceDigest: createHash('sha256').update(unchanged).digest('hex'),
    unchangedProductSourceDigest: createHash('sha256').update(entries.filter(([path]) => !TARGETED_V200_SOURCE_PATHS.slice(6).includes(path)).map(([path, entry]) => `${entry}\t${path}\n`).join('')).digest('hex'),
    allowedEntries: Object.fromEntries(TARGETED_V200_SOURCE_PATHS.map(path => [path, all.get(path) ?? null])) };
}

// Ender's v2.0.0 decision retains exact old executions, not new-source passes.
// Keep this beside the existing one-release contract, not a generic waiver API.
export function validateTargetedV200(receipt, sourceDigest, { originalBytes, sourceProof, postchecksBytes } = {}) {
  const fail = message => { throw new Error(`v2.0.0 targeted acceptance: ${message}`); };
  const nonempty = value => typeof value === 'string' && value.trim() !== '';
  const hash = value => /^[a-f0-9]{64}$/.test(value || '');
  const evidence = value => Array.isArray(value) && value.length > 0 && value.every(nonempty);
  const exact = (actual, expected) => Array.isArray(actual) && actual.length === new Set(actual).size && JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
  const same = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);
  const bound = value => value?.sourceDigest === sourceDigest && evidence(value.evidence);
  const originalSHA = 'e7301dd53d78dde2b14b9d4f3f003610fadf3592ab54f889233cc4a4b5548fb4';
  const oldSource = '5eed2376d3565325feca3e9221cd261d84e598f00da1513ff9282d20487edbb6';
  const ownerSHA = 'eab11b7c3df4187d46a6aaaaa1c11759cd6bcdbee5d304f476fef06eab546758';
  if (!originalBytes || createHash('sha256').update(originalBytes).digest('hex') !== originalSHA) fail('frozen original execution evidence changed');
  const original = JSON.parse(String(originalBytes));
  const owner = receipt.ownerException;
  const deferred = owner?.scope === 'v2.0.0-owner-release-with-postchecks-20261021';
  let snapshot;
  if (deferred) {
    const snapshotSHA = 'c5d4721a9abb2d84a16baa85104eeb1463b3900e51b178ae773164d879ae4520';
    if (!postchecksBytes || createHash('sha256').update(postchecksBytes).digest('hex') !== snapshotSHA
      || receipt.postchecksSnapshotSHA256 !== snapshotSHA) fail('frozen postchecks and complete cost index required');
    snapshot = JSON.parse(String(postchecksBytes));
    if (owner.authorizationSHA256 !== snapshot.ownerAuthorization.authorizationSHA256
      || owner.instruction !== snapshot.ownerAuthorization.instruction || owner.previousAuthorizationSHA256 !== ownerSHA
      || receipt.additionalPaidTestsStopped !== true || receipt.acceptanceComplete !== false
      || !same(receipt.throughLedger, snapshot.throughLedger)
      || sourceProof?.unchangedProductSourceDigest !== snapshot.unchangedProductSourceDigest) fail('exact owner release decision and unchanged product source required');
  }
  if (receipt.version !== 'v2.0.0' || receipt.contractVersion !== 3 || receipt.sourceDigest !== sourceDigest
    || !hash(sourceDigest) || sourceDigest === oldSource
    || (!deferred && (owner?.scope !== 'v2.0.0-wand-audio-targeted-retest-20261021'
      || owner.instruction !== original.ownerAuthorization.answer || owner.authorizationSHA256 !== ownerSHA))
    || owner?.approvedBy !== 'Ender' || !bound(owner)
    || receipt.originalExecutionSHA256 !== originalSHA || receipt.originalExecutionSourceDigest !== oldSource
    || receipt.liveTestWaiver || receipt.financialEvidenceException) fail('exact single-version authorization and original source required');
  const allowedChanges = TARGETED_V200_SOURCE_PATHS;
  if (sourceProof?.unchangedSourceDigest !== original.originalSourceProof.unchangedSourceDigest
    || !exact(Object.keys(sourceProof.allowedEntries || {}), allowedChanges)
    || allowedChanges.some(path => !/^100(?:644|755) blob [a-f0-9]{40}$/.test(sourceProof.allowedEntries[path] || '')
      || sourceProof.allowedEntries[path] === original.originalSourceProof.allowedEntries[path])) fail('source changes exceed or omit the reviewed audio and acceptance scope');
  const impact = receipt.impactReview;
  if (impact?.result !== 'approved' || impact.independent !== true || !nonempty(impact.reviewer) || !bound(impact)
    || !exact(impact.changedSourcePaths, allowedChanges)) fail('current independent impact review required');
  if (receipt.budgetCNY !== 50 || !Number.isFinite(receipt.spentCNY) || receipt.spentCNY < original.originalSpentCNY
    || !Number.isFinite(receipt.pendingCNY) || receipt.pendingCNY < 0 || receipt.spentCNY + receipt.pendingCNY > 50
    || (!deferred && (receipt.pendingCNY !== 0 || receipt.financialUncertainty?.status === 'unresolved'))) fail('all cash and full unresolved holds must fit the original CNY 50');
  const cases = receipt.cases;
  if (!Array.isArray(cases) || cases.length !== 12 || new Set(cases.map(x => x.taskId)).size !== 12) fail('exact twelve original cases required');
  for (const previous of original.originalCases) {
    const item = cases.find(x => x.taskId === previous.taskId);
    if (!item || Object.entries(previous).some(([key, value]) => !same(item[key], value))) fail('original case source, task, parameters or evidence was relabeled');
  }
  if (receipt.liveMatrixStatus !== 'retained_original_execution'
    || receipt.agentAcceptanceStatus !== (deferred ? 'incomplete_owner_deferred' : 'passed_with_retained_original_checks')) fail('retained executions must not be called current-source matrix passes');
  const inspected = inspectFixtureManifest(receipt.scenario?.fixtures, 3);
  if (!same(receipt.scenario, original.originalScenario) || !inspected.ok || cases.some(x => x.fixtureDigest !== inspected.digest)
    || !nonempty(receipt.scenario?.id) || !nonempty(receipt.scenario.title)
    || !/^https?:\/\/\S+$/.test(receipt.scenario.source || '') || !/^\d{4}-\d{2}-\d{2}$/.test(receipt.scenario.queryDate || '')) fail('original scenario and fixtures must remain explicit');
  const checks = receipt.agentChecks, reused = [];
  if (!checks || !exact(Object.keys(checks), releaseAgentChecks('v2.0.0'))) fail('all 23 checks required');
  for (const id of releaseAgentChecks('v2.0.0')) {
    const check = checks[id], previous = original.retainedAgentChecks[id];
    if (deferred) {
      if (!same(check, snapshot.agentChecks[id])) fail(`frozen check status, source and prior evidence must remain: ${id}`);
      if (check.sourceDigest === oldSource) reused.push(id);
      continue;
    }
    if (check?.status !== 'passed' || !evidence(check.evidence) || !['native', 'deterministic'].includes(check.method)
      || (check.method === 'deterministic' && !releaseDeterministicChecks('v2.0.0').includes(id))) fail(`missing real acceptance: ${id}`);
    if (check.sourceDigest === oldSource) {
      if (!previous || Object.entries(previous).some(([key, value]) => !same(check[key], value))) fail(`unapproved or relabeled historical check: ${id}`);
      reused.push(id);
    } else if (!bound(check) || (previous && same(check.evidence, previous.evidence))) fail(`check ${id} requires new current-source evidence, not relabeled originals`);
  }
  if (!exact(impact.retainedCheckIds, reused)) fail('impact review must enumerate the exact retained checks');
  if (deferred && !same(receipt.postReleaseChecks, snapshot.postReleaseChecks)) fail('all seven failed or pending post-release checks must remain explicit');
  for (const id of deferred ? [] : ['native_audio', 'native_video', 'media_film_review']) {
    if (!bound(checks[id]) || checks[id].method !== 'native') fail(`current native ${id} required`);
  }
  const attempts = receipt.billingAttempts;
  if (!Array.isArray(attempts) || !attempts.length || new Set(attempts.map(x => x.id)).size !== attempts.length) fail('all distinct billing attempts required');
  const holds = new Map(original.originalBillingHolds.map(x => [x.id, x]));
  const additional = new Map((snapshot?.additionalBillingAttempts || []).map(x => [x.id, x]));
  const groups = new Map();
  for (const item of attempts) {
    const previous = holds.get(item.originalHoldId);
    const frozen = additional.get(item.id);
    const pending = deferred && item.billing === 'pending';
    if (!nonempty(item.id) || !['media', 'chat', 'other'].includes(item.kind) || !evidence(item.evidence)
      || (pending ? (item.costCNY !== null || item.settlementEvidenceSHA256 !== null
        || item.heldCNY !== (previous?.settledCNY === null ? Number(previous.amount) / 1000000 : frozen?.heldCNY)
        || !Number.isFinite(item.heldCNY) || item.heldCNY <= 0 || (previous ? previous.settledCNY !== null : frozen?.billing !== 'pending'))
        : (!['settled', 'refunded'].includes(item.billing) || !Number.isFinite(item.costCNY) || item.costCNY < 0 || !hash(item.settlementEvidenceSHA256)))) fail('invalid cash or omitted full pending hold');
    if (deferred && frozen) {
      // A later final bill may settle a frozen pending cost; it cannot change
      // the original request, source, full hold, result or cost-only provenance.
      const settlementFields = frozen.billing === 'pending' ? ['billing', 'costCNY', 'settlementEvidenceSHA256'] : [];
      if (Object.entries(frozen).some(([key, value]) => !settlementFields.includes(key) && !same(item[key], value))) fail('new cost source or frozen receipt was rewritten');
    }
    if (deferred && !previous && !frozen && !same(item, snapshot.externalCash)) fail('cost must belong to the complete frozen ledger index');
    if (item.originalHoldId && !previous) fail('unknown original hold');
    if (previous) {
      if (item.kind !== previous.kind || !same(item.originalHold, previous)) fail('original hold/request/time/bill evidence must be preserved');
      const list = groups.get(previous.id) || []; list.push(item); groups.set(previous.id, list);
      const media = cases.find(x => x.taskId === item.taskId);
      if (previous.kind === 'media') {
        if (!media || item.executedSourceDigest !== oldSource || item.executionSourceStatus !== 'known_original') fail('media bill requires exact original execution source');
        const expectedHold = media.path.endsWith('image')
          ? (media.round === 2 ? 'round2-image-batch-approval' : `round1-${media.path === 'text-image' ? 't2i' : 'i2i'}-approval`)
          : `round${media.round}-video-batch-approval`;
        if (item.originalHoldId !== expectedHold || item.requestId !== media.gatewayRequestId) fail('media bill must preserve exact original hold and gateway request');
      } else if (item.executedSourceDigest !== null || item.executionSourceStatus !== 'unknown_historical'
        || item.requestId !== previous.requestId) fail('untraced old cost must preserve its request and remain unknown_historical, not acceptance evidence');
    } else if (item.externalReviewJob === original.externalReviewCostUncertainty.job) {
      if (item.kind !== 'other' || item.executedSourceDigest !== null || item.executionSourceStatus !== 'unknown_historical') fail('historical external review is cost-only');
    } else if (item.executionSourceStatus === 'not_app_execution') {
      if (item.kind === 'media' || item.executedSourceDigest !== null || !hash(item.executorSHA256)) fail('new direct diagnosis requires its real executor source');
    } else if (item.executionSourceStatus === 'superseded_candidate') {
      if (item.kind === 'media' || item.executedSourceDigest !== oldSource || item.acceptanceCredit !== false
        || !hash(item.executionSourceEvidenceSHA256)) fail('additional old-candidate cost needs exact original source proof and no current acceptance credit');
    } else if (item.executedSourceDigest !== (deferred ? snapshot.executedSourceDigest : sourceDigest)
      || item.executionSourceStatus !== 'current') fail('new app attempts require their actual execution source');
    if (!previous && item.kind === 'media') fail('owner authorized no repeated paid media matrix');
  }
  if (deferred) {
    if ([...additional.keys()].some(id => !attempts.some(x => x.id === id))) fail('a post-original billing attempt was omitted');
    const pending = attempts.filter(x => x.billing === 'pending');
    if (Math.abs(pending.reduce((sum, x) => sum + x.heldCNY, 0) - receipt.pendingCNY) > 0.000001
      || !Array.isArray(receipt.postReleaseBilling) || !exact(receipt.postReleaseBilling.map(x => x.id), pending.map(x => x.id))
      || receipt.postReleaseBilling.some(x => {
        const item = pending.find(y => y.id === x.id);
        return x.requestId !== item.requestId || x.heldCNY !== item.heldCNY || x.costCNY !== null
          || x.status !== 'pending' || !nonempty(x.owner) || !nonempty(x.nextAction) || !evidence(x.evidence);
      })) fail('every unresolved bill needs its full held amount and post-release owner');
  }
  for (const previous of holds.values()) {
    const group = groups.get(previous.id);
    if (!group?.length || (previous.kind !== 'media' && group.length !== 1)) fail('an original attempt was omitted or duplicated');
    if (previous.settledCNY !== null && Math.abs(group.reduce((sum, x) => sum + x.costCNY, 0) - previous.settledCNY) > 0.000001) fail('known original cash changed');
  }
  if (attempts.filter(x => x.externalReviewJob === original.externalReviewCostUncertainty.job).length !== 1) fail('external review uncertainty needs its exact final cash result');
  for (const item of cases) {
    const bills = attempts.filter(x => x.kind === 'media' && x.taskId === item.taskId);
    if (bills.length !== 1 || bills[0].billing !== 'settled' || Math.abs(bills[0].costCNY - item.costCNY) > 0.000001) fail('each original media task requires its unique settled final bill');
  }
  if (Math.abs(attempts.reduce((sum, x) => sum + x.costCNY, 0) - receipt.spentCNY) > 0.000001) fail('all original and new costs must reconcile');
  if (receipt.review?.result !== 'approved' || receipt.review.independent !== true || !nonempty(receipt.review.reviewer) || !bound(receipt.review)
    || receipt.upgrade?.preservedData !== true || receipt.upgrade.generationVerified !== true || !bound(receipt.upgrade)) fail('current independent review and upgrade verification required');
  for (const id of ['localReleaseGate', 'ci', 'audioOwnershipVersionRange', 'audioFailureCancellation', 'opusTextBridge', 'videoWireRegression']) {
    if (receipt.verification?.[id]?.status !== 'passed' || !bound(receipt.verification[id])) fail(`current ${id} evidence required`);
  }
  const packages = receipt.packages;
  if (!packages || !exact(packages.platforms, ['darwin-arm64', 'darwin-amd64', 'windows-amd64', 'linux-amd64'])
    || packages.sourceDigest !== sourceDigest || !evidence(packages.workflowEvidence)
    || !['windowsReleasedUpgradeAndRollbackBeforeUpload', 'finalArchiveSmokeBeforeUpload', 'linuxNativeWindowBeforeUpload', 'signedManifestBeforePublish', 'publicReadbackAfterPublish'].every(k => packages[k] === true)
    || typeof receipt.releasePublished !== 'boolean') fail('current final archive, upgrade/rollback, signing and public-readback gates required');
  if (!receipt.releasePublished) {
    if (packages.status !== 'pending_release_workflow' || packages.archives != null || receipt.releaseComplete !== false) fail('preflight cannot claim published packages');
  } else {
    if (packages.status !== 'verified' || !Array.isArray(packages.archives) || !exact(packages.archives.map(x => x.platform), packages.platforms)
      || packages.archives.some(x => !hash(x.sha256) || !bound(x)) || receipt.releaseComplete !== true) fail('published release requires actual current-source final archives');
    for (const id of ['signature', 'publicReadback', 'windowsReleasedUpgradeAndRollback', 'finalArchiveSmoke', 'linuxNativeWindow']) {
      if (packages[id]?.status !== 'passed' || !bound(packages[id])) fail(`published release requires current ${id}`);
    }
  }
  return deferred ? { retainedCases: 12, retainedChecks: reused.length, retainedProductChecks: 4, postReleaseChecks: 7, pendingBills: attempts.filter(x => x.billing === 'pending').length }
    : { retainedCases: 12, retainedChecks: reused.length, currentChecks: 23 - reused.length };
}

// One owner-authorized release ordering exception. It records missing tests,
// never promotes historical execution to current-source acceptance.
export function validateDeferredV1713(receipt, sourceDigest) {
  const fail = message => { throw new Error(`v1.7.13 deferred acceptance: ${message}`); };
  const nonempty = value => typeof value === 'string' && value.trim() !== '';
  const hash = value => /^[a-f0-9]{64}$/.test(value || '');
  const evidence = value => Array.isArray(value) && value.length > 0 && value.every(nonempty);
  const bound = value => value?.sourceDigest === sourceDigest && evidence(value.evidence);
  const exactSet = (actual, expected) => Array.isArray(actual) && actual.length === new Set(actual).size && JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
  const owner = receipt.ownerException;
  if (receipt.version !== 'v1.7.13' || receipt.contractVersion !== 3 || receipt.sourceDigest !== sourceDigest
    || owner?.scope !== 'release-before-remaining-acceptance-20261008' || owner.approvedBy !== 'Ender'
    || owner.instruction !== '提高到100元 你可以先上线 补测剩下的' || !evidence(owner.evidence)
    || receipt.liveTestWaiver || receipt.financialEvidenceException || receipt.financialUncertainty?.status === 'unresolved') fail('exact version and owner authorization required');
  if (receipt.budgetCNY !== 100 || receipt.historicalSpentCNY !== 42.413106
    || !Number.isFinite(receipt.spentCNY) || receipt.spentCNY < receipt.historicalSpentCNY || receipt.spentCNY > 100
    || !Number.isFinite(receipt.newSpentCNY) || Math.abs(receipt.newSpentCNY - (receipt.spentCNY - receipt.historicalSpentCNY)) > 0.000001
    || receipt.pendingCNY !== 0 || receipt.knownPendingCNY !== 0) fail('all historical and new costs must fit total CNY100 with no pending');
  const attempts = receipt.billingAttempts;
  if (!Array.isArray(attempts) || !attempts.length) fail('all billing attempts required');
  const ids = new Set(); let total = 0, historical = 0;
  for (const item of attempts) {
    const sourceValid = item.phase === 'current'
      ? item.executedSourceDigest === sourceDigest
        || (item.kind === 'other' && item.executedSourceDigest === null && item.executionSourceStatus === 'not_app_execution' && item.reviewedSourceDigest === sourceDigest)
      : item.phase === 'superseded_candidate'
        ? item.executionSourceStatus === 'known' && hash(item.executedSourceDigest) && item.executedSourceDigest !== sourceDigest
      : (hash(item.executedSourceDigest) && item.executedSourceDigest !== sourceDigest)
        || (item.executedSourceDigest === null && ['unknown', 'not_app_execution'].includes(item.executionSourceStatus));
    if (!nonempty(item.id) || ids.has(item.id) || !['media', 'chat', 'other'].includes(item.kind)
      || !['settled', 'refunded'].includes(item.billing) || !['historical', 'current', 'superseded_candidate'].includes(item.phase)
      || !sourceValid || !evidence(item.evidence) || !Number.isFinite(item.costCNY) || item.costCNY < 0) fail('invalid, unresolved or relabeled billing attempt');
    ids.add(item.id); total += item.costCNY;
    if (item.phase === 'historical') historical += item.costCNY;
  }
  if (!attempts.some(item => item.kind === 'chat') || Math.abs(total - receipt.spentCNY) > 0.000001 || Math.abs(historical - 42.413106) > 0.000001) fail('billing ledger must reconcile including historical baseline and chat');
  if (receipt.review?.result !== 'approved' || receipt.review.independent !== true || !nonempty(receipt.review.reviewer) || !bound(receipt.review)
    || receipt.upgrade?.preservedData !== true || !bound(receipt.upgrade)) fail('current independent review and data preservation required');
  for (const id of ['localReleaseGate', 'ci']) {
    if (receipt.verification?.[id]?.status !== 'passed' || !bound(receipt.verification[id])) fail(`current ${id} evidence required`);
  }
  const scenario = receipt.scenario;
  const inspected = inspectFixtureManifest(scenario?.fixtures, 3);
  if (!inspected.ok || !nonempty(scenario?.id) || !nonempty(scenario.title) || !/^https?:\/\/\S+$/.test(scenario.source || '') || !/^\d{4}-\d{2}-\d{2}$/.test(scenario.queryDate || '')) fail('explicit scenario and native audio/video fixture manifest required');
  const caseKeys = [1, 2].flatMap(round => ['text-image', 'image-image', 'image-video', 'text-video', 'video-video', 'multi-video'].map(path => `${round}/${path}`));
  const accepted = new Set(), tasks = new Set();
  if (!Array.isArray(receipt.cases)) fail('current cases must be an array, even when empty');
  for (const item of receipt.cases) {
    const key = `${item.round}/${item.path}`;
    if (!caseKeys.includes(key) || accepted.has(key) || !nonempty(item.taskId) || tasks.has(item.taskId)
      || item.executedSourceDigest !== sourceDigest || item.fixtureDigest !== inspected.digest || item.clientVersion !== 'v1.7.13'
      || item.status !== 'succeeded' || item.billing !== 'settled' || item.entrypoint !== 'assistant' || item.confirmed !== true
      || !['sessionId', 'turnId', 'proposalId', 'operationId', 'providerRequestId', 'platform', 'model'].every(field => nonempty(item[field]))
      || !['clientSubmitted', 'canvasVerified', 'mediaDecoded', 'mediaOpened'].every(field => item[field] === true)
      || !hash(item.artifactSHA256) || !evidence(item.evidence) || !Number.isFinite(item.costCNY) || item.costCNY < 0) fail('invalid or historical current-source media case');
    const billed = attempts.filter(attempt => attempt.phase === 'current' && attempt.kind === 'media' && attempt.taskId === item.taskId);
    if (billed.length !== 1 || billed[0].billing !== 'settled' || Math.abs(billed[0].costCNY - item.costCNY) > 0.000001) fail('current case requires exact settled task bill');
    accepted.add(key); tasks.add(item.taskId);
  }
  const required = releaseAgentChecks('v1.7.13'), pendingChecks = [], checks = receipt.agentChecks;
  if (!checks || typeof checks !== 'object' || Array.isArray(checks) || !exactSet(Object.keys(checks), required)) fail('all 23 checks must be explicitly recorded');
  for (const id of required) {
    const check = checks[id];
    if (check?.status === 'pending_after_release') { pendingChecks.push(id); continue; }
    if (check?.status !== 'passed' || !bound(check) || !['native', 'deterministic'].includes(check.method)
      || (check.method === 'deterministic' && !releaseDeterministicChecks('v1.7.13').includes(id))) fail(`invalid or historical passed check: ${id}`);
  }
  const deferred = receipt.deferredAcceptance;
  const missing = caseKeys.filter(key => !accepted.has(key));
  if (!['pending_after_release', 'completed_after_release'].includes(deferred?.status)
    || !exactSet(deferred.caseKeys, missing) || !exactSet(deferred.agentCheckIds, pendingChecks)
    || typeof receipt.releasePublished !== 'boolean') fail('all remaining tests must be explicitly recorded');
  const complete = deferred.status === 'completed_after_release';
  if (complete) {
    if (missing.length || pendingChecks.length || receipt.releasePublished !== true || receipt.acceptanceComplete !== true || receipt.releaseComplete !== true
      || receipt.liveMatrixStatus !== 'passed' || receipt.agentAcceptanceStatus !== 'passed') fail('completion requires published release and all current 12/23 acceptance');
  } else if ((!missing.length && !pendingChecks.length) || receipt.liveMatrixStatus !== 'pending_after_release' || receipt.agentAcceptanceStatus !== 'pending_after_release'
    || receipt.acceptanceComplete !== false || receipt.releaseComplete !== false) fail('pending tests must never be labeled complete');
  const history = deferred.historicalEvidence;
  if (!Array.isArray(history) || !history.length || !history.some(item => item.kind === 'media_matrix') || !history.some(item => item.kind === 'agent_checks')
    || history.some(item => !['media_matrix', 'agent_checks', 'native_film', 'targeted_native'].includes(item.kind) || !hash(item.sourceDigest) || item.sourceDigest === sourceDigest || !evidence(item.evidence))) fail('original historical source evidence required without relabeling');
  const packages = receipt.packages;
  if (!packages || !exactSet(packages.platforms, ['darwin-arm64', 'darwin-amd64', 'windows-amd64'])
    || !['windowsReleasedUpgradeAndRollbackBeforeUpload', 'finalArchiveSmokeBeforeUpload', 'signedManifestBeforePublish', 'publicReadbackAfterPublish'].every(field => packages[field] === true)
    || !evidence(packages.workflowEvidence)) fail('all final platform, signature, archive, Windows upgrade/rollback and public readback gates remain mandatory');
  if (!receipt.releasePublished) {
    if (packages.status !== 'pending_release_workflow' || packages.archives != null) fail('unpublished preflight must not invent final archives');
  } else {
    if (packages.status !== 'verified' || !Array.isArray(packages.archives) || packages.archives.length !== 3
      || !exactSet(packages.archives.map(item => item.platform), packages.platforms)
      || packages.archives.some(item => !hash(item.sha256) || !bound(item))) fail('published release requires actual source-bound final archives');
    for (const id of ['signature', 'publicReadback', 'windowsReleasedUpgradeAndRollback', 'finalArchiveSmoke']) {
      if (packages[id]?.status !== 'passed' || !bound(packages[id])) fail(`published release requires actual ${id} evidence`);
    }
  }
  return { pendingCases: missing.length, pendingChecks: pendingChecks.length, complete };
}
