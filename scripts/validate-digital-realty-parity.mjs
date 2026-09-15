import { readFile } from 'node:fs/promises';

const COMPANY = 'Digital Realty';
const SNAPSHOT_PATH = 'data/digital-realty-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const OFFICIAL_HOST = 'hdep.fa.us2.oraclecloud.com';
const OFFICIAL_PATH_PREFIX = '/hcmUI/CandidateExperience/en/sites/CX/job/';

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

function canonicalDigitalRealtyUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '')); } catch { return null; }
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
  const snapshotById = new Map();
  const snapshotIds = new Set();
  const snapshotUrls = new Set();
  const publicIds = new Set();
  const publicUrls = new Set();

  for (const job of snapshot) {
    const id = clean(job?.id);
    const parsedUrl = canonicalDigitalRealtyUrl(job?.sourceUrl);
    const idMatch = id.match(/^oracle-digitalrealty-(\d+)$/);

    if (!idMatch) issues.push(`Digital Realty snapshot role ${id || '(missing id)'} does not use the canonical oracle-digitalrealty-<requisition id> identity.`);
    if (!parsedUrl) issues.push(`Digital Realty snapshot role ${id || '(missing id)'} does not use a canonical employer-direct Oracle Recruiting Cloud detail URL.`);
    if (idMatch && parsedUrl && idMatch[1] !== parsedUrl.requisitionId) issues.push(`Digital Realty snapshot role ${id} does not match its official requisition ${parsedUrl.requisitionId}.`);

    if (id) {
      if (snapshotIds.has(id)) issues.push(`Digital Realty snapshot contains duplicate id ${id}.`);
      snapshotIds.add(id);
      snapshotById.set(id, job);
    }
    if (parsedUrl) {
      if (snapshotUrls.has(parsedUrl.url)) issues.push(`Digital Realty snapshot contains duplicate URL ${parsedUrl.url}.`);
      snapshotUrls.add(parsedUrl.url);
    }
  }

  for (const job of publicJobs) {
    const id = clean(job?.id);
    const parsedUrl = canonicalDigitalRealtyUrl(job?.sourceUrl);
    const idMatch = id.match(/^oracle-digitalrealty-(\d+)$/);

    if (!idMatch) issues.push(`Public Digital Realty role ${id || '(missing id)'} does not use the canonical oracle-digitalrealty-<requisition id> identity.`);
    if (!parsedUrl) issues.push(`Public Digital Realty role ${id || '(missing id)'} does not use a canonical employer-direct Oracle Recruiting Cloud detail URL.`);
    if (idMatch && parsedUrl && idMatch[1] !== parsedUrl.requisitionId) issues.push(`Public Digital Realty role ${id} does not match its official requisition ${parsedUrl.requisitionId}.`);

    if (id) {
      if (publicIds.has(id)) issues.push(`Digital Realty public feed contains duplicate id ${id}.`);
      publicIds.add(id);
    }
    if (parsedUrl) {
      if (publicUrls.has(parsedUrl.url)) issues.push(`Digital Realty public feed contains duplicate URL ${parsedUrl.url}.`);
      publicUrls.add(parsedUrl.url);
    }

    const authoritative = snapshotById.get(id);
    if (!authoritative) {
      issues.push(`Public Digital Realty role ${id || '(missing id)'} is not traceable to the authoritative snapshot.`);
      continue;
    }

    const authoritativeUrl = canonicalDigitalRealtyUrl(authoritative?.sourceUrl);
    if (parsedUrl && authoritativeUrl && parsedUrl.url !== authoritativeUrl.url) {
      issues.push(`Public Digital Realty role ${id} does not preserve its authoritative employer URL.`);
    }
    if (canonicalTitle(job) !== canonicalTitle(authoritative)) {
      issues.push(`Public Digital Realty role ${id} title drifted from authoritative snapshot: ${clean(authoritative?.title)} -> ${clean(job?.title)}.`);
    }
    if (normalize(job?.location) !== normalize(authoritative?.location)) {
      issues.push(`Public Digital Realty role ${id} location drifted from authoritative snapshot: ${clean(authoritative?.location)} -> ${clean(job?.location)}.`);
    }
    if (clean(job?.type) !== clean(authoritative?.type)) {
      issues.push(`Public Digital Realty role ${id} type drifted from ${clean(authoritative?.type)} to ${clean(job?.type)}.`);
    }
    if (clean(job?.experience) !== clean(authoritative?.experience)) {
      issues.push(`Public Digital Realty role ${id} experience drifted from ${clean(authoritative?.experience)} to ${clean(job?.experience)}.`);
    }
    if (clean(job?.source) !== clean(authoritative?.source)) {
      issues.push(`Public Digital Realty role ${id} source label drifted from ${clean(authoritative?.source)} to ${clean(job?.source)}.`);
    }
    if (job?.active !== authoritative?.active || job?.demo !== authoritative?.demo) {
      issues.push(`Public Digital Realty role ${id} production state drifted from the authoritative snapshot.`);
    }
  }

  for (const job of snapshot) {
    const id = clean(job?.id);
    if (id && !publicIds.has(id)) issues.push(`Digital Realty public feed is missing authoritative requisition ${id}.`);
  }

  return issues;
}

