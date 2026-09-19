import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/major-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const STATE_PATH = 'data/major-workday-freshness.json';
const MAX_FALLBACK_AGE_HOURS = 96;
const HEALTHY_STAMP_INTERVAL_HOURS = 20;
const DETAIL_SAMPLE_SIZE = 3;
const REQUEST_TIMEOUT_MS = 10000;
const RETRIES = 2;

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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

async function fetchJson(url, options = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'user-agent': 'DataCenterCareersBot/1.7 (+https://datacentercareers.us/)',
          ...(options.headers || {})
        }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = clean(response.headers.get('content-type')).toLowerCase();
      if (contentType && !contentType.includes('json')) {
        throw new Error(`expected JSON but received ${contentType}`);
      }
      const payload = await response.json();
      clearTimeout(timeout);
      return payload;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (attempt < RETRIES) await sleep(350 * attempt);
    }
  }
  throw lastError || new Error('request failed');
}

function detailPathFromSourceUrl(board, sourceUrl) {
  let parsed;
  try {
    parsed = new URL(clean(sourceUrl));
  } catch {
    return '';
  }
  if (parsed.protocol !== 'https:' || parsed.origin !== board.origin) return '';
  const prefix = `/${board.locale}/${board.site}`;
  if (!parsed.pathname.startsWith(`${prefix}/`)) return '';
  const externalPath = parsed.pathname.slice(prefix.length);
  return externalPath.startsWith('/job/') ? externalPath : '';
}

function hasUsableDetail(payload) {
  const info = payload?.jobPostingInfo || payload?.jobInfo;
  if (!info || typeof info !== 'object') return false;
  return Boolean(clean(info.title || info.jobTitle || info.jobDescription || info.description));
}

function detailTransportHealthy(attempted, succeeded) {
  return attempted > 0 && succeeded === attempted;
}

