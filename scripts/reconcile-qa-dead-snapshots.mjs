import { readFile, writeFile } from 'node:fs/promises';

const QA_REPORT_PATH = 'data/qa-report.json';
const AMAZON_SNAPSHOT_PATH = 'data/amazon-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const AWS_COMPANY = 'Amazon Web Services';
const MAX_REPORT_AGE_MS = 2 * 60 * 60 * 1000;

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

function amazonRequisitionId(record = {}) {
  const idMatch = clean(record?.id).match(/^amazon-(\d+)$/i);
  if (idMatch) return idMatch[1];

  try {
    const parsed = new URL(clean(record?.sourceUrl || record?.url));
    if (!['amazon.jobs', 'www.amazon.jobs'].includes(parsed.hostname.toLowerCase())) return '';
    return parsed.pathname.match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?jobs\/(\d+)\b/i)?.[1] || '';
  } catch {
    return '';
  }
}

function reportIsCurrent(report = {}, status = {}, nowMs = Date.now()) {
  const checkedAt = clean(report?.checkedAt);
  if (!checkedAt || checkedAt !== clean(status?.postQa?.checkedAt)) return false;
  const checkedAtMs = Date.parse(checkedAt);
  if (!Number.isFinite(checkedAtMs)) return false;
  const ageMs = nowMs - checkedAtMs;
  return ageMs >= 0 && ageMs <= MAX_REPORT_AGE_MS;
}

function reconcileAmazonSnapshot(snapshot = [], report = {}, status = {}, nowMs = Date.now()) {
  if (!Array.isArray(snapshot)) throw new Error('AWS snapshot must be an array.');
  if (!reportIsCurrent(report, status, nowMs)) {
    return { kept: snapshot, removed: [], skipped: true, reason: 'QA report does not match the current fresh post-QA status.' };
  }

  const deadReqs = new Set((Array.isArray(report?.deadJobLinksRemoved) ? report.deadJobLinksRemoved : [])
    .filter(check => clean(check?.company) === AWS_COMPANY && clean(check?.state) === 'dead')
    .map(amazonRequisitionId)
    .filter(Boolean));

  if (!deadReqs.size) return { kept: snapshot, removed: [], skipped: false, reason: 'No confirmed-dead AWS links.' };

  const kept = [];
  const removed = [];
  for (const job of snapshot) {
    const req = amazonRequisitionId(job);
    if (clean(job?.company) === AWS_COMPANY && req && deadReqs.has(req)) removed.push(job);
    else kept.push(job);
  }

  return { kept, removed, skipped: false, reason: '' };
}

function applyAmazonStatus(status, retainedCount, removed, checkedAt) {
  const amazon = status?.amazonDatacenter;
  if (!amazon || typeof amazon !== 'object' || Array.isArray(amazon)) return;

  if (Number.isFinite(Number(amazon.qualifyingRoles))) amazon.qualifyingRoles = retainedCount;
  if (Number.isFinite(Number(amazon.preservedPreviousRoles)) && Number(amazon.preservedPreviousRoles) > 0) {
    amazon.preservedPreviousRoles = Math.min(Number(amazon.preservedPreviousRoles), retainedCount);
  }
  amazon.qaDeadSnapshotReconciliation = {
    checkedAt,
    removedRoles: removed.length,
    removedRequisitionIds: removed.map(amazonRequisitionId).filter(Boolean),
    policy: 'Nightly QA-confirmed 404/410 or generic-career redirects are removed from the preserved AWS snapshot so stale roles do not return during an active source fallback.'
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(`QA snapshot reconciliation regression: ${message}`);
}

function sampleJob(number, company = AWS_COMPANY) {
  return {
    id: `amazon-${number}`,
    company,
    sourceUrl: `https://www.amazon.jobs/en/jobs/${number}/data-center-technician`
  };
}

function runTests() {
  const checkedAt = '2026-09-22T09:40:00.000Z';
  const nowMs = Date.parse('2026-09-22T09:41:00.000Z');
  const status = { postQa: { checkedAt }, amazonDatacenter: { qualifyingRoles: 3, preservedPreviousRoles: 3 } };
  const snapshot = [sampleJob(1001), sampleJob(1002), sampleJob(1003)];
  const report = {
    checkedAt,
    deadJobLinksRemoved: [
      { ...sampleJob(1002), state: 'dead', status: 404, url: sampleJob(1002).sourceUrl },
      { id: '', company: AWS_COMPANY, state: 'dead', status: 410, url: sampleJob(1003).sourceUrl },
      { id: 'other-1', company: 'Other Employer', state: 'dead', status: 404, url: 'https://example.com/jobs/1' }
    ]
  };

  let result = reconcileAmazonSnapshot(snapshot, report, status, nowMs);
  assert(result.removed.length === 2 && result.kept.length === 1, 'current QA dead-link evidence must prune matching AWS snapshot roles.');
  assert(amazonRequisitionId(result.kept[0]) === '1001', 'unflagged AWS role must remain.');

  const mutatedStatus = structuredClone(status);
  applyAmazonStatus(mutatedStatus, result.kept.length, result.removed, checkedAt);
  assert(mutatedStatus.amazonDatacenter.qualifyingRoles === 1, 'AWS qualifying count must follow the reconciled snapshot.');
  assert(mutatedStatus.amazonDatacenter.preservedPreviousRoles === 1, 'preserved fallback count must follow the reconciled snapshot.');
  assert(mutatedStatus.amazonDatacenter.qaDeadSnapshotReconciliation.removedRoles === 2, 'status must record the exact QA prune count.');

  result = reconcileAmazonSnapshot(snapshot, { ...report, checkedAt: '2026-09-22T06:00:00.000Z' }, status, nowMs);
  assert(result.skipped && result.removed.length === 0, 'mismatched QA report/status timestamps must never prune a snapshot.');

  result = reconcileAmazonSnapshot(snapshot, report, status, Date.parse('2026-09-22T12:01:00.000Z'));
  assert(result.skipped && result.removed.length === 0, 'stale QA reports must never prune a snapshot.');

  console.log('QA dead-snapshot reconciliation regression tests passed.');
}

if (process.argv.includes('--test')) {
  runTests();
  process.exit(0);
}

const report = JSON.parse(await readFile(QA_REPORT_PATH, 'utf8'));
const snapshot = JSON.parse(await readFile(AMAZON_SNAPSHOT_PATH, 'utf8'));
const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
const result = reconcileAmazonSnapshot(snapshot, report, status);

if (result.skipped) {
  console.log(`AWS snapshot reconciliation skipped: ${result.reason}`);
  process.exit(0);
}
if (!result.removed.length) {
  console.log('AWS snapshot reconciliation found no QA-confirmed dead roles to remove.');
  process.exit(0);
}

applyAmazonStatus(status, result.kept.length, result.removed, report.checkedAt);
await writeFile(AMAZON_SNAPSHOT_PATH, `${JSON.stringify(result.kept, null, 2)}\n`);
await writeFile(STATUS_PATH, `${JSON.stringify(status, null, 2)}\n`);

console.log(`Reconciled AWS snapshot after live QA: removed ${result.removed.length} confirmed-dead role(s); ${result.kept.length} authoritative role(s) remain.`);
