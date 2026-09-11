import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const MAJOR_PATH = 'data/major-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const MAX_ROLE_EVIDENCE_AGE_HOURS = 96;
const HEALTHY_STAMP_INTERVAL_HOURS = 20;

// Targeted recovery can find roles that the broad Workday listing temporarily
// misses. Re-check the official Workday detail endpoint every six hours so
// recovered records cannot linger after an employer closes them or when a role
// can no longer be verified independently for an extended period.
const boards = new Map([
  ['Vantage Data Centers', { origin: 'https://vantagedc.wd1.myworkdayjobs.com', tenant: 'vantagedc', site: 'Vantage', locale: 'en-US' }],
  ['QTS Data Centers', { origin: 'https://qtsdatacenters.wd5.myworkdayjobs.com', tenant: 'qtsdatacenters', site: 'QTS', locale: 'en-US' }],
  ['CyrusOne', { origin: 'https://cyrusone.wd1.myworkdayjobs.com', tenant: 'cyrusone', site: 'CyrusOneCareerPortal', locale: 'en-US' }],
  ['STACK Infrastructure', { origin: 'https://stackinfra.wd108.myworkdayjobs.com', tenant: 'stackinfra', site: 'STACK_AMER', locale: 'en-US' }],
  ['NTT Global Data Centers', { origin: 'https://nttglobaldatacenters.wd501.myworkdayjobs.com', tenant: 'nttglobaldatacenters', site: 'External', locale: 'en-US' }],
  ['Aligned Data Centers', { origin: 'https://aligneddc.wd12.myworkdayjobs.com', tenant: 'aligneddc', site: 'aligneddc', locale: 'en-US' }]
]);

const clean = value => String(value ?? '').trim();
const canonicalUrl = value => {
  const raw = clean(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return raw.replace(/\/$/, '');
  }
};

async function readArray(path) {
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(value)) throw new Error(`${path} must contain an array`);
  return value;
}