async function probeBoard(board, companySnapshot = []) {
  const endpoint = `${board.origin}/wday/cxs/${board.tenant}/${board.site}/jobs`;
  const seen = new Set();
  const listingPaths = [];
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
      const externalPath = clean(row?.externalPath);
      const key = clean(externalPath || row?.bulletFields?.[0] || `${row?.title || ''}|${row?.locationsText || ''}`);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (externalPath.startsWith('/job/')) listingPaths.push(externalPath);
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

  const listingComplete = !incompleteReason && Number.isFinite(total) && total > 0 && seen.size === total;
  if (!listingComplete) {
    return {
      healthy: false,
      listingComplete: false,
      detailHealthy: false,
      detailAttempted: 0,
      detailSucceeded: 0,
      detailErrors: [],
      reportedRows: Number.isFinite(total) ? total : null,
      uniqueRows: seen.size,
      pagesAttempted,
      pagesSucceeded,
      ...(incompleteReason ? { incompleteReason } : {})
    };
  }

  const listingPathSet = new Set(listingPaths);
  const samplePaths = [];
  const sampled = new Set();
  for (const job of companySnapshot) {
    const path = detailPathFromSourceUrl(board, job?.sourceUrl);
    if (!path || !listingPathSet.has(path) || sampled.has(path)) continue;
    sampled.add(path);
    samplePaths.push(path);
    if (samplePaths.length >= DETAIL_SAMPLE_SIZE) break;
  }
  if (samplePaths.length < DETAIL_SAMPLE_SIZE) {
    for (const path of listingPaths) {
      if (sampled.has(path)) continue;
      sampled.add(path);
      samplePaths.push(path);
      if (samplePaths.length >= DETAIL_SAMPLE_SIZE) break;
    }
  }

  let detailSucceeded = 0;
  const detailErrors = [];
  for (const externalPath of samplePaths) {
    const sourceUrl = `${board.origin}/${board.locale}/${board.site}${externalPath}`;
    const detailUrl = `${board.origin}/wday/cxs/${board.tenant}/${board.site}${externalPath}`;
    try {
      const payload = await fetchJson(detailUrl, { headers: { referer: sourceUrl } });
      if (!hasUsableDetail(payload)) throw new Error('detail response lacked job posting content');
      detailSucceeded += 1;
    } catch (error) {
      detailErrors.push(`${externalPath}: ${clean(error?.message || error)}`);
    }
  }

  const detailAttempted = samplePaths.length;
  const detailHealthy = detailTransportHealthy(detailAttempted, detailSucceeded);
  const healthy = listingComplete && detailHealthy;
  if (!detailHealthy) {
    incompleteReason = detailAttempted
      ? `Workday listing is complete, but only ${detailSucceeded}/${detailAttempted} sampled current detail endpoint(s) returned usable JSON`
      : 'Workday listing is complete, but no current detail endpoint could be sampled';
  }

  return {
    healthy,
    listingComplete,
    detailHealthy,
    detailAttempted,
    detailSucceeded,
    detailErrors,
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
  const common = {
    checkedAt: nowIso,
    roles,
    maxAgeHours: MAX_FALLBACK_AGE_HOURS,
    listingComplete: probe?.listingComplete === true,
    detailHealthy: probe?.detailHealthy === true,
    detailAttempted: Number(probe?.detailAttempted || 0),
    detailSucceeded: Number(probe?.detailSucceeded || 0),
    reportedRows: probe?.reportedRows ?? null,
    uniqueRows: probe?.uniqueRows ?? 0,
    pagesAttempted: probe?.pagesAttempted ?? 0,
    pagesSucceeded: probe?.pagesSucceeded ?? 0,
    ...(Array.isArray(probe?.detailErrors) && probe.detailErrors.length ? { detailErrors: probe.detailErrors.slice(0, DETAIL_SAMPLE_SIZE) } : {})
  };

  if (healthy) {
    return {
      sourceHealthy: true,
      active: false,
      expired: false,
      ...common,
      lastHealthyAt: nowIso,
      expiresAt: new Date(Date.parse(nowIso) + MAX_FALLBACK_AGE_HOURS * 36e5).toISOString()
    };
  }

  const decision = freshnessDecision(baseline, Date.parse(nowIso));
  return {
    sourceHealthy: false,
    active: decision.active,
    expired: decision.expired,
    ...common,
    lastHealthyAt: baseline || null,
    expiresAt: decision.expiresAt ? new Date(decision.expiresAt).toISOString() : null,
    ageHours: decision.ageHours === null ? null : Math.round(decision.ageHours * 10) / 10,
    reason: reason || probe?.incompleteReason || 'Employer Workday listing/detail verification could not be completed.'
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

  if (!detailTransportHealthy(3, 3)) throw new Error('fully healthy sampled detail transport was rejected');
  if (detailTransportHealthy(3, 2)) throw new Error('partial sampled detail transport incorrectly refreshed source freshness');
  if (detailTransportHealthy(3, 0)) throw new Error('collapsed sampled detail transport incorrectly refreshed source freshness');
  if (detailTransportHealthy(0, 0)) throw new Error('missing detail sample incorrectly refreshed source freshness');

  const board = boards[0];
  const parsed = detailPathFromSourceUrl(
    board,
    'https://vantagedc.wd1.myworkdayjobs.com/en-US/Vantage/job/Ashburn-Virginia/Critical-Facilities-Engineer_R12345'
  );
  if (parsed !== '/job/Ashburn-Virginia/Critical-Facilities-Engineer_R12345') {
    throw new Error(`detail-path parsing regression: ${parsed || '(empty)'}`);
  }
  if (detailPathFromSourceUrl(board, 'https://example.com/en-US/Vantage/job/Test_R1')) {
    throw new Error('detail-path parser accepted a non-official host');
  }
  if (!hasUsableDetail({ jobPostingInfo: { jobDescription: '<p>Role</p>' } })) {
    throw new Error('usable Workday detail payload was rejected');
  }
  if (hasUsableDetail({ jobPostingInfo: {} }) || hasUsableDetail({})) {
    throw new Error('empty Workday detail payload was accepted');
  }

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

  console.log('Major Workday listing/detail fallback freshness regression tests passed.');
}

async function validateState() {
  const jobs = await readJson(JOBS_PATH, []);
  const snapshot = await readJson(SNAPSHOT_PATH, []);
  const status = await readJson(STATUS_PATH, {});
  const durable = await readJson(STATE_PATH, {});
  const violations = [];
  const diagnostics = status?.majorSources?.employerDiagnostics || {};
  const durableEmployers = durable?.employers && typeof durable.employers === 'object' ? durable.employers : {};
  const nowMs = Date.now();

  for (const board of boards) {
    const watch = durableEmployers[board.company] || diagnostics?.[board.company]?.fallbackFreshness;
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
    if (watch.sourceHealthy === true && watch.listingComplete !== true) {
      violations.push(`${board.company}: healthy source lacks complete listing verification`);
    }
    if (watch.sourceHealthy === true && watch.detailHealthy !== true) {
      violations.push(`${board.company}: healthy source lacks sampled detail verification`);
    }
    if (watch.sourceHealthy === true && (!Number.isFinite(Number(watch.detailAttempted)) || Number(watch.detailAttempted) < 1)) {
      violations.push(`${board.company}: healthy source has no sampled detail evidence`);
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
const originalDurable = await readJson(STATE_PATH, {});
if (!Array.isArray(originalJobs)) throw new Error(`${JOBS_PATH} must contain an array.`);
if (!Array.isArray(originalSnapshot)) throw new Error(`${SNAPSHOT_PATH} must contain an array.`);
if (!originalStatus || typeof originalStatus !== 'object' || Array.isArray(originalStatus)) throw new Error(`${STATUS_PATH} must contain an object.`);

let jobs = [...originalJobs];
let snapshot = [...originalSnapshot];
const status = structuredClone(originalStatus);
const durable = originalDurable && typeof originalDurable === 'object' && !Array.isArray(originalDurable) ? structuredClone(originalDurable) : {};
durable.version = 2;
durable.maxFallbackAgeHours = MAX_FALLBACK_AGE_HOURS;
durable.verificationPolicy = 'complete Workday listing plus sampled current job-detail JSON';
durable.employers = durable.employers && typeof durable.employers === 'object' && !Array.isArray(durable.employers) ? durable.employers : {};
status.majorSources = status.majorSources && typeof status.majorSources === 'object' ? status.majorSources : {};
status.majorSources.employerDiagnostics = status.majorSources.employerDiagnostics && typeof status.majorSources.employerDiagnostics === 'object'
  ? status.majorSources.employerDiagnostics
  : {};

const nowMs = Date.now();
const nowIso = new Date(nowMs).toISOString();
let rolesChanged = false;
let statusChanged = false;
let durableChanged = false;
const summaries = [];

for (const board of boards) {
  const diagnostics = status.majorSources.employerDiagnostics[board.company] || {};
  const statusWatch = diagnostics.fallbackFreshness && typeof diagnostics.fallbackFreshness === 'object'
    ? diagnostics.fallbackFreshness
    : null;
  const durableWatch = durable.employers[board.company] && typeof durable.employers[board.company] === 'object'
    ? durable.employers[board.company]
    : null;
  const priorWatch = durableWatch || statusWatch;
  const currentRoleCount = jobs.filter(job => isCompany(job, board.company)).length;
  const companySnapshot = snapshot.filter(job => isCompany(job, board.company));
  let probe = null;
  let probeError = '';
  try {
    probe = await probeBoard(board, companySnapshot);
  } catch (error) {
    probeError = clean(error?.message || error);
    probe = {
      healthy: false,
      listingComplete: false,
      detailHealthy: false,
      detailAttempted: 0,
      detailSucceeded: 0,
      detailErrors: [],
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
    const previousPolicyWasDetailAware = priorWatch?.detailHealthy === true && Number(priorWatch?.detailAttempted) > 0;
    const shouldPersist = !durableWatch || !statusWatch || !priorWatch || !previousPolicyWasDetailAware ||
      priorWatch.sourceHealthy !== true || priorWatch.active === true || priorWatch.expired === true ||
      stampAgeHours >= HEALTHY_STAMP_INTERVAL_HOURS;
    if (shouldPersist) {
      const nextWatch = watchRecord({ healthy: true, nowIso, baseline: nowIso, probe, roles: currentRoleCount });
      status.majorSources.employerDiagnostics[board.company] = { ...diagnostics, fallbackFreshness: nextWatch };
      durable.employers[board.company] = nextWatch;
      statusChanged = true;
      durableChanged = true;
    }
    summaries.push({
      company: board.company,
      state: 'healthy',
      roles: currentRoleCount,
      reportedRows: probe.reportedRows,
      detailVerified: `${probe.detailSucceeded}/${probe.detailAttempted}`
    });
    continue;
  }

  const baseline = clean(durableWatch?.lastHealthyAt) || clean(statusWatch?.lastHealthyAt) || legacyHealthyBaseline(status, diagnostics, nowMs);
  const decision = freshnessDecision(baseline, nowMs);
  const reason = probeError || probe.incompleteReason;
  if (!decision.expired) {
    const nextWatch = watchRecord({ healthy: false, nowIso, baseline, probe, roles: currentRoleCount, reason });
    status.majorSources.employerDiagnostics[board.company] = { ...diagnostics, fallbackFreshness: nextWatch };
    durable.employers[board.company] = nextWatch;
    statusChanged = true;
    durableChanged = true;
    summaries.push({
      company: board.company,
      state: 'fallback',
      roles: currentRoleCount,
      expiresAt: nextWatch.expiresAt,
      listingComplete: probe.listingComplete === true,
      detailVerified: `${probe.detailSucceeded || 0}/${probe.detailAttempted || 0}`
    });
    continue;
  }

  const publicBefore = jobs.filter(job => isCompany(job, board.company)).length;
  const snapshotBefore = snapshot.filter(job => isCompany(job, board.company)).length;
  jobs = jobs.filter(job => !isCompany(job, board.company));
  snapshot = snapshot.filter(job => !isCompany(job, board.company));
  const removed = publicBefore + snapshotBefore;
  rolesChanged = rolesChanged || removed > 0;

  const nextWatch = watchRecord({ healthy: false, nowIso, baseline, probe, roles: 0, reason });
  nextWatch.rolesRemovedFromPublic = publicBefore;
  nextWatch.rolesRemovedFromSnapshot = snapshotBefore;
  nextWatch.reason = baseline
    ? `Employer-direct listing/detail verification exceeded ${MAX_FALLBACK_AGE_HOURS} hours, so retained ${board.company} roles were removed until the source recovers. Last check: ${reason || 'unverified Workday source'}`
    : `No trustworthy employer-direct verification timestamp was available, so retained ${board.company} roles were removed until the source can be verified.`;
  status.majorSources.employerDiagnostics[board.company] = { ...diagnostics, fallbackFreshness: nextWatch };
  durable.employers[board.company] = nextWatch;
  statusChanged = true;
  durableChanged = true;
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
    detailSampleSize: DETAIL_SAMPLE_SIZE,
    policy: `Retain a priority Workday employer snapshot for at most ${MAX_FALLBACK_AGE_HOURS} hours after the last complete official listing plus sampled current job-detail verification; then remove that employer until recovery.`,
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
if (durableChanged || JSON.stringify(durable) !== JSON.stringify(originalDurable)) {
  await writeFile(STATE_PATH, JSON.stringify(durable, null, 2) + '\n');
}

const healthyCount = summaries.filter(item => item.state === 'healthy').length;
const fallbackCount = summaries.filter(item => item.state === 'fallback').length;
const expiredCount = summaries.filter(item => item.state === 'expired').length;
console.log(`Major Workday listing/detail freshness check: ${healthyCount} healthy, ${fallbackCount} inside fallback window, ${expiredCount} expired; ${rolesChanged ? 'stale roles pruned' : 'no role pruning required'}.`);
