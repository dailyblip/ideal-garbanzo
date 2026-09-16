import { readFile } from 'node:fs/promises';

const COMPANY = 'Stream Data Centers';
const PUBLIC_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/stream-data-centers-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const BOARD_HOST = 'apply.workable.com';
const BOARD_SLUG = 'stream-dc';
const BOARD_ROOT = `https://${BOARD_HOST}/${BOARD_SLUG}/`;
const SHORTCODE_PATTERN = /^[a-z0-9]{6,64}$/i;
const allowedTypes = new Set(['entry-level', 'apprenticeship', 'internship', 'trainee']);
const allowedExperiences = new Set(['no-experience', '0-2-years', '2-5-years']);
const missionTitlePattern = /\b(?:critical engineering technician|critical operations technician|critical facilities technician|data cent(?:er|re) technician|data cent(?:er|re) operations technician|facilities technician|facility technician)\b/i;
const seniorTitlePattern = /\b(?:senior|sr\.?|lead|principal|staff|manager|director|vice president|vp|chief|head of|supervisor|superintendent|foreman)\b/i;
const parityFields = ['title', 'company', 'location', 'type', 'experience', 'source', 'sourceUrl', 'active', 'demo'];

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const normalize = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function canonicalStreamIdentity(job = {}) {
  const sourceUrl = clean(job.sourceUrl);
  let url;
  try { url = new URL(sourceUrl); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== BOARD_HOST) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 3 || segments[0].toLowerCase() !== BOARD_SLUG || segments[1].toLowerCase() !== 'j') return null;
  const shortcode = segments[2];
  if (!SHORTCODE_PATTERN.test(shortcode)) return null;
  const expectedId = `workable-stream-dc-${shortcode}`;
  if (clean(job.id).toLowerCase() !== expectedId.toLowerCase()) return null;
  return { shortcode, expectedId, sourceUrl };
}

function isStreamJob(job = {}) {
  if (clean(job.company) === COMPANY) return true;
  try {
    const url = new URL(clean(job.sourceUrl));
    const segments = url.pathname.split('/').filter(Boolean);
    return url.protocol === 'https:' &&
      url.hostname.toLowerCase() === BOARD_HOST &&
      segments.length >= 2 &&
      segments[0].toLowerCase() === BOARD_SLUG &&
      segments[1].toLowerCase() === 'j';
  } catch {
    return false;
  }
}

function validateState(snapshot, jobs, status) {
  const failures = [];
  if (!Array.isArray(snapshot)) failures.push('Stream snapshot must contain an array.');
  if (!Array.isArray(jobs)) failures.push('jobs.json must contain an array.');

  const authoritative = new Map();
  const urls = new Set();
  const identities = new Set();

  for (const job of Array.isArray(snapshot) ? snapshot : []) {
    const id = clean(job?.id);
    const title = clean(job?.title);
    const location = clean(job?.location);
    const sourceUrl = clean(job?.sourceUrl);
    const identity = [COMPANY, title, location].map(normalize).join('|');
    const canonical = canonicalStreamIdentity(job);

    if (clean(job?.company) !== COMPANY) failures.push(`${id || title}: wrong company.`);
    if (job?.active !== true) failures.push(`${id || title}: active must be true.`);
    if (job?.demo !== false) failures.push(`${id || title}: demo must be false.`);
    if (!allowedTypes.has(clean(job?.type))) failures.push(`${id || title}: invalid type ${clean(job?.type)}.`);
    if (!allowedExperiences.has(clean(job?.experience))) failures.push(`${id || title}: invalid experience ${clean(job?.experience)}.`);
    if (clean(job?.source) !== 'Employer career site') failures.push(`${id || title}: source must be Employer career site.`);
    if (!canonical) failures.push(`${id || title || sourceUrl}: id/sourceUrl must be the same canonical Stream Workable requisition.`);
    if (!missionTitlePattern.test(title)) failures.push(`${id || title}: title is outside Stream's approved technician scope.`);
    if (seniorTitlePattern.test(title)) failures.push(`${id || title}: senior/supervisory title leaked into snapshot.`);
    if (!location) failures.push(`${id || title}: location missing.`);

    if (!id) failures.push(`${title || sourceUrl}: id missing.`);
    else if (authoritative.has(id.toLowerCase())) failures.push(`${id}: duplicate id in Stream snapshot.`);
    else authoritative.set(id.toLowerCase(), job);

    if (!sourceUrl) failures.push(`${id || title}: source URL missing.`);
    else if (urls.has(sourceUrl.toLowerCase())) failures.push(`${id || title}: duplicate source URL in Stream snapshot.`);
    else urls.add(sourceUrl.toLowerCase());

    if (identities.has(identity)) failures.push(`${id || title}: duplicate title/location identity in Stream snapshot.`);
    else identities.add(identity);
  }

  const publicStreamJobs = (Array.isArray(jobs) ? jobs : []).filter(isStreamJob);
  const publicIds = new Set();
  for (const job of publicStreamJobs) {
    const id = clean(job?.id);
    const idKey = id.toLowerCase();
    const title = clean(job?.title);
    const canonical = canonicalStreamIdentity(job);

    if (clean(job?.company) !== COMPANY) failures.push(`${id || title}: Stream Workable requisition is misattributed to ${clean(job?.company) || 'no company'}.`);
    if (!canonical) failures.push(`${id || title}: public Stream card does not use a canonical employer-direct requisition id/URL pair.`);
    if (!id) failures.push(`${title || clean(job?.sourceUrl)}: public Stream card is missing id.`);
    else if (publicIds.has(idKey)) failures.push(`${id}: duplicate Stream requisition in jobs.json.`);
    else publicIds.add(idKey);

    const source = authoritative.get(idKey);
    if (!source) {
      failures.push(`${id || title}: public Stream requisition is not present in the authoritative snapshot.`);
      continue;
    }
    for (const field of parityFields) {
      const publicValue = typeof job?.[field] === 'string' ? clean(job[field]) : job?.[field];
      const sourceValue = typeof source?.[field] === 'string' ? clean(source[field]) : source?.[field];
      if (publicValue !== sourceValue) failures.push(`${id}: ${field} drifted from authoritative snapshot.`);
    }
  }

  const missingIds = [...authoritative.keys()].filter(id => !publicIds.has(id));
  if (missingIds.length) {
    failures.push(`${missingIds.length}/${authoritative.size} verified Stream requisition(s) are missing from jobs.json: ${missingIds.slice(0, 5).join(', ')}${missingIds.length > 5 ? ', ...' : ''}.`);
  }
  if (publicStreamJobs.length !== authoritative.size && missingIds.length === 0) {
    failures.push(`public Stream requisition count ${publicStreamJobs.length} does not match authoritative snapshot ${authoritative.size}.`);
  }

  const source = status?.streamDataCenters;
  if (!source || source.sourceHealthy !== true) failures.push('collector-status: streamDataCenters.sourceHealthy must be true.');
  if (!source || source.listingComplete !== true) failures.push('collector-status: streamDataCenters.listingComplete must be true.');
  if (!source || source.authoritativeSnapshot !== true) failures.push('collector-status: streamDataCenters.authoritativeSnapshot must be true.');
  if (!source || Number(source.listedJobs || 0) <= 0) failures.push('collector-status: Stream official Workable source must report at least one public job.');
  if (source && Number(source.qualifyingRoles) !== (Array.isArray(snapshot) ? snapshot.length : 0)) {
    failures.push(`collector-status: qualifyingRoles ${source.qualifyingRoles} does not match snapshot ${snapshot.length}.`);
  }

  return failures;
}

