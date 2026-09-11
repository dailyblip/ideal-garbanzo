import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/major-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const MAX_FALLBACK_AGE_HOURS = 96;
const HEALTHY_STAMP_INTERVAL_HOURS = 20;

const boards = [
  { company: 'Vantage Data Centers', origin: 'https://vantagedc.wd1.myworkdayjobs.com', tenant: 'vantagedc', site: 'Vantage', locale: 'en-US' },
  { company: 'QTS Data Centers', origin: 'https://qtsdatacenters.wd5.myworkdayjobs.com', tenant: 'qtsdatacenters', site: 'QTS', locale: 'en-US' },
  { company: 'CyrusOne', origin: 'https://cyrusone.wd1.myworkdayjobs.com', tenant: 'cyrusone', site: 'CyrusOneCareerPortal', locale: 'en-US' },
  { company: 'STACK Infrastructure', origin: 'https://stackinfra.wd108.myworkdayjobs.com', tenant: 'stackinfra', site: 'STACK_AMER', locale: 'en-US' },
  { company: 'NTT Global Data Centers', origin: 'https://nttglobaldatacenters.wd501.myworkdayjobs.com', tenant: 'nttglobaldatacenters', site: 'External', locale: 'en-US' },
  { company: 'Aligned Data Centers', origin: 'https://aligneddc.wd12.myworkdayjobs.com', tenant: 'aligneddc', site: 'aligneddc', locale: 'en-US' }
];

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const isCompany = (job, company) => clean(job?.company) === company;

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: 'application/json',
      'user-agent': 'DataCenterCareersBot/1.5 (+https://datacentercareers.us/)',
      ...(options.headers || {})
    }
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

async function probeBoard(board) {
  const endpoint = `${board.origin}/wday/cxs/${board.tenant}/${board.site}/jobs`;
  const seen = new Set();
  let offset = 0;
  let total = null;
  let pagesAttempted = 0;
  let pagesSucceeded = 0;
  let incompleteReason = '';

  for (let page = 0; page < 100; page += 1) {
    if (Number.isFinite(total) && offset >= total) break;
    pagesAttempted += 1;
    const payload = await fetchJson(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        referer: `${board.origin}/${board.locale}/${board.site}`
      },
      body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: '' })
    });
    pagesSucceeded += 1;

    const rows = Array.isArray(payload.jobPostings) ? payload.jobPostings : [];
    if (page === 0) {
      const reported = Number(payload.total);
      if (!Number.isFinite(reported) || reported < 0) {
        incompleteReason = 'Workday did not return a valid total count';
        break;
      }
      total = reported;
      if (total === 0) {
        incompleteReason = 'Workday reported zero jobs for a priority operator';
        break;
      }
    }

    let fresh = 0;
    for (const row of rows) {
      const key = clean(row?.externalPath || row?.bulletFields?.[0] || `${row?.title || ''}|${row?.locationsText || ''}`);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      fresh += 1;
    }

    offset += rows.length;
    if (offset >= total) break;
    if (rows.length === 0) {
      incompleteReason = `listing ended at ${offset}/${total} rows`;
      break;
    }
    if (rows.length < 20) {
      incompleteReason = `short page returned ${rows.length} rows at ${offset}/${total}`;
      break;
    }
    if (fresh === 0) {
      incompleteReason = `duplicate page before reaching reported total (${offset}/${total})`;
      break;
    }
  }

  if (!incompleteReason && (!Number.isFinite(total) || offset < total)) {
    incompleteReason = `pagination cap reached at ${offset}/${Number.isFinite(total) ? total : 'unknown'} rows`;
  }
  if (!incompleteReason && seen.size !== total) {
    incompleteReason = `listing returned ${seen.size} unique postings for a reported total of ${total}`;
  }

  const healthy = !incompleteReason && Number.isFinite(total) && total > 0 && seen.size === total;
  return {
    healthy,
    listingComplete: healthy,
    reportedRows: Number.isFinite(total) ? total : null,
    uniqueRows: seen.size,
    pagesAttempted,
    pagesSucceeded,
    ...(incompleteReason ? { incompleteReason } : {})
  };
}

