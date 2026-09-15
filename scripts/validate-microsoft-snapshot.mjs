import { readFile } from 'node:fs/promises';

const SNAPSHOT_PATH = 'data/microsoft-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const COMPANY = 'Microsoft';
const OFFICIAL_HOST = 'apply.careers.microsoft.com';
const MIN_PUBLIC_RETENTION = 0.80;
const MAX_FALLBACK_AGE_HOURS = 96;

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const normalize = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function canonicalTitle(job) {
  let title = clean(job?.title);
  const location = normalize(job?.location);
  const locationTokens = new Set(location.split(' ').filter(token => token.length > 1));
  const tailBelongsToLocation = tail => {
    const tokens = normalize(tail).split(' ').filter(token => token.length > 1);
    return tokens.length > 0 && tokens.every(token => locationTokens.has(token));
  };
  title = title.replace(/^\s*\d{2,5}\s*[-–—]\s*/u, '');
  title = title.replace(/\s+[-–—]\s+([^|]+)$/u, (full, tail) => tailBelongsToLocation(tail) ? '' : full);
  title = title.replace(/\s*\(([^)]+)\)\s*$/u, (full, tail) => tailBelongsToLocation(tail) ? '' : full);
  title = title.replace(/\s*[-–—,:()]?\s*(?:day|night|overnight|weekend)\s+shift(?:\s*\d+)?\s*$/iu, '');
  return normalize(title);
}
const uniqueTitles = records => new Set((records || []).map(canonicalTitle).filter(Boolean));

function canonicalMicrosoftUrl(value) {
  let parsed;
  try { parsed = new URL(clean(value)); }
  catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== OFFICIAL_HOST) return null;
  const match = parsed.pathname.match(/^\/careers\/job\/(\d+)\/?$/i);
  if (!match) return null;
  return {
    requisitionId: match[1],
    url: `https://${OFFICIAL_HOST}/careers/job/${match[1]}`
  };
}

function validatePublicSnapshotTraceability(snapshot, publicMicrosoft) {
  const issues = [];
  const snapshotById = new Map((snapshot || []).map(job => [clean(job?.id), job]).filter(([id]) => id));
  const publicIds = new Set();
  const publicRequisitions = new Set();

  for (const job of publicMicrosoft || []) {
    const id = clean(job?.id);
    const idMatch = id.match(/^microsoft-(\d+)$/i);
    const parsedUrl = canonicalMicrosoftUrl(job?.sourceUrl);

    if (!idMatch) issues.push(`Microsoft public role ${id || '(missing id)'} does not use the canonical microsoft-<requisition id> identity.`);
    if (!parsedUrl) issues.push(`Microsoft public role ${id || '(missing id)'} does not use a canonical employer-direct Microsoft Careers detail URL.`);
    if (idMatch && parsedUrl && idMatch[1] !== parsedUrl.requisitionId) {
      issues.push(`Microsoft public role ${id} does not match its Careers requisition ${parsedUrl.requisitionId}.`);
    }

    if (id) {
      if (publicIds.has(id)) issues.push(`Microsoft public feed contains duplicate id ${id}.`);
      publicIds.add(id);
    }
    if (parsedUrl) {
      if (publicRequisitions.has(parsedUrl.requisitionId)) issues.push(`Microsoft public feed contains duplicate requisition ${parsedUrl.requisitionId}.`);
      publicRequisitions.add(parsedUrl.requisitionId);
    }

    const authoritative = snapshotById.get(id);
    if (!authoritative) {
      issues.push(`Microsoft public role ${id || '(missing id)'} is not traceable to the authoritative snapshot.`);
      continue;
    }

    const authoritativeUrl = canonicalMicrosoftUrl(authoritative?.sourceUrl);
    if (!authoritativeUrl) {
      issues.push(`Microsoft authoritative role ${id} does not have a canonical Microsoft Careers detail URL.`);
    } else if (parsedUrl && parsedUrl.requisitionId !== authoritativeUrl.requisitionId) {
      issues.push(`Microsoft public role ${id} does not preserve authoritative requisition ${authoritativeUrl.requisitionId}.`);
    }
    if (canonicalTitle(job) !== canonicalTitle(authoritative)) {
      issues.push(`Microsoft public role ${id} title drifted from authoritative snapshot: ${clean(authoritative?.title)} -> ${clean(job?.title)}.`);
    }
    if (normalize(job?.location) !== normalize(authoritative?.location)) {
      issues.push(`Microsoft public role ${id} location drifted from authoritative snapshot: ${clean(authoritative?.location)} -> ${clean(job?.location)}.`);
    }
    if (clean(job?.type) !== clean(authoritative?.type)) {
      issues.push(`Microsoft public role ${id} type drifted from ${clean(authoritative?.type)} to ${clean(job?.type)}.`);
    }
    if (clean(job?.experience) !== clean(authoritative?.experience)) {
      issues.push(`Microsoft public role ${id} experience drifted from ${clean(authoritative?.experience)} to ${clean(job?.experience)}.`);
    }
    if (clean(job?.source) !== clean(authoritative?.source)) {
      issues.push(`Microsoft public role ${id} source label drifted from ${clean(authoritative?.source)} to ${clean(job?.source)}.`);
    }
    if (job?.active !== authoritative?.active || job?.demo !== authoritative?.demo) {
      issues.push(`Microsoft public role ${id} production state drifted from the authoritative snapshot.`);
    }
  }

  return issues;
}

