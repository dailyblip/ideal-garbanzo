import { readFile } from 'node:fs/promises';

const SNAPSHOT_PATH = 'data/t5-data-centers-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const COMPANY = 'T5 Data Centers';
const BOARD_HOST = 'jobs.lever.co';
const BOARD_SLUG = 't5datacenters';
const BOARD_ROOT = `https://${BOARD_HOST}/${BOARD_SLUG}/`;
const LEVER_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const normalize = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const allowedTypes = new Set(['entry-level', 'apprenticeship', 'internship', 'trainee']);
const allowedExperience = new Set(['no-experience', '0-2-years', '2-5-years']);
const missionTitlePattern = /\b(?:jr\.?\s+critical facilities technician|critical facilities technician|critical maintenance technician|general maintenance technician|data cent(?:er|re) facilities operator|electrical apprentice|mechanical apprentice|facilities technician|facility technician)\b/i;
const excludedTitlePattern = /\b(?:senior|sr\.?|lead|principal|staff|manager|director|vice president|vp|chief|head of|supervisor|superintendent|foreman|journeyman|subject matter expert|sme)\b/i;
const parityFields = ['title', 'company', 'location', 'type', 'experience', 'source', 'sourceUrl', 'active', 'demo'];

function canonicalLeverIdentity(job = {}) {
  const sourceUrl = clean(job.sourceUrl);
  let url;
  try { url = new URL(sourceUrl); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== BOARD_HOST) return null;
  if (url.username || url.password) return null;
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 2 || segments[0].toLowerCase() !== BOARD_SLUG) return null;
  const leverId = segments[1].toLowerCase();
  if (!LEVER_UUID_PATTERN.test(leverId)) return null;
  const expectedId = `lever-t5-${leverId}`;
  if (clean(job.id).toLowerCase() !== expectedId) return null;
  return { leverId, expectedId, sourceUrl };
}

function isT5Job(job = {}) {
  if (clean(job.company) === COMPANY) return true;
  try {
    const url = new URL(clean(job.sourceUrl));
    const segments = url.pathname.split('/').filter(Boolean);
    return url.protocol === 'https:' &&
      url.hostname.toLowerCase() === BOARD_HOST &&
      segments.length >= 1 &&
      segments[0].toLowerCase() === BOARD_SLUG;
  } catch {
    return false;
  }
}

function validateState(snapshot, jobs, status) {
  const failures = [];
  if (!Array.isArray(snapshot) || snapshot.length === 0) failures.push('T5 snapshot must be a non-empty array.');
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
    const canonical = canonicalLeverIdentity(job);

    if (clean(job?.company) !== COMPANY) failures.push(`${id || title}: wrong company.`);
    if (job?.active !== true) failures.push(`${id || title}: active must be true.`);
    if (job?.demo !== false) failures.push(`${id || title}: demo must be false.`);
    if (!allowedTypes.has(clean(job?.type))) failures.push(`${id || title}: invalid type ${clean(job?.type)}.`);
    if (!allowedExperience.has(clean(job?.experience))) failures.push(`${id || title}: invalid experience ${clean(job?.experience)}.`);
    if (clean(job?.source) !== 'Employer career site') failures.push(`${id || title}: source must be Employer career site.`);
    if (!canonical) failures.push(`${id || title || sourceUrl}: id/sourceUrl must be the same canonical T5 Lever requisition.`);
    if (!missionTitlePattern.test(title)) failures.push(`${id || title}: title is outside the approved mission-fit families.`);
    if (excludedTitlePattern.test(title)) failures.push(`${id || title}: senior/supervisory title leaked into snapshot.`);
    if (!location) failures.push(`${id || title}: location missing.`);

    if (!id) failures.push(`${title || sourceUrl}: id missing.`);
    else if (authoritative.has(id)) failures.push(`${id}: duplicate id in T5 snapshot.`);
    else authoritative.set(id, job);

    if (!sourceUrl) failures.push(`${id || title}: source URL missing.`);
    else if (urls.has(sourceUrl)) failures.push(`${id || title}: duplicate source URL in T5 snapshot.`);
    else urls.add(sourceUrl);

    if (identities.has(identity)) failures.push(`${id || title}: duplicate title/location identity in T5 snapshot.`);
    else identities.add(identity);
  }

  const publicT5Jobs = (Array.isArray(jobs) ? jobs : []).filter(isT5Job);
  const publicIds = new Set();
  for (const job of publicT5Jobs) {
    const id = clean(job?.id);
    const title = clean(job?.title);
    const canonical = canonicalLeverIdentity(job);
    if (clean(job?.company) !== COMPANY) failures.push(`${id || title}: T5 Lever requisition is misattributed to ${clean(job?.company) || 'no company'}.`);
    if (!canonical) failures.push(`${id || title}: public T5 card does not use a canonical employer-direct requisition id/URL pair.`);
    if (!id) failures.push(`${title || clean(job?.sourceUrl)}: public T5 card is missing id.`);
    else if (publicIds.has(id)) failures.push(`${id}: duplicate T5 requisition in jobs.json.`);
    else publicIds.add(id);

    const source = authoritative.get(id);
    if (!source) {
      failures.push(`${id || title}: public T5 requisition is not present in the authoritative snapshot.`);
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
    failures.push(`${missingIds.length}/${authoritative.size} verified T5 requisition(s) are missing from jobs.json: ${missingIds.slice(0, 5).join(', ')}${missingIds.length > 5 ? ', ...' : ''}.`);
  }
  if (publicT5Jobs.length !== authoritative.size && missingIds.length === 0) {
    failures.push(`public T5 requisition count ${publicT5Jobs.length} does not match authoritative snapshot ${authoritative.size}.`);
  }

  const t5Status = status?.t5DataCenters;
  if (!t5Status || t5Status.sourceHealthy !== true) failures.push('collector-status: t5DataCenters.sourceHealthy must be true.');
  if (!t5Status || t5Status.listingComplete !== true) failures.push('collector-status: t5DataCenters.listingComplete must be true.');
  if (!t5Status || t5Status.authoritativeSnapshot !== true) failures.push('collector-status: t5DataCenters.authoritativeSnapshot must be true.');
  if (t5Status && Number(t5Status.qualifyingRoles) !== (Array.isArray(snapshot) ? snapshot.length : 0)) {
    failures.push(`collector-status: qualifyingRoles ${t5Status.qualifyingRoles} does not match snapshot ${snapshot.length}.`);
  }

  return failures;
}