function freshnessDecision(lastHealthyAt, nowMs) {
  const verifiedMs = Date.parse(String(lastHealthyAt || ''));
  if (!Number.isFinite(verifiedMs)) {
    return { expired: true, active: false, ageHours: null, expiresAt: null };
  }
  const expiresAt = verifiedMs + MAX_FALLBACK_AGE_HOURS * 36e5;
  const ageHours = Math.max(0, (nowMs - verifiedMs) / 36e5);
  return {
    expired: nowMs >= expiresAt,
    active: nowMs < expiresAt,
    ageHours,
    expiresAt
  };
}

function legacyHealthyBaseline(status, diagnostics, nowMs) {
  if (diagnostics?.sourceHealthy !== true || diagnostics?.listingComplete !== true || diagnostics?.usedPreviousSnapshot === true) return null;
  const candidates = [status?.majorSources?.reconciliation?.checkedAt, status?.updatedAt]
    .map(value => Date.parse(String(value || '')))
    .filter(value => Number.isFinite(value) && value <= nowMs);
  if (!candidates.length) return null;
  return new Date(Math.max(...candidates)).toISOString();
}

function watchRecord({ healthy, nowIso, baseline, probe, roles, reason = '' }) {
  if (healthy) {
    return {
      sourceHealthy: true,
      active: false,
      expired: false,
      checkedAt: nowIso,
      lastHealthyAt: nowIso,
      expiresAt: new Date(Date.parse(nowIso) + MAX_FALLBACK_AGE_HOURS * 36e5).toISOString(),
      roles,
      maxAgeHours: MAX_FALLBACK_AGE_HOURS,
      listingComplete: true,
      reportedRows: probe.reportedRows,
      uniqueRows: probe.uniqueRows,
      pagesAttempted: probe.pagesAttempted,
      pagesSucceeded: probe.pagesSucceeded
    };
  }

  const decision = freshnessDecision(baseline, Date.parse(nowIso));
  return {
    sourceHealthy: false,
    active: decision.active,
    expired: decision.expired,
    checkedAt: nowIso,
    lastHealthyAt: baseline || null,
    expiresAt: decision.expiresAt ? new Date(decision.expiresAt).toISOString() : null,
    ageHours: decision.ageHours === null ? null : Math.round(decision.ageHours * 10) / 10,
    roles,
    maxAgeHours: MAX_FALLBACK_AGE_HOURS,
    listingComplete: false,
    reportedRows: probe?.reportedRows ?? null,
    uniqueRows: probe?.uniqueRows ?? 0,
    pagesAttempted: probe?.pagesAttempted ?? 0,
    pagesSucceeded: probe?.pagesSucceeded ?? 0,
    reason: reason || probe?.incompleteReason || 'Employer Workday listing could not be verified.'
  };
}

function runSelfTest() {
  const now = Date.parse('2026-09-10T12:00:00Z');
  const fresh = freshnessDecision('2026-09-06T13:00:00Z', now);
  if (!fresh.active || fresh.expired) throw new Error('major Workday fallback expired before 96 hours');
  const boundary = freshnessDecision('2026-09-06T12:00:00Z', now);
  if (!boundary.expired || boundary.active) throw new Error('major Workday fallback did not expire at 96 hours');
  const unknown = freshnessDecision(null, now);
  if (!unknown.expired || unknown.active) throw new Error('major Workday fallback without verification evidence did not fail closed');
  const legacy = legacyHealthyBaseline(
    { updatedAt: '2026-09-10T10:00:00Z', majorSources: { reconciliation: { checkedAt: '2026-09-10T11:00:00Z' } } },
    { sourceHealthy: true, listingComplete: true, usedPreviousSnapshot: false },
    now
  );
  if (legacy !== '2026-09-10T11:00:00.000Z') throw new Error('major Workday legacy healthy-baseline migration regression');
  const rejectedLegacy = legacyHealthyBaseline(
    { updatedAt: '2026-09-10T10:00:00Z' },
    { sourceHealthy: false, listingComplete: false, usedPreviousSnapshot: true },
    now
  );
  if (rejectedLegacy !== null) throw new Error('unhealthy legacy diagnostics were incorrectly accepted as verification evidence');
  console.log('Major Workday fallback freshness regression tests passed.');
}

