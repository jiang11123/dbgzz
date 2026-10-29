import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateH3FamilyRelease } from './h3-family-release-contract.mjs';

test('family release rejects budget reset, missing bills, replay duplication and forward waiver', () => {
  // The real receipt supplies identities; pending checks are replaced only in
  // this synthetic gate test, never written back to the release receipt.
  const value = JSON.parse(readFileSync(new URL('../docs/release-evidence/v1.7.20.json', import.meta.url)));
  const digest = 'a'.repeat(64);
  value.sourceDigest = digest;
  value.review.result = 'approved';
  for (const section of [value.review, value.upgrade, value.candidateReopen, ...Object.values(value.verification)]) section.sourceDigest = digest;
  for (const check of Object.values(value.verification)) check.status = 'passed';
  Object.assign(value.candidateReopen, { byteExact: true, nativePlayback: true });
  validateH3FamilyRelease(value, digest);
  for (const mutate of [
    r => r.version = 'v1.7.21', r => r.sourceDigest = 'b'.repeat(64),
    r => r.ownerException.instruction = '都上吧', r => r.releaseAuthorization.scope = 'future versions',
    r => r.paidSubmissionLimit = 9, r => r.h3Funding.budgetCNY = 40,
    r => r.h3Funding.reservedUpperCNY = 20.01, r => r.priorH3Inference.count = 0,
    r => r.h3Funding.inferenceRequestIds.pop(), r => r.familyCalls[1].providerRequestId = r.familyCalls[0].providerRequestId,
    r => r.familyCalls[0].billing = 'reserved', r => r.familyCalls[2].costCNY = null,
    r => r.familyCalls[2].clientVersion = 'v1.7.20', r => r.familyCalls[2].executedCommit = '0'.repeat(40),
    r => r.familyCalls[1].referenceImages = 5, r => r.familyCalls[1].freeReferenceImages = 6,
    r => r.candidateReopen.newPaidSubmissions = 1, r => r.candidateReopen.byteExact = false,
    r => r.candidateReopen.nativePlayback = false, r => r.candidateReopen.h3ExecutionUnchanged = false,
    r => r.priorFinancialUncertainty.pendingCNY = 0, r => r.spentCNY = 0,
    r => r.review.independent = false, r => r.verification.ci.status = 'pending',
    r => r.packages.windowsReleasedUpgradeAndRollbackBeforeUpload = false,
    r => r.packages.platforms.pop(), r => r.releasePublished = true,
  ]) {
    const changed = structuredClone(value);
    mutate(changed);
    assert.throws(() => validateH3FamilyRelease(changed, digest));
  }
});