if (process.argv.includes('--test')) {
  const base = {
    id: 'lever-t5-290bc834-72f8-4134-bfad-5ed5fb1c2ef5',
    title: 'Critical Facilities Technician',
    company: COMPANY,
    location: 'Newark, CA',
    type: 'entry-level',
    experience: '2-5-years',
    source: 'Employer career site',
    sourceUrl: `${BOARD_ROOT}290bc834-72f8-4134-bfad-5ed5fb1c2ef5`,
    active: true,
    demo: false
  };
  const healthy = { t5DataCenters: { sourceHealthy: true, listingComplete: true, authoritativeSnapshot: true, qualifyingRoles: 1 } };
  const regressions = [
    ['canonical pair accepted', [base], [base], healthy, true],
    ['mismatched id/url rejected', [{ ...base, id: 'lever-t5-35219eee-b456-4bd9-a9db-b0637a778dee' }], [base], healthy, false],
    ['wrong board rejected', [{ ...base, sourceUrl: 'https://jobs.lever.co/example/290bc834-72f8-4134-bfad-5ed5fb1c2ef5' }], [base], healthy, false],
    ['missing public requisition rejected', [base], [], healthy, false],
    ['unexpected public requisition rejected', [base], [base, { ...base, id: 'lever-t5-35219eee-b456-4bd9-a9db-b0637a778dee', sourceUrl: `${BOARD_ROOT}35219eee-b456-4bd9-a9db-b0637a778dee`, location: 'Albuquerque, NM' }], healthy, false],
    ['field drift rejected', [base], [{ ...base, experience: '0-2-years' }], healthy, false]
  ];
  const testFailures = [];
  for (const [name, snapshot, jobs, status, shouldPass] of regressions) {
    const failures = validateState(snapshot, jobs, status);
    if ((failures.length === 0) !== shouldPass) testFailures.push(`${name}: ${failures.join(' | ') || 'unexpected pass'}`);
  }
  if (testFailures.length) {
    for (const failure of testFailures) console.error(`T5 integrity regression: ${failure}`);
    process.exit(1);
  }
  console.log(`T5 source-integrity validator passed ${regressions.length} regression cases.`);
  process.exit(0);
}

const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
const jobs = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
const failures = validateState(snapshot, jobs, status);

if (failures.length) {
  for (const failure of failures) console.error(`T5 validation: ${failure}`);
  process.exit(1);
}

const publicCount = jobs.filter(isT5Job).length;
console.log(`T5 validation passed: ${snapshot.length} authoritative requisition(s) match ${publicCount} public employer-direct card(s) exactly.`);