if (process.argv.includes('--test')) {
  const base = {
    id: 'workable-stream-dc-62B4F3BCF5',
    title: 'Critical Engineering Technician',
    company: COMPANY,
    location: 'Chaska, Minnesota',
    type: 'entry-level',
    experience: '2-5-years',
    source: 'Employer career site',
    sourceUrl: `${BOARD_ROOT}j/62B4F3BCF5/`,
    active: true,
    demo: false
  };
  const healthy = { streamDataCenters: { sourceHealthy: true, listingComplete: true, authoritativeSnapshot: true, listedJobs: 10, qualifyingRoles: 1 } };
  const alternate = { ...base, id: 'workable-stream-dc-CDC5638BF1', sourceUrl: `${BOARD_ROOT}j/CDC5638BF1/`, location: 'Garland, Texas' };
  const regressions = [
    ['canonical pair accepted', [base], [base], healthy, true],
    ['mismatched id/url rejected', [{ ...base, id: 'workable-stream-dc-CDC5638BF1' }], [base], healthy, false],
    ['wrong board rejected', [{ ...base, sourceUrl: 'https://apply.workable.com/example/j/62B4F3BCF5/' }], [base], healthy, false],
    ['duplicate snapshot requisition rejected', [base, { ...base }], [base], { streamDataCenters: { ...healthy.streamDataCenters, qualifyingRoles: 2 } }, false],
    ['missing public requisition rejected', [base], [], healthy, false],
    ['unexpected public requisition rejected', [base], [base, alternate], healthy, false],
    ['misattributed official URL rejected', [base], [{ ...base, company: 'Example Operator' }], healthy, false],
    ['field drift rejected', [base], [{ ...base, experience: '0-2-years' }], healthy, false]
  ];
  const testFailures = [];
  for (const [name, snapshot, jobs, status, shouldPass] of regressions) {
    const failures = validateState(snapshot, jobs, status);
    if ((failures.length === 0) !== shouldPass) testFailures.push(`${name}: ${failures.join(' | ') || 'unexpected pass'}`);
  }
  if (testFailures.length) {
    for (const failure of testFailures) console.error(`Stream integrity regression: ${failure}`);
    process.exit(1);
  }
  console.log(`Stream source-integrity validator passed ${regressions.length} regression cases.`);
  process.exit(0);
}

const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
const jobs = JSON.parse(await readFile(PUBLIC_PATH, 'utf8'));
const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
const failures = validateState(snapshot, jobs, status);

if (failures.length) {
  console.error('Stream Data Centers source validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

const publicCount = jobs.filter(isStreamJob).length;
console.log(`Stream validation passed: ${snapshot.length} authoritative requisition(s) match ${publicCount} public employer-direct card(s) exactly.`);
