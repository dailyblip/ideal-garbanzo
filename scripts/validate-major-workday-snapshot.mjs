import { readFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/major-jobs.json';
const SOURCE = 'Employer career site';
const ALLOWED_TYPES = new Set(['entry-level', 'internship', 'apprenticeship', 'trainee']);
const ALLOWED_EXPERIENCE = new Set(['no-experience', '0-2-years', '2-5-years']);

const employers = [
  { company: 'Vantage Data Centers', host: 'vantagedc.wd1.myworkdayjobs.com', site: 'Vantage', idPrefix: 'workday-vantagedc-' },
  { company: 'QTS Data Centers', host: 'qtsdatacenters.wd5.myworkdayjobs.com', site: 'QTS', idPrefix: 'workday-qtsdatacenters-' },
  { company: 'CyrusOne', host: 'cyrusone.wd1.myworkdayjobs.com', site: 'CyrusOneCareerPortal', idPrefix: 'workday-cyrusone-' },
  { company: 'STACK Infrastructure', host: 'stackinfra.wd108.myworkdayjobs.com', site: 'STACK_AMER', idPrefix: 'workday-stackinfra-' },
  { company: 'NTT Global Data Centers', host: 'nttglobaldatacenters.wd501.myworkdayjobs.com', site: 'External', idPrefix: 'workday-nttglobaldatacenters-' },
  { company: 'Aligned Data Centers', host: 'aligneddc.wd12.myworkdayjobs.com', site: 'aligneddc', idPrefix: 'workday-aligneddc-' }
];

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const normalizedUrl = value => {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
};

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function assertRole(job, config, where) {
  const id = clean(job?.id);
  if (clean(job?.company) !== config.company) {
    throw new Error(`${where} contains a role assigned to the wrong employer.`);
  }
  if (!id || !id.startsWith(config.idPrefix)) {
    throw new Error(`${where} role has an invalid id for ${config.company}: ${id || '(missing)'}.`);
  }
  if (!clean(job?.title) || !clean(job?.location)) {
    throw new Error(`${where} role ${id} is missing title or location.`);
  }
  if (!ALLOWED_TYPES.has(clean(job?.type))) {
    throw new Error(`${where} role ${id} has unsupported type ${clean(job?.type) || '(missing)'}.`);
  }
  if (!ALLOWED_EXPERIENCE.has(clean(job?.experience))) {
    throw new Error(`${where} role ${id} has unsupported experience ${clean(job?.experience) || '(missing)'}.`);
  }
  if (clean(job?.source) !== SOURCE) {
    throw new Error(`${where} role ${id} is not labeled as ${SOURCE}.`);
  }
  if (job?.active !== true || job?.demo === true) {
    throw new Error(`${where} role ${id} is not a live production role.`);
  }

  const sourceUrl = normalizedUrl(job?.sourceUrl);
  if (!sourceUrl) throw new Error(`${where} role ${id} has an invalid source URL.`);
  const url = new URL(sourceUrl);
  if (url.protocol !== 'https:' || url.hostname !== config.host) {
    throw new Error(`${where} role ${id} does not point to ${config.company}'s verified Workday host.`);
  }
  const expectedPrefix = `/en-US/${config.site}/job/`;
  if (!url.pathname.startsWith(expectedPrefix)) {
    throw new Error(`${where} role ${id} does not point to the verified ${config.site} Workday job path.`);
  }
}

function parityFields(job) {
  return {
    title: clean(job?.title),
    type: clean(job?.type),
    experience: clean(job?.experience),
    source: clean(job?.source),
    sourceUrl: normalizedUrl(job?.sourceUrl),
    active: job?.active === true,
    demo: job?.demo === true
  };
}

const [jobs, snapshot] = await Promise.all([
  readJson(JOBS_PATH),
  readJson(SNAPSHOT_PATH)
]);

if (!Array.isArray(jobs)) throw new Error(`${JOBS_PATH} must contain an array.`);
if (!Array.isArray(snapshot)) throw new Error(`${SNAPSHOT_PATH} must contain an array.`);

const violations = [];
const summary = [];

for (const config of employers) {
  const snapshotRoles = snapshot.filter(job => clean(job?.company) === config.company);
  const publicRoles = jobs.filter(job => clean(job?.company) === config.company && job?.active === true && job?.demo !== true);
  const snapshotById = new Map();
  const publicById = new Map();

  for (const job of snapshotRoles) {
    try {
      assertRole(job, config, `${config.company} snapshot`);
    } catch (error) {
      violations.push(error.message);
      continue;
    }
    if (snapshotById.has(job.id)) {
      violations.push(`${config.company}: duplicate snapshot id ${job.id}.`);
      continue;
    }
    snapshotById.set(job.id, job);
  }

  for (const job of publicRoles) {
    try {
      assertRole(job, config, `${config.company} public feed`);
    } catch (error) {
      violations.push(error.message);
      continue;
    }
    if (publicById.has(job.id)) {
      violations.push(`${config.company}: duplicate public-feed id ${job.id}.`);
      continue;
    }
    publicById.set(job.id, job);
  }

  if (snapshotById.size !== snapshotRoles.length || publicById.size !== publicRoles.length) {
    summary.push(`${config.company}=invalid`);
    continue;
  }

  if (snapshotById.size !== publicById.size) {
    violations.push(`${config.company}: snapshot/public-feed count drift (${snapshotById.size} snapshot, ${publicById.size} public).`);
  }

  for (const [id, snapshotJob] of snapshotById) {
    const publicJob = publicById.get(id);
    if (!publicJob) {
      violations.push(`${config.company}: snapshot role ${id} is missing from the public feed.`);
      continue;
    }
    const expected = parityFields(snapshotJob);
    const actual = parityFields(publicJob);
    for (const field of Object.keys(expected)) {
      if (actual[field] !== expected[field]) {
        violations.push(`${config.company} ${id}: ${field} drift between snapshot and public feed.`);
      }
    }
  }

  for (const id of publicById.keys()) {
    if (!snapshotById.has(id)) {
      violations.push(`${config.company}: public role ${id} is not present in the authoritative major-employer snapshot.`);
    }
  }

  summary.push(`${config.company}=${snapshotById.size}`);
}

if (violations.length) {
  for (const violation of violations) console.error(`Major Workday snapshot guard: ${violation}`);
  throw new Error(`Blocked ${violations.length} major Workday snapshot/public-feed regression(s).`);
}

console.log(`Major Workday snapshot guard passed with exact role membership and authoritative-field parity. ${summary.join(', ')}`);
