import { readFile, writeFile } from 'node:fs/promises';

const QA_REPORT_PATH = 'data/qa-report.json';
const STATUS_PATH = 'data/collector-status.json';
const MAX_REPORT_AGE_MS = 2 * 60 * 60 * 1000;

const SOURCES = [
  {
    company: 'Amazon Web Services',
    snapshotPath: 'data/amazon-jobs.json',
    statusKey: 'amazonDatacenter',
    identity: amazonRequisitionId,
    policy: 'Nightly QA-confirmed 404/410 or generic-career redirects are removed from the preserved AWS snapshot so stale roles do not return during an active source fallback.'
  },
  {
    company: 'TierPoint',
    snapshotPath: 'data/tierpoint-jobs.json',
    statusKey: 'tierPoint',
    identity: tierPointRequisitionId,
    policy: 'Nightly QA-confirmed dead TierPoint detail links are removed from the authoritative iCIMS snapshot so stale roles do not return after live QA removes them from the public feed.'
  }
];

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

function tierPointRequisitionId(record = {}) {
  const idMatch = clean(record?.id).match(/^icims-tierpoint-(\d+)$/i);
  if (idMatch) return idMatch[1];

  try {
    const parsed = new URL(clean(record?.sourceUrl || record?.url));
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'careers-tierpoint.icims.com') return '';
    return parsed.pathname.match(/^\/jobs\/(\d+)\/[^/]+\/job\/?$/i)?.[1] || '';
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

function reconcileSnapshot({ snapshot = [], report = {}, status = {}, source, nowMs = Date.now() }) {
  if (!Array.isArray(snapshot)) throw new Error(`${source.company} snapshot must be an array.`);
  if (!reportIsCurrent(report, status, nowMs)) {
    return { kept: snapshot, removed: [], skipped: true, reason: 'QA report does not match the current fresh post-QA status.' };
  }

  const deadIds = new Set((Array.isArray(report?.deadJobLinksRemoved) ? report.deadJobLinksRemoved : [])
    .filter(check => clean(check?.company) === source.company && clean(check?.state) === 'dead')
    .map(source.identity)
    .filter(Boolean));

  if (!deadIds.size) return { kept: snapshot, removed: [], skipped: false, reason: 'No confirmed-dead links.' };

  const kept = [];
  const removed = [];
  for (const job of snapshot) {
    const id = source.identity(job);
    if (clean(job?.company) === source.company && id && deadIds.has(id)) removed.push(job);
    else kept.push(job);
  }

  return { kept, removed, skipped: false, reason: '' };
}

function applySourceStatus(status, source, retainedCount, removed, checkedAt) {
  const diagnostic = status?.[source.statusKey];
  if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)) return;

  if (Number.isFinite(Number(diagnostic.qualifyingRoles))) diagnostic.qualifyingRoles = retainedCount;
  if (source.statusKey === 'amazonDatacenter' && Number.isFinite(Number(diagnostic.preservedPreviousRoles)) && Number(diagnostic.preservedPreviousRoles) > 0) {
    diagnostic.preservedPreviousRoles = Math.min(Number(diagnostic.preservedPreviousRoles), retainedCount);
  }
  diagnostic.qaDeadSnapshotReconciliation = {
    checkedAt,
    removedRoles: removed.length,
    removedRequisitionIds: removed.map(source.identity).filter(Boolean),
    policy: source.policy
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(`QA snapshot reconciliation regression: ${message}`);
}

function sampleAmazon(number) {
  return {
    id: `amazon-${number}`,
    company: 'Amazon Web Services',
    sourceUrl: `https://www.amazon.jobs/en/jobs/${number}/data-center-technician`
  };
}

function sampleTierPoint(number) {
  return {
    id: `icims-tierpoint-${number}`,
    company: 'TierPoint',
    sourceUrl: `https://careers-tierpoint.icims.com/jobs/${number}/mep-technician-ii/job`
  };
}

