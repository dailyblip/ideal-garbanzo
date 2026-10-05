import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const QA_REPORT_PATH = 'data/qa-report.json';
const STATUS_PATH = 'data/collector-status.json';
const MAX_REPORT_AGE_MS = 2 * 60 * 60 * 1000;
const POLICY = 'Remove only same-employer snapshot requisitions positively confirmed dead by the current fresh live QA report. Preserve unrelated roles, source health, and original verification/expiry evidence.';
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const numeric = value => value !== null && value !== '' && value !== undefined && Number.isFinite(Number(value));

// Explicit ownership prevents a public-feed absence, provider outage, or another
// employer's matching ID from retiring unverified roles. Shared Workday sources
// remain in major-jobs; no competing dedicated writer is introduced.
export const SOURCES = [
  ['Amazon Web Services', 'amazon', 'amazonDatacenter'],
  ['TierPoint', 'tierpoint', 'tierPoint'],
  ['Google', 'google', 'googleCareers'],
  ['Microsoft', 'microsoft', 'microsoftDatacenter'],
  ['Meta', 'meta', 'metaCareers'],
  ['Oracle', 'oracle', 'oracleCareers'],
  ['Digital Realty', 'digital-realty', 'digitalRealty'],
  ['Iron Mountain', 'iron-mountain', 'ironMountain'],
  ['Cologix', 'cologix', 'cologix'],
  ['Flexential', 'flexential', 'flexential'],
  ['T5 Data Centers', 't5-data-centers', 't5DataCenters'],
  ['Stream Data Centers', 'stream-data-centers', 'streamDataCenters'],
  ['Switch', 'switch', 'switchCareers'],
  ['DataBank', 'databank', 'databank'],
  ['Sabey Data Centers', 'sabey', 'sabeyCareers'],
  ['Novva Data Centers', 'novva', 'novvaCareers'],
  ['Compass Datacenters', 'compass', 'compass'],
  ['CloudHQ', 'cloudhq', 'cloudHqCareers'],
  ['CoreWeave', 'coreweave', 'coreWeaveCareers'],
  ['EdgeConneX', 'edgeconnex', 'edgeconnexCareers'],
  ['Prime Data Centers', 'prime-data-centers', 'primeDataCenters'],
  ['H5 Data Centers', 'h5-data-centers', 'h5DataCenters'],
  ['Csquare', 'csquare', 'csquare']
].map(([company, slug, statusKey]) => ({ company, snapshotPath: `data/${slug}-jobs.json`, statusKey }));
SOURCES.push({ company: 'CoreSite', snapshotPath: 'data/coresite-verified-fallback.json', statusKey: 'coreSite' });
for (const company of ['Vantage Data Centers', 'QTS Data Centers', 'CyrusOne', 'STACK Infrastructure', 'NTT Global Data Centers', 'Aligned Data Centers']) {
  SOURCES.push({ company, snapshotPath: 'data/major-jobs.json', major: true });
}

const SIDECARS = {
  'Compass Datacenters': 'data/compass-status.json',
  CoreWeave: 'data/coreweave-source-evidence.json',
  EdgeConneX: 'data/edgeconnex-source-evidence.json'
};
export const OWNED_PATHS = [...new Set([
  STATUS_PATH, ...SOURCES.map(source => source.snapshotPath), ...Object.values(SIDECARS), 'data/major-workday-freshness.json'
])];

function sourceUrl(record = {}) {
  return clean(record.sourceUrl || record.url);
}

function canonicalUrl(record = {}) {
  try {
    const url = new URL(sourceUrl(record));
    if (!['https:', 'http:'].includes(url.protocol)) return '';
    url.hash = '';
    // Keep all query parameters: req, jobId, gh_jid and opportunityId identify
    // different openings even when the host and path are identical.
    return url.href;
  } catch {
    return '';
  }
}