function assertTest(condition, message) {
  if (!condition) throw new Error(`Microsoft requisition parity regression failed: ${message}`);
}

function runParityRegressionTests() {
  const authoritative = {
    id: 'microsoft-123456789',
    title: 'Data Center Technician (Nightshift)',
    company: COMPANY,
    location: 'Ashburn, VA',
    type: 'entry-level',
    experience: '0-2-years',
    source: 'Official Microsoft Careers',
    sourceUrl: 'https://apply.careers.microsoft.com/careers/job/123456789',
    active: true,
    demo: false
  };

  let issues = validatePublicSnapshotTraceability(
    [authoritative],
    [{ ...authoritative, pay: '$25–$35 / hr', region: 'mid-atlantic', firstSeenAt: '2026-09-01T00:00:00.000Z' }]
  );
  assertTest(issues.length === 0, `downstream enrichment should preserve traceability, got ${issues.join(' | ')}`);

  issues = validatePublicSnapshotTraceability([authoritative], [{ ...authoritative, experience: '2-5-years' }]);
  assertTest(issues.some(issue => issue.includes('experience drifted')), 'experience drift must fail closed');

  issues = validatePublicSnapshotTraceability([authoritative], [{ ...authoritative, location: 'Boydton, VA' }]);
  assertTest(issues.some(issue => issue.includes('location drifted')), 'location drift must fail closed');

  issues = validatePublicSnapshotTraceability([authoritative], [{ ...authoritative, sourceUrl: 'https://apply.careers.microsoft.com/careers/job/999999999' }]);
  assertTest(issues.some(issue => issue.includes('does not match its Careers requisition')), 'requisition URL drift must fail closed');

  issues = validatePublicSnapshotTraceability([], [authoritative]);
  assertTest(issues.some(issue => issue.includes('not traceable to the authoritative snapshot')), 'unexpected public requisition must fail closed');

  issues = validatePublicSnapshotTraceability([authoritative], [authoritative, { ...authoritative }]);
  assertTest(issues.some(issue => issue.includes('duplicate id')), 'duplicate public requisition id must fail closed');

  console.log('Microsoft requisition parity regression passed.');
}

if (process.argv.includes('--test')) {
  runParityRegressionTests();
  process.exit(0);
}

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' && fallback !== null) return fallback;
    throw error;
  }
}

let snapshot;
try {
  snapshot = await readJson(SNAPSHOT_PATH);
} catch (error) {
  if (error?.code === 'ENOENT') {
    console.warn('Microsoft verified snapshot has not been created yet; validation will become active after the next healthy Microsoft refresh.');
    process.exit(0);
  }
  throw error;
}

if (!snapshot || !Array.isArray(snapshot.jobs) || !snapshot.jobs.length) {
  throw new Error('Microsoft snapshot must contain at least one verified job.');
}
const verifiedAt = Date.parse(snapshot.verifiedAt);
const expiresAt = Date.parse(snapshot.expiresAt);
if (!Number.isFinite(verifiedAt) || !Number.isFinite(expiresAt) || expiresAt <= verifiedAt) {
  throw new Error('Microsoft snapshot verification timestamps are invalid.');
}
if (expiresAt - verifiedAt > 8 * 24 * 60 * 60 * 1000) {
  throw new Error('Microsoft snapshot fallback window exceeds the allowed short-term recovery period.');
}
const policyExpiresAt = Math.min(expiresAt, verifiedAt + MAX_FALLBACK_AGE_HOURS * 60 * 60 * 1000);
const policyFresh = Date.now() < policyExpiresAt;

const ids = new Set();
const requisitions = new Set();
for (const job of snapshot.jobs) {
  if (!job || typeof job !== 'object') throw new Error('Microsoft snapshot contains a non-object role.');
  if (clean(job.company) !== COMPANY) throw new Error(`Microsoft snapshot contains unexpected company ${job.company || '(missing)'}.`);
  const id = clean(job.id);
  const idMatch = id.match(/^microsoft-(\d+)$/i);
  if (!id || ids.has(id)) throw new Error(`Microsoft snapshot contains a missing or duplicate job id: ${id || '(missing)'}`);
  ids.add(id);
  if (!idMatch) throw new Error(`Microsoft snapshot id ${id} does not use microsoft-<requisition id>.`);
  const parsedUrl = canonicalMicrosoftUrl(job.sourceUrl);
  if (!parsedUrl) throw new Error(`Microsoft snapshot contains a non-canonical official URL for ${id}.`);
  if (parsedUrl.requisitionId !== idMatch[1]) throw new Error(`Microsoft snapshot id ${id} does not match requisition ${parsedUrl.requisitionId}.`);
  if (requisitions.has(parsedUrl.requisitionId)) throw new Error(`Microsoft snapshot contains duplicate requisition ${parsedUrl.requisitionId}.`);
  requisitions.add(parsedUrl.requisitionId);
  if (!['internship', 'apprenticeship', 'trainee', 'entry-level'].includes(job.type)) throw new Error(`Microsoft snapshot has unsupported type ${job.type || '(missing)'}.`);
  if (!['no-experience', '0-2-years', '2-5-years'].includes(job.experience)) throw new Error(`Microsoft snapshot has unsupported experience ${job.experience || '(missing)'}.`);
  if (job?.active !== true || job?.demo === true) throw new Error(`Microsoft snapshot role ${id} is not an active production role.`);
  if (clean(job?.source) !== 'Official Microsoft Careers') throw new Error(`Microsoft snapshot role ${id} has unexpected source label ${clean(job?.source) || '(missing)'}.`);
}