async function validateState() {
  const jobs = await readJson(JOBS_PATH, []);
  const snapshot = await readJson(SNAPSHOT_PATH, []);
  const status = await readJson(STATUS_PATH, {});
  const violations = [];
  const diagnostics = status?.majorSources?.employerDiagnostics || {};
  const nowMs = Date.now();

  for (const board of boards) {
    const watch = diagnostics?.[board.company]?.fallbackFreshness;
    if (!watch || typeof watch !== 'object') {
      violations.push(`${board.company}: missing fallback-freshness state`);
      continue;
    }
    const publicRoles = jobs.filter(job => isCompany(job, board.company)).length;
    const snapshotRoles = snapshot.filter(job => isCompany(job, board.company)).length;
    if (watch.expired === true && (publicRoles > 0 || snapshotRoles > 0)) {
      violations.push(`${board.company}: expired fallback still has ${publicRoles} public and ${snapshotRoles} snapshot role(s)`);
    }
    if (watch.active === true) {
      const expires = Date.parse(String(watch.expiresAt || ''));
      if (!Number.isFinite(expires) || nowMs >= expires) violations.push(`${board.company}: active fallback is already beyond its expiry`);
    }
    if (watch.sourceHealthy === true && (watch.active === true || watch.expired === true)) {
      violations.push(`${board.company}: healthy source is also marked fallback-active/expired`);
    }
  }

  if (violations.length) {
    for (const violation of violations) console.error(`Major Workday fallback freshness violation: ${violation}`);
    throw new Error(`Blocked ${violations.length} major Workday stale-fallback integrity violation(s).`);
  }
  console.log(`Major Workday fallback freshness state is valid for ${boards.length} priority employers.`);
}

if (process.argv.includes('--test')) {
  runSelfTest();
  process.exit(0);
}
if (process.argv.includes('--validate')) {
  await validateState();
  process.exit(0);
}

const originalJobs = await readJson(JOBS_PATH, []);
const originalSnapshot = await readJson(SNAPSHOT_PATH, []);
const originalStatus = await readJson(STATUS_PATH, {});
if (!Array.isArray(originalJobs)) throw new Error(`${JOBS_PATH} must contain an array.`);
if (!Array.isArray(originalSnapshot)) throw new Error(`${SNAPSHOT_PATH} must contain an array.`);
if (!originalStatus || typeof originalStatus !== 'object' || Array.isArray(originalStatus)) throw new Error(`${STATUS_PATH} must contain an object.`);

let jobs = [...originalJobs];
let snapshot = [...originalSnapshot];
const status = structuredClone(originalStatus);
status.majorSources = status.majorSources && typeof status.majorSources === 'object' ? status.majorSources : {};
status.majorSources.employerDiagnostics = status.majorSources.employerDiagnostics && typeof status.majorSources.employerDiagnostics === 'object'
  ? status.majorSources.employerDiagnostics
  : {};

const nowMs = Date.now();
const nowIso = new Date(nowMs).toISOString();
let rolesChanged = false;
let statusChanged = false;
const summaries = [];

