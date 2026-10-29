import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { validateTeamRelease } from './team-release-contract.mjs';
import {
  THEME_AGENT_CONTRACT_VERSION,
  THEME_AGENT_SINCE,
  REQUIRED_AGENT_CHECK_IDS,
  DETERMINISTIC_FAULT_CHECK_IDS,
  fixtureDigestFromManifest,
  inspectFixtureManifest,
  requiresThemeAgentContract,
  findCopiedPriorTheme,
  releaseContractVersion,
  DURABLE_AGENT_CHECK_IDS,
  validateTargetedV200,
  targetedV200SourceProof,
} from './real-generation-release-contract.mjs';

const PATHS = ['text-image', 'image-image', 'image-video', 'text-video', 'video-video', 'multi-video'];
const BUNNY_FIXTURES = {
  'image-1.jpg': '93701f45cf50d48de5ba452cd26eeafeba40a2fceef2e50fb98940ccb919250f',
  'image-2.jpg': '5946874132e3e82d7c1ed74db2a97e39b08f58ba7dc3fa9129adffcdd714af84',
  'reference.mp4': '282ef9563a8dbad86470368bef7afa9fcfd1df7791cf38f4f5e803c9d535da60',
};

function copyGate(dir) {
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'docs/release-evidence'), { recursive: true });
  for (const name of ['verify-real-generation-release.mjs', 'real-generation-release-contract.mjs', 'h3-family-release-contract.mjs', 'video-direct-delivery-release-contract.mjs', 'team-release-contract.mjs', 'image-preparation-release-contract.mjs', 'music3-release-contract.mjs']) {
    writeFileSync(join(dir, 'scripts', name), readFileSync(new URL(`./${name}`, import.meta.url)));
  }
}