const jobs = await readJson(JOBS_PATH, []);
if (!Array.isArray(jobs)) throw new Error('data/jobs.json must contain an array.');
const status = await readJson(STATUS_PATH, {});
const microsoftStatus = status?.microsoftDatacenter || {};
const sourceHealthy = microsoftStatus.sourceHealthy === true && microsoftStatus.sourceMode !== 'retained-previous';
const fallback = microsoftStatus.snapshotFallback || {};
const publicMicrosoft = jobs.filter(job => clean(job?.company) === COMPANY);

const traceabilityIssues = validatePublicSnapshotTraceability(snapshot.jobs, publicMicrosoft);
if (traceabilityIssues.length) {
  for (const issue of traceabilityIssues) console.error(`Microsoft source-integrity violation: ${issue}`);
  throw new Error(`Blocked ${traceabilityIssues.length} Microsoft requisition traceability violation(s).`);
}

if (!sourceHealthy && !policyFresh && publicMicrosoft.length) {
  throw new Error(`Microsoft public feed still contains ${publicMicrosoft.length} role(s) more than ${MAX_FALLBACK_AGE_HOURS} hours after the last verified employer-direct snapshot.`);
}

const snapshotTitles = uniqueTitles(snapshot.jobs);
const publicTitles = uniqueTitles(publicMicrosoft);
const missingTitles = [...snapshotTitles].filter(title => !publicTitles.has(title));
const shouldEnforceRetention = sourceHealthy || policyFresh || fallback.active === true;

// The public feed intentionally collapses same-employer/same-title postings
// across locations and shifts. Protect unique role coverage while separately
// requiring every published Microsoft card to trace to one exact requisition.
if (shouldEnforceRetention && snapshotTitles.size >= 8) {
  const minimumRetained = Math.ceil(snapshotTitles.size * MIN_PUBLIC_RETENTION);
  if (publicTitles.size < minimumRetained) {
    throw new Error(`Microsoft public feed retained only ${publicTitles.size}/${snapshotTitles.size} unique verified role titles; expected at least ${minimumRetained}.`);
  }
}
if (shouldEnforceRetention && missingTitles.length > Math.floor(snapshotTitles.size * (1 - MIN_PUBLIC_RETENTION))) {
  throw new Error(`Microsoft public feed is missing ${missingTitles.length}/${snapshotTitles.size} unique verified role title(s).`);
}

if (fallback.active === true) {
  const fallbackExpiresAt = Date.parse(clean(fallback.expiresAt));
  const fallbackRoles = Number(fallback.roles || 0);
  if (!Number.isFinite(fallbackExpiresAt)) {
    throw new Error('Microsoft snapshot fallback is active without a valid expiry timestamp.');
  }
  if (fallbackExpiresAt > verifiedAt + MAX_FALLBACK_AGE_HOURS * 60 * 60 * 1000) {
    throw new Error(`Microsoft snapshot fallback extends beyond the ${MAX_FALLBACK_AGE_HOURS}-hour employer-verification window.`);
  }
  if (Date.now() >= fallbackExpiresAt) {
    throw new Error(`Microsoft snapshot fallback is still active after its ${fallback.expiresAt} expiry.`);
  }
  if (fallbackRoles !== snapshot.jobs.length) {
    throw new Error(`Microsoft fallback metadata expects ${fallbackRoles} role(s), but the verified snapshot contains ${snapshot.jobs.length}.`);
  }
  if (missingTitles.length) {
    throw new Error(`Microsoft active fallback lost ${missingTitles.length}/${snapshotTitles.size} unique verified role title(s) before deployment.`);
  }
}

if (!policyFresh) {
  console.warn(`Microsoft snapshot exceeded the ${MAX_FALLBACK_AGE_HOURS}-hour publication window at ${new Date(policyExpiresAt).toISOString()}; fallback restoration is disabled until a fresh direct-source refresh.`);
} else {
  console.log(`Microsoft snapshot validation passed: ${snapshot.jobs.length} employer-direct requisitions represented by ${publicMicrosoft.length} exact-traceable public card(s) across ${publicTitles.size} role title(s), recoverable through ${new Date(policyExpiresAt).toISOString()}.`);
}
if (fallback.active === true) {
  console.log(`Microsoft zero-collapse fallback integrity passed: ${publicTitles.size}/${snapshotTitles.size} unique verified role titles remain public.`);
}