export function identity(record = {}, source) {
  const rawUrl = sourceUrl(record);
  // Existing AWS/iCIMS ownership supports canonical requisitions across title
  // slug or locale changes. A supplied URL takes priority over a conflicting ID.
  if (source.company === 'Amazon Web Services' || source.company === 'TierPoint') {
    const amazon = source.company === 'Amazon Web Services';
    if (!rawUrl) return clean(record.id).match(amazon ? /^amazon-(\d+)$/i : /^icims-tierpoint-(\d+)$/i)?.[1] || '';
    try {
      const url = new URL(rawUrl);
      if (!['http:', 'https:'].includes(url.protocol)) return '';
      if (amazon && ['amazon.jobs', 'www.amazon.jobs'].includes(url.hostname.toLowerCase())) {
        return url.pathname.match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?jobs\/(\d+)\b/i)?.[1] || '';
      }
      if (!amazon && url.hostname.toLowerCase() === 'careers-tierpoint.icims.com') {
        return url.pathname.match(/^\/jobs\/(\d+)\/[^/]+\/job\/?$/i)?.[1] || '';
      }
    } catch {}
    return '';
  }
  // Exact checked URL is the authoritative evidence for other providers. Never
  // use title/location similarity or an ID alone to guess that a role closed.
  return canonicalUrl(record);
}

export function reportIsCurrent(report = {}, status = {}, nowMs = Date.now()) {
  const checkedAt = clean(report?.checkedAt);
  if (!checkedAt || checkedAt !== clean(status?.postQa?.checkedAt)) return false;
  const checkedAtMs = Date.parse(checkedAt);
  const ageMs = nowMs - checkedAtMs;
  return Number.isFinite(checkedAtMs) && ageMs >= 0 && ageMs <= MAX_REPORT_AGE_MS;
}

export function confirmedDead(check) {
  if (clean(check?.state) !== 'dead') return false;
  const status = Number(check?.status);
  if (status === 404 || status === 410) return true;
  return status >= 200 && status < 400
    && check?.reason === 'redirected-to-generic-career-page'
    && Boolean(canonicalUrl({ url: check.finalUrl }))
    && canonicalUrl({ url: check.finalUrl }) !== canonicalUrl(check);
}

export function snapshotJobs(snapshot, source) {
  if (Array.isArray(snapshot)) return snapshot;
  if (isObject(snapshot) && Array.isArray(snapshot.jobs)) return snapshot.jobs;
  throw new Error(`${source.company} snapshot must be an array or an object with a jobs array.`);
}

export function reconcileSnapshot({ snapshot = [], report = {}, status = {}, source, nowMs = Date.now() }) {
  const jobs = snapshotJobs(snapshot, source);
  if (!reportIsCurrent(report, status, nowMs)) {
    return { kept: jobs, removed: [], skipped: true, reason: 'QA report does not match the current fresh post-QA status.' };
  }
  const deadIds = new Set((Array.isArray(report?.deadJobLinksRemoved) ? report.deadJobLinksRemoved : [])
    .filter(check => clean(check?.company) === source.company && confirmedDead(check))
    .map(check => identity(check, source)).filter(Boolean));
  const kept = [], removed = [];
  for (const job of jobs) {
    const id = identity(job, source);
    if (clean(job?.company) === source.company && id && deadIds.has(id)) removed.push(job);
    else kept.push(job);
  }
  return { kept, removed, skipped: false, reason: removed.length ? '' : 'No confirmed-dead snapshot roles.' };
}

export function applyDiagnostic(diagnostic, source, retainedCount, removed, checkedAt, checks = []) {
  if (!isObject(diagnostic)) return;
  // Clamp old collection counters rather than manufacturing freshly discovered
  // roles during a fallback. Inventory counters follow the retained snapshot.
  for (const key of ['qualifyingRoles', 'preservedPrevious', 'preservedPreviousRoles', 'preservedFromPrevious', 'currentQualifyingRoles', 'freshQualifyingRoles', 'snapshotRestored']) {
    if (numeric(diagnostic[key])) diagnostic[key] = Math.min(Number(diagnostic[key]), retainedCount);
  }
  for (const key of ['snapshotRoles', 'publishedRoles']) {
    if (numeric(diagnostic[key])) diagnostic[key] = retainedCount;
  }
  for (const key of ['snapshotFallback', 'verifiedFallback', 'fallbackFreshness']) {
    const fallback = diagnostic[key];
    if (isObject(fallback) && numeric(fallback.roles)) fallback.roles = Math.min(Number(fallback.roles), retainedCount);
  }
  diagnostic.qaDeadSnapshotReconciliation = {
    checkedAt,
    removedRoles: removed.length,
    removedRequisitionIds: removed.map(job => clean(job.id) || identity(job, source)),
    removedUrls: removed.map(sourceUrl).filter(Boolean),
    retainedRoles: retainedCount,
    confirmedDeadChecks: checks.filter(check => clean(check.company) === source.company && confirmedDead(check)
      && removed.some(job => identity(job, source) === identity(check, source)))
      .map(({ id, company, url, state, status, reason, finalUrl }) => ({ id, company, url, state, status, ...(reason ? { reason } : {}), ...(finalUrl ? { finalUrl } : {}) })),
    policy: POLICY
  };
}

