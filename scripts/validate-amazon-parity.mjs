import { readFile } from 'node:fs/promises';

const COMPANY = 'Amazon Web Services';
const SNAPSHOT_PATH = 'data/amazon-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const SOURCE_LABEL = 'Official Amazon Jobs';
const MIN_LARGE_SNAPSHOT_RETENTION = 0.95;
const allowedTypes = new Set(['entry-level', 'internship', 'apprenticeship', 'trainee']);
const allowedExperience = new Set(['no-experience', '0-2-years', '2-5-years']);

// Keep these publication exclusions aligned with filter-mission-fit.mjs. The AWS
// recovery snapshot is a verified source ledger; the public feed may legitimately
// omit senior, non-mission, foreign, or later-QA-dead records from that ledger.
const obviousNonMissionTitlePattern = /\b(?:administrative business partner|business analyst|financial operations|financial analyst|finance analyst|finance|accounting|accountant|procurement|purchasing|cost management|cost estimator|cost analyst|cost controls|security operations|security engineer|security analyst|security specialist|security technician|security officer|security guard|physical security|global security operations center|gsoc|wireless intrusion detection|cybersecurity|information security|software engineer|software developer|site reliability engineer|machine learning engineer|ml engineer|data scientist|product manager|program manager|talent acquisition|human resources|recruiter|account executive|sales representative|sales manager|marketing manager|marketing specialist|legal counsel|corporate counsel|legal assistant|legal intern|paralegal|law clerk|enterprise it support|enterprise applications|process analytics|project controls analyst|material planner|cnc operator|assembly technician|quality technician|assurance operations analyst)\b/i;
const obviousSeniorTitlePattern = /\b(?:senior|sr\.?|lead|leader|principal|chief|manager|mgr\.?|director|vice president|vp|head of|staff|supervisor|superintendent|foreman|architect)\b/i;
const canadianProvinceCodePattern = /,\s*(?:AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)\b(?:\s*,?\s*Canada)?\s*$/i;
const canadianProvinceNamePattern = /,\s*(?:Alberta|British Columbia|Manitoba|New Brunswick|Newfoundland(?: and Labrador)?|Nova Scotia|Northwest Territories|Nunavut|Ontario|Prince Edward Island|Quebec|Saskatchewan|Yukon)\b(?:\s*,?\s*Canada)?\s*$/i;
const foreignCountryPattern = /(?:^|[,;]\s*)(?:Canada|Mexico|Ireland|United Kingdom|UK|England|Germany|France|Netherlands|Switzerland|India|Japan|Taiwan|Singapore|Australia|China|Malaysia|Indonesia|Thailand|Brazil|South Africa|United Arab Emirates)\s*$/i;

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const normalize = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function canonicalAmazonUrl(value) {
  let parsed;
  try { parsed = new URL(clean(value)); } catch { return null; }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || !new Set(['amazon.jobs', 'www.amazon.jobs']).has(host)) return null;
  const match = parsed.pathname.match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?jobs\/(\d+)(?:\/([^/?#]+))?\/?$/i);
  if (!match) return null;
  return {
    requisitionId: match[1],
    canonicalUrl: `https://www.amazon.jobs/en/jobs/${match[1]}`
  };
}

function clearlyNonUsLocation(location = '') {
  return clean(location).split(';').map(part => part.trim()).filter(Boolean).some(segment =>
    canadianProvinceCodePattern.test(segment) ||
    canadianProvinceNamePattern.test(segment) ||
    foreignCountryPattern.test(segment)
  );
}

function publicationEligible(job) {
  const title = clean(job?.title);
  if (!title || obviousNonMissionTitlePattern.test(title) || obviousSeniorTitlePattern.test(title)) return false;
  return !clearlyNonUsLocation(job?.location);
}

function isAmazonRole(job) {
  return clean(job?.company) === COMPANY || Boolean(canonicalAmazonUrl(job?.sourceUrl));
}

function snapshotStatusCounts(status = {}) {
  return [...new Set([
    Number(status?.amazonDetailRecovery?.qualifyingRoles),
    Number(status?.amazonDatacenter?.qualifyingRoles)
  ].filter(Number.isFinite))];
}

function minimumRetainedCount(eligibleCount) {
  if (eligibleCount <= 0) return 0;
  if (eligibleCount < 20) return Math.max(1, eligibleCount - 1);
  return Math.ceil(eligibleCount * MIN_LARGE_SNAPSHOT_RETENTION);
}

function validateAmazonPublication(snapshot, publicJobs, status = {}) {
  const issues = [];
  const snapshotIds = new Set();
  const snapshotReqs = new Set();
  const protectedByReq = new Map();
  const protectedSnapshot = [];

  for (const job of snapshot) {
    const id = clean(job?.id);
    const idMatch = id.match(/^amazon-(\d+)$/i);
    const parsed = canonicalAmazonUrl(job?.sourceUrl);
    const type = clean(job?.type);
    const experience = clean(job?.experience);

    if (clean(job?.company) !== COMPANY) issues.push(`Snapshot ${id || '(missing id)'} belongs to ${clean(job?.company) || '(missing company)'}.`);
    if (!idMatch) issues.push(`Snapshot ${id || '(missing id)'} does not use amazon-<requisition id>.`);
    if (!parsed) issues.push(`Snapshot ${id || '(missing id)'} does not use an official Amazon Jobs detail URL.`);
    if (idMatch && parsed && idMatch[1] !== parsed.requisitionId) issues.push(`Snapshot ${id} does not match Amazon requisition ${parsed.requisitionId}.`);
    if (clean(job?.source) !== SOURCE_LABEL) issues.push(`Snapshot ${id || '(missing id)'} has unexpected source ${clean(job?.source) || '(missing)'}.`);
    if (!allowedTypes.has(type)) issues.push(`Snapshot ${id || '(missing id)'} has unsupported type ${type || '(missing)'}.`);
    if (!allowedExperience.has(experience)) issues.push(`Snapshot ${id || '(missing id)'} has unsupported experience ${experience || '(missing)'}.`);
    if (job?.active !== true || job?.demo === true) issues.push(`Snapshot ${id || '(missing id)'} is not an active production role.`);
    if (!clean(job?.title)) issues.push(`Snapshot ${id || '(missing id)'} has no title.`);
    if (!clean(job?.location)) issues.push(`Snapshot ${id || '(missing id)'} has no location.`);

    if (id) {
      if (snapshotIds.has(id)) issues.push(`Snapshot contains duplicate id ${id}.`);
      snapshotIds.add(id);
    }
    if (parsed) {
      if (snapshotReqs.has(parsed.requisitionId)) issues.push(`Snapshot contains duplicate requisition ${parsed.requisitionId}.`);
      snapshotReqs.add(parsed.requisitionId);
    }

    if (publicationEligible(job) && parsed) {
      protectedSnapshot.push(job);
      protectedByReq.set(parsed.requisitionId, job);
    }
  }

  const publicReqs = new Set();
  for (const job of publicJobs) {
    const id = clean(job?.id);
    const idMatch = id.match(/^amazon-(\d+)$/i);
    const parsed = canonicalAmazonUrl(job?.sourceUrl);
    const type = clean(job?.type);
    const experience = clean(job?.experience);

    if (clean(job?.company) !== COMPANY) issues.push(`Public AWS role ${id || '(missing id)'} has the wrong company.`);
    if (!idMatch) issues.push(`Public AWS role ${id || '(missing id)'} does not use amazon-<requisition id>.`);
    if (!parsed) issues.push(`Public AWS role ${id || '(missing id)'} does not use an official Amazon Jobs detail URL.`);
    if (idMatch && parsed && idMatch[1] !== parsed.requisitionId) issues.push(`Public AWS role ${id} does not match Amazon requisition ${parsed.requisitionId}.`);
    if (clean(job?.source) !== SOURCE_LABEL) issues.push(`Public AWS role ${id || '(missing id)'} has unexpected source ${clean(job?.source) || '(missing)'}.`);
    if (!allowedTypes.has(type)) issues.push(`Public AWS role ${id || '(missing id)'} has unsupported type ${type || '(missing)'}.`);
    if (!allowedExperience.has(experience)) issues.push(`Public AWS role ${id || '(missing id)'} has unsupported experience ${experience || '(missing)'}.`);
    if (job?.active !== true || job?.demo === true) issues.push(`Public AWS role ${id || '(missing id)'} is not an active production role.`);
    if (!publicationEligible(job)) issues.push(`Public AWS role ${id || '(missing id)'} violates the shared mission-fit backstop.`);

    const req = parsed?.requisitionId || idMatch?.[1] || '';
    if (!req) continue;
    if (publicReqs.has(req)) issues.push(`Public feed contains duplicate AWS requisition ${req}.`);
    publicReqs.add(req);

    const authoritative = protectedByReq.get(req);
    if (!authoritative) {
      issues.push(`Public AWS requisition ${req} is not traceable to a publication-eligible authoritative snapshot role.`);
      continue;
    }

    const parityChecks = [
      ['title', normalize(job?.title), normalize(authoritative?.title)],
      ['location', normalize(job?.location), normalize(authoritative?.location)],
      ['type', clean(job?.type), clean(authoritative?.type)],
      ['experience', clean(job?.experience), clean(authoritative?.experience)],
      ['source', clean(job?.source), clean(authoritative?.source)],
      ['active', job?.active, authoritative?.active],
      ['demo', job?.demo, authoritative?.demo]
    ];
    for (const [field, actual, expected] of parityChecks) {
      if (actual !== expected) issues.push(`Public AWS requisition ${req} differs from the authoritative snapshot for ${field}.`);
    }
  }

  const requiredPublic = minimumRetainedCount(protectedSnapshot.length);
  if (publicReqs.size < requiredPublic) {
    const pct = protectedSnapshot.length ? Math.round((publicReqs.size / protectedSnapshot.length) * 1000) / 10 : 100;
    issues.push(`AWS public feed retained only ${publicReqs.size}/${protectedSnapshot.length} publication-eligible authoritative requisitions (${pct}%); minimum is ${requiredPublic}.`);
  }

  const reportedCounts = snapshotStatusCounts(status);
  if (reportedCounts.length && !reportedCounts.includes(snapshot.length)) {
    issues.push(`AWS status does not account for the authoritative snapshot count ${snapshot.length}; reported qualifying counts: ${reportedCounts.join(', ')}.`);
  }

  const amazonStatus = status?.amazonDatacenter || {};
  const fallback = amazonStatus?.fallbackFreshness || {};
  if (fallback?.expired === true && (snapshot.length || publicJobs.length)) {
    issues.push(`AWS fallback is expired but ${snapshot.length} snapshot / ${publicJobs.length} public role(s) remain.`);
  }
  if (amazonStatus?.sourceHealthy === true) {
    const attempted = Number(amazonStatus?.queriesAttempted || 0);
    const succeeded = Number(amazonStatus?.queriesSucceeded || 0);
    if (attempted <= 0 || succeeded !== attempted) issues.push(`AWS source is marked healthy without a complete official search set (${succeeded}/${attempted}).`);
    if (Number(amazonStatus?.preservedPreviousRoles || 0) !== 0) issues.push('AWS source is marked healthy while preserved fallback roles remain.');
  }

  return {
    issues,
    snapshotCount: snapshot.length,
    eligibleCount: protectedSnapshot.length,
    excludedCount: snapshot.length - protectedSnapshot.length,
    publicCount: publicReqs.size,
    requiredPublic
  };
}

function assertTest(condition, message) {
  if (!condition) throw new Error(`AWS publication regression failed: ${message}`);
}

function sampleJob(number, overrides = {}) {
  return {
    id: `amazon-${10000000 + number}`,
    title: `Data Center Operations Technician ${number}`,
    company: COMPANY,
    location: 'Sterling, VA',
    type: 'entry-level',
    experience: '0-2-years',
    source: SOURCE_LABEL,
    sourceUrl: `https://www.amazon.jobs/en/jobs/${10000000 + number}/data-center-operations-technician-${number}`,
    active: true,
    demo: false,
    ...overrides
  };
}

function runRegressionTests() {
  const authoritative = sampleJob(1, { type: 'internship', experience: 'no-experience', title: 'Data Center Engineering Operations Technician Internship' });
  const healthy = { amazonDatacenter: { sourceHealthy: true, queriesAttempted: 5, queriesSucceeded: 5, preservedPreviousRoles: 0, qualifyingRoles: 1 } };

  let result = validateAmazonPublication([authoritative], [{ ...authoritative, pay: '$25–$35 / hr', region: 'mid-atlantic' }], healthy);
  assertTest(result.issues.length === 0, `downstream enrichment should preserve exact source parity: ${result.issues.join(' | ')}`);

  result = validateAmazonPublication([authoritative], [{ ...authoritative, experience: '2-5-years' }], healthy);
  assertTest(result.issues.some(issue => issue.includes('experience')), 'experience drift must fail closed');

  result = validateAmazonPublication([authoritative], [{ ...authoritative, sourceUrl: 'https://www.amazon.jobs/en/jobs/99999999/not-the-same-role' }], healthy);
  assertTest(result.issues.some(issue => issue.includes('does not match Amazon requisition')), 'requisition mismatch must fail closed');

  result = validateAmazonPublication([], [authoritative], {});
  assertTest(result.issues.some(issue => issue.includes('not traceable')), 'unexpected public requisition must fail closed');

  result = validateAmazonPublication([authoritative], [authoritative, { ...authoritative }], healthy);
  assertTest(result.issues.some(issue => issue.includes('duplicate AWS requisition')), 'duplicate public requisition must fail closed');

  const senior = sampleJob(2, { title: 'Cluster Operations Leader, ADC Data Center Ops' });
  result = validateAmazonPublication([senior], [], { amazonDatacenter: { qualifyingRoles: 1 } });
  assertTest(result.issues.length === 0 && result.excludedCount === 1, 'shared senior-title backstop must be an intentional snapshot exclusion');

  const hundred = Array.from({ length: 100 }, (_, index) => sampleJob(index + 100));
  result = validateAmazonPublication(hundred, hundred.slice(0, 95), { amazonDetailRecovery: { qualifyingRoles: 100 } });
  assertTest(result.issues.length === 0 && result.requiredPublic === 95, '95/100 eligible AWS roles must satisfy strict retention');

  result = validateAmazonPublication(hundred, hundred.slice(0, 94), { amazonDetailRecovery: { qualifyingRoles: 100 } });
  assertTest(result.issues.some(issue => issue.includes('retained only')), '94/100 eligible AWS roles must fail strict retention');

  result = validateAmazonPublication([authoritative], [authoritative], {
    amazonDatacenter: { ...healthy.amazonDatacenter, fallbackFreshness: { expired: true } }
  });
  assertTest(result.issues.some(issue => issue.includes('fallback is expired')), 'expired fallback with published roles must fail closed');

  result = validateAmazonPublication([authoritative], [authoritative], {
    amazonDatacenter: { ...healthy.amazonDatacenter, qualifyingRoles: 19 },
    amazonDetailRecovery: { qualifyingRoles: 1 }
  });
  assertTest(!result.issues.some(issue => issue.includes('does not account')), 'a matching recovery-layer count must satisfy snapshot accountability');

  assertTest(Boolean(canonicalAmazonUrl('https://amazon.jobs/en/jobs/10000001/role/')), 'official host alias must canonicalize');
  assertTest(!canonicalAmazonUrl('https://example.com/en/jobs/10000001/role'), 'non-official host must be rejected');

  console.log('AWS publication/source integrity regression tests passed.');
}

if (process.argv.includes('--test')) {
  runRegressionTests();
  process.exit(0);
}

const violations = [];
let snapshot = [];
let jobs = [];
let status = {};
try { snapshot = await readJson(SNAPSHOT_PATH); } catch (error) { violations.push(`AWS snapshot could not be read: ${error.message}`); }
try { jobs = await readJson(JOBS_PATH); } catch (error) { violations.push(`Public jobs feed could not be read: ${error.message}`); }
try { status = await readJson(STATUS_PATH); } catch (error) { violations.push(`Collector status could not be read: ${error.message}`); }
if (!Array.isArray(snapshot)) { violations.push('AWS authoritative snapshot is not an array.'); snapshot = []; }
if (!Array.isArray(jobs)) { violations.push('Public jobs feed is not an array.'); jobs = []; }

const result = validateAmazonPublication(snapshot, jobs.filter(isAmazonRole), status);
violations.push(...result.issues);

if (violations.length) {
  console.error('AWS publication/source integrity validation failed:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

const retentionPct = result.eligibleCount ? Math.round((result.publicCount / result.eligibleCount) * 1000) / 10 : 100;
console.log(`AWS publication/source integrity passed: ${result.publicCount}/${result.eligibleCount} publication-eligible authoritative requisitions retained (${retentionPct}%); every public AWS card exactly traces to its official snapshot requisition; ${result.excludedCount} verified upstream role(s) are intentionally outside the shared publication filter.`);