function runTests() {
  const checkedAt = '2026-09-22T09:40:00.000Z';
  const nowMs = Date.parse('2026-09-22T09:41:00.000Z');
  const status = {
    postQa: { checkedAt },
    amazonDatacenter: { qualifyingRoles: 3, preservedPreviousRoles: 3 },
    tierPoint: { qualifyingRoles: 3, sourceHealthy: true }
  };
  const amazon = SOURCES[0];
  const tierPoint = SOURCES[1];
  const report = {
    checkedAt,
    deadJobLinksRemoved: [
      { ...sampleAmazon(1002), state: 'dead', status: 404, url: sampleAmazon(1002).sourceUrl },
      { id: '', company: 'Amazon Web Services', state: 'dead', status: 410, url: sampleAmazon(1003).sourceUrl },
      { ...sampleTierPoint(2959), state: 'dead', status: 404, url: sampleTierPoint(2959).sourceUrl },
      { id: 'other-1', company: 'Other Employer', state: 'dead', status: 404, url: 'https://example.com/jobs/1' }
    ]
  };

  let result = reconcileSnapshot({ snapshot: [sampleAmazon(1001), sampleAmazon(1002), sampleAmazon(1003)], report, status, source: amazon, nowMs });
  assert(result.removed.length === 2 && result.kept.length === 1, 'current QA dead-link evidence must prune matching AWS snapshot roles.');
  assert(amazonRequisitionId(result.kept[0]) === '1001', 'unflagged AWS role must remain.');
  const awsStatus = structuredClone(status);
  applySourceStatus(awsStatus, amazon, result.kept.length, result.removed, checkedAt);
  assert(awsStatus.amazonDatacenter.qualifyingRoles === 1, 'AWS qualifying count must follow the reconciled snapshot.');
  assert(awsStatus.amazonDatacenter.preservedPreviousRoles === 1, 'AWS preserved fallback count must follow the reconciled snapshot.');

  result = reconcileSnapshot({ snapshot: [sampleTierPoint(3057), sampleTierPoint(2962), sampleTierPoint(2959)], report, status, source: tierPoint, nowMs });
  assert(result.removed.length === 1 && result.kept.length === 2, 'current QA dead-link evidence must prune matching TierPoint snapshot roles.');
  assert(tierPointRequisitionId(result.removed[0]) === '2959', 'TierPoint URL/id identity must target the confirmed-dead requisition only.');
  const tierPointStatus = structuredClone(status);
  applySourceStatus(tierPointStatus, tierPoint, result.kept.length, result.removed, checkedAt);
  assert(tierPointStatus.tierPoint.qualifyingRoles === 2, 'TierPoint qualifying count must follow the reconciled snapshot.');
  assert(tierPointStatus.tierPoint.sourceHealthy === true, 'Nightly detail-link reconciliation must not invent a new listing-source health state.');

  result = reconcileSnapshot({ snapshot: [sampleAmazon(1001)], report: { ...report, checkedAt: '2026-09-22T06:00:00.000Z' }, status, source: amazon, nowMs });
  assert(result.skipped && result.removed.length === 0, 'mismatched QA report/status timestamps must never prune a snapshot.');
  result = reconcileSnapshot({ snapshot: [sampleTierPoint(2959)], report, status, source: tierPoint, nowMs: Date.parse('2026-09-22T12:01:00.000Z') });
  assert(result.skipped && result.removed.length === 0, 'stale QA reports must never prune a snapshot.');

  console.log('QA dead-snapshot reconciliation regression tests passed for AWS and TierPoint.');
}

if (process.argv.includes('--test')) {
  runTests();
  process.exit(0);
}

const report = JSON.parse(await readFile(QA_REPORT_PATH, 'utf8'));
const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
let changed = false;
const summaries = [];

for (const source of SOURCES) {
  const snapshot = JSON.parse(await readFile(source.snapshotPath, 'utf8'));
  const result = reconcileSnapshot({ snapshot, report, status, source });
  if (result.skipped) {
    summaries.push(`${source.company}: skipped (${result.reason})`);
    continue;
  }
  if (!result.removed.length) {
    summaries.push(`${source.company}: no confirmed-dead snapshot roles`);
    continue;
  }

  applySourceStatus(status, source, result.kept.length, result.removed, report.checkedAt);
  await writeFile(source.snapshotPath, `${JSON.stringify(result.kept, null, 2)}\n`);
  changed = true;
  summaries.push(`${source.company}: removed ${result.removed.length}; ${result.kept.length} authoritative role(s) remain`);
}

if (changed) await writeFile(STATUS_PATH, `${JSON.stringify(status, null, 2)}\n`);
console.log(`QA snapshot reconciliation: ${summaries.join(' | ')}`);
