import { readFile } from 'node:fs/promises';

const COMPANY = 'Amazon Web Services';
const SNAPSHOT_PATH = 'data/amazon-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const SOURCE_LABEL = 'Official Amazon Jobs';
const allowedTypes = new Set(['entry-level', 'internship', 'apprenticeship', 'trainee']);
const allowedExperience = new Set(['no-experience', '0-2-years', '2-5-years']);

// Keep these publication exclusions aligned with filter-mission-fit.mjs. The AWS
// recovery snapshot intentionally preserves verified source records before the
// shared publication backstop removes clearly senior/non-mission families.
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
  const match = parsed.pathname.match(/^\/en\/jobs\/(\d+)(?:\/([^/?#]+))?\/?$/i);
  if (!match) return null;
  const slug = clean(match[2] || '');
  return {
    requisitionId: match[1],
    url: `https://www.amazon.jobs/en/jobs/${match[1]}${slug ? `/${slug}` : ''}`
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

function reportedSnapshotCounts(status = {}) {
  const values = [
    Number(status?.amazonDetailRecovery?.qualifyingRoles),
    Number(status?.amazonDatacenter?.qualifyingRoles)
  ];
  return [...new Set(values.filter(Number.isFinite))];
}

function validateAmazonParity(snapshot, publicJobs, status = {}) {
  const issues = [];
  const authoritativeById = new Map();
  const snapshotIds = new Set();
  const snapshotUrls = new Set();
  const publicIds = new Set();
  const publicUrls = new Set();
  const protectedSnapshot = [];

  for (const job of snapshot) {
    const id = clean(job?.id);
    const idMatch = id.match(/^amazon-(\d+)$/i);
    const parsedUrl = canonicalAmazonUrl(job?.sourceUrl);
    const type = clean(job?.type);
    const experience = clean(job?.experience);

    if (clean(job?.company) !== COMPANY) issues.push(`AWS snapshot role ${id || '(missing id)'} belongs to ${clean(job?.company) || '(missing company)'}.`);
    if (!idMatch) issues.push(`AWS snapshot role ${id || '(missing id)'} does not use canonical amazon-<requisition id> identity.`);
    if (!parsedUrl) issues.push(`AWS snapshot role ${id || '(missing id)'} does not use a canonical employer-direct Amazon Jobs detail URL.`);
    if (idMatch && parsedUrl && idMatch[1] !== parsedUrl.requisitionId) issues.push(`AWS snapshot role ${id} does not match Amazon requisition ${parsedUrl.requisitionId}.`);
    if (clean(job?.source) !== SOURCE_LABEL) issues.push(`AWS snapshot role ${id || '(missing id)'} has unexpected source label ${clean(job?.source) || '(missing)'}.`);
    if (!allowedTypes.has(type)) issues.push(`AWS snapshot role ${id || '(missing id)'} has unsupported type ${type || '(missing)'}.`);
    if (!allowedExperience.has(experience)) issues.push(`AWS snapshot role ${id || '(missing id)'} has unsupported experience band ${experience || '(missing)'}.`);
    if (job?.active !== true || job?.demo === true) issues.push(`AWS snapshot role ${id || '(missing id)'} is not an active production role.`);
    if (!clean(job?.title)) issues.push(`AWS snapshot role ${id || '(missing id)'} has no title.`);
    if (!clean(job?.location)) issues.push(`AWS snapshot role ${id || '(missing id)'} has no location.`);

    if (id) {
      if (snapshotIds.has(id)) issues.push(`AWS authoritative snapshot contains duplicate id ${id}.`);
      snapshotIds.add(id);
    }
    if (parsedUrl) {
      if (snapshotUrls.has(parsedUrl.url)) issues.push(`AWS authoritative snapshot contains duplicate URL ${parsedUrl.url}.`);
      snapshotUrls.add(parsedUrl.url);
    }

    if (publicationEligible(job)) {
      protectedSnapshot.push(job);
      if (id) authoritativeById.set(id, job);
    }
  }

  for (const job of publicJobs) {
    const id = clean(job?.id);
    const idMatch = id.match(/^amazon-(\d+)$/i);
    const parsedUrl = canonicalAmazonUrl(job?.sourceUrl);

    if (clean(job?.company) !== COMPANY) issues.push(`Public Amazon Jobs role ${id || '(missing id)'} is attributed to ${clean(job?.company) || '(missing company)'}.`);
    if (!idMatch) issues.push(`Public AWS role ${id || '(missing id)'} does not use canonical amazon-<requisition id> identity.`);
    if (!parsedUrl) issues.push(`Public AWS role ${id || '(missing id)'} does not use a canonical employer-direct Amazon Jobs detail URL.`);
    if (idMatch && parsedUrl && idMatch[1] !== parsedUrl.requisitionId) issues.push(`Public AWS role ${id} does not match Amazon requisition ${parsedUrl.requisitionId}.`);
    if (!publicationEligible(job)) issues.push(`Public AWS role ${id || '(missing id)'} violates the shared publication mission-fit backstop.`);

    if (id) {
      if (publicIds.has(id)) issues.push(`AWS public feed contains duplicate id ${id}.`);
      publicIds.add(id);
    }
    if (parsedUrl) {
      if (publicUrls.has(parsedUrl.url)) issues.push(`AWS public feed contains duplicate URL ${parsedUrl.url}.`);
      publicUrls.add(parsedUrl.url);
    }

    const authoritative = authoritativeById.get(id);
    if (!authoritative) {
      issues.push(`Public AWS role ${id || '(missing id)'} is not traceable to the publication-eligible authoritative Amazon snapshot.`);
      continue;
    }

    const authoritativeUrl = canonicalAmazonUrl(authoritative?.sourceUrl);
    if (parsedUrl && authoritativeUrl && parsedUrl.url !== authoritativeUrl.url) issues.push(`Public AWS role ${id} does not preserve its authoritative employer URL.`);
    if (normalize(job?.title) !== normalize(authoritative?.title)) issues.push(`Public AWS role ${id} title drifted from authoritative snapshot.`);
    if (normalize(job?.location) !== normalize(authoritative?.location)) issues.push(`Public AWS role ${id} location drifted from authoritative snapshot.`);
    if (clean(job?.type) !== clean(authoritative?.type)) issues.push(`Public AWS role ${id} type drifted from ${clean(authoritative?.type)} to ${clean(job?.type)}.`);
    if (clean(job?.experience) !== clean(authoritative?.experience)) issues.push(`Public AWS role ${id} experience drifted from ${clean(authoritative?.experience)} to ${clean(job?.experience)}.`);
    if (clean(job?.source) !== clean(authoritative?.source)) issues.push(`Public AWS role ${id} source label drifted from ${clean(authoritative?.source)} to ${clean(job?.source)}.`);
    if (job?.active !== authoritative?.active || job?.demo !== authoritative?.demo) issues.push(`Public AWS role ${id} production state drifted from the authoritative snapshot.`);
  }

  for (const job of protectedSnapshot) {
    const id = clean(job?.id);
    if (id && !publicIds.has(id)) issues.push(`AWS public feed is missing publication-eligible authoritative requisition ${id}.`);
  }

  const reportedCounts = reportedSnapshotCounts(status);
  if (reportedCounts.length && !reportedCounts.includes(snapshot.length)) {
    issues.push(`AWS status does not report the authoritative snapshot count ${snapshot.length}; reported qualifying counts: ${reportedCounts.join(', ')}.`);
  }

  const amazonStatus = status?.amazonDatacenter || {};
  if (amazonStatus?.fallbackFreshness?.expired === true && (snapshot.length || publicJobs.length)) {
    issues.push(`AWS fallback is expired but ${snapshot.length} snapshot / ${publicJobs.length} public role(s) remain published.`);
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
    protectedCount: protectedSnapshot.length,
    excludedCount: snapshot.length - protectedSnapshot.length,
    publicCount: publicJobs.length
  };
}

function assertTest(condition, message) {
  if (!condition) throw new Error(`AWS parity regression failed: ${message}`);
}

function runRegressionTests() {
  const authoritative = {
    id: 'amazon-10537998',
    title: 'Data Center Engineering Operations Technician Internship',
    company: COMPANY,
    location: 'Sterling, VA',
    type: 'internship',
    experience: 'no-experience',
    source: SOURCE_LABEL,
    sourceUrl: 'https://www.amazon.jobs/en/jobs/10537998/data-center-engineering-operations-technician-internship',
    active: true,
    demo: false
  };
  const excludedLeader = {
    ...authoritative,
    id: 'amazon-10534644',
    title: 'Cluster Operations Leader, ADC Data Center Ops',
    location: 'San Antonio, TX',
    sourceUrl: 'https://www.amazon.jobs/en/jobs/10534644/cluster-operations-leader-adc-data-center-ops'
  };
  const healthyStatus = {
    amazonDatacenter: {
      sourceHealthy: true,
      queriesAttempted: 5,
      queriesSucceeded: 5,
      preservedPreviousRoles: 0,
      qualifyingRoles: 2
    }
  };

  let result = validateAmazonParity(
    [authoritative, excludedLeader],
    [{ ...authoritative, pay: '$25.00–$35.00 / hr', region: 'mid-atlantic', postedHours: 12 }],
    healthyStatus
  );
  assertTest(result.issues.length === 0, `downstream enrichment and intentional mission filtering should preserve parity, got ${result.issues.join(' | ')}`);
  assertTest(result.protectedCount === 1 && result.excludedCount === 1, 'senior snapshot role must not be required for publication');

  result = validateAmazonParity([authoritative], [{ ...authoritative, experience: '0-2-years' }], {
    amazonDatacenter: { ...healthyStatus.amazonDatacenter, qualifyingRoles: 1 }
  });
  assertTest(result.issues.some(issue => issue.includes('experience drifted')), 'experience drift must fail closed');

  result = validateAmazonParity([authoritative], [{ ...authoritative, location: 'Ashburn, VA' }], {
    amazonDatacenter: { ...healthyStatus.amazonDatacenter, qualifyingRoles: 1 }
  });
  assertTest(result.issues.some(issue => issue.includes('location drifted')), 'location drift must fail closed');

  result = validateAmazonParity([authoritative], [{ ...authoritative, sourceUrl: 'https://www.amazon.jobs/en/jobs/99999999/not-the-same-role' }], {
    amazonDatacenter: { ...healthyStatus.amazonDatacenter, qualifyingRoles: 1 }
  });
  assertTest(result.issues.some(issue => issue.includes('does not match Amazon requisition')), 'requisition/URL mismatch must fail closed');

  result = validateAmazonParity([authoritative], [], { amazonDatacenter: { qualifyingRoles: 1 } });
  assertTest(result.issues.some(issue => issue.includes('missing publication-eligible authoritative requisition')), 'missing public requisition must fail closed');

  result = validateAmazonParity([], [authoritative], { amazonDatacenter: { qualifyingRoles: 0 } });
  assertTest(result.issues.some(issue => issue.includes('not traceable to the publication-eligible authoritative Amazon snapshot')), 'unexpected public requisition must fail closed');

  result = validateAmazonParity([authoritative], [authoritative, { ...authoritative }], { amazonDatacenter: { qualifyingRoles: 1 } });
  assertTest(result.issues.some(issue => issue.includes('duplicate id')), 'duplicate public requisition id must fail closed');

  result = validateAmazonParity([excludedLeader], [excludedLeader], { amazonDatacenter: { qualifyingRoles: 1 } });
  assertTest(result.issues.some(issue => issue.includes('mission-fit backstop')), 'senior/non-mission snapshot roles must not become publishable merely because they exist upstream');

  result = validateAmazonParity([authoritative], [authoritative], {
    amazonDatacenter: { ...healthyStatus.amazonDatacenter, qualifyingRoles: 1, fallbackFreshness: { expired: true } }
  });
  assertTest(result.issues.some(issue => issue.includes('fallback is expired')), 'expired fallback with published roles must fail closed');

  result = validateAmazonParity([authoritative], [authoritative], {
    amazonDatacenter: { ...healthyStatus.amazonDatacenter, qualifyingRoles: 19 },
    amazonDetailRecovery: { qualifyingRoles: 1 }
  });
  assertTest(!result.issues.some(issue => issue.includes('snapshot count')), 'a matching detail-recovery status count must satisfy snapshot accountability');

  const hostAlias = canonicalAmazonUrl('https://amazon.jobs/en/jobs/10537998/data-center-engineering-operations-technician-internship/');
  assertTest(hostAlias?.requisitionId === '10537998', 'official Amazon host alias and trailing slash must canonicalize');
  assertTest(!canonicalAmazonUrl('https://example.com/en/jobs/10537998/role'), 'non-official host must be rejected');

  console.log('AWS snapshot/public parity regression passed.');
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

const publicAmazon = jobs.filter(isAmazonRole);
const parity = validateAmazonParity(snapshot, publicAmazon, status);
violations.push(...parity.issues);

if (violations.length) {
  console.error('AWS snapshot/public parity validation failed:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`AWS snapshot/public parity passed: ${parity.protectedCount} publication-eligible requisition(s) exactly traceable in the public feed; ${parity.excludedCount} verified upstream role(s) intentionally excluded by the shared mission-fit backstop.`);