function assertTest(condition, message) {
  if (!condition) throw new Error(`Digital Realty parity regression failed: ${message}`);
}

function runRegressionTests() {
  const authoritative = {
    id: 'oracle-digitalrealty-8510',
    title: 'Technician II',
    company: COMPANY,
    location: 'NY, United States',
    type: 'entry-level',
    experience: '2-5-years',
    source: 'Employer career site',
    sourceUrl: 'https://hdep.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/8510',
    active: true,
    demo: false
  };

  let issues = validateSnapshotPublicParity(
    [authoritative],
    [{ ...authoritative, pay: '$38.00–$41.50 / hr', region: 'northeast', firstSeenAt: '2026-09-15T00:00:00.000Z' }]
  );
  assertTest(issues.length === 0, `downstream enrichment should preserve parity, got ${issues.join(' | ')}`);

  issues = validateSnapshotPublicParity([authoritative], [{ ...authoritative, experience: '0-2-years' }]);
  assertTest(issues.some(issue => issue.includes('experience drifted')), 'experience drift must fail closed');

  issues = validateSnapshotPublicParity([authoritative], [{ ...authoritative, location: 'Manassas, VA, United States' }]);
  assertTest(issues.some(issue => issue.includes('location drifted')), 'location drift must fail closed');

  issues = validateSnapshotPublicParity([authoritative], [{ ...authoritative, sourceUrl: 'https://hdep.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/9999' }]);
  assertTest(issues.some(issue => issue.includes('does not match its official requisition')), 'requisition/URL mismatch must fail closed');

  issues = validateSnapshotPublicParity([authoritative], []);
  assertTest(issues.some(issue => issue.includes('missing authoritative requisition')), 'missing public requisition must fail closed');

  issues = validateSnapshotPublicParity([], [authoritative]);
  assertTest(issues.some(issue => issue.includes('not traceable to the authoritative snapshot')), 'unexpected public requisition must fail closed');

  issues = validateSnapshotPublicParity([authoritative], [authoritative, { ...authoritative }]);
  assertTest(issues.some(issue => issue.includes('duplicate id')), 'duplicate public requisition id must fail closed');

  console.log('Digital Realty snapshot parity regression passed.');
}

if (process.argv.includes('--test')) {
  runRegressionTests();
  process.exit(0);
}

const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
const jobs = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
const issues = [];

if (!Array.isArray(snapshot)) issues.push('Digital Realty authoritative snapshot is not an array.');
if (!Array.isArray(jobs)) issues.push('Public jobs feed is not an array.');

const authoritative = Array.isArray(snapshot) ? snapshot : [];
const publicDigitalRealty = Array.isArray(jobs) ? jobs.filter(job => clean(job?.company) === COMPANY) : [];
issues.push(...validateSnapshotPublicParity(authoritative, publicDigitalRealty));

if (issues.length) {
  console.error('Digital Realty snapshot/public parity validation failed:');
  for (const issue of issues) console.error(`- ${issue}`);
  process.exit(1);
}

console.log(`Digital Realty snapshot/public parity passed: ${authoritative.length} authoritative requisition(s) exactly traceable in the public feed.`);