async function readObject(path) {
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must contain an object`);
  return value;
}

function summarize(records, field) {
  return records.reduce((acc, job) => {
    const value = clean(job?.[field]) || 'unknown';
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function detailEndpoint(job) {
  const board = boards.get(clean(job?.company));
  if (!board) return null;

  let source;
  try { source = new URL(clean(job?.sourceUrl)); }
  catch { return null; }

  const origin = new URL(board.origin);
  if (source.protocol !== 'https:' || source.hostname.toLowerCase() !== origin.hostname.toLowerCase()) return null;

  const prefix = `/${board.locale}/${board.site}`;
  if (!source.pathname.startsWith(prefix)) return null;
  const externalPath = source.pathname.slice(prefix.length);
  if (!externalPath.startsWith('/')) return null;

  return {
    sourceUrl: source.href,
    detailUrl: `${board.origin}/wday/cxs/${board.tenant}/${board.site}${externalPath}`
  };
}

async function liveState(job) {
  const endpoint = detailEndpoint(job);
  if (!endpoint) return { state: 'unmanaged' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(endpoint.detailUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        accept: 'application/json',
        referer: endpoint.sourceUrl,
        'user-agent': 'DataCenterCareersBot/1.6 (+https://datacentercareers.us/)'
      }
    });
    if (response.ok) {
      try {
        const payload = await response.json();
        const info = payload?.jobPostingInfo || payload?.jobInfo || payload;
        const marker = clean(info?.title || info?.jobPostingTitle || info?.jobTitle || info?.jobDescription || info?.description);
        if (!marker) return { state: 'transient', status: response.status, error: 'official detail endpoint returned an empty payload' };
        return { state: 'live', status: response.status };
      } catch {
        return { state: 'transient', status: response.status, error: 'official detail endpoint did not return valid JSON' };
      }
    }
    if (response.status === 404 || response.status === 410) return { state: 'closed', status: response.status };
    return { state: 'transient', status: response.status };
  } catch (error) {
    return { state: 'transient', error: error?.name === 'AbortError' ? 'timeout' : clean(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

function key(job) {
  return canonicalUrl(job?.sourceUrl);
}

function evidenceDecision(record, nowMs) {
  const verifiedMs = Date.parse(clean(record?.lastVerifiedAt));
  const unverifiedMs = Date.parse(clean(record?.firstUnverifiedAt));
  const baselineMs = Number.isFinite(verifiedMs) ? verifiedMs : unverifiedMs;
  if (!Number.isFinite(baselineMs)) {
    return { expired: false, ageHours: 0, baseline: null, startsGraceNow: true };
  }
  const ageHours = Math.max(0, (nowMs - baselineMs) / 36e5);
  return {
    expired: ageHours >= MAX_ROLE_EVIDENCE_AGE_HOURS,
    ageHours,
    baseline: new Date(baselineMs).toISOString(),
    startsGraceNow: false
  };
}

function runSelfTest() {
  const now = Date.parse('2026-09-11T12:00:00Z');
  const freshVerified = evidenceDecision({ lastVerifiedAt: '2026-09-07T13:00:00Z' }, now);
  if (freshVerified.expired) throw new Error('per-role evidence expired before 96 hours');
  const expiredVerified = evidenceDecision({ lastVerifiedAt: '2026-09-07T12:00:00Z' }, now);
  if (!expiredVerified.expired) throw new Error('per-role evidence did not expire at 96 hours');
  const freshGrace = evidenceDecision({ firstUnverifiedAt: '2026-09-10T12:00:00Z' }, now);
  if (freshGrace.expired) throw new Error('new-role transient grace expired too early');
  const missing = evidenceDecision({}, now);
  if (missing.expired || !missing.startsGraceNow) throw new Error('missing evidence did not start a bounded grace window');
  const verifiedWins = evidenceDecision({
    lastVerifiedAt: '2026-09-07T12:00:00Z',
    firstUnverifiedAt: '2026-09-11T11:00:00Z'
  }, now);
  if (!verifiedWins.expired) throw new Error('new transient timestamp incorrectly extended old successful evidence');
  console.log('Priority Workday per-role evidence regression tests passed.');
}

if (process.argv.includes('--test')) {
  runSelfTest();
  process.exit(0);
}

const jobs = await readArray(JOBS_PATH);
const major = await readArray(MAJOR_PATH);
const status = await readObject(STATUS_PATH);
status.majorSources = status.majorSources && typeof status.majorSources === 'object' && !Array.isArray(status.majorSources)
  ? status.majorSources
  : {};
const previousPrune = status.majorSources.closedRolePrune;
const previousEvidence = status.majorSources.roleEvidence && typeof status.majorSources.roleEvidence === 'object' && !Array.isArray(status.majorSources.roleEvidence)
  ? status.majorSources.roleEvidence
  : {};
const evidence = { ...previousEvidence };

const candidates = new Map();
for (const job of [...jobs, ...major]) {
  const url = key(job);
  if (!url || candidates.has(url) || !detailEndpoint(job)) continue;
  candidates.set(url, job);
}

const removeUrls = new Set();
const closedByCompany = {};
const evidenceExpiredByCompany = {};
const transient = [];
const removedRoles = [];
const nowMs = Date.now();
const nowIso = new Date(nowMs).toISOString();
let checked = 0;
let live = 0;
let evidenceChanged = false;

const rows = [...candidates.entries()];
for (let index = 0; index < rows.length; index += 8) {
  const batch = rows.slice(index, index + 8);
  const states = await Promise.all(batch.map(async ([url, job]) => [url, job, await liveState(job)]));
  for (const [url, job, result] of states) {
    checked += 1;
    const prior = evidence[url] && typeof evidence[url] === 'object' ? evidence[url] : {};

    if (result.state === 'live') {
      live += 1;
      const priorVerifiedMs = Date.parse(clean(prior.lastVerifiedAt));
      const ageHours = Number.isFinite(priorVerifiedMs) ? Math.max(0, (nowMs - priorVerifiedMs) / 36e5) : Infinity;
      if (!prior.lastVerifiedAt || prior.firstUnverifiedAt || prior.lastState !== 'live' || ageHours >= HEALTHY_STAMP_INTERVAL_HOURS) {
        evidence[url] = {
          company: clean(job.company),
          title: clean(job.title),
          sourceUrl: clean(job.sourceUrl),
          lastVerifiedAt: nowIso,
          firstUnverifiedAt: null,
          lastState: 'live',
          lastStatus: result.status || 200
        };
        evidenceChanged = true;
      }
      continue;
    }

    if (result.state === 'closed') {
      removeUrls.add(url);
      const company = clean(job.company) || 'Unknown';
      closedByCompany[company] = (closedByCompany[company] || 0) + 1;
      removedRoles.push({ company, title: clean(job.title), sourceUrl: clean(job.sourceUrl), reason: `HTTP ${result.status}` });
      evidence[url] = {
        ...prior,
        company,
        title: clean(job.title),
        sourceUrl: clean(job.sourceUrl),
        firstUnverifiedAt: prior.firstUnverifiedAt || nowIso,
        lastState: 'closed',
        lastStatus: result.status || null,
        closedAt: nowIso
      };
      evidenceChanged = true;
      console.log(`Closed Workday role: ${job.company} — ${job.title} (${result.status})`);
      continue;
    }

    if (result.state === 'transient') {
      const decision = evidenceDecision(prior, nowMs);
      const firstUnverifiedAt = prior.firstUnverifiedAt || (decision.startsGraceNow ? nowIso : null);
      const nextRecord = {
        ...prior,
        company: clean(job.company),
        title: clean(job.title),
        sourceUrl: clean(job.sourceUrl),
        firstUnverifiedAt,
        lastState: 'transient',
        lastStatus: result.status || null,
        lastError: result.error || null
      };
      if (JSON.stringify(nextRecord) !== JSON.stringify(prior)) {
        evidence[url] = nextRecord;
        evidenceChanged = true;
      }

      const effectiveDecision = evidenceDecision(nextRecord, nowMs);
      if (effectiveDecision.expired) {
        removeUrls.add(url);
        const company = clean(job.company) || 'Unknown';
        evidenceExpiredByCompany[company] = (evidenceExpiredByCompany[company] || 0) + 1;
        removedRoles.push({
          company,
          title: clean(job.title),
          sourceUrl: clean(job.sourceUrl),
          reason: `${effectiveDecision.ageHours.toFixed(1)}h without successful per-role verification`
        });
        console.log(`Unverified Workday role expired: ${job.company} — ${job.title} (${effectiveDecision.ageHours.toFixed(1)}h without successful per-role verification)`);
      } else {
        transient.push({
          company: job.company,
          title: job.title,
          status: result.status || null,
          error: result.error || null,
          evidenceAgeHours: Number(effectiveDecision.ageHours.toFixed(1)),
          evidenceExpiresAt: effectiveDecision.baseline
            ? new Date(Date.parse(effectiveDecision.baseline) + MAX_ROLE_EVIDENCE_AGE_HOURS * 36e5).toISOString()
            : new Date(nowMs + MAX_ROLE_EVIDENCE_AGE_HOURS * 36e5).toISOString()
        });
      }
    }
  }
}

const nextJobs = jobs.filter(job => !removeUrls.has(key(job)));
const nextMajor = major.filter(job => !removeUrls.has(key(job)));
const retainedUrls = new Set([...nextJobs, ...nextMajor].map(key).filter(Boolean));
for (const url of Object.keys(evidence)) {
  if (!retainedUrls.has(url)) {
    delete evidence[url];
    evidenceChanged = true;
  }
}

const rolesChanged = nextJobs.length !== jobs.length || nextMajor.length !== major.length;
if (rolesChanged) {
  status.updatedAt = nowIso;
  status.jobs = nextJobs.length;
  status.countsByType = summarize(nextJobs, 'type');
  status.countsByExperience = summarize(nextJobs, 'experience');
  status.majorSources.jobs = nextMajor.length;
  status.majorSources.reconciliation = {
    ...(status.majorSources.reconciliation || {}),
    checkedAt: nowIso,
    rawJobs: nextMajor.length,
    publishedUsJobs: nextMajor.length,
    closedRolePruneAt: nowIso,
    closedRolesRemoved: Object.values(closedByCompany).reduce((sum, value) => sum + value, 0),
    staleEvidenceRolesRemoved: Object.values(evidenceExpiredByCompany).reduce((sum, value) => sum + value, 0)
  };
}

status.majorSources.roleEvidence = evidence;
status.majorSources.closedRolePrune = {
  checkedAt: nowIso,
  officialRoleUrlsChecked: checked,
  liveVerified: live,
  removed: removeUrls.size,
  closedRemoved: Object.values(closedByCompany).reduce((sum, value) => sum + value, 0),
  staleEvidenceRemoved: Object.values(evidenceExpiredByCompany).reduce((sum, value) => sum + value, 0),
  removedClosedByCompany: closedByCompany,
  removedStaleEvidenceByCompany: evidenceExpiredByCompany,
  transientKept: transient.length,
  removedRoles,
  maxPerRoleEvidenceAgeHours: MAX_ROLE_EVIDENCE_AGE_HOURS,
  healthyStampIntervalHours: HEALTHY_STAMP_INTERVAL_HOURS,
  policy: `Remove priority Workday roles immediately on official HTTP 404/410. For transient detail failures, each role must regain its own successful official detail verification within ${MAX_ROLE_EVIDENCE_AGE_HOURS} hours; a newly tracked role gets one bounded grace window instead of being removed on its first transient check. Aggregate employer health cannot indefinitely protect an unverified role.`
};

if (rolesChanged) {
  await writeFile(JOBS_PATH, JSON.stringify(nextJobs, null, 2) + '\n');
  await writeFile(MAJOR_PATH, JSON.stringify(nextMajor, null, 2) + '\n');
}
if (rolesChanged || evidenceChanged || JSON.stringify(status.majorSources.closedRolePrune) !== JSON.stringify(previousPrune)) {
  await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
}

if (!removeUrls.size) {
  console.log(`Priority Workday liveness passed: ${checked} official role URL(s) checked; ${live} independently verified live; 0 removed.${transient.length ? ` ${transient.length} transient check(s) remain inside the ${MAX_ROLE_EVIDENCE_AGE_HOURS}-hour per-role evidence window.` : ''}`);
  process.exit(0);
}

console.log(`Pruned ${removeUrls.size} priority Workday role URL(s): ${Object.values(closedByCompany).reduce((sum, value) => sum + value, 0)} definitively closed, ${Object.values(evidenceExpiredByCompany).reduce((sum, value) => sum + value, 0)} beyond the per-role evidence window; public feed ${jobs.length}→${nextJobs.length}, major snapshot ${major.length}→${nextMajor.length}.`);
if (transient.length) console.log(`Kept ${transient.length} transient role(s) still inside the bounded evidence window.`);