export async function reconcileFiles({ root = '.', nowMs = Date.now() } = {}) {
  const documents = new Map();
  const changedPaths = new Set();
  const summaries = [];
  let majorWasReconciled;
  async function read(path) {
    if (!documents.has(path)) documents.set(path, JSON.parse(await readFile(resolve(root, path), 'utf8')));
    return documents.get(path);
  }
  const report = await read(QA_REPORT_PATH);
  const status = await read(STATUS_PATH);
  if (!reportIsCurrent(report, status, nowMs)) {
    return { changedPaths: [], summaries: ['skipped (QA report does not match the current fresh post-QA status)'] };
  }

  for (const source of SOURCES) {
    const snapshot = await read(source.snapshotPath);
    const before = snapshotJobs(snapshot, source);
    const result = reconcileSnapshot({ snapshot, report, status, source, nowMs });
    if (!result.removed.length) continue;
    const retainedCount = result.kept.filter(job => clean(job.company) === source.company).length;
    documents.set(source.snapshotPath, Array.isArray(snapshot) ? result.kept : { ...snapshot, jobs: result.kept });
    changedPaths.add(source.snapshotPath);
    const diagnostic = source.major ? status.majorSources?.employerDiagnostics?.[source.company] : status[source.statusKey];
    applyDiagnostic(diagnostic, source, retainedCount, result.removed, report.checkedAt, report.deadJobLinksRemoved);
    if (source.company === 'Amazon Web Services') {
      applyDiagnostic(status.amazonDetailRecovery, source, retainedCount, result.removed, report.checkedAt, report.deadJobLinksRemoved);
    }
    changedPaths.add(STATUS_PATH);

    if (SIDECARS[source.company]) {
      const path = SIDECARS[source.company];
      applyDiagnostic(await read(path), source, retainedCount, result.removed, report.checkedAt, report.deadJobLinksRemoved);
      changedPaths.add(path);
    }
    if (source.major) {
      const major = status.majorSources;
      // Keep exact-parity mode only when it was already established. Do not
      // promote a partial/additive snapshot to full reconciliation implicitly.
      if (majorWasReconciled === undefined) {
        majorWasReconciled = numeric(major?.reconciliation?.publishedUsJobs) && Number(major.reconciliation.publishedUsJobs) === before.length;
      }
      if (majorWasReconciled) major.reconciliation.publishedUsJobs = result.kept.length;
      if (numeric(major?.publishedJobs)) major.publishedJobs = Math.max(0, Number(major.publishedJobs) - result.removed.length);
      for (const summary of major?.fallbackFreshness?.summaries || []) {
        if (summary.company === source.company && numeric(summary.roles)) summary.roles = Math.min(Number(summary.roles), retainedCount);
      }
      const path = 'data/major-workday-freshness.json';
      const durable = (await read(path))?.employers?.[source.company];
      if (isObject(durable) && numeric(durable.roles)) durable.roles = Math.min(Number(durable.roles), retainedCount);
      changedPaths.add(path);
    }
    summaries.push(`${source.company}: removed ${result.removed.length}; ${retainedCount} authoritative role(s) remain`);
  }
  // Read and validate every affected snapshot/sidecar before writing any file.
  for (const path of changedPaths) await writeFile(resolve(root, path), `${JSON.stringify(documents.get(path), null, 2)}\n`);
  return { changedPaths: [...changedPaths], summaries: summaries.length ? summaries : ['no confirmed-dead snapshot roles'] };
}

async function main() {
  if (process.argv.includes('--list-paths')) {
    console.log(OWNED_PATHS.join('\n'));
  } else if (process.argv.includes('--test')) {
    await import('./test-qa-dead-snapshots.mjs');
  } else {
    const { summaries } = await reconcileFiles();
    console.log(`QA snapshot reconciliation: ${summaries.join(' | ')}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