function setupRepo(version) {
  const dir = mkdtempSync(join(tmpdir(), 'beeftv-receipt-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init');
  copyGate(dir);
  writeFileSync(join(dir, 'VERSION'), `${version}\n`);
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'candidate');
  const run = (...args) => execFileSync(process.execPath, ['scripts/verify-real-generation-release.mjs', ...args], { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
  const save = (value, name = version) => writeFileSync(join(dir, `docs/release-evidence/${name}.json`), JSON.stringify(value));
  const commitVersion = next => {
    writeFileSync(join(dir, 'VERSION'), `${next}\n`);
    git('add', 'VERSION');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', next);
  };
  return { dir, git, run, save, commitVersion };
}

// These receipts are synthetic cash/acceptance fixtures; they never write the
// real release receipt or claim that an unresolved supplier bill is free.
const originalV200Bytes = readFileSync(new URL('../docs/release-evidence/v2.0.0-original-execution.json', import.meta.url));
const originalV200 = JSON.parse(originalV200Bytes);
const audioV200Paths = ['agent-host/media-content.mjs', 'agent-host/operation-descriptors.fixture.json', 'agent-host/operation-policy.test.mjs',
  'backend/internal/app/operations_media_review.go', 'backend/internal/app/operations_media_review_audio_test.go', 'backend/internal/operations/media_review.go',
  'scripts/real-generation-release-contract.mjs', 'scripts/verify-real-generation-release.mjs', 'scripts/verify-real-generation-release.test.mjs'];
function makeTargetedV200() {
  const sourceDigest = 'c'.repeat(64), proof = ['synthetic current-source fixture; not real acceptance'];
  const bound = { sourceDigest, evidence: proof };
  const passed = { status: 'passed', method: 'native', ...bound };
  const review = { result: 'approved', independent: true, reviewer: 'synthetic independent reviewer', ...bound };
  const cases = structuredClone(originalV200.originalCases);
  const holdFor = item => item.path.endsWith('image')
    ? (item.round === 2 ? 'round2-image-batch-approval' : `round1-${item.path === 'text-image' ? 't2i' : 'i2i'}-approval`)
    : `round${item.round}-video-batch-approval`;
  const billingAttempts = [];
  for (const hold of originalV200.originalBillingHolds) {
    const base = { originalHoldId: hold.id, originalHold: structuredClone(hold), billing: 'settled',
      settlementEvidenceSHA256: 'd'.repeat(64), evidence: ['synthetic final bill; not a real settlement'] };
    if (hold.kind === 'media') {
      for (const item of cases.filter(x => holdFor(x) === hold.id)) billingAttempts.push({ ...base, id: item.taskId,
        kind: 'media', taskId: item.taskId, requestId: item.gatewayRequestId, costCNY: item.costCNY,
        executedSourceDigest: originalV200.sourceDigest, executionSourceStatus: 'known_original' });
    } else billingAttempts.push({ ...base, id: hold.id, kind: hold.kind, requestId: hold.requestId,
      costCNY: hold.settledCNY ?? 0, executedSourceDigest: null, executionSourceStatus: 'unknown_historical' });
  }
  billingAttempts.push({ id: 'synthetic-external-final-bill', kind: 'other', externalReviewJob: originalV200.externalReviewCostUncertainty.job,
    executedSourceDigest: null, executionSourceStatus: 'unknown_historical', billing: 'settled', costCNY: 0,
    settlementEvidenceSHA256: 'd'.repeat(64), evidence: ['synthetic only; actual Grok bill still separate'] });
  return { version: 'v2.0.0', contractVersion: 3, sourceDigest,
    ownerException: { scope: 'v2.0.0-wand-audio-targeted-retest-20261021', approvedBy: 'Ender', instruction: originalV200.ownerAuthorization.answer,
      authorizationSHA256: 'eab11b7c3df4187d46a6aaaaa1c11759cd6bcdbee5d304f476fef06eab546758', ...bound },
    originalExecutionSHA256: createHash('sha256').update(originalV200Bytes).digest('hex'), originalExecutionSourceDigest: originalV200.sourceDigest,
    budgetCNY: 50, spentCNY: Number(billingAttempts.reduce((s,x) => s+x.costCNY,0).toFixed(6)), pendingCNY: 0,
    cases, billingAttempts, scenario: structuredClone(originalV200.originalScenario),
    liveMatrixStatus: 'retained_original_execution', agentAcceptanceStatus: 'passed_with_retained_original_checks',
    agentChecks: { ...Object.fromEntries([...REQUIRED_AGENT_CHECK_IDS,...DURABLE_AGENT_CHECK_IDS].map(id => [id, structuredClone(passed)])),
      ...structuredClone(originalV200.retainedAgentChecks) },
    impactReview: { ...review, changedSourcePaths: audioV200Paths, retainedCheckIds: Object.keys(originalV200.retainedAgentChecks) },
    review, upgrade: { preservedData: true, generationVerified: true, ...bound },
    verification: Object.fromEntries(['localReleaseGate','ci','audioOwnershipVersionRange','audioFailureCancellation','opusTextBridge','videoWireRegression'].map(id => [id,structuredClone(passed)])),
    packages: { sourceDigest, platforms: ['darwin-arm64','darwin-amd64','windows-amd64','linux-amd64'], status: 'pending_release_workflow', archives: null,
      windowsReleasedUpgradeAndRollbackBeforeUpload: true, finalArchiveSmokeBeforeUpload: true, linuxNativeWindowBeforeUpload: true,
      signedManifestBeforePublish: true, publicReadbackAfterPublish: true, workflowEvidence: ['.github/workflows/release-desktop.yml'] },
    releasePublished: false, releaseComplete: false };
}
const syntheticV200Proof = { unchangedSourceDigest: originalV200.originalSourceProof.unchangedSourceDigest,
  allowedEntries: Object.fromEntries(audioV200Paths.map(path => [path, `100644 blob ${'e'.repeat(40)}`])) };
const validateV200 = (receipt, proofs = {}) => validateTargetedV200(receipt, 'c'.repeat(64), { originalBytes: originalV200Bytes, sourceProof: syntheticV200Proof, ...proofs });

test('v2.0.0 exact targeted authorization retains 12 original cases and 12 checks, but requires 11 current checks', () => {
  const valid = makeTargetedV200();
  assert.deepEqual(validateV200(valid), { retainedCases: 12, retainedChecks: 12, currentChecks: 11 });
  assert.equal(valid.billingAttempts.filter(x => x.executionSourceStatus === 'unknown_historical').length,116);
  const current = structuredClone(valid);
  current.agentChecks.cancel = { status: 'passed', method: 'native', sourceDigest: current.sourceDigest, evidence: ['synthetic new actual cancellation'] };
  current.impactReview.retainedCheckIds = current.impactReview.retainedCheckIds.filter(x => x !== 'cancel');
  assert.equal(validateV200(current).currentChecks,12);
});

test('v2.0.0 targeted acceptance rejects relabeling, expanded scope, incomplete cash and missing current evidence', async t => {
  const mutations = {
    'later version': r => { r.version = 'v2.0.1'; },
    'wrong exact approval': r => { r.ownerException.instruction = '发布吧'; },
    'changed approval hash': r => { r.ownerException.authorizationSHA256 = 'a'.repeat(64); },
    'different original source': r => { r.originalExecutionSourceDigest = r.sourceDigest; },
    'original baseline rewrite': r => { r.originalExecutionSHA256 = 'a'.repeat(64); },
    'matrix claimed current': r => { r.liveMatrixStatus = 'passed'; },
    'case source relabeled': r => { r.cases[0].executedSourceDigest = r.sourceDigest; },
    'case task replaced': r => { r.cases[0].taskId = 'new-task'; },
    'case request replaced': r => { r.cases[0].gatewayRequestId = 'different-request'; },
    'case evidence changed': r => { r.cases[0].evidence = ['different']; },
    'frozen failed continuation hidden': r => { r.cases[0].autoDeliveryPassed = true; },
    'case omitted': r => { r.cases.pop(); },
    'old native audio': r => { r.agentChecks.native_audio.sourceDigest = originalV200.sourceDigest; },
    'fixture native audio': r => { r.agentChecks.native_audio.method = 'deterministic'; },
    'video pending': r => { r.agentChecks.native_video.status = 'pending'; },
    'film review missing': r => { delete r.agentChecks.media_film_review; },
    'old passed check resigned': r => { r.agentChecks.cancel.sourceDigest = r.sourceDigest; r.impactReview.retainedCheckIds = r.impactReview.retainedCheckIds.filter(x=>x!=='cancel'); },
    'retained check evidence rewritten': r => { r.agentChecks.cancel.evidence = ['new']; },
    'impact review hides retained check': r => { r.impactReview.retainedCheckIds.pop(); },
    'remaining assistant check pending': r => { r.agentChecks.canvas_mutation.status = 'pending'; },
    'unsettled final bill': r => { r.billingAttempts[0].billing = 'pending'; },
    'pending total hidden': r => { r.pendingCNY = 1; },
    'old source fabricated': r => { r.billingAttempts[0].executedSourceDigest = r.sourceDigest; },
    'old request changed': r => { r.billingAttempts[0].requestId = 'different'; },
    'original hold rewritten': r => { r.billingAttempts[0].originalHold.at = 'different'; },
    'old failed attempt omitted': r => { const x=r.billingAttempts.findIndex(x=>x.kind==='chat' && x.costCNY===0); assert.ok(x>=0);r.billingAttempts.splice(x,1); },
    'old known fee changed': r => { r.billingAttempts[0].costCNY=0;r.spentCNY=37.415623; },
    'external unknown omitted': r => { r.billingAttempts.pop(); },
    'over original 50': r => { r.budgetCNY = 51; },
    'old review': r => { r.review.sourceDigest=originalV200.sourceDigest; },
    'old upgrade': r => { r.upgrade.sourceDigest=originalV200.sourceDigest; },
    'audio cancellation regression missing': r => { delete r.verification.audioFailureCancellation; },
    'old package source': r => { r.packages.sourceDigest=originalV200.sourceDigest; },
    'Windows rollback waived': r => { r.packages.windowsReleasedUpgradeAndRollbackBeforeUpload=false; },
    'preflight claims completed publish': r => { r.releaseComplete=true; },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, () => {
    const invalid=makeTargetedV200();mutate(invalid);assert.throws(()=>validateV200(invalid));
  });
  assert.throws(()=>validateV200(makeTargetedV200(),{originalBytes:Buffer.from('{}')}),/original execution evidence changed/);
  assert.throws(()=>validateV200(makeTargetedV200(),{sourceProof:{...syntheticV200Proof,unchangedSourceDigest:'a'.repeat(64)}}),/source changes/);
  const missing=structuredClone(syntheticV200Proof);delete missing.allowedEntries[audioV200Paths[0]];
  assert.throws(()=>validateV200(makeTargetedV200(),{sourceProof:missing}),/source changes/);
  const unmodified=structuredClone(syntheticV200Proof);unmodified.allowedEntries[audioV200Paths[0]]=originalV200.originalSourceProof.allowedEntries[audioV200Paths[0]];
  assert.throws(()=>validateV200(makeTargetedV200(),{sourceProof:unmodified}),/source changes/);
});

test('v2.0.0 source proof works with current HEAD alone and detects unrelated source changes', () => {
  const {dir,git}=setupRepo('v2.0.0');
  try {
    assert.throws(()=>git('cat-file','-e','3d080c9a470e62372676af4cf7cb4c1a43850fdb'));
    const tree=()=>git('ls-tree','-r','HEAD','--','scripts','VERSION').toString();
    const before=targetedV200SourceProof(tree());
    writeFileSync(join(dir,'scripts/verify-real-generation-release.mjs'),'synthetic allowed change\n');
    git('add','.');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','allowed');
    const after=targetedV200SourceProof(tree());
    assert.equal(after.unchangedSourceDigest,before.unchangedSourceDigest);
    assert.notEqual(after.allowedEntries['scripts/verify-real-generation-release.mjs'],before.allowedEntries['scripts/verify-real-generation-release.mjs']);
    writeFileSync(join(dir,'scripts/unrelated.mjs'),'synthetic unrelated change\n');
    git('add','.');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','unrelated');
    assert.notEqual(targetedV200SourceProof(tree()).unchangedSourceDigest,after.unchangedSourceDigest);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('v2.0.0 new app/direct costs retain actual provenance and cannot repeat the media matrix', () => {
  const value=makeTargetedV200();
  const item={id:'synthetic-new-chat',kind:'chat',billing:'settled',costCNY:0.01,executedSourceDigest:value.sourceDigest,executionSourceStatus:'current',settlementEvidenceSHA256:'e'.repeat(64),evidence:['synthetic new bill']};
  value.billingAttempts.push(item);value.spentCNY=Number((value.spentCNY+0.01).toFixed(6));validateV200(value);
  item.executionSourceStatus='not_app_execution';item.executedSourceDigest=null;assert.throws(()=>validateV200(value));
  item.executorSHA256='f'.repeat(64);validateV200(value);
  item.kind='media';assert.throws(()=>validateV200(value));
  item.kind='chat';item.executionSourceStatus='superseded_candidate';item.executedSourceDigest=originalV200.sourceDigest;
  assert.throws(()=>validateV200(value));
  item.acceptanceCredit=false;item.executionSourceEvidenceSHA256='e'.repeat(64);validateV200(value);
  item.acceptanceCredit=true;assert.throws(()=>validateV200(value));
  item.acceptanceCredit=false;item.executedSourceDigest='a'.repeat(64);assert.throws(()=>validateV200(value));
});

test('v2.0.0 published package receipts require actual source-bound archives, upgrade/rollback and readback', () => {
  const value=makeTargetedV200();value.releasePublished=true;value.releaseComplete=true;value.packages.status='verified';
  value.packages.archives=value.packages.platforms.map(platform=>({platform,sha256:'e'.repeat(64),sourceDigest:value.sourceDigest,evidence:['synthetic final archive']}));
  for(const id of ['signature','publicReadback','windowsReleasedUpgradeAndRollback','finalArchiveSmoke','linuxNativeWindow']) value.packages[id]={status:'passed',sourceDigest:value.sourceDigest,evidence:['synthetic package verification']};
  validateV200(value);
  for(const mutate of [r=>r.packages.archives.pop(),r=>r.packages.archives[0].sourceDigest=originalV200.sourceDigest,r=>r.packages.windowsReleasedUpgradeAndRollback.status='pending',r=>r.packages.publicReadback.sourceDigest=originalV200.sourceDigest]) {
    const invalid=structuredClone(value);mutate(invalid);assert.throws(()=>validateV200(invalid));
  }
});

const postchecksV200Bytes = readFileSync(new URL('../docs/release-evidence/v2.0.0-owner-postchecks-snapshot.json', import.meta.url));
const postchecksV200 = JSON.parse(postchecksV200Bytes);
function makePostchecksV200() {
  const value = makeTargetedV200();
  value.ownerException = { ...value.ownerException, scope: 'v2.0.0-owner-release-with-postchecks-20261021', ...postchecksV200.ownerAuthorization };
  value.postchecksSnapshotSHA256 = createHash('sha256').update(postchecksV200Bytes).digest('hex');
  value.additionalPaidTestsStopped = true;
  value.acceptanceComplete = false;
  value.throughLedger = structuredClone(postchecksV200.throughLedger);
  value.agentAcceptanceStatus = 'incomplete_owner_deferred';
  value.agentChecks = structuredClone(postchecksV200.agentChecks);
  value.postReleaseChecks = structuredClone(postchecksV200.postReleaseChecks);
  value.billingAttempts.pop();
  for (const item of value.billingAttempts.filter(x => x.originalHold?.settledCNY === null)) {
    item.billing = 'pending'; item.costCNY = null; item.settlementEvidenceSHA256 = null;
    item.heldCNY = Number(item.originalHold.amount) / 1000000;
  }
  value.billingAttempts.push(...structuredClone(postchecksV200.additionalBillingAttempts), structuredClone(postchecksV200.externalCash));
  refreshPostchecksCash(value);
  return value;
}
function refreshPostchecksCash(value) {
  value.spentCNY = Number(value.billingAttempts.reduce((s,x) => s+(x.costCNY ?? 0),0).toFixed(6));
  const pending = value.billingAttempts.filter(x => x.billing === 'pending');
  value.pendingCNY = Number(pending.reduce((s,x) => s+x.heldCNY,0).toFixed(6));
  value.postReleaseBilling = pending.map(x => ({ id: x.id, requestId: x.requestId, heldCNY: x.heldCNY, costCNY: null,
    status: 'pending', owner: 'Ender', nextAction: 'Read final supplier bill; preserve unknown until verified.', evidence: x.evidence }));
}
const postchecksV200Proof = { ...syntheticV200Proof, unchangedProductSourceDigest: postchecksV200.unchangedProductSourceDigest };
const validatePostchecksV200 = (value, options = {}) => validateV200(value, { postchecksBytes: postchecksV200Bytes, sourceProof: postchecksV200Proof, ...options });

test('v2.0.0 owner postchecks preserves exact 16/3/4, original 120 plus 33 costs and six full pending holds', () => {
  const value = makePostchecksV200();
  assert.deepEqual(validatePostchecksV200(value), { retainedCases: 12, retainedChecks: 12, retainedProductChecks: 4, postReleaseChecks: 7, pendingBills: 6 });
  assert.equal(value.spentCNY,42.796765); assert.equal(value.pendingCNY,3.506822);
  assert.equal(value.billingAttempts.length,161);
  assert.equal(value.agentChecks.native_audio.status,'failed');
  assert.equal(value.agentChecks.native_audio.earlierPass.status,'passed');
  assert.equal(value.agentChecks.native_audio.earlierPass.sourceDigest,postchecksV200.executedSourceDigest);
  assert.equal(value.billingAttempts.filter(x=>x.executionSourceStatus==='unknown_historical').length,116);
  assert.equal(value.agentChecks.session_history.sourceDigest,null);
});

test('v2.0.0 owner postchecks rejects concealed failures, costs, authorization or final-source gates', async t => {
  const mutations = {
    'future version': r=>{r.version='v2.0.1';},
    'generic skip scope': r=>{r.ownerException.scope='release-with-postchecks';},
    'different owner quote': r=>{r.ownerException.instruction='直接发布吧';},
    'old owner only': r=>{r.ownerException.authorizationSHA256=r.ownerException.previousAuthorizationSHA256;},
    'snapshot changed': r=>{r.postchecksSnapshotSHA256='a'.repeat(64);},
    'live ledger cutoff relabeled': r=>{r.throughLedger.prefixBytes++;},
    'additional paid calls allowed': r=>{r.additionalPaidTestsStopped=false;},
    'acceptance complete': r=>{r.acceptanceComplete=true;},
    'checks all claimed passed': r=>{r.agentAcceptanceStatus='passed_with_retained_original_checks';},
    'real audio failure hidden': r=>{r.agentChecks.native_audio.status='passed';},
    'earlier audio pass deleted': r=>{delete r.agentChecks.native_audio.earlierPass;},
    'video failure changed to pending': r=>{r.agentChecks.native_video.status='pending';},
    'pending source invented': r=>{r.agentChecks.skill_files.sourceDigest=r.sourceDigest;},
    '667 pass resigned': r=>{r.agentChecks.canvas_read.sourceDigest=r.sourceDigest;},
    'old 3d check resigned': r=>{r.agentChecks.cancel.sourceDigest=r.sourceDigest;},
    'postcheck omitted': r=>{r.postReleaseChecks.pop();},
    'postcheck marked passed': r=>{r.postReleaseChecks[0].status='passed';},
    'postcheck reason hidden': r=>{r.postReleaseChecks[0].reason='';},
    'original task omitted': r=>{r.cases.pop();},
    'original task resigned': r=>{r.cases[0].executedSourceDigest=r.sourceDigest;},
    'original failed cost omitted': r=>{r.billingAttempts.splice(r.billingAttempts.findIndex(x=>x.originalHoldId&&x.costCNY===0),1);refreshPostchecksCash(r);},
    'new settled cost omitted': r=>{r.billingAttempts.splice(r.billingAttempts.findIndex(x=>!x.originalHoldId&&x.costCNY>0),1);refreshPostchecksCash(r);},
    'new pending cost omitted': r=>{r.billingAttempts.splice(r.billingAttempts.findIndex(x=>!x.originalHoldId&&x.billing==='pending'),1);refreshPostchecksCash(r);},
    'new settled amount altered': r=>{r.billingAttempts.find(x=>!x.originalHoldId&&x.costCNY>0).costCNY=0;refreshPostchecksCash(r);},
    'new source resigned': r=>{r.billingAttempts.find(x=>x.executionSourceStatus==='current').executedSourceDigest=r.sourceDigest;},
    'direct executor invented': r=>{r.billingAttempts.find(x=>x.executionSourceStatus==='not_app_execution').executorSHA256='a'.repeat(64);},
    'new unknown cost outside frozen index': r=>{r.billingAttempts.push({...r.billingAttempts.at(-2),id:'extra'});refreshPostchecksCash(r);},
    'pending reported zero cash': r=>{r.billingAttempts.find(x=>x.billing==='pending').costCNY=0;},
    'pending hold reduced': r=>{r.billingAttempts.find(x=>x.billing==='pending').heldCNY=0.01;refreshPostchecksCash(r);},
    'pending marked settled without bill': r=>{const x=r.billingAttempts.find(x=>x.billing==='pending');x.billing='settled';x.costCNY=0;refreshPostchecksCash(r);},
    'settled changed to pending': r=>{const x=r.billingAttempts.find(x=>x.costCNY>0);x.billing='pending';x.costCNY=null;x.settlementEvidenceSHA256=null;refreshPostchecksCash(r);},
    'postrelease bill omitted': r=>{r.postReleaseBilling.pop();},
    'postrelease bill has no owner': r=>{r.postReleaseBilling[0].owner='';},
    'pending total hidden': r=>{r.pendingCNY=0;},
    'budget raised': r=>{r.budgetCNY=51;},
    'current review resigned old': r=>{r.review.sourceDigest=postchecksV200.executedSourceDigest;},
    'CI skipped': r=>{r.verification.ci.status='pending';},
    'upgrade removed': r=>{delete r.upgrade;},
    'four platform dropped': r=>{r.packages.platforms.pop();},
    'rollback waived': r=>{r.packages.windowsReleasedUpgradeAndRollbackBeforeUpload=false;},
    'signature waived': r=>{r.packages.signedManifestBeforePublish=false;},
    'public readback waived': r=>{r.packages.publicReadbackAfterPublish=false;},
    'published without archives': r=>{r.releasePublished=true;r.releaseComplete=true;},
  };
  for(const [name,mutate] of Object.entries(mutations)) await t.test(name,()=>{
    const invalid=makePostchecksV200();mutate(invalid);assert.throws(()=>validatePostchecksV200(invalid));
  });
  assert.throws(()=>validatePostchecksV200(makePostchecksV200(),{postchecksBytes:Buffer.from('{}')}),/frozen postchecks/);
  assert.throws(()=>validatePostchecksV200(makePostchecksV200(),{sourceProof:{...postchecksV200Proof,unchangedProductSourceDigest:'a'.repeat(64)}}),/unchanged product/);
});

test('v2.0.0 pending billing may become final only with final cash evidence, original hold retained and cap enforced', () => {
  const value=makePostchecksV200();
  const item=value.billingAttempts.find(x=>!x.originalHoldId&&x.billing==='pending');
  const original=structuredClone(item);
  item.billing='settled';item.costCNY=0.1;item.settlementEvidenceSHA256='d'.repeat(64);refreshPostchecksCash(value);
  assert.equal(validatePostchecksV200(value).pendingBills,5);
  assert.equal(item.heldCNY,original.heldCNY);assert.equal(item.requestId,original.requestId);
  item.costCNY=10;refreshPostchecksCash(value);assert.throws(()=>validatePostchecksV200(value),/CNY 50/);
  item.costCNY=-1;refreshPostchecksCash(value);assert.throws(()=>validatePostchecksV200(value));
});

test('v2.0.0 postchecks product proof excludes only the three acceptance scripts and needs no old git objects', () => {
  const {dir,git}=setupRepo('v2.0.0');
  try {
    assert.throws(()=>git('cat-file','-e',postchecksV200.executedCommit));
    const tree=()=>git('ls-tree','-r','HEAD','--','scripts','VERSION','backend').toString();
    const before=targetedV200SourceProof(tree());
    writeFileSync(join(dir,'scripts/verify-real-generation-release.mjs'),'synthetic acceptance only\n');
    git('add','.');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','acceptance');
    assert.equal(targetedV200SourceProof(tree()).unchangedProductSourceDigest,before.unchangedProductSourceDigest);
    mkdirSync(join(dir,'backend/internal/app'),{recursive:true});
    writeFileSync(join(dir,'backend/internal/app/operations_media_review.go'),'synthetic product change\n');
    git('add','.');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','product');
    assert.notEqual(targetedV200SourceProof(tree()).unchangedProductSourceDigest,before.unchangedProductSourceDigest);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('v1.7.25 defers #176 and keeps source-bound checks, financial uncertainty and package gates', () => {
  const { dir, run, save, commitVersion } = setupRepo('v1.7.25');
  try {
    const sourceDigest = run('--fingerprint').trim();
    const evidence = ['synthetic gate fixture; not live acceptance'];
    const bound = { sourceDigest, evidence };
    const passed = method => ({ status: 'passed', method, ...bound });
    const value = {
      version: 'v1.7.25', sourceDigest,
      ownerException: { scope: 'team-targeted-defer-skills-20261017', approvedBy: 'Ender', instruction: '本版豁免重跑付费矩阵，专项验收后发布（推荐）', ...bound },
      releaseAuthorization: { additionalHumanReplyRequired: false, scope: 'v1.7.25 only', ...bound },
      baseRelease: 'v1.7.24', baseCommit: '2fe2311198f82ad8904a5d4c5dcbed7fbd7c8dd2',
      includedPullRequests: [160, 161, 162, 163, 167, 168, 169, 171, 172, 174, 175, 177, 178, 179],
      deferredPullRequests: [176], revertedCommit: 'e2e278a7e71f9f4d25ae02b5b51b6ea2e6f6cf57',
      paidSubmissionLimit: 0, newBudgetCNY: 0, newSpentCNY: 0, newPendingCNY: 0,
      cases: [], billingAttempts: [], budgetCNY: null, spentCNY: null, pendingCNY: null,
      liveMatrixStatus: 'not_run_owner_waived', agentAcceptanceStatus: 'not_run_owner_waived', acceptanceComplete: false,
      priorFinancialUncertainty: { status: 'unresolved', carriedFromVersion: 'v1.7.24', pendingCNY: null, evidence: ['docs/release-evidence/v1.7.24.json'] },
      review: { result: 'approved', independent: true, reviewer: 'synthetic reviewer', ...bound },
      upgrade: { preservedData: true, ...bound },
      verification: {
        ...Object.fromEntries(Object.entries({ generationAndRecovery: 'test', canvasAndDiagnostics: 'test', assistantAndSkillDeferral: 'test', installers: 'test', noNewPaidGeneration: 'source-diff', ci: 'github-actions' }).map(([id, method]) => [id, passed(method)])),
        localReleaseGate: { status: 'pending_release_workflow', method: 'local-script', beforeDraft: true, sourceDigest, evidence: ['.github/workflows/release-desktop.yml'] },
      },
      packages: { platforms: ['darwin-arm64', 'darwin-amd64', 'windows-amd64', 'linux-amd64'], status: 'pending_release_workflow', archives: null,
        windowsReleasedUpgradeAndRollbackBeforeUpload: true, finalArchiveSmokeBeforeUpload: true, linuxNativeWindowBeforeUpload: true,
        signedManifestBeforePublish: true, publicReadbackAfterPublish: true, workflowEvidence: ['.github/workflows/release-desktop.yml'] },
      releasePublished: false, releaseComplete: false,
    };
    save(value);
    assert.match(run(), /v1\.7\.25 targeted team release/);
    for (const mutate of [
      r => { r.ownerException.instruction = '发布吧'; },
      r => { r.ownerException.sourceDigest = 'a'.repeat(64); },
      r => { r.includedPullRequests.push(176); },
      r => { r.deferredPullRequests = []; },
      r => { r.newSpentCNY = 1; },
      r => { r.cases.push({ status: 'succeeded' }); },
      r => { r.pendingCNY = 0; },
      r => { r.priorFinancialUncertainty.pendingCNY = 0; },
      r => { r.review.independent = false; },
      r => { r.review.sourceDigest = 'a'.repeat(64); },
      r => { r.upgrade.preservedData = false; },
      r => { r.verification.localReleaseGate.status = 'failed'; },
      r => { r.verification.localReleaseGate.beforeDraft = false; },
      r => { r.verification.localReleaseGate.evidence = evidence; },
      r => { r.verification.ci.sourceDigest = 'a'.repeat(64); },
      r => { r.packages.platforms.pop(); },
      r => { r.packages.windowsReleasedUpgradeAndRollbackBeforeUpload = false; },
      r => { r.packages.signedManifestBeforePublish = false; },
      r => { r.packages.publicReadbackAfterPublish = false; },
      r => { r.releaseComplete = true; },
    ]) {
      const invalid = structuredClone(value);
      mutate(invalid);
      assert.throws(() => validateTeamRelease(invalid, sourceDigest));
    }
    commitVersion('v1.7.26');
    save({ ...value, version: 'v1.7.26', sourceDigest: run('--fingerprint').trim() }, 'v1.7.26');
    assert.throws(() => run());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v1.7.24 packages cross-reviewed PRs and BytePlus/TLS fixes and cannot carry the waiver forward', () => {
  const { dir, run, save, commitVersion } = setupRepo('v1.7.24');
  try {
    assert.throws(() => run());
    const sourceDigest = run('--fingerprint').trim();
    const evidence = ['synthetic receipt for gate testing; not live acceptance'];
    const passed = (method) => ({ status: 'passed', method, sourceDigest, evidence });
    const value = {
      version: 'v1.7.24', sourceDigest,
      ownerException: { scope: 'cross-reviewed-prs-and-byteplus-tls-20261015', approvedBy: 'Ender', instruction: '把已 commit 的 codex/byteplus-compat 和 fix/tls-submission-20261015 合进 main 后一起发 v1.7.24（未 commit 的 4 个工作区留下一版）', evidence },
      releaseAuthorization: { additionalHumanReplyRequired: false, scope: 'v1.7.24 only' },
      baseRelease: 'v1.7.23', baseCommit: 'cabdbdd116530feaac04bb93d940162d586413d4',
      includedPullRequests: [147, 154, 157, 153, 155, 156, 158, 159], paidSubmissionPathChanged: false,
      paidSubmissionLimit: 0, newBudgetCNY: 0, newSpentCNY: 0, newPendingCNY: 0,
      cases: [], billingAttempts: [], budgetCNY: null, spentCNY: null, pendingCNY: null,
      liveMatrixStatus: 'not_run_owner_waived', agentAcceptanceStatus: 'not_run_owner_waived', acceptanceComplete: false,
      priorFinancialUncertainty: { status: 'unresolved', carriedFromVersion: 'v1.7.23', pendingCNY: null, evidence },
      review: { result: 'approved', independent: true, reviewer: 'synthetic reviewer', sourceDigest, evidence },
      upgrade: { preservedData: true, sourceDigest, evidence },
      verification: {
        canvasAndWebviewFixes: passed('test'),
        externalVideoAndBytePlus: passed('test'),
        updaterAndSubmissionDiagnostics: passed('test'),
        noNewPaidGeneration: passed('source-diff'),
        localReleaseGate: passed('local-script'),
        ci: passed('github-actions'),
      },
      packages: { platforms: ['darwin-arm64', 'darwin-amd64', 'windows-amd64', 'linux-amd64'], status: 'pending_release_workflow', archives: null,
        windowsReleasedUpgradeAndRollbackBeforeUpload: true, finalArchiveSmokeBeforeUpload: true, linuxNativeWindowBeforeUpload: true,
        signedManifestBeforePublish: true, publicReadbackAfterPublish: true, workflowEvidence: evidence },
      releasePublished: false, releaseComplete: false,
    };
    save(value);
    assert.match(run(), /v1\.7\.24 cross-reviewed canvas, updater, external video and BytePlus\/TLS package/);
    commitVersion('v1.7.25');
    save({ ...value, version: 'v1.7.25', sourceDigest: run('--fingerprint').trim() }, 'v1.7.25');
    assert.throws(() => run());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v1.7.23 packages Windows installer and canvas media bind fixes and cannot carry the waiver forward', () => {
  const { dir, run, save, commitVersion } = setupRepo('v1.7.23');
  try {
    assert.throws(() => run());
    const sourceDigest = run('--fingerprint').trim();
    const evidence = ['synthetic receipt for gate testing; not live acceptance'];
    const passed = (method) => ({ status: 'passed', method, sourceDigest, evidence });
    const value = {
      version: 'v1.7.23', sourceDigest,
      ownerException: { scope: 'late-merged-installer-canvas-bind-20261015', approvedBy: 'Ender', instruction: '把那两个lucas没review的群里在提醒一遍lucas 然后发版吧 发版后告诉lucas这版更新了什么', evidence },
      releaseAuthorization: { additionalHumanReplyRequired: false, scope: 'v1.7.23 only' },
      baseRelease: 'v1.7.22', baseCommit: 'a99c0c41c0bbb71a4b2b2479e5e5c14f14c3151a',
      includedPullRequests: [151], paidSubmissionPathChanged: false,
      paidSubmissionLimit: 0, newBudgetCNY: 0, newSpentCNY: 0, newPendingCNY: 0,
      cases: [], billingAttempts: [], budgetCNY: null, spentCNY: null, pendingCNY: null,
      liveMatrixStatus: 'not_run_owner_waived', agentAcceptanceStatus: 'not_run_owner_waived', acceptanceComplete: false,
      priorFinancialUncertainty: { status: 'unresolved', carriedFromVersion: 'v1.7.22', pendingCNY: null, evidence },
      review: { result: 'approved', independent: true, reviewer: 'synthetic reviewer', sourceDigest, evidence },
      upgrade: { preservedData: true, sourceDigest, evidence },
      verification: {
        windowsInstallerUX: passed('test'),
        canvasMediaBindAndRetry: passed('test'),
        noNewPaidGeneration: passed('source-diff'),
        localReleaseGate: passed('local-script'),
        ci: passed('github-actions'),
      },
      packages: { platforms: ['darwin-arm64', 'darwin-amd64', 'windows-amd64', 'linux-amd64'], status: 'pending_release_workflow', archives: null,
        windowsReleasedUpgradeAndRollbackBeforeUpload: true, finalArchiveSmokeBeforeUpload: true, linuxNativeWindowBeforeUpload: true,
        signedManifestBeforePublish: true, publicReadbackAfterPublish: true, workflowEvidence: evidence },
      releasePublished: false, releaseComplete: false,
    };
    save(value);
    assert.match(run(), /Windows installer and canvas media bind package/);
    const deny = mutate => { const changed = structuredClone(value); mutate(changed); save(changed); assert.throws(() => run()); };
    for (const mutate of [
      r => r.ownerException.instruction = '发版吧', r => r.ownerException.approvedBy = 'other',
      r => r.releaseAuthorization.additionalHumanReplyRequired = true, r => r.releaseAuthorization.scope = 'later versions',
      r => r.baseRelease = 'v1.7.21', r => r.baseCommit = '0'.repeat(40),
      r => r.includedPullRequests = [], r => r.includedPullRequests = [151, 147],
      r => r.paidSubmissionPathChanged = true, r => r.paidSubmissionLimit = 1, r => r.newBudgetCNY = 1,
      r => r.cases.push({}), r => r.billingAttempts.push({}), r => r.budgetCNY = 0, r => r.spentCNY = 0, r => r.pendingCNY = 0,
      r => r.liveMatrixStatus = 'passed', r => r.acceptanceComplete = true,
      r => r.priorFinancialUncertainty.carriedFromVersion = 'v1.7.21', r => r.priorFinancialUncertainty.pendingCNY = 0,
      r => r.review.independent = false, r => r.upgrade.preservedData = false,
      r => r.verification.ci.method = 'test', r => r.verification.windowsInstallerUX.status = 'pending',
      r => r.packages.platforms.pop(), r => r.packages.archives = {}, r => r.releaseComplete = true,
    ]) deny(mutate);
    save(value);
    commitVersion('v1.7.25');
    save({ ...value, version: 'v1.7.25', sourceDigest: run('--fingerprint').trim() }, 'v1.7.25');
    assert.throws(() => run());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v1.7.19 packages only the three late merges and cannot carry the waiver forward', () => {
  const { dir, run, save, commitVersion } = setupRepo('v1.7.19');
  try {
    assert.throws(() => run());
    const sourceDigest = run('--fingerprint').trim();
    const evidence = ['synthetic receipt for gate testing; not live acceptance'];
    const passed = (method) => ({ status: 'passed', method, sourceDigest, evidence });
    const value = {
      version: 'v1.7.19', sourceDigest,
      ownerException: { scope: 'late-merged-installer-ui-20261013', approvedBy: 'Ender', instruction: '继续打包有两项pr晚于这次打包但是合了', evidence },
      releaseAuthorization: { additionalHumanReplyRequired: false, scope: 'v1.7.19 only' },
      baseRelease: 'v1.7.18', baseCommit: '3df73e4da93e30b4fdf394e6ed317ed7d90dcdd0',
      includedPullRequests: [136, 137, 135], paidSubmissionPathChanged: false,
      paidSubmissionLimit: 0, newBudgetCNY: 0, newSpentCNY: 0, newPendingCNY: 0,
      cases: [], billingAttempts: [], budgetCNY: null, spentCNY: null, pendingCNY: null,
      liveMatrixStatus: 'not_run_owner_waived', agentAcceptanceStatus: 'not_run_owner_waived', acceptanceComplete: false,
      priorFinancialUncertainty: { status: 'unresolved', carriedFromVersion: 'v1.7.18', pendingCNY: null, evidence },
      review: { result: 'approved', independent: true, reviewer: 'synthetic reviewer', sourceDigest, evidence },
      upgrade: { preservedData: true, sourceDigest, evidence },
      verification: {
        singleExtractProgress: passed('test'),
        reducedMotionModelMenu: passed('test'),
        installSaveAndRetry: passed('test'),
        noNewPaidGeneration: passed('source-diff'),
        localReleaseGate: passed('local-script'),
        ci: passed('github-actions'),
      },
      packages: { platforms: ['darwin-arm64', 'darwin-amd64', 'windows-amd64', 'linux-amd64'], status: 'pending_release_workflow', archives: null,
        windowsReleasedUpgradeAndRollbackBeforeUpload: true, finalArchiveSmokeBeforeUpload: true, linuxNativeWindowBeforeUpload: true,
        signedManifestBeforePublish: true, publicReadbackAfterPublish: true, workflowEvidence: evidence },
      releasePublished: false, releaseComplete: false,
    };
    save(value);
    assert.match(run(), /late installer and settings package/);
    const deny = mutate => { const changed = structuredClone(value); mutate(changed); save(changed); assert.throws(() => run()); };
    for (const mutate of [
      r => r.ownerException.instruction = '继续打包', r => r.ownerException.approvedBy = 'other',
      r => r.releaseAuthorization.additionalHumanReplyRequired = true, r => r.releaseAuthorization.scope = 'later versions',
      r => r.baseRelease = 'v1.7.17', r => r.baseCommit = '0'.repeat(40),
      r => r.includedPullRequests = [136, 137], r => r.includedPullRequests = [136, 137, 135, 119],
      r => r.paidSubmissionPathChanged = true, r => r.paidSubmissionLimit = 1, r => r.newBudgetCNY = 1,
      r => r.cases.push({}), r => r.billingAttempts.push({}), r => r.budgetCNY = 0, r => r.spentCNY = 0, r => r.pendingCNY = 0,
      r => r.liveMatrixStatus = 'passed', r => r.acceptanceComplete = true,
      r => r.priorFinancialUncertainty.carriedFromVersion = 'v1.7.17', r => r.priorFinancialUncertainty.pendingCNY = 0,
      r => r.review.independent = false, r => r.upgrade.preservedData = false,
      r => r.verification.ci.method = 'test', r => r.verification.singleExtractProgress.status = 'pending',
      r => r.packages.platforms.pop(), r => r.packages.archives = {}, r => r.releaseComplete = true,
    ]) deny(mutate);
    save(value);
    commitVersion('v1.7.20');
    save({ ...value, version: 'v1.7.20', sourceDigest: run('--fingerprint').trim() }, 'v1.7.20');
    assert.throws(() => run());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v1.7.18 H3-only receipt requires current native settlement, bounded funding and all package gates', () => {
  const { dir, run, save, commitVersion } = setupRepo('v1.7.18');
  try {
    assert.throws(() => run());
    const sourceDigest = run('--fingerprint').trim();
    const evidence = ['synthetic receipt for gate testing; not live acceptance'];
    const passed = { status: 'passed', sourceDigest, evidence };
    const value = {
      version: 'v1.7.18', sourceDigest,
      ownerException: { scope: 'fal-h3-targeted-20261013', approvedBy: 'Ender', instruction: '本版采用 H3 专项验收（推荐）', evidence },
      releaseAuthorization: { additionalHumanReplyRequired: false, scope: 'v1.7.18 only' },
      liveMatrixStatus: 'not_run_owner_waived', agentAcceptanceStatus: 'not_run_owner_waived', acceptanceComplete: false,
      cases: [], billingAttempts: [], budgetCNY: null, spentCNY: null, pendingCNY: null, newSpentCNY: null, newPendingCNY: null,
      paidSubmissionLimit: 5,
      priorH3Canaries: Object.entries({ 'text-768p': '768p', 'first-last-480p': '480p', 'last-only-1080p': '1080p', 'pinned-audio-768p': '768p' }).map(([id, resolution]) => ({
        id, resolution, seconds: 3, method: 'production-go-test', model: 'minimax-h3-max-turbo', status: 'succeeded',
        executedSourceDigest: '1eca0cde63aaa9d09431465f997c9959d523ca2cda60cb8dcf00e132a6f55f50', providerRequestId: id, artifactSHA256: 'a'.repeat(64), evidence,
      })),
      h3Funding: { budgetCNY: 20, reservedUpperCNY: 7.10326, inferenceRequestIds: ['text-768p','first-last-480p','last-only-1080p','pinned-audio-768p','native-task'], supplierInvoiceConfirmed: false, supplierBillingReadHTTPStatus: 403, evidence },
      productionH3: { sourceDigest, evidence, method: 'native-cli', clientVersion: 'v1.7.18', model: 'minimax-h3-max-turbo', resolution: '768p', seconds: 3,
        status: 'succeeded', billing: 'settled', billingMarket: 'enterprise', costCNY: 0.7323912, canvasVerified: true, saved: true, reopened: true,
        mediaDecoded: true, mediaOpened: true, noDuplicateSubmission: true, taskId: 'local-task', gatewayTaskId: 'gateway-task', providerRequestId: 'native-task', artifactSHA256: 'b'.repeat(64) },
      priorFinancialUncertainty: { status: 'unresolved', carriedFromVersion: 'v1.7.17', pendingCNY: null, evidence },
      review: { result: 'approved', independent: true, reviewer: 'synthetic reviewer', sourceDigest, evidence },
      upgrade: { preservedData: true, sourceDigest, evidence },
      verification: Object.fromEntries(['h3Catalog', 'h3KeyframesAudio', 'nativeCanvasDelivery', 'noDuplicateSubmission', 'localReleaseGate', 'ci'].map(id => [id, { ...passed }])),
      packages: { platforms: ['darwin-arm64', 'darwin-amd64', 'windows-amd64', 'linux-amd64'], status: 'pending_release_workflow', windowsReleasedUpgradeAndRollbackBeforeUpload: true,
        finalArchiveSmokeBeforeUpload: true, linuxNativeWindowBeforeUpload: true, signedManifestBeforePublish: true, publicReadbackAfterPublish: true, workflowEvidence: evidence },
      releasePublished: false, releaseComplete: false,
    };
    save(value);
    assert.match(run(), /full matrix NOT run/);
    const deny = mutate => { const changed = structuredClone(value); mutate(changed); save(changed); assert.throws(() => run()); };
    for (const mutate of [
      r => r.ownerException.instruction = '继续上线', r => r.releaseAuthorization.additionalHumanReplyRequired = true,
      r => r.cases.push({ billing: 'settled', costCNY: 100 }), r => r.billingAttempts.push({ costCNY: 100 }),
      r => r.budgetCNY = 20, r => r.spentCNY = 0, r => r.pendingCNY = 0, r => r.newSpentCNY = 0, r => r.newPendingCNY = 0,
      r => r.sourceDigest = '0'.repeat(64), r => r.priorH3Canaries[0].method = 'native', r => r.priorH3Canaries[0].executedSourceDigest = sourceDigest,
      r => r.priorH3Canaries[0].providerRequestId = r.priorH3Canaries[1].providerRequestId, r => r.priorH3Canaries.pop(),
      r => r.h3Funding.reservedUpperCNY = 20.01, r => r.h3Funding.reservedUpperCNY = 0, r => r.h3Funding.reservedUpperCNY = null,
      r => r.h3Funding.reservedUpperCNY = 5.018236, r => r.h3Funding.inferenceRequestIds.push('extra-request'),
      r => r.h3Funding.inferenceRequestIds[4] = r.h3Funding.inferenceRequestIds[0], r => r.h3Funding.inferenceRequestIds[4] = 'unrecorded-request',
      r => r.h3Funding.supplierInvoiceConfirmed = true, r => r.paidSubmissionLimit = 6,
      r => r.productionH3.method = 'mock', r => r.productionH3.billing = 'pending', r => r.productionH3.billingMarket = 'domestic',
      r => r.productionH3.costCNY = 0, r => r.productionH3.costCNY = 0.2441304, r => r.productionH3.reopened = false,
      r => r.productionH3.sourceDigest = '0'.repeat(64), r => r.productionH3.providerRequestId = r.priorH3Canaries[0].providerRequestId,
      r => r.productionH3.noDuplicateSubmission = false, r => r.productionH3.mediaOpened = false,
      r => r.priorFinancialUncertainty.pendingCNY = 0, r => r.verification.ci.status = 'pending', r => r.review.independent = false,
      r => r.packages.platforms.pop(), r => r.packages.signedManifestBeforePublish = false, r => r.packages.windowsReleasedUpgradeAndRollbackBeforeUpload = false,
      r => r.packages.linuxNativeWindowBeforeUpload = false, r => r.releaseComplete = true,
    ]) deny(mutate);
    save(value);
    commitVersion('v1.7.19');
    save({ ...value, version: 'v1.7.19', sourceDigest: run('--fingerprint').trim() }, 'v1.7.19');
    assert.throws(() => run());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v1.7.17 rejects the superseded paid-rerun authorization', () => {
  const { run, save, dir } = setupRepo('v1.7.17');
  try {
    save({
      version: 'v1.7.17', sourceDigest: run('--fingerprint').trim(),
      ownerException: { approvedBy: 'Ender', scope: 'generation-delivery-targeted-20261012' },
      paidSubmissionLimit: 5, newBudgetCNY: 10,
    });
    assert.throws(() => run(), /paid rerun authorization was superseded/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v1.7.17 owner acceptance forbids new spending, preserves evidence and cannot carry forward', () => {
  const { run, save, commitVersion, dir } = setupRepo('v1.7.17');
  try {
    const sourceDigest = run('--fingerprint').trim();
    const evidence = ['synthetic test receipt, not live acceptance'];
    const accepted = { confirmedBy: 'Ender', method: 'native', status: 'passed', testedSourceDigest: 'a'.repeat(64), instruction: '实测通过', evidence };
    const value = {
      version: 'v1.7.17', sourceDigest, newBudgetCNY: 0, newSpentCNY: 0, newPendingCNY: 0, paidSubmissionLimit: 0,
      budgetCNY: null, spentCNY: null, pendingCNY: null, cases: [],
      liveMatrixStatus: 'not_run_owner_waived', agentAcceptanceStatus: 'not_run_owner_waived',
      acceptanceComplete: false, releasePublished: false, releaseComplete: false,
      ownerException: { approvedBy: 'Ender', instruction: '采用本次实测，不重复付费（推荐）', scope: 'generation-delivery-owner-accepted-20261013', evidence },
      ownerAcceptance: {
        generationDelivery: { ...accepted, testedSourceDigest: 'd8024f245c9fdbb054a1f4adc705e783caed2e5e6b4fb07ea43e9c043aea9b3c' },
        videoFullscreen: { ...accepted, testedSourceDigest: 'a25801431e4bf791ee0ef8679fbc6ba1ddae717ac737fc0feeec730225ab6870' },
      },
      priorFinancialUncertainty: { status: 'unresolved', carriedFromVersion: 'v1.7.16', pendingCNY: null, evidence },
      review: { result: 'approved', independent: true, reviewer: 'fixture', sourceDigest, evidence },
      upgrade: { preservedData: true, sourceDigest, evidence },
      verification: Object.fromEntries(['generationDelivery', 'imageRecoveryBudget', 'noDuplicateSubmission', 'videoFullscreen', 'localReleaseGate', 'ci'].map(id => [id, { status: 'passed', sourceDigest, evidence }])),
      packages: { status: 'pending_release_workflow', archives: null, platforms: ['darwin-arm64', 'darwin-amd64', 'windows-amd64', 'linux-amd64'],
        windowsReleasedUpgradeAndRollbackBeforeUpload: true, finalArchiveSmokeBeforeUpload: true, linuxNativeWindowBeforeUpload: true,
        signedManifestBeforePublish: true, publicReadbackAfterPublish: true, workflowEvidence: evidence },
    };
    save(value); assert.match(run(), /owner native acceptance; no new paid generation.*package gates pending/);
    const mutations = [
      r => r.ownerException.instruction = '发吧', r => r.ownerException.approvedBy = 'other', r => r.ownerException.evidence = [],
      r => r.paidSubmissionLimit = 1, r => r.newBudgetCNY = 1, r => r.newSpentCNY = 1, r => r.newPendingCNY = 1, r => r.cases.push({}),
      r => r.liveMatrixStatus = 'passed', r => r.agentAcceptanceStatus = 'passed', r => r.acceptanceComplete = true,
      r => r.spentCNY = 0, r => r.priorFinancialUncertainty.status = 'resolved', r => r.review.independent = false,
      r => r.review.sourceDigest = 'old', r => r.upgrade.preservedData = false, r => r.releasePublished = true,
      r => r.packages.platforms.pop(), r => r.packages.publicReadbackAfterPublish = false,
    ];
    for (const id of Object.keys(value.ownerAcceptance)) mutations.push(r => delete r.ownerAcceptance[id], r => r.ownerAcceptance[id].confirmedBy = 'agent',
      r => r.ownerAcceptance[id].method = 'mock', r => r.ownerAcceptance[id].status = 'pending', r => r.ownerAcceptance[id].testedSourceDigest = 'unknown',
      r => r.ownerAcceptance[id].testedSourceDigest = sourceDigest, r => r.ownerAcceptance[id].testedSourceDigest = 'a'.repeat(64), r => r.ownerAcceptance[id].evidence = []);
    for (const id of Object.keys(value.verification)) mutations.push(r => r.verification[id].status = 'pending', r => r.verification[id].sourceDigest = 'old');
    for (const mutate of mutations) { const invalid = structuredClone(value); mutate(invalid); save(invalid); assert.throws(() => run()); }
    commitVersion('v1.7.18');
    save({ ...value, version: 'v1.7.18', sourceDigest: run('--fingerprint').trim() }, 'v1.7.18');
    assert.throws(() => run());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v1.7.16 requires one settled native ASR and cannot waive evidence or carry forward', () => {
  const { dir, run, save, commitVersion } = setupRepo('v1.7.16');
  try {
    assert.throws(() => run()); // A missing live receipt is never release-ready.
    const sourceDigest = run('--fingerprint').trim();
    const evidence = ['synthetic test receipt, not live acceptance'];
    const value = {
      version: 'v1.7.16', sourceDigest, newBudgetCNY: 1, newSpentCNY: 0.001, newPendingCNY: 0,
      budgetCNY: null, spentCNY: null, pendingCNY: null, paidSubmissionLimit: 1,
      liveMatrixStatus: 'not_run_owner_waived', agentAcceptanceStatus: 'not_run_owner_waived',
      acceptanceComplete: false, releasePublished: false, releaseComplete: false,
      ownerException: { approvedBy: 'Ender', instruction: '按建议专项验收后发布，本版豁免完整矩阵', scope: 'asr-transcription-targeted-20261011', evidence },
      cases: [{ path: 'audio-transcription', model: 'hy-asr-3.0-preview', attempts: 1, status: 'succeeded', method: 'native',
        clientSubmitted: true, subtitleTextVerified: true, subtitleTimingVerified: true, subtitleSaved: true, subtitleReopened: true, srtExported: true,
        billing: 'settled', costCNY: 0.001, executedSourceDigest: sourceDigest, clientVersion: 'v1.7.16', taskId: 'fixture-task', providerRequestId: 'fixture-request', artifactSHA256: 'a'.repeat(64), evidence }],
      priorFinancialUncertainty: { status: 'unresolved', carriedFromVersion: 'v1.7.15', pendingCNY: null, evidence },
      review: { result: 'approved', independent: true, reviewer: 'fixture', sourceDigest, evidence },
      upgrade: { preservedData: true, sourceDigest, evidence },
      verification: Object.fromEntries(['asrCatalog', 'nativeSubtitleSave', 'scopeIsolation', 'noDuplicateSubmission', 'localReleaseGate', 'ci'].map(id => [id, { status: 'passed', method: 'native', sourceDigest, evidence }])),
      packages: { status: 'pending_release_workflow', archives: null, platforms: ['darwin-arm64', 'darwin-amd64', 'windows-amd64', 'linux-amd64'],
        windowsReleasedUpgradeAndRollbackBeforeUpload: true, finalArchiveSmokeBeforeUpload: true, linuxNativeWindowBeforeUpload: true,
        signedManifestBeforePublish: true, publicReadbackAfterPublish: true, workflowEvidence: evidence },
    };
    save(value); assert.match(run(), /native ASR saved and settled within CNY 1.*package gates pending/);
    const mutations = [
      r => r.ownerException.instruction = '发布吧', r => r.ownerException.evidence = [],
      r => r.ownerException.scope = 'other', r => r.ownerException.approvedBy = 'other',
      r => r.paidSubmissionLimit = 2, r => r.newBudgetCNY = 2, r => r.cases = [], r => r.cases.push(r.cases[0]),
      r => r.newSpentCNY = 0, r => r.newPendingCNY = null, r => r.newPendingCNY = 0.1,
      r => r.cases[0].costCNY = 1.01, r => r.cases[0].costCNY = 0, r => r.cases[0].attempts = 2,
      r => r.cases[0].status = 'pending', r => r.cases[0].billing = 'unknown', r => r.cases[0].method = 'mock',
      r => r.cases[0].model = 'speech', r => r.cases[0].path = 'text-image', r => r.cases[0].executedSourceDigest = 'old',
      r => r.cases[0].clientVersion = 'v1.7.15', r => r.cases[0].taskId = '', r => r.cases[0].providerRequestId = '',
      r => r.cases[0].artifactSHA256 = '', r => r.cases[0].evidence = [],
      r => r.priorFinancialUncertainty.pendingCNY = 0, r => r.priorFinancialUncertainty.evidence = [], r => r.pendingCNY = 0,
      r => r.review.independent = false, r => r.review.sourceDigest = 'old', r => r.review.result = 'pending',
      r => r.upgrade.preservedData = false, r => r.upgrade.sourceDigest = 'old',
      r => r.verification.nativeSubtitleSave.method = 'mock', r => r.liveMatrixStatus = 'passed', r => r.agentAcceptanceStatus = 'passed',
      r => r.acceptanceComplete = true, r => r.releasePublished = true, r => r.releaseComplete = true,
      r => r.packages.platforms.pop(), r => r.packages.platforms.push('linux-amd64'), r => r.packages.status = 'passed',
      r => r.packages.archives = {}, r => r.packages.workflowEvidence = [],
    ];
    for (const field of ['clientSubmitted', 'subtitleTextVerified', 'subtitleTimingVerified', 'subtitleSaved', 'subtitleReopened', 'srtExported']) mutations.push(r => r.cases[0][field] = false);
    for (const field of ['windowsReleasedUpgradeAndRollbackBeforeUpload', 'finalArchiveSmokeBeforeUpload', 'linuxNativeWindowBeforeUpload', 'signedManifestBeforePublish', 'publicReadbackAfterPublish']) mutations.push(r => r.packages[field] = false);
    for (const id of Object.keys(value.verification)) mutations.push(r => delete r.verification[id], r => r.verification[id].status = 'pending', r => r.verification[id].sourceDigest = 'old', r => r.verification[id].evidence = []);
    for (const mutate of mutations) { const invalid = structuredClone(value); mutate(invalid); save(invalid); assert.throws(() => run()); }
    commitVersion('v1.7.17');
    save({ ...value, version: 'v1.7.17', sourceDigest: run('--fingerprint').trim() }, 'v1.7.17');
    assert.throws(() => run());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v1.7.15 waiver keeps source review and all four package gates and cannot carry forward', () => {
  const { dir, run, save, commitVersion } = setupRepo('v1.7.15');
  try {
    const sourceDigest = run('--fingerprint').trim();
    const evidence = ['synthetic test receipt'];
    const value = {
      version: 'v1.7.15', sourceDigest, newSpentCNY: 0, newPendingCNY: 0, cases: [],
      liveMatrixStatus: 'not_run_owner_waived', acceptanceComplete: false, releasePublished: false, releaseComplete: false,
      ownerException: { approvedBy: 'Ender', instruction: '一起合入并发布，本版豁免付费矩阵（推荐）', scope: 'workspace-media-domestic-targeted-20261010', evidence },
      priorFinancialUncertainty: { status: 'unresolved', pendingCNY: null, evidence },
      review: { result: 'approved', independent: true, reviewer: 'fixture', sourceDigest, evidence },
      upgrade: { preservedData: true, sourceDigest, evidence },
      verification: Object.fromEntries(['workspaceRegression', 'videoRecovery', 'networkPolicy', 'localReleaseGate', 'ci'].map(id => [id, { status: 'passed', sourceDigest, evidence }])),
      packages: {
        status: 'pending_release_workflow', archives: null, platforms: ['darwin-arm64', 'darwin-amd64', 'windows-amd64', 'linux-amd64'],
        windowsReleasedUpgradeAndRollbackBeforeUpload: true, finalArchiveSmokeBeforeUpload: true,
        linuxNativeWindowBeforeUpload: true, signedManifestBeforePublish: true, publicReadbackAfterPublish: true, workflowEvidence: evidence,
      },
    };
    save(value); assert.match(run(), /paid matrix NOT run.*four-platform package gates pending/);
    const mutations = [
      r => r.ownerException.instruction = '发包吧', r => r.ownerException.approvedBy = 'other',
      r => r.ownerException.evidence = [], r => r.ownerException.scope = 'other',
      r => r.newSpentCNY = 1, r => r.newPendingCNY = null, r => r.cases.push({}),
      r => r.liveMatrixStatus = 'passed', r => r.acceptanceComplete = true,
      r => r.priorFinancialUncertainty.pendingCNY = 0, r => r.priorFinancialUncertainty.evidence = [],
      r => r.review.independent = false, r => r.review.sourceDigest = 'old', r => r.review.result = 'pending',
      r => r.upgrade.preservedData = false, r => r.upgrade.sourceDigest = 'old',
      r => r.packages.platforms.pop(), r => r.packages.platforms.push('linux-amd64'),
      r => r.packages.windowsReleasedUpgradeAndRollbackBeforeUpload = false,
      r => r.packages.finalArchiveSmokeBeforeUpload = false, r => r.packages.linuxNativeWindowBeforeUpload = false,
      r => r.packages.signedManifestBeforePublish = false, r => r.packages.publicReadbackAfterPublish = false,
      r => r.packages.workflowEvidence = [], r => r.packages.status = 'passed', r => r.packages.archives = {},
      r => r.releasePublished = true, r => r.releaseComplete = true,
    ];
    for (const id of Object.keys(value.verification)) mutations.push(
      r => delete r.verification[id], r => r.verification[id].status = 'pending',
      r => r.verification[id].sourceDigest = 'old', r => r.verification[id].evidence = []);
    for (const mutate of mutations) {
      const invalid = structuredClone(value); mutate(invalid); save(invalid); assert.throws(() => run());
    }
    commitVersion('v1.7.16');
    save({ ...value, version: 'v1.7.16', sourceDigest: run('--fingerprint').trim() }, 'v1.7.16');
    assert.throws(() => run());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v1.7.12 unified-name waiver cannot waive evidence or carry forward', () => {
  const { dir, run, save, commitVersion } = setupRepo('v1.7.12');
  try {
    const sourceDigest = run('--fingerprint').trim();
    const evidence = ['synthetic test receipt'];
    const value = {
      version: 'v1.7.12', sourceDigest, budgetCNY: null, spentCNY: null, pendingCNY: null,
      newSpentCNY: 0, newPendingCNY: 0, cases: [], liveMatrixStatus: 'not_run_owner_waived', releaseComplete: false,
      liveTestWaiver: { approvedBy: 'Ender', instruction: '上线吧 豁免了 飞书文档你再看看还要不要更新', scope: 'seedance-unified-display', evidence },
      priorFinancialUncertainty: { status: 'unresolved', carriedFromVersion: 'v1.7.11', pendingCNY: null, evidence },
      review: { result: 'approved', independent: true, reviewer: 'fixture', sourceDigest, evidence },
      upgrade: { preservedData: true, sourceDigest, evidence },
      verification: Object.fromEntries(['displayNames', 'nativeNames', 'localReleaseGate', 'ci'].map(id => [id, { status: 'passed', method: id === 'nativeNames' ? 'native' : 'test', sourceDigest, evidence }])),
      packages: { status: 'pending_release_workflow', windowsReleasedUpgradeAndRollbackBeforeUpload: true, finalArchiveSmokeBeforeUpload: true, workflowEvidence: evidence },
    };
    save(value); assert.match(run(), /unified Seedance release; paid matrix NOT run/);
    const mutations = [
      r => r.liveTestWaiver.instruction = '上线吧', r => r.liveTestWaiver.approvedBy = 'other',
      r => r.liveTestWaiver.evidence = [], r => r.liveTestWaiver.scope = 'other',
      r => r.newSpentCNY = 1, r => r.newPendingCNY = null, r => r.cases.push({}),
      r => r.liveMatrixStatus = 'passed', r => r.budgetCNY = 0, r => r.spentCNY = 0, r => r.pendingCNY = 0,
      r => r.priorFinancialUncertainty.pendingCNY = 0, r => r.priorFinancialUncertainty.evidence = [],
      r => r.priorFinancialUncertainty.carriedFromVersion = 'v1.7.10', r => r.review.independent = false,
      r => r.review.sourceDigest = 'old', r => r.review.result = 'pending', r => r.upgrade.preservedData = false,
      r => r.upgrade.sourceDigest = 'old', r => r.verification.nativeNames.method = 'static',
      r => r.packages.windowsReleasedUpgradeAndRollbackBeforeUpload = false,
      r => r.packages.finalArchiveSmokeBeforeUpload = false, r => r.packages.workflowEvidence = [],
      r => r.packages.status = 'passed', r => r.packages.archives = {}, r => r.releaseComplete = true,
    ];
    for (const id of Object.keys(value.verification)) mutations.push(
      r => delete r.verification[id], r => r.verification[id].status = 'pending',
      r => r.verification[id].sourceDigest = 'old', r => r.verification[id].evidence = []);
    for (const mutate of mutations) {
      const invalid = structuredClone(value); mutate(invalid); save(invalid); assert.throws(() => run());
    }
    commitVersion('v1.7.13');
    save({ ...value, version: 'v1.7.13', sourceDigest: run('--fingerprint').trim() }, 'v1.7.13');
    assert.throws(() => run());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v1.7.10 name-only waiver retains native, review, financial and package gates', () => {
  const { dir, run, save, commitVersion } = setupRepo('v1.7.10');
  try {
    const sourceDigest = run('--fingerprint').trim();
    const evidence = ['synthetic test receipt'];
    const value = {
      version: 'v1.7.10', sourceDigest, budgetCNY: 0, spentCNY: 0, newSpentCNY: 0, pendingCNY: 0,
      liveMatrixStatus: 'not_run_owner_waived', cases: [], releaseComplete: false,
      liveTestWaiver: { approvedBy: 'Ender', instruction: 'beeftv本次豁免 直接上线', scope: 'seedance-display-names-only', evidence },
      priorFinancialUncertainty: { status: 'unresolved', carriedFromVersion: 'v1.7.9', pendingCNY: null, evidence },
      review: { result: 'approved', independent: true, reviewer: 'fixture', sourceDigest, evidence },
      upgrade: { preservedData: true, sourceDigest, evidence },
      verification: Object.fromEntries(['displayNames', 'nativeNames', 'localReleaseGate', 'ci'].map(id => [id, { status: 'passed', method: id === 'nativeNames' ? 'native' : 'test', sourceDigest, evidence }])),
      packages: { status: 'pending_release_workflow', windowsReleasedUpgradeAndRollbackBeforeUpload: true, finalArchiveSmokeBeforeUpload: true, workflowEvidence: evidence },
    };
    save(value);
    assert.match(run(), /display-name release; paid matrix NOT run/);
    for (const mutate of [
      r => { r.liveTestWaiver.instruction = '上线吧'; },
      r => { r.spentCNY = 1; },
      r => { r.liveMatrixStatus = 'passed'; },
      r => { r.priorFinancialUncertainty.pendingCNY = 0; },
      r => { r.review.independent = false; },
      r => { r.upgrade.preservedData = false; },
      r => { r.verification.nativeNames.method = 'static'; },
      r => { r.verification.displayNames.sourceDigest = 'old'; },
      r => { r.verification.ci.status = 'pending'; },
      r => { r.packages.windowsReleasedUpgradeAndRollbackBeforeUpload = false; },
      r => { r.releaseComplete = true; },
    ]) {
      const invalid = structuredClone(value); mutate(invalid); save(invalid);
      assert.throws(() => run());
    }
    commitVersion('v1.7.11');
    value.version = 'v1.7.11'; value.sourceDigest = run('--fingerprint').trim(); save(value, 'v1.7.11');
    assert.throws(() => run());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v1.7.9 accepted evidence cannot hide gaps, skip native cases, or carry to another version', () => {
  const { dir, git, run, save, commitVersion } = setupRepo('v1.7.9');
  try {
    // Reuse Git objects only: no working files, accounts or private test media.
    git('fetch', '--quiet', '--depth=1', decodeURIComponent(new URL('..', import.meta.url).pathname), 'refs/tags/v1.7.9');
    git('update-ref', 'HEAD', 'FETCH_HEAD');
    const value = JSON.parse(readFileSync(new URL('../docs/release-evidence/v1.7.9.json', import.meta.url)));
    value.sourceDigest = run('--fingerprint').trim();
    value.review.sourceDigest = value.sourceDigest;
    value.review.result = 'approved'; // Synthetic isolated test fixture, not a release approval.
    save(value);
    assert.match(run(), /owner-authorized evidence carry-forward/);
    for (const mutate of [
      r => { r.ownerException.instruction = 'yes'; },
      r => { r.pendingCNY = 0; },
      r => { r.budgetCNY = 200; },
      r => { r.portraitAcceptance.cases[1].billing = 'pending'; },
      r => { r.portraitAcceptance.cases[0].attempts = 2; },
      r => { r.cases[0].executedSourceDigest = r.sourceDigest; },
      r => { r.cases[0].confirmed = false; },
      r => { delete r.agentChecks.cli_mcp; },
      r => { r.agentChecks.session_restart.status = 'pending'; },
      r => { r.review.result = 'pending'; },
      r => { r.packages.windowsReleasedUpgradeAndRollbackBeforeUpload = false; },
      r => { r.releaseComplete = true; },
    ]) {
      const invalid = structuredClone(value);
      mutate(invalid); save(invalid);
      assert.throws(() => run());
    }
    // Product changes cannot be hidden by updating the outer receipt digest.
    mkdirSync(join(dir, 'backend'), { recursive: true });
    writeFileSync(join(dir, 'backend/unaccepted-change.txt'), 'changed runtime');
    git('add', 'backend/unaccepted-change.txt');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'unaccepted runtime');
    value.sourceDigest = run('--fingerprint').trim(); value.review.sourceDigest = value.sourceDigest; save(value);
    assert.throws(() => run());
    commitVersion('v1.7.10');
    value.version = 'v1.7.10'; value.sourceDigest = run('--fingerprint').trim(); save(value, 'v1.7.10');
    assert.throws(() => run());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v1.7.11 one-image authorization rejects additional calls, stale source, missing recovery or review', () => {
  const { dir, run, save, commitVersion } = setupRepo('v1.7.11');
  try {
    const digest = run('--fingerprint').trim();
    const bound = { sourceDigest: digest, evidence: ['synthetic.log'] };
    const valid = {
      version: 'v1.7.11', sourceDigest: digest, releaseComplete: false,
      ownerException: { scope: 'canvas-image-bind-regression-20261007', approvedBy: 'Ender', instruction: '只复测一次生成图片看看会不会复现报错即可上线', evidence: ['owner.log'] },
      liveMatrixStatus: 'not_run_owner_limited_to_one_image', paidSubmissionLimit: 1,
      cases: [{ path: 'image-image', model: 'beefapi::gpt-image-2.5', attempts: 1, status: 'succeeded', clientSubmitted: true, canvasVerified: true, mediaDecoded: true, mediaOpened: true, billing: 'settled', costCNY: 0.42, executedSourceDigest: digest, clientVersion: 'v1.7.11', taskId: 'synthetic-task', providerRequestId: 'synthetic-request', artifactSHA256: 'a'.repeat(64), evidence: ['native.log'] }],
      newSpentCNY: 0.42, newPendingCNY: 0,
      budgetCNY: null, spentCNY: null, pendingCNY: null,
      financialUncertainty: { status: 'unresolved', evidence: ['prior.json'] },
      priorFinancialUncertainty: { status: 'unresolved', carriedFromVersion: 'v1.7.10', pendingCNY: null, evidence: ['prior.json'] },
      review: { ...bound, result: 'approved', independent: true, reviewer: 'synthetic-reviewer' },
      upgrade: { ...bound, preservedData: true },
      verification: Object.fromEntries(['saveBarrier', 'resultRecovery', 'scopeIsolation', 'localReleaseGate', 'ci'].map(id => [id, { ...bound, status: 'passed' }])),
      packages: { status: 'pending_release_workflow', windowsReleasedUpgradeAndRollbackBeforeUpload: true, finalArchiveSmokeBeforeUpload: true, workflowEvidence: ['workflow.yml'] },
    };
    save(valid); assert.match(run(), /single-image regression passed/);
    for (const mutate of [
      r => r.cases.push(r.cases[0]), r => r.cases[0].attempts = 2,
      r => r.cases[0].canvasVerified = false, r => r.cases[0].billing = 'pending',
      r => r.cases[0].executedSourceDigest = 'b'.repeat(64),
      r => r.ownerException.instruction = 'yes', r => r.review.result = 'pending',
      r => r.verification.resultRecovery.status = 'pending', r => r.priorFinancialUncertainty.pendingCNY = 0,
      r => r.budgetCNY = 0, r => r.spentCNY = 0, r => r.pendingCNY = 0,
      r => delete r.financialUncertainty, r => r.financialUncertainty.evidence = [],
      r => { r.cases[0].costCNY = 0; r.newSpentCNY = 0; },
      r => r.packages.finalArchiveSmokeBeforeUpload = false, r => r.releaseComplete = true,
    ]) { const invalid = structuredClone(valid); mutate(invalid); save(invalid); assert.throws(() => run()); }
    commitVersion('v1.7.12');
    valid.version = 'v1.7.12'; valid.sourceDigest = run('--fingerprint').trim(); save(valid, 'v1.7.12');
    assert.throws(() => run());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('release fingerprint binds the packaged app icon', () => {
  const { dir, git, run } = setupRepo('v1.7.6');
  try {
    const before = run('--fingerprint').trim();
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'assets/app-icon.png'), 'test icon bytes');
    git('add', 'assets/app-icon.png');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'change packaged icon');
    assert.notEqual(run('--fingerprint').trim(), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function makeChecks(sourceDigest, tweak) {
  const checks = Object.fromEntries(REQUIRED_AGENT_CHECK_IDS.map(id => [id, {
    status: 'passed',
    method: DETERMINISTIC_FAULT_CHECK_IDS.includes(id) ? 'deterministic' : 'native',
    evidence: [`${id}.log`],
    sourceDigest,
  }]));
  if (tweak) tweak(checks);
  return checks;
}

function makeCases(version, fixtureDigest) {
  return [1, 2].flatMap(round => PATHS.map(path => ({
    round,
    path,
    taskId: `${round}/${path}`,
    providerRequestId: `${round}/${path}`,
    clientVersion: version,
    platform: 'test-only',
    fixtureDigest,
    model: 'test-only',
    status: 'succeeded',
    clientSubmitted: true,
    canvasVerified: true,
    mediaDecoded: true,
    mediaOpened: true,
    billing: 'settled',
    costCNY: 1,
    artifactSHA256: 'b'.repeat(64),
    entrypoint: 'assistant',
    sessionId: `s-${round}-${path}`,
    turnId: `t-${round}-${path}`,
    proposalId: `p-${round}-${path}`,
    operationId: `proposal:p-${round}-${path}:node-${round}-${path}`,
    confirmed: true,
  })));
}

function makeScenario(fixtures, extra = {}) {
  return {
    id: 'autumn-lantern-2026',
    title: 'city lantern night',
    source: 'https://example.invalid/trends/lantern',
    queryDate: '2026-10-02',
    fixtures,
    ...extra,
  };
}

function themeFixtures(salt = 'c') {
  return {
    'theme-a.jpg': salt.repeat(64),
    'theme-b.png': String.fromCharCode(salt.charCodeAt(0) + 1).repeat(64),
    'theme-c.mp4': String.fromCharCode(salt.charCodeAt(0) + 2).repeat(64),
  };
}

function makeV2(version, sourceDigest, extra = {}) {
  const fixtures = extra.fixtures || themeFixtures();
  const fixtureDigest = fixtureDigestFromManifest(fixtures);
  const { fixtures: _ignored, ...rest } = extra;
  return {
    version,
    sourceDigest,
    contractVersion: THEME_AGENT_CONTRACT_VERSION,
    budgetCNY: 50,
    spentCNY: 12,
    pendingCNY: 0,
    upgrade: { preservedData: true, generationVerified: true },
    scenario: makeScenario(fixtures),
    agentChecks: makeChecks(sourceDigest),
    review: { result: 'approved', sourceDigest, reviewer: 'independent-test-reviewer', evidence: ['review.md'] },
    cases: makeCases(version, fixtureDigest),
    ...rest,
  };
}

function makeV3(version, sourceDigest, extra = {}) {
  const fixtures = extra.fixtures || { ...themeFixtures(), 'voice.wav': 'f'.repeat(64) };
  const value = makeV2(version, sourceDigest, { ...extra, fixtures, contractVersion: 3 });
  value.review.independent = true;
  for (const id of DURABLE_AGENT_CHECK_IDS) value.agentChecks[id] = { status: 'passed', method: 'native', sourceDigest, evidence: [`${id}.log`] };
  value.billingAttempts = value.cases.map(item => ({ id: item.taskId, taskId: item.taskId, kind: 'media', billing: 'settled', costCNY: item.costCNY, evidence: ['billing.json'] }));
  value.billingAttempts.push({ id: 'chat-1', kind: 'chat', billing: 'settled', costCNY: 1, evidence: ['chat-billing.json'] });
  value.spentCNY = value.billingAttempts.reduce((sum, item) => sum + item.costCNY, 0);
  return value;
}

test('v1.7.13 contract 3 preserves twelve cases, adds native capabilities and reconciles CNY50', () => {
  const { dir, run, save } = setupRepo('v1.7.13');
  try {
    const digest = run('--fingerprint').trim();
    const valid = makeV3('v1.7.13', digest);
    save(valid); assert.match(run(), /12\/12/);
    assert.equal(releaseContractVersion('v1.7.12'), 2);
    assert.equal(releaseContractVersion('v1.7.13'), 3);
    assert.equal(releaseContractVersion('v2.0.0'), 3);
    assert.equal(inspectFixtureManifest(valid.scenario.fixtures, 3).ok, true);
    assert.equal(inspectFixtureManifest(valid.scenario.fixtures, 2).ok, false);
    const mutations = [
      r => r.contractVersion = 2, r => r.contractVersion = 4,
      r => r.budgetCNY = 51, r => r.spentCNY = 51, r => r.pendingCNY = 1,
      r => r.review.independent = false, r => delete r.scenario.fixtures['voice.wav'],
      r => r.cases.pop(), r => r.cases[0].confirmed = false,
      r => delete r.billingAttempts, r => r.billingAttempts.pop(),
      r => r.billingAttempts[0].billing = 'pending', r => r.billingAttempts[0].costCNY = null,
      r => r.billingAttempts[0].evidence = [], r => r.billingAttempts[0].taskId = 'unrelated',
      r => r.billingAttempts.push(r.billingAttempts[0]),
      r => r.liveTestWaiver = { approvedBy: 'Ender', instruction: '上线吧 豁免了 飞书文档你再看看还要不要更新', scope: 'seedance-unified-display' },
      r => r.ownerException = { approvedBy: 'Ender', instruction: '上线吧' },
    ];
    for (const id of DURABLE_AGENT_CHECK_IDS) mutations.push(r => delete r.agentChecks[id], r => r.agentChecks[id].sourceDigest = 'old', r => r.agentChecks[id].method = 'fixture');
    // Historical waivers cannot excuse v3 evidence or a missing matrix.
    for (const mutate of mutations) {
      const invalid = structuredClone(valid); mutate(invalid); save(invalid); assert.throws(() => run());
    }
    const waived = structuredClone(valid); waived.cases = []; waived.liveTestWaiver = { approvedBy: 'Ender', instruction: '上线吧 豁免了 飞书文档你再看看还要不要更新', scope: 'seedance-unified-display' };
    save(waived); assert.throws(() => run());
    for (const id of ['native_video', 'native_audio', 'skill_version', 'skill_files', 'permission_modes', 'external_business', 'media_film_review']) {
      const invalid = structuredClone(valid); invalid.agentChecks[id].method = 'deterministic'; save(invalid); assert.throws(() => run());
    }
    const fault = structuredClone(valid); fault.agentChecks.durable_resume.method = 'deterministic'; save(fault); assert.match(run(), /12\/12/);
    const refunds = structuredClone(valid); refunds.billingAttempts.push({ id: 'failed-refunded', kind: 'chat', billing: 'refunded', costCNY: 0, evidence: ['refund.json'] }); save(refunds); assert.match(run(), /12\/12/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const version of ['v1.7.3', 'v1.7.5', 'v1.7.6', 'v1.7.7', 'v1.7.8']) test(`${version} waiver requires current targeted evidence and cannot carry forward`, () => {
  const { dir, run, save, commitVersion } = setupRepo(version);
  try {
    const sourceDigest = run('--fingerprint').trim();
    const proof = { status: 'passed', sourceDigest, evidence: ['synthetic-test-evidence'] };
    const valid = {
      version, sourceDigest, budgetCNY: 0, spentCNY: 0, newSpentCNY: 0, pendingCNY: 0,
      liveMatrixStatus: 'not_run_owner_waived', cases: [], releaseComplete: false,
      liveTestWaiver: { approvedBy: 'Ender', instruction: '本版豁免付费矩阵，专项验收、独立复审和 CI 通过后发布', scope: 'byok-updater-targeted-acceptance' },
      priorFinancialUncertainty: { status: 'unresolved', carriedFromVersion: 'v1.7.2', pendingCNY: null, failedRequestIds: ['202610020816334239151708268d9d6eZ5lRPwt', '202610021242434383740578268d9d6BAoXA1u1'], evidence: ['prior.json'] },
      review: { result: 'approved', independent: true, reviewer: 'test-only', sourceDigest, evidence: ['review.md'] },
      upgrade: { preservedData: true, sourceDigest, evidence: ['upgrade.md'] },
      verification: Object.fromEntries(['modelServiceFlow', 'credentialPersistence', 'saveBarrier', 'localReleaseGate', 'ci'].map(id => [id, { ...proof }])),
      packages: { status: 'pending_release_workflow', finalArchiveSmokeBeforeUpload: true, windowsReleasedUpgradeAndRollbackBeforeUpload: true, workflowEvidence: ['workflow.yml'] },
    };
    if (version === 'v1.7.5') {
      valid.liveTestWaiver = { approvedBy: 'Ender', instruction: '合了一起发布吧', scope: 'byok-download-resume-targeted-acceptance' };
      for (const id of ['fullReferenceContract', 'relativeDownload', 'nativePlaybackAndSave', 'updaterResume', 'privacyScan']) valid.verification[id] = { ...proof, method: 'native' };
      for (const id of ['fullReferenceContract', 'relativeDownload', 'nativePlaybackAndSave', 'updaterResume', 'privacyScan']) {
        const missing = structuredClone(valid); delete missing.verification[id]; save(missing); assert.throws(() => run());
      }
      const nonNative = structuredClone(valid); nonNative.verification.nativePlaybackAndSave.method = 'static'; save(nonNative); assert.throws(() => run());
      const oldWaiver = structuredClone(valid); oldWaiver.liveTestWaiver.instruction = '本版豁免付费矩阵，专项验收、独立复审和 CI 通过后发布'; save(oldWaiver); assert.throws(() => run());
    }
    if (version === 'v1.7.6') {
      valid.liveTestWaiver.scope = 'workspace-assets-targeted-acceptance';
      valid.verification = Object.fromEntries(['uploadLifecycle', 'deleteConfirmation', 'archivedRecovery', 'mediaPreview', 'localReleaseGate', 'ci'].map(id => [id, { ...proof }]));
      for (const id of Object.keys(valid.verification)) {
        const missing = structuredClone(valid); delete missing.verification[id]; save(missing); assert.throws(() => run());
      }
    }
    if (version === 'v1.7.7') {
      valid.liveTestWaiver = { approvedBy: 'Ender', instruction: '本版豁免付费矩阵，专项验收、review 和 CI 通过后发布', scope: 'reference-media-targeted-acceptance' };
      valid.verification = Object.fromEntries(['mediaAdmission', 'referenceLinks', 'preparationStage', 'configScalars', 'localReleaseGate', 'ci'].map(id => [id, { ...proof }]));
      for (const id of Object.keys(valid.verification)) {
        const missing = structuredClone(valid); delete missing.verification[id]; save(missing); assert.throws(() => run());
      }
    }
    if (version === 'v1.7.8') {
      valid.liveTestWaiver = { approvedBy: 'Ender', instruction: '豁免  你只要复现并且保证修复  同时你现在让一个子agent去看看还有没有这类bug 审计一下', scope: 'video-preview-audio-targeted-acceptance' };
      valid.verification = Object.fromEntries(['previewRegression', 'configRecovery', 'typeAudit', 'localReleaseGate', 'ci'].map(id => [id, { ...proof }]));
      for (const id of Object.keys(valid.verification)) {
        const missing = structuredClone(valid); delete missing.verification[id]; save(missing); assert.throws(() => run());
      }
    }
    save(valid); assert.match(run(), /paid matrix NOT run/);
    for (const mutate of [
      r => r.liveTestWaiver.approvedBy = 'other', r => r.review.independent = false,
      r => r.review.sourceDigest = 'stale', r => r.upgrade.preservedData = false,
      r => r.newSpentCNY = 1, r => r.cases = [{}], r => r.priorFinancialUncertainty.pendingCNY = 0,
      r => r.verification[version === 'v1.7.8' ? 'previewRegression' : version === 'v1.7.7' ? 'referenceLinks' : version === 'v1.7.6' ? 'archivedRecovery' : 'credentialPersistence'].status = 'failed', r => r.verification.ci.sourceDigest = 'stale',
      r => r.packages.windowsReleasedUpgradeAndRollbackBeforeUpload = false,
      r => r.releaseComplete = true, r => r.packages.status = 'passed',
    ]) {
      const changed = structuredClone(valid); mutate(changed); save(changed); assert.throws(() => run());
    }
    const next = version === 'v1.7.3' ? 'v1.7.4' : version === 'v1.7.5' ? 'v1.7.6' : version === 'v1.7.6' ? 'v1.7.7' : version === 'v1.7.7' ? 'v1.7.8' : 'v1.7.9';
    commitVersion(next);
    save({ ...valid, version: next, sourceDigest: run('--fingerprint').trim() }, next);
    assert.throws(() => run());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v1.7.2 paid-generation waiver requires targeted evidence and preserves prior uncertainty', () => {
  const { dir, run, save, commitVersion } = setupRepo('v1.7.2');
  try {
    const sourceDigest = run('--fingerprint').trim();
    const requestIds = ['202610020816334239151708268d9d6eZ5lRPwt', '202610021242434383740578268d9d6BAoXA1u1'];
    const platforms = ['darwin-arm64', 'darwin-amd64', 'windows-amd64'];
    const checkIds = ['mcpStartup', 'assistantRuntime', 'windowsNativeRuntime', 'packagedCLI', 'localReleaseGate', 'ci'];
    const valid = {
      version: 'v1.7.2', sourceDigest, budgetCNY: 100, spentCNY: 43.74479, newSpentCNY: 0,
      pendingCNY: null, knownPendingCNY: 0, cases: [], liveMatrixStatus: 'not_run_owner_waived', releaseComplete: false,
      liveTestWaiver: { approvedBy: 'Ender', instruction: '本版豁免付费生成，专项验收通过后上线', scope: 'mcp-assistant-targeted-acceptance' },
      financialUncertainty: { status: 'unresolved', carriedFromVersion: 'v1.7.1', failedRequestIds: requestIds, evidence: ['prior-financial-audit.md'] },
      review: { result: 'approved', independent: true, reviewer: 'independent-test-reviewer', sourceDigest, evidence: ['review.md'] },
      upgrade: { preservedData: true, sourceDigest, evidence: ['upgrade.md'] },
      verification: Object.fromEntries(checkIds.map(id => [id, { status: 'passed', sourceDigest, evidence: [`${id}.md`] }])),
    };
    valid.verification.windowsNativeRuntime.method = 'native';
    Object.assign(valid.verification.packagedCLI, {
      method: 'package-validator', platforms, finalArchiveSmokeBeforeUpload: true,
      releaseWorkflowEvidence: ['release-desktop.yml#archive-validation-before-upload'], finalArchivesStatus: 'pending_release_workflow',
    });
    save(valid);
    assert.match(run(), /media matrix NOT run; new expense 0; two prior refund terminal states remain unknown; final archives: pending_release_workflow/);
    const mutations = [
      r => r.sourceDigest = 'stale', r => r.pendingCNY = 0, r => r.pendingCNY = 1,
      r => r.knownPendingCNY = 1, r => r.spentCNY = 0, r => r.newSpentCNY = 1,
      r => r.financialUncertainty.status = 'settled', r => r.financialUncertainty.carriedFromVersion = 'v1.6.23',
      r => r.financialUncertainty.failedRequestIds.pop(), r => r.financialUncertainty.failedRequestIds.push('extra'),
      r => r.financialUncertainty.evidence = [], r => delete r.financialUncertainty,
      r => r.liveTestWaiver.approvedBy = 'other', r => r.liveTestWaiver.scope = 'model-picker-targeted-acceptance',
      r => r.liveTestWaiver.instruction = '上线吧', r => r.review.independent = false,
      r => r.review.sourceDigest = 'stale', r => r.review.result = 'pending', r => r.review.evidence = [],
      r => r.upgrade.preservedData = false, r => r.upgrade.sourceDigest = 'stale', r => r.upgrade.evidence = [],
      r => r.cases.push({ status: 'succeeded' }), r => r.liveMatrixStatus = 'passed',
      r => r.verification.windowsNativeRuntime.method = 'cross-compiled',
      r => r.verification.packagedCLI.method = 'mocked-final-archives',
      r => r.verification.packagedCLI.platforms.pop(), r => r.verification.packagedCLI.platforms.push('linux-amd64'),
      r => r.verification.packagedCLI.finalArchiveSmokeBeforeUpload = false,
      r => r.verification.packagedCLI.releaseWorkflowEvidence = [],
      r => r.verification.packagedCLI.finalArchivesStatus = 'passed',
      r => r.verification.packagedCLI.finalArchivesStatus = 'waived',
      r => r.verification.packagedCLI.finalArchives = { 'windows-amd64': { status: 'passed' } },
      r => r.releaseComplete = true,
    ];
    for (const id of checkIds) {
      mutations.push(r => delete r.verification[id], r => r.verification[id].status = 'pending',
        r => r.verification[id].evidence = [], r => r.verification[id].sourceDigest = 'stale');
    }
    for (const mutate of mutations) {
      const invalid = structuredClone(valid); mutate(invalid); save(invalid); assert.throws(() => run());
    }
    const completed = structuredClone(valid);
    completed.releaseComplete = true;
    completed.verification.packagedCLI.finalArchivesStatus = 'passed';
    completed.verification.packagedCLI.finalArchives = Object.fromEntries(platforms.map(platform => [platform, {
      status: 'passed', sourceDigest, sha256: 'a'.repeat(64), evidence: [`${platform}-archive-smoke.md`],
    }]));
    save(completed); assert.match(run(), /final archives: passed/);
    for (const platform of platforms) {
      for (const field of ['status', 'sourceDigest', 'sha256', 'evidence']) {
        const invalid = structuredClone(completed); delete invalid.verification.packagedCLI.finalArchives[platform][field];
        save(invalid); assert.throws(() => run());
      }
    }
    commitVersion('v1.7.3');
    save({ ...valid, version: 'v1.7.3', sourceDigest: run('--fingerprint').trim() }, 'v1.7.3');
    assert.throws(() => run());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v1.7.1 targeted acceptance preserves uncertainty and never carries forward', () => {
  const { dir, run, save, commitVersion } = setupRepo('v1.7.1');
  try {
    const sourceDigest = run('--fingerprint').trim();
    const requestIds = ['202610020816334239151708268d9d6eZ5lRPwt', '202610021242434383740578268d9d6BAoXA1u1'];
    const instruction = '上线吧 1.7.1 值得一个大版本';
    const valid = {
      version: 'v1.7.1', sourceDigest, budgetCNY: 100, spentCNY: 43.74479, newSpentCNY: 0,
      pendingCNY: null, knownPendingCNY: 0, cases: [], liveMatrixStatus: 'not_run_owner_waived',
      liveTestWaiver: { approvedBy: 'Ender', instruction, scope: 'model-picker-targeted-acceptance' },
      financialUncertainty: { status: 'unresolved', failedRequestIds: requestIds },
      financialEvidenceException: { approvedBy: 'Ender', instruction, scope: 'two-failed-chat-refund-evidence-only', requestIds, evidence: ['audit.md'] },
      review: { result: 'approved', reviewer: 'independent', sourceDigest, evidence: ['review.md'] },
      upgrade: { preservedData: true },
      verification: Object.fromEntries(['modelPicker', 'authorizationDefaultRecovery', 'saveBarrier', 'localReleaseGate', 'ci'].map(id => [id, { status: 'passed', evidence: ['targeted.md'] }])),
    };
    save(valid); assert.match(run(), /media matrix NOT run/);
    for (const mutate of [r => r.pendingCNY = 0, r => r.newSpentCNY = 1,
      r => r.financialUncertainty.failedRequestIds.push('other'), r => r.financialEvidenceException.evidence = [],
      r => r.liveTestWaiver.instruction = '上线吧', r => r.review.sourceDigest = 'stale',
      r => r.review.result = 'pending', r => r.upgrade.preservedData = false,
      r => r.cases.push({status:'succeeded'}), r => r.liveMatrixStatus = 'passed',
      r => r.verification.modelPicker.evidence = [], r => delete r.verification.ci]) {
      const invalid = structuredClone(valid); mutate(invalid); save(invalid); assert.throws(() => run());
    }
    commitVersion('v1.7.2');
    save({ ...valid, version: 'v1.7.2', sourceDigest: run('--fingerprint').trim() }, 'v1.7.2');
    assert.throws(() => run());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v1.6.23 failed-chat evidence exception is exact and cannot waive media or future releases', () => {
  const { dir, run, save, commitVersion } = setupRepo('v1.6.23');
  try {
    const requestIds = ['202610020816334239151708268d9d6eZ5lRPwt', '202610021242434383740578268d9d6BAoXA1u1'];
    const valid = makeV2('v1.6.23', run('--fingerprint').trim(), {
      pendingCNY: null, knownPendingCNY: 0,
      financialUncertainty: { status: 'unresolved', failedRequestIds: requestIds },
      financialEvidenceException: { approvedBy: 'Ender', instruction: '上线吧', scope: 'two-failed-chat-refund-evidence-only', requestIds, evidence: ['financial-audit.json'] },
    });
    save(valid); assert.match(run(), /total pending remains unknown/);
    for (const mutate of [r => delete r.financialEvidenceException, r => r.knownPendingCNY = 1, r => r.pendingCNY = 1, r => r.pendingCNY = 0, r => delete r.financialEvidenceException.approvedBy, r => r.financialEvidenceException.requestIds = ['other'], r => r.financialUncertainty.failedRequestIds = [...requestIds, 'other'], r => r.financialEvidenceException.evidence = [], r => r.cases[0].billing = 'pending', r => r.cases.pop(), r => r.review.result = 'pending']) {
      const invalid = structuredClone(valid); mutate(invalid); save(invalid); assert.throws(() => run());
    }
    commitVersion('v1.6.24');
    save({ ...valid, version: 'v1.6.24', sourceDigest: run('--fingerprint').trim() }, 'v1.6.24');
    assert.throws(() => run(), /unresolved billing/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('canonical fixture digest matches historical bunny receipts', () => {
  assert.equal(fixtureDigestFromManifest(BUNNY_FIXTURES), '2714dc3b18420b1b9b266fef54883611185a71b2afb8fe78db13885fac07e2c6');
  assert.equal(inspectFixtureManifest(BUNNY_FIXTURES).ok, true);
  assert.equal(inspectFixtureManifest({ 'only.jpg': 'a'.repeat(64), 'clip.mp4': 'b'.repeat(64) }).ok, false);
  assert.equal(inspectFixtureManifest({ 'a.jpg': 'a'.repeat(64), 'b.jpg': 'a'.repeat(64), 'c.mp4': 'b'.repeat(64) }).ok, false);
});

test('theme/agent contract starts at v1.6.23 and stays closed for unknown versions', () => {
  assert.equal(requiresThemeAgentContract('v1.6.22'), false);
  assert.equal(requiresThemeAgentContract(THEME_AGENT_SINCE), true);
  assert.equal(requiresThemeAgentContract('v1.6.24'), true);
  assert.equal(requiresThemeAgentContract('v1.7.0'), true);
  assert.equal(requiresThemeAgentContract('v2.0.0'), true);
  assert.throws(() => requiresThemeAgentContract('1.6.23'), /unparseable VERSION/);
  const prior = { contractVersion: 2, version: 'v1.6.23', scenario: makeScenario(themeFixtures()) };
  const digest = fixtureDigestFromManifest(themeFixtures());
  assert.ok(findCopiedPriorTheme(makeScenario(themeFixtures()), digest, [prior]));
  assert.equal(findCopiedPriorTheme(makeScenario(themeFixtures('a'), { id: 'new-theme' }), digest, [{ ...prior, contractVersion: 1 }]), null);
});

test('release receipt rejects incomplete, stale, reused and unbalanced evidence', () => {
  const { dir, git, run, save } = setupRepo('v1.6.17');
  try {
    const valid = { version: 'v1.6.17', sourceDigest: run('--fingerprint').trim(), budgetCNY: 50, spentCNY: 12, pendingCNY: 0, upgrade: { preservedData: true, generationVerified: true }, cases: [1, 2].flatMap(round => PATHS.map(path => ({ round, path, taskId: `${round}/${path}`, providerRequestId: `${round}/${path}`, clientVersion: 'v1.6.17', platform: 'test-only', fixtureDigest: 'a'.repeat(64), model: 'test-only', status: 'succeeded', clientSubmitted: true, canvasVerified: true, mediaDecoded: true, mediaOpened: true, billing: 'settled', costCNY: 1, artifactSHA256: 'b'.repeat(64) }))) };
    save(valid); assert.match(run(), /12\/12/);
    for (const mutate of [r => r.cases.pop(), r => r.sourceDigest = 'old', r => r.cases[1].taskId = r.cases[0].taskId, r => r.cases[0].clientSubmitted = false, r => r.cases[0].clientVersion = 'v1.6.16', r => r.pendingCNY = 1, r => r.spentCNY = 51, r => r.spentCNY = 1]) {
      const invalid = structuredClone(valid); mutate(invalid); save(invalid); assert.throws(() => run());
    }
    mkdirSync(join(dir, 'agent-host'));
    for (const file of ['server.mjs', 'bun.lock', 'package.json']) {
      const current = { ...valid, sourceDigest: run('--fingerprint').trim() };
      save(current); assert.match(run(), /12\/12/);
      writeFileSync(join(dir, 'agent-host', file), `changed ${file}\n`);
      git('add', `agent-host/${file}`);
      git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', `host ${file}`);
      assert.notEqual(run('--fingerprint').trim(), current.sourceDigest);
      assert.throws(() => run(), /receipt does not match this release source/);
    }
    for (const version of ['v1.6.18', 'v1.6.19', 'v1.6.20']) {
      writeFileSync(join(dir, 'VERSION'), `${version}\n`);
      git('add', 'VERSION'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', version);
      const waiver = { ...valid, version, sourceDigest: run('--fingerprint').trim(), cases: [], liveTestWaiver: { approvedBy: 'Ender', instruction: '没事 这轮就不用实测了' }, verification: { windowsNativeRegression: 'passed' }, review: { result: 'approved' } };
      const saveWaiver = r => save(r, version);
      saveWaiver(waiver);
      if (version === 'v1.6.18') {
        assert.match(run(), /waived by owner.*live matrix NOT completed/);
        for (const mutate of [r => r.sourceDigest = 'old', r => r.pendingCNY = 1, r => r.liveTestWaiver.approvedBy = 'unknown', r => r.review.result = 'pending', r => r.verification.windowsNativeRegression = 'unverified']) {
          const invalid = structuredClone(waiver); mutate(invalid); saveWaiver(invalid); assert.throws(() => run());
        }
      } else {
        assert.throws(() => run());
        const directRelease = { ...waiver, liveTestWaiver: { approvedBy: 'Ender', instruction: '发布吧' }, verification: { localReleaseGate: 'passed', errorRegression: 'passed' } };
        saveWaiver(directRelease);
        if (version === 'v1.6.19') {
          assert.match(run(), /waived by owner.*live matrix NOT completed/);
          for (const mutate of [r => r.sourceDigest = 'old', r => r.pendingCNY = 1, r => r.spentCNY = 51, r => r.liveTestWaiver.approvedBy = 'unknown', r => r.review.result = 'pending', r => r.verification.errorRegression = 'unverified', r => r.verification.localReleaseGate = 'unverified', r => r.upgrade.preservedData = false]) {
            const invalid = structuredClone(directRelease); mutate(invalid); saveWaiver(invalid); assert.throws(() => run());
          }
        } else {
          assert.throws(() => run());
          const downloadOnly = { ...valid, version, sourceDigest: run('--fingerprint').trim(), budgetCNY: 0, spentCNY: 0, pendingCNY: 0, cases: [], liveTestWaiver: { approvedBy: 'Ender', instruction: '本版豁免付费生成矩阵，review 通过就发布（推荐）' }, verification: { windowsDownloads: 'passed', ci: 'passed' }, review: { result: 'approved' }, upgrade: { preservedData: true } };
          saveWaiver(downloadOnly);
          assert.match(run(), /waived by owner.*live matrix NOT completed/);
          for (const mutate of [r => r.sourceDigest = 'old', r => r.pendingCNY = 1, r => r.spentCNY = 1, r => r.liveTestWaiver.approvedBy = 'unknown', r => r.review.result = 'pending', r => r.verification.windowsDownloads = 'unverified', r => r.verification.ci = 'unverified', r => r.upgrade.preservedData = false]) {
            const invalid = structuredClone(downloadOnly); mutate(invalid); saveWaiver(invalid); assert.throws(() => run());
          }
        }
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v1.6.23+ requires theme, shared fixtures and native assistant evidence', () => {
  const { dir, run, save, commitVersion } = setupRepo('v1.6.23');
  try {
    const sourceDigest = run('--fingerprint').trim();
    const valid = makeV2('v1.6.23', sourceDigest);
    save(valid);
    assert.match(run(), /12\/12/);

    for (const [mutate, pattern] of [
      [r => { delete r.contractVersion; }, /explicit contractVersion=2 is required/],
      [r => { r.contractVersion = 1; }, /explicit contractVersion=2 is required/],
      [r => { r.contractVersion = 3; }, /explicit contractVersion=2 is required/],
      [r => { r.contractVersion = '2'; }, /explicit contractVersion=2 is required/],
      [r => { delete r.review; }, /independent review must approve/],
      [r => { r.review.result = 'pending'; }, /independent review must approve/],
      [r => { r.review.result = 'rejected'; }, /independent review must approve/],
      [r => { r.review.sourceDigest = 'old'; }, /independent review must approve/],
      [r => { r.review.reviewer = ' '; }, /independent review must approve/],
      [r => { r.review.evidence = []; }, /independent review must approve/],
      [r => { r.review.evidence = [' ']; }, /independent review must approve/],
      [r => { r.scenario.id = ''; }, /scenario must include nonempty id, title, source URL and query date/],
      [r => { r.scenario.title = ' '; }, /scenario must include nonempty id, title, source URL and query date/],
      [r => { r.scenario.source = 'ftp://example.invalid/trends'; }, /scenario must include nonempty id, title, source URL and query date/],
      [r => { r.scenario.queryDate = '2026/10/02'; }, /scenario must include nonempty id, title, source URL and query date/],
      [r => { r.scenario.fixtures = { 'only.jpg': 'c'.repeat(64), 'clip.mp4': 'd'.repeat(64) }; }, /fixture manifest must include at least two image and one video SHA256/],
      [r => { r.scenario.fixtures = { 'a.jpg': 'c'.repeat(64), 'b.png': 'd'.repeat(64) }; }, /fixture manifest must include at least two image and one video SHA256/],
      [r => { r.cases[0].fixtureDigest = 'f'.repeat(64); }, /cases must share the scenario fixtureDigest/],
      [r => { r.cases.pop(); }, /expected exactly twelve successful cases/],
      [r => { r.cases[1].taskId = r.cases[0].taskId; }, /missing or reused task/],
      [r => { r.cases[0].entrypoint = 'canvas'; }, /incomplete assistant provenance/],
      [r => { r.cases[0].sessionId = ''; }, /incomplete assistant provenance/],
      [r => { r.cases[0].turnId = ' '; }, /incomplete assistant provenance/],
      [r => { r.cases[0].proposalId = ''; }, /incomplete assistant provenance/],
      [r => { delete r.cases[0].operationId; }, /incomplete assistant provenance/],
      [r => { r.cases[0].operationId = ' '; }, /incomplete assistant provenance/],
      [r => { r.cases[0].confirmed = false; }, /incomplete assistant provenance/],
      [r => { r.sourceDigest = 'old'; }, /receipt does not match this release source/],
      [r => { delete r.agentChecks; }, /boolean-only agent coverage is not accepted/],
      [r => { r.agentChecks = true; }, /boolean-only agent coverage is not accepted/],
      [r => { r.agentChecks.canvas_read = true; }, /boolean-only agent coverage is not accepted/],
      [r => { delete r.agentChecks.cli_mcp; }, /agentChecks must include cli_mcp/],
      [r => { r.agentChecks.budget.evidence = []; }, /agentChecks must include budget/],
      [r => { r.agentChecks.canvas_read.method = 'deterministic'; }, /agent check canvas_read must use native method/],
      [r => { r.agentChecks.multi_turn.method = 'deterministic'; }, /agent check multi_turn must use native method/],
      [r => { r.agentChecks.cli_mcp.method = 'deterministic'; }, /agent check cli_mcp must use native method/],
      [r => { r.agentChecks.session_history.sourceDigest = 'a'.repeat(64); }, /agent check session_history sourceDigest does not match this release source/],
      [r => { r.liveTestWaiver = { approvedBy: 'Ender', instruction: '没事 这轮就不用实测了' }; r.cases = []; }, /expected exactly twelve successful cases/],
    ]) {
      const invalid = structuredClone(valid);
      mutate(invalid);
      save(invalid);
      assert.throws(() => run(), pattern);
    }

    save(valid);
    assert.match(run(), /12\/12/);

    const bunny = makeV2('v1.6.23', sourceDigest, { fixtures: BUNNY_FIXTURES });
    save({ version: 'v1.6.22', cases: [{ fixtureDigest: fixtureDigestFromManifest(BUNNY_FIXTURES) }] }, 'v1.6.22');
    save(bunny);
    assert.throws(() => run(), /copied preceding release scenario or fixtures/);

    commitVersion('v1.6.24');
    const nextDigest = run('--fingerprint').trim();
    const copied = makeV2('v1.6.24', nextDigest, { fixtures: themeFixtures() });
    copied.scenario = structuredClone(valid.scenario);
    copied.cases = makeCases('v1.6.24', fixtureDigestFromManifest(valid.scenario.fixtures));
    copied.agentChecks = makeChecks(nextDigest);
    save(copied, 'v1.6.24');
    save(valid, 'v1.6.23');
    assert.throws(() => run(), /copied preceding release scenario or fixtures/);

    copied.scenario.id = 'harbor-rain-2026';
    save(copied, 'v1.6.24');
    assert.throws(() => run(), /copied preceding release scenario or fixtures/);

    const rotated = makeV2('v1.6.24', nextDigest, { fixtures: themeFixtures('a') });
    rotated.scenario.id = 'harbor-rain-2026';
    save(rotated, 'v1.6.24');
    assert.match(run(), /12\/12/);

    save(copied, 'v1.6.24');
    rmSync(join(dir, 'docs/release-evidence/v1.6.23.json'));
    assert.match(run(), /12\/12/);

    for (const major of ['v1.7.0', 'v2.0.0']) {
      commitVersion(major);
      const digest = run('--fingerprint').trim();
      const incomplete = { version: major, sourceDigest: digest, budgetCNY: 50, spentCNY: 12, pendingCNY: 0, upgrade: { preservedData: true, generationVerified: true }, cases: makeCases(major, 'a'.repeat(64)) };
      incomplete.cases.forEach(item => { delete item.entrypoint; delete item.sessionId; delete item.turnId; delete item.proposalId; delete item.confirmed; });
      save(incomplete, major);
      assert.throws(() => run(), new RegExp(`explicit contractVersion=${releaseContractVersion(major)} is required`));
      const fixtures = themeFixtures(major === 'v1.7.0' ? 'a' : '0');
      const next = releaseContractVersion(major) === 3 ? makeV3(major, digest, { fixtures: { ...fixtures, 'voice.wav': 'f'.repeat(64) } }) : makeV2(major, digest, { fixtures });
      next.scenario.id = `${major}-theme`;
      save(next, major);
      assert.match(run(), /12\/12/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function makeDeferredV1713(sourceDigest) {
  const value = makeV3('v1.7.13', sourceDigest);
  value.ownerException = { scope: 'release-before-remaining-acceptance-20261008', approvedBy: 'Ender', instruction: '提高到100元 你可以先上线 补测剩下的', evidence: ['owner-authorization.md'] };
  Object.assign(value, { budgetCNY: 100, historicalSpentCNY: 42.413106, spentCNY: 42.413106, newSpentCNY: 0, pendingCNY: 0, knownPendingCNY: 0, liveMatrixStatus: 'pending_after_release', agentAcceptanceStatus: 'pending_after_release', releasePublished: false, acceptanceComplete: false, releaseComplete: false, cases: [] });
  const historicalDigest = 'a'.repeat(64);
  value.billingAttempts = [{ id: 'historic-cost', kind: 'other', phase: 'historical', executedSourceDigest: historicalDigest, billing: 'settled', costCNY: 42.413106, evidence: ['historical-ledger.json'] }, { id: 'historic-chat', kind: 'chat', phase: 'historical', executedSourceDigest: historicalDigest, billing: 'settled', costCNY: 0, evidence: ['historical-ledger.json'] }];
  const ids = [...REQUIRED_AGENT_CHECK_IDS, ...DURABLE_AGENT_CHECK_IDS];
  value.agentChecks = Object.fromEntries(ids.map(id => [id, { status: 'pending_after_release' }]));
  value.deferredAcceptance = { status: 'pending_after_release', caseKeys: [1, 2].flatMap(round => PATHS.map(path => `${round}/${path}`)), agentCheckIds: ids, historicalEvidence: ['media_matrix', 'agent_checks'].map(kind => ({ kind, sourceDigest: historicalDigest, evidence: ['historical-source-receipt.json'] })) };
  value.upgrade = { preservedData: true, sourceDigest, evidence: ['data-preservation.json'] };
  value.verification = Object.fromEntries(['localReleaseGate', 'ci'].map(id => [id, { status: 'passed', sourceDigest, evidence: [`${id}.json`] }]));
  value.packages = { status: 'pending_release_workflow', archives: null, platforms: ['darwin-arm64', 'darwin-amd64', 'windows-amd64'], windowsReleasedUpgradeAndRollbackBeforeUpload: true, finalArchiveSmokeBeforeUpload: true, signedManifestBeforePublish: true, publicReadbackAfterPublish: true, workflowEvidence: ['release-desktop.yml'] };
  return value;
}

test('v1.7.13 exact owner authorization defers only live acceptance and keeps CNY100 total and release gates', () => {
  const { dir, run, save } = setupRepo('v1.7.13');
  try {
    const valid = makeDeferredV1713(run('--fingerprint').trim());
    save(valid); assert.match(run(), /acceptance PENDING/);
    const superseded = structuredClone(valid);
    superseded.billingAttempts.push({ id: 'superseded-chat', kind: 'chat', phase: 'superseded_candidate', executionSourceStatus: 'known', executedSourceDigest: 'b'.repeat(64), billing: 'settled', costCNY: 0.070210, evidence: ['actual-superseded-chat-bill.json'] });
    superseded.spentCNY += 0.070210; superseded.newSpentCNY = 0.070210;
    save(superseded); assert.match(run(), /acceptance PENDING/);
    for (const mutate of [r => r.billingAttempts.at(-1).executedSourceDigest = r.sourceDigest,
      r => r.billingAttempts.at(-1).executedSourceDigest = null,
      r => r.billingAttempts.at(-1).executionSourceStatus = 'unknown',
      r => delete r.billingAttempts.at(-1).executionSourceStatus,
      r => r.billingAttempts.at(-1).billing = 'pending', r => r.billingAttempts.at(-1).evidence = [],
      r => { r.billingAttempts.at(-1).costCNY = 60; r.spentCNY = 102.413106; r.newSpentCNY = 60; },
      r => r.newSpentCNY = 0, r => r.historicalSpentCNY += 0.070210]) {
      const invalid = structuredClone(superseded); mutate(invalid); save(invalid); assert.throws(() => run());
    }
    const mutations = [
      r => r.ownerException.approvedBy = 'model', r => r.ownerException.instruction = '上线吧', r => r.ownerException.evidence = [], r => r.ownerException.scope = 'anything',
      r => r.budgetCNY = 101, r => r.historicalSpentCNY = 0, r => r.spentCNY = 0, r => r.newSpentCNY = 42.413106, r => r.pendingCNY = 1, r => r.knownPendingCNY = null,
      r => r.billingAttempts[0].billing = 'pending', r => r.billingAttempts[0].phase = 'current', r => r.billingAttempts[0].executedSourceDigest = r.sourceDigest, r => r.billingAttempts.push(r.billingAttempts[0]),
      r => r.liveMatrixStatus = 'passed', r => r.acceptanceComplete = true, r => r.releaseComplete = true,
      r => r.deferredAcceptance.caseKeys.pop(), r => r.deferredAcceptance.agentCheckIds.pop(), r => r.agentChecks.cancel.status = 'passed',
      r => r.deferredAcceptance.historicalEvidence[0].sourceDigest = r.sourceDigest, r => r.deferredAcceptance.historicalEvidence[0].kind = 'anything',
      r => r.review.independent = false, r => r.review.sourceDigest = 'old', r => r.upgrade.preservedData = false, r => r.verification.ci.status = 'pending',
      r => r.packages.platforms.pop(), r => r.packages.signedManifestBeforePublish = false, r => r.packages.windowsReleasedUpgradeAndRollbackBeforeUpload = false, r => r.packages.publicReadbackAfterPublish = false,
    ];
    for (const mutate of mutations) { const invalid = structuredClone(valid); mutate(invalid); save(invalid); assert.throws(() => run()); }
    for (const status of ['unknown', 'not_app_execution']) {
      const honest = structuredClone(valid); honest.billingAttempts[0].executedSourceDigest = null; honest.billingAttempts[0].executionSourceStatus = status;
      save(honest); assert.match(run(), /acceptance PENDING/);
      delete honest.billingAttempts[0].executionSourceStatus; save(honest); assert.throws(() => run());
      honest.billingAttempts[0].executionSourceStatus = status; honest.billingAttempts[0].phase = 'current'; save(honest); assert.throws(() => run());
    }
    const currentReview = structuredClone(valid); currentReview.spentCNY += 0.02; currentReview.newSpentCNY = 0.02;
    currentReview.billingAttempts.push({ id: 'current-independent-review', kind: 'other', phase: 'current', executedSourceDigest: null, executionSourceStatus: 'not_app_execution', reviewedSourceDigest: valid.sourceDigest, billing: 'settled', costCNY: 0.02, evidence: ['actual-review-bill.json'] });
    save(currentReview); assert.match(run(), /acceptance PENDING/);
    for (const mutate of [r => r.billingAttempts.at(-1).kind = 'media', r => r.billingAttempts.at(-1).kind = 'chat', r => delete r.billingAttempts.at(-1).reviewedSourceDigest, r => r.billingAttempts.at(-1).reviewedSourceDigest = 'a'.repeat(64), r => r.billingAttempts.at(-1).executionSourceStatus = 'unknown', r => r.billingAttempts.at(-1).evidence = []]) {
      const invalid = structuredClone(currentReview); mutate(invalid); save(invalid); assert.throws(() => run());
    }
    const partial = structuredClone(valid);
    const item = makeCases('v1.7.13', fixtureDigestFromManifest(valid.scenario.fixtures))[0];
    Object.assign(item, { executedSourceDigest: valid.sourceDigest, evidence: ['current-media.json'] });
    partial.cases = [item]; partial.deferredAcceptance.caseKeys = partial.deferredAcceptance.caseKeys.filter(key => key !== '1/text-image');
    partial.billingAttempts.push({ id: 'current-media', taskId: item.taskId, kind: 'media', phase: 'current', executedSourceDigest: valid.sourceDigest, billing: 'settled', costCNY: 1, evidence: ['current-media-bill.json'] });
    partial.spentCNY += 1; partial.newSpentCNY = 1; save(partial); assert.match(run(), /11\/12 cases/);
    const obsoleteBill = structuredClone(partial);
    Object.assign(obsoleteBill.billingAttempts.at(-1), { phase: 'superseded_candidate', executionSourceStatus: 'known', executedSourceDigest: 'b'.repeat(64) });
    save(obsoleteBill); assert.throws(() => run());
    for (const mutate of [r => r.cases[0].executedSourceDigest = 'a'.repeat(64), r => r.cases[0].confirmed = false, r => r.cases[0].mediaOpened = false, r => r.cases[0].costCNY = 2, r => r.deferredAcceptance.caseKeys.push('1/text-image')]) {
      const invalid = structuredClone(partial); mutate(invalid); save(invalid); assert.throws(() => run());
    }
    const published = structuredClone(valid); published.releasePublished = true; published.packages.status = 'verified';
    published.packages.archives = published.packages.platforms.map(platform => ({ platform, sha256: 'b'.repeat(64), sourceDigest: valid.sourceDigest, evidence: ['actual-archive.json'] }));
    for (const id of ['signature', 'publicReadback', 'windowsReleasedUpgradeAndRollback', 'finalArchiveSmoke']) published.packages[id] = { status: 'passed', sourceDigest: valid.sourceDigest, evidence: [`actual-${id}.json`] };
    save(published); assert.match(run(), /acceptance PENDING/);
    for (const mutate of [r => r.packages.archives.pop(), r => r.packages.signature.status = 'pending', r => r.packages.windowsReleasedUpgradeAndRollback.sourceDigest = 'old']) {
      const invalid = structuredClone(published); mutate(invalid); save(invalid); assert.throws(() => run());
    }
    const completed = structuredClone(published);
    completed.deferredAcceptance.status = 'completed_after_release'; completed.deferredAcceptance.caseKeys = []; completed.deferredAcceptance.agentCheckIds = [];
    completed.liveMatrixStatus = 'passed'; completed.agentAcceptanceStatus = 'passed'; completed.acceptanceComplete = true; completed.releaseComplete = true;
    completed.cases = makeCases('v1.7.13', fixtureDigestFromManifest(valid.scenario.fixtures)).map(item => ({ ...item, executedSourceDigest: valid.sourceDigest, evidence: ['actual-current-case.json'] }));
    completed.agentChecks = Object.fromEntries([...REQUIRED_AGENT_CHECK_IDS, ...DURABLE_AGENT_CHECK_IDS].map(id => [id, { status: 'passed', method: 'native', sourceDigest: valid.sourceDigest, evidence: ['actual-current-check.json'] }]));
    completed.billingAttempts.push(...completed.cases.map(item => ({ id: item.taskId, taskId: item.taskId, kind: 'media', phase: 'current', executedSourceDigest: valid.sourceDigest, billing: 'settled', costCNY: item.costCNY, evidence: ['actual-current-bill.json'] })));
    completed.spentCNY += 12; completed.newSpentCNY = 12; save(completed); assert.match(run(), /acceptance COMPLETE: 12\/12 cases, 23\/23 checks/);
    for (const mutate of [r => { r.cases.pop(); r.deferredAcceptance.caseKeys = ['2/multi-video']; }, r => { r.agentChecks.native_audio.status = 'pending_after_release'; r.deferredAcceptance.agentCheckIds = ['native_audio']; }, r => r.releasePublished = false, r => r.budgetCNY = 101, r => r.packages.status = 'pending_release_workflow']) {
      const invalid = structuredClone(completed); mutate(invalid); save(invalid); assert.throws(() => run());
    }
    const checked = structuredClone(valid); checked.agentChecks.budget = { status: 'passed', sourceDigest: valid.sourceDigest, method: 'deterministic', evidence: ['budget.json'] }; checked.deferredAcceptance.agentCheckIds = checked.deferredAcceptance.agentCheckIds.filter(id => id !== 'budget'); save(checked); assert.match(run(), /acceptance PENDING/);
    checked.agentChecks.native_audio = { status: 'passed', sourceDigest: valid.sourceDigest, method: 'deterministic', evidence: ['audio.json'] }; checked.deferredAcceptance.agentCheckIds = checked.deferredAcceptance.agentCheckIds.filter(id => id !== 'native_audio'); save(checked); assert.throws(() => run());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v1.7.13 post-release acceptance authorization never carries into another version', () => {
  for (const version of ['v1.7.12', 'v1.7.14', 'v2.0.0']) {
    const { dir, run, save } = setupRepo(version);
    try { const value = makeDeferredV1713(run('--fingerprint').trim()); value.version = version; save(value); assert.throws(() => run()); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