for (const board of boards) {
  const diagnostics = status.majorSources.employerDiagnostics[board.company] || {};
  const priorWatch = diagnostics.fallbackFreshness && typeof diagnostics.fallbackFreshness === 'object'
    ? diagnostics.fallbackFreshness
    : null;
  const currentRoleCount = jobs.filter(job => isCompany(job, board.company)).length;
  let probe = null;
  let probeError = '';
  try {
    probe = await probeBoard(board);
  } catch (error) {
    probeError = clean(error?.message || error);
    probe = {
      healthy: false,
      listingComplete: false,
      reportedRows: null,
      uniqueRows: 0,
      pagesAttempted: 0,
      pagesSucceeded: 0,
      incompleteReason: probeError || 'Workday listing request failed'
    };
  }

  if (probe.healthy) {
    const priorHealthyMs = Date.parse(String(priorWatch?.lastHealthyAt || ''));
    const stampAgeHours = Number.isFinite(priorHealthyMs) ? Math.max(0, (nowMs - priorHealthyMs) / 36e5) : Infinity;
    const shouldPersist = !priorWatch || priorWatch.sourceHealthy !== true || priorWatch.active === true || priorWatch.expired === true || stampAgeHours >= HEALTHY_STAMP_INTERVAL_HOURS;
    if (shouldPersist) {
      const nextWatch = watchRecord({ healthy: true, nowIso, baseline: nowIso, probe, roles: currentRoleCount });
      status.majorSources.employerDiagnostics[board.company] = { ...diagnostics, fallbackFreshness: nextWatch };
      statusChanged = true;
    }
    summaries.push({ company: board.company, state: 'healthy', roles: currentRoleCount, reportedRows: probe.reportedRows });
    continue;
  }

  const baseline = clean(priorWatch?.lastHealthyAt) || legacyHealthyBaseline(status, diagnostics, nowMs);
  const decision = freshnessDecision(baseline, nowMs);
  if (!decision.expired) {
    const nextWatch = watchRecord({ healthy: false, nowIso, baseline, probe, roles: currentRoleCount, reason: probeError || probe.incompleteReason });
    status.majorSources.employerDiagnostics[board.company] = { ...diagnostics, fallbackFreshness: nextWatch };
    statusChanged = true;
    summaries.push({ company: board.company, state: 'fallback', roles: currentRoleCount, expiresAt: nextWatch.expiresAt });
    continue;
  }

  const publicBefore = jobs.filter(job => isCompany(job, board.company)).length;
  const snapshotBefore = snapshot.filter(job => isCompany(job, board.company)).length;
  jobs = jobs.filter(job => !isCompany(job, board.company));
  snapshot = snapshot.filter(job => !isCompany(job, board.company));
  const removed = publicBefore + snapshotBefore;
  rolesChanged = rolesChanged || removed > 0;

  const nextWatch = watchRecord({ healthy: false, nowIso, baseline, probe, roles: 0, reason: probeError || probe.incompleteReason });
  nextWatch.rolesRemovedFromPublic = publicBefore;
  nextWatch.rolesRemovedFromSnapshot = snapshotBefore;
  nextWatch.reason = baseline
    ? `Employer-direct verification exceeded ${MAX_FALLBACK_AGE_HOURS} hours, so retained ${board.company} roles were removed until the source recovers. Last check: ${probeError || probe.incompleteReason || 'unverified listing'}`
    : `No trustworthy employer-direct verification timestamp was available, so retained ${board.company} roles were removed until the source can be verified.`;
  status.majorSources.employerDiagnostics[board.company] = { ...diagnostics, fallbackFreshness: nextWatch };
  statusChanged = true;
  summaries.push({ company: board.company, state: 'expired', rolesRemoved: removed });
}

if (rolesChanged) {
  status.updatedAt = nowIso;
  status.jobs = jobs.length;
  status.countsByType = jobs.reduce((acc, job) => {
    const key = clean(job?.type) || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  status.countsByExperience = jobs.reduce((acc, job) => {
    const key = clean(job?.experience) || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  status.majorSources.jobs = snapshot.length;
  status.majorSources.reconciliation = {
    ...(status.majorSources.reconciliation || {}),
    checkedAt: nowIso,
    rawJobs: snapshot.length,
    publishedUsJobs: snapshot.length,
    staleFallbackPruned: true
  };
}

if (statusChanged) {
  status.majorSources.fallbackFreshness = {
    maxAgeHours: MAX_FALLBACK_AGE_HOURS,
    healthyStampIntervalHours: HEALTHY_STAMP_INTERVAL_HOURS,
    policy: `Retain a priority Workday employer snapshot for at most ${MAX_FALLBACK_AGE_HOURS} hours after the last complete official listing verification; then remove that employer until recovery.`,
    summaries
  };
}

if (JSON.stringify(jobs) !== JSON.stringify(originalJobs)) {
  await writeFile(JOBS_PATH, JSON.stringify(jobs, null, 2) + '\n');
}
if (JSON.stringify(snapshot) !== JSON.stringify(originalSnapshot)) {
  await writeFile(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + '\n');
}
if (JSON.stringify(status) !== JSON.stringify(originalStatus)) {
  await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
}

const healthyCount = summaries.filter(item => item.state === 'healthy').length;
const fallbackCount = summaries.filter(item => item.state === 'fallback').length;
const expiredCount = summaries.filter(item => item.state === 'expired').length;
console.log(`Major Workday freshness check: ${healthyCount} healthy, ${fallbackCount} inside fallback window, ${expiredCount} expired; ${rolesChanged ? 'stale roles pruned' : 'no role pruning required'}.`);
