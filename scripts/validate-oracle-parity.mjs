import { readFile } from 'node:fs/promises';

const COMPANY = 'Oracle';
const SNAPSHOT_PATH = 'data/oracle-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const OFFICIAL_HOST = 'eeho.fa.us2.oraclecloud.com';
const OFFICIAL_PATH_PREFIX = '/hcmUI/CandidateExperience/en/sites/jobsearch/job/';
const CLEARLY_NON_OPERATIONAL_TITLE = /\b(business analyst|business operations|cost management|cost estimator|cost analyst|cost controls|procurement|purchasing|finance|financial|security operations|cybersecurity|information security|software|application|frontend|backend|full[ -]?stack|database|product|ux|ui|machine learning|data scientist|talent sourcer|talent acquisition|recruiter|recruiting)\b/i;

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const normalize = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function parityProtected(job) {
  return !CLEARLY_NON_OPERATIONAL_TITLE.test(clean(job?.title));
}

function canonicalOracleUrl(value) {
  let parsed;
  try {
    parsed = new URL(clean(value));
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== OFFICIAL_HOST) return null;
  const escapedPrefix = OFFICIAL_PATH_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = parsed.pathname.match(new RegExp(`^${escapedPrefix}(\\d+)\\/?$`, 'i'));
  if (!match) return null;

  return {
    requisitionId: match[1],
    url: `https://${OFFICIAL_HOST}${OFFICIAL_PATH_PREFIX}${match[1]}`
  };
}

function validateSnapshotPublicParity(snapshot, publicJobs) {
  const issues = [];
  const protectedSnapshot = snapshot.filter(parityProtected);
  const authoritativeById = new Map();
  const snapshotIds = new Set();
  const snapshotUrls = new Set();
  const publicIds = new Set();
  const publicUrls = new Set();

  for (const job of protectedSnapshot) {
    const id = clean(job?.id);
    const parsedUrl = canonicalOracleUrl(job?.sourceUrl);
    const idMatch = id.match(/^oracle-careers-(\d+)$/);

    if (clean(job?.company) !== COMPANY) {
      issues.push(`Oracle snapshot role ${id || '(missing id)'} belongs to another company.`);
    }
    if (!idMatch) {
      issues.push(`Oracle snapshot role ${id || '(missing id)'} does not use the canonical oracle-careers-<requisition id> identity.`);
    }
    if (!parsedUrl) {
      issues.push(`Oracle snapshot role ${id || '(missing id)'} does not use a canonical employer-direct Oracle Careers detail URL.`);
    }
    if (idMatch && parsedUrl && idMatch[1] !== parsedUrl.requisitionId) {
      issues.push(`Oracle snapshot role ${id} does not match its official requisition ${parsedUrl.requisitionId}.`);
    }

    if (id) {
      if (snapshotIds.has(id)) issues.push(`Oracle mission-fit snapshot contains duplicate id ${id}.`);
      snapshotIds.add(id);
      authoritativeById.set(id, job);
    }
    if (parsedUrl) {
      if (snapshotUrls.has(parsedUrl.url)) issues.push(`Oracle mission-fit snapshot contains duplicate URL ${parsedUrl.url}.`);
      snapshotUrls.add(parsedUrl.url);
    }
  }

  for (const job of publicJobs) {
    const id = clean(job?.id);
    const parsedUrl = canonicalOracleUrl(job?.sourceUrl);
    const idMatch = id.match(/^oracle-careers-(\d+)$/);

    if (!idMatch) {
      issues.push(`Public Oracle role ${id || '(missing id)'} does not use the canonical oracle-careers-<requisition id> identity.`);
    }
    if (!parsedUrl) {
      issues.push(`Public Oracle role ${id || '(missing id)'} does not use a canonical employer-direct Oracle Careers detail URL.`);
    }
    if (idMatch && parsedUrl && idMatch[1] !== parsedUrl.requisitionId) {
      issues.push(`Public Oracle role ${id} does not match its official requisition ${parsedUrl.requisitionId}.`);
    }

    if (id) {
      if (publicIds.has(id)) issues.push(`Oracle public feed contains duplicate id ${id}.`);
      publicIds.add(id);
    }
    if (parsedUrl) {
      if (publicUrls.has(parsedUrl.url)) issues.push(`Oracle public feed contains duplicate URL ${parsedUrl.url}.`);
      publicUrls.add(parsedUrl.url);
    }

    const authoritative = authoritativeById.get(id);
    if (!authoritative) {
      issues.push(`Public Oracle role ${id || '(missing id)'} is not traceable to the mission-fit authoritative snapshot.`);
      continue;
    }

    const authoritativeUrl = canonicalOracleUrl(authoritative?.sourceUrl);
    if (parsedUrl && authoritativeUrl && parsedUrl.url !== authoritativeUrl.url) {
      issues.push(`Public Oracle role ${id} does not preserve its authoritative employer URL.`);
    }
    if (normalize(job?.title) !== normalize(authoritative?.title)) {
      issues.push(`Public Oracle role ${id} title drifted from authoritative snapshot: ${clean(authoritative?.title)} -> ${clean(job?.title)}.`);
    }
    if (normalize(job?.location) !== normalize(authoritative?.location)) {
      issues.push(`Public Oracle role ${id} location drifted from authoritative snapshot: ${clean(authoritative?.location)} -> ${clean(job?.location)}.`);
    }
    if (clean(job?.type) !== clean(authoritative?.type)) {
      issues.push(`Public Oracle role ${id} type drifted from ${clean(authoritative?.type)} to ${clean(job?.type)}.`);
    }
    if (clean(job?.experience) !== clean(authoritative?.experience)) {
      issues.push(`Public Oracle role ${id} experience drifted from ${clean(authoritative?.experience)} to ${clean(job?.experience)}.`);
    }
    if (clean(job?.source) !== clean(authoritative?.source)) {
      issues.push(`Public Oracle role ${id} source label drifted from ${clean(authoritative?.source)} to ${clean(job?.source)}.`);
    }
    if (job?.active !== authoritative?.active || job?.demo !== authoritative?.demo) {
      issues.push(`Public Oracle role ${id} production state drifted from the authoritative snapshot.`);
    }
  }

  for (const job of protectedSnapshot) {
    const id = clean(job?.id);
    if (id && !publicIds.has(id)) issues.push(`Oracle public feed is missing authoritative requisition ${id}.`);
  }

  return {
    issues,
    protectedCount: protectedSnapshot.length,
    excludedCount: snapshot.length - protectedSnapshot.length
  };
}

function assertTest(condition, message) {
  if (!condition) throw new Error(`Oracle parity regression failed: ${message}`);
}

function runRegressionTests() {
  const authoritative = {
    id: 'oracle-careers-344884',
    title: 'Data Center Technician',
    company: COMPANY,
    location: 'Ashburn, VA, United States',
    type: 'entry-level',
    experience: '2-5-years',
    source: 'Oracle Careers',
    sourceUrl: 'https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/344884',
    active: true,
    demo: false
  };
  const nonOperational = {
    ...authoritative,
    id: 'oracle-careers-344999',
    title: 'Data Center Talent Sourcer',
    sourceUrl: 'https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/344999'
  };

  let result = validateSnapshotPublicParity(
    [authoritative, nonOperational],
    [{ ...authoritative, pay: '$27.64–$56.83 / hr', region: 'mid-atlantic', firstSeenAt: '2026-09-13T00:00:00.000Z' }]
  );
  assertTest(result.issues.length === 0, `downstream enrichment should preserve parity, got ${result.issues.join(' | ')}`);
  assertTest(result.protectedCount === 1 && result.excludedCount === 1, 'non-operational snapshot candidates must not be required for publication');

  result = validateSnapshotPublicParity([authoritative], [{ ...authoritative, experience: '0-2-years' }]);
  assertTest(result.issues.some(issue => issue.includes('experience drifted')), 'experience drift must fail closed');

  result = validateSnapshotPublicParity([authoritative], [{ ...authoritative, location: 'Austin, TX, United States' }]);
  assertTest(result.issues.some(issue => issue.includes('location drifted')), 'location drift must fail closed');

  result = validateSnapshotPublicParity([authoritative], [{ ...authoritative, sourceUrl: 'https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/999999' }]);
  assertTest(result.issues.some(issue => issue.includes('does not match its official requisition')), 'requisition/URL mismatch must fail closed');

  result = validateSnapshotPublicParity([authoritative], []);
  assertTest(result.issues.some(issue => issue.includes('missing authoritative requisition')), 'missing public requisition must fail closed');

  result = validateSnapshotPublicParity([], [authoritative]);
  assertTest(result.issues.some(issue => issue.includes('not traceable to the mission-fit authoritative snapshot')), 'unexpected public requisition must fail closed');

  result = validateSnapshotPublicParity([authoritative], [authoritative, { ...authoritative }]);
  assertTest(result.issues.some(issue => issue.includes('duplicate id')), 'duplicate public requisition id must fail closed');

  result = validateSnapshotPublicParity([nonOperational], [nonOperational]);
  assertTest(result.issues.some(issue => issue.includes('not traceable to the mission-fit authoritative snapshot')), 'non-operational candidates must not be publishable merely because they exist in the raw snapshot');

  console.log('Oracle snapshot parity regression passed.');
}

if (process.argv.includes('--test')) {
  runRegressionTests();
  process.exit(0);
}

const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
const jobs = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
const issues = [];

if (!Array.isArray(snapshot)) issues.push('Oracle authoritative snapshot is not an array.');
if (!Array.isArray(jobs)) issues.push('Public jobs feed is not an array.');

const authoritative = Array.isArray(snapshot) ? snapshot : [];
const publicOracle = Array.isArray(jobs) ? jobs.filter(job => clean(job?.company) === COMPANY) : [];
const parity = validateSnapshotPublicParity(authoritative, publicOracle);
issues.push(...parity.issues);

if (issues.length) {
  console.error('Oracle snapshot/public parity validation failed:');
  for (const issue of issues) console.error(`- ${issue}`);
  process.exit(1);
}

console.log(`Oracle snapshot/public parity passed: ${parity.protectedCount} mission-fit authoritative requisition(s) exactly traceable in the public feed; ${parity.excludedCount} non-operational snapshot candidate(s) intentionally excluded.`);
