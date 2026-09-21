import { readFile } from 'node:fs/promises';

const COMPANY = 'Amazon Web Services';
const MAX_ALLOWED_FALLBACK_HOURS = 96;
const ALLOWED_TYPES = new Set(['entry-level', 'internship', 'apprenticeship', 'trainee']);
const ALLOWED_EXPERIENCE = new Set(['no-experience', '0-2-years', '2-5-years']);
const SENIOR_TITLE = /\b(?:senior|sr\.?|lead|principal|chief|manager|mgr\.?|director|vice president|vp|head of|staff engineer|supervisor|architect|program manager|product manager|software|developer|scientist|security engineer|security specialist|sales|account executive|recruiter|construction manager|project manager)\b/i;

const [snapshot, jobs, status] = await Promise.all([
  readJson('data/amazon-jobs.json'),
  readJson('data/jobs.json'),
  readJson('data/collector-status.json')
]);

if (!Array.isArray(snapshot)) throw new Error('data/amazon-jobs.json must contain an array.');
if (!Array.isArray(jobs)) throw new Error('data/jobs.json must contain an array.');
if (!status || typeof status !== 'object' || Array.isArray(status)) throw new Error('data/collector-status.json must contain an object.');

const diagnostic = status.amazonDatacenter;
if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)) {
  throw new Error('AWS source integrity: amazonDatacenter diagnostic is missing.');
}
if (typeof diagnostic.sourceHealthy !== 'boolean') {
  throw new Error('AWS source integrity: sourceHealthy must be a boolean.');
}

const violations = [];
validateSourceState(diagnostic, violations);

const publicAws = jobs.filter(job => job?.company === COMPANY && job?.active === true && job?.demo !== true);
const mislabeledAmazonJobs = jobs.filter(job => {
  if (job?.company === COMPANY) return false;
  try { return new URL(String(job?.sourceUrl || '')).hostname === 'www.amazon.jobs'; }
  catch { return false; }
});
if (mislabeledAmazonJobs.length) {
  violations.push(`${mislabeledAmazonJobs.length} public amazon.jobs role(s) are not labeled ${COMPANY}`);
}

validateRoles(snapshot, 'snapshot', violations);
validateRoles(publicAws, 'public feed', violations);
validateParity(snapshot, publicAws, violations);

if (violations.length) {
  for (const violation of violations) console.error(`AWS source integrity: ${violation}`);
  throw new Error(`Blocked ${violations.length} AWS source-integrity regression(s).`);
}

const mode = diagnostic.sourceHealthy ? 'live official search' : 'bounded verified fallback';
console.log(`AWS source integrity passed: ${snapshot.length} authoritative role(s), ${publicAws.length} public role(s), ${mode}.`);

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function validateSourceState(value, out) {
  const fallback = value.fallbackFreshness;
  if (value.sourceHealthy) {
    if (!Number.isFinite(Number(value.queriesSucceeded)) || Number(value.queriesSucceeded) < 1) {
      out.push('healthy source state must report at least one successful Amazon Jobs query');
    }
    if (fallback?.active === true) out.push('healthy source state cannot also report an active fallback');
    return;
  }

  if (!fallback || typeof fallback !== 'object' || Array.isArray(fallback)) {
    out.push('degraded source state is missing fallback freshness evidence');
    return;
  }
  if (fallback.active !== true) out.push('degraded source state must report fallbackFreshness.active=true');
  if (fallback.expired !== false) out.push('degraded source state must report fallbackFreshness.expired=false');

  const maxAgeHours = Number(fallback.maxAgeHours);
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0 || maxAgeHours > MAX_ALLOWED_FALLBACK_HOURS) {
    out.push(`fallback maxAgeHours must be between 1 and ${MAX_ALLOWED_FALLBACK_HOURS}`);
  }

  const lastHealthyAt = Date.parse(String(fallback.lastHealthyAt || ''));
  if (!Number.isFinite(lastHealthyAt)) {
    out.push('degraded source state is missing a valid fallback lastHealthyAt timestamp');
    return;
  }
  if (Number.isFinite(maxAgeHours) && Date.now() - lastHealthyAt > maxAgeHours * 60 * 60 * 1000) {
    out.push(`fallback evidence is older than its ${maxAgeHours}-hour retention window`);
  }
}

function validateRoles(roles, label, out) {
  const ids = new Set();
  const urls = new Set();

  for (const [index, job] of roles.entries()) {
    const prefix = `${label}[${index}]`;
    if (!job || typeof job !== 'object' || Array.isArray(job)) {
      out.push(`${prefix} is not an object`);
      continue;
    }
    if (job.company !== COMPANY) out.push(`${prefix} has unexpected company ${JSON.stringify(job.company)}`);
    if (job.active !== true) out.push(`${prefix} must be active=true`);
    if (job.demo === true) out.push(`${prefix} cannot be a demo role`);
    if (!ALLOWED_TYPES.has(job.type)) out.push(`${prefix} has unsupported type ${JSON.stringify(job.type)}`);
    if (!ALLOWED_EXPERIENCE.has(job.experience)) out.push(`${prefix} has unsupported experience ${JSON.stringify(job.experience)}`);
    if (!String(job.title || '').trim()) out.push(`${prefix} is missing a title`);
    if (SENIOR_TITLE.test(String(job.title || ''))) out.push(`${prefix} leaks a senior/out-of-scope title: ${job.title}`);
    if (!String(job.location || '').trim()) out.push(`${prefix} is missing a location`);
    if (job.source !== 'Official Amazon Jobs') out.push(`${prefix} must use source "Official Amazon Jobs"`);

    const id = String(job.id || '');
    const idMatch = id.match(/^amazon-(\d+)$/);
    if (!idMatch) out.push(`${prefix} has invalid Amazon job id ${JSON.stringify(job.id)}`);
    else if (ids.has(id)) out.push(`${prefix} duplicates id ${id}`);
    else ids.add(id);

    const url = String(job.sourceUrl || '');
    let urlJobId = null;
    try {
      const parsed = new URL(url);
      const pathMatch = parsed.pathname.match(/^\/en\/jobs\/(\d+)(?:\/|$)/);
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.amazon.jobs' || !pathMatch) {
        out.push(`${prefix} is not an official canonical Amazon Jobs URL: ${url}`);
      } else {
        urlJobId = pathMatch[1];
      }
    } catch {
      out.push(`${prefix} has invalid sourceUrl ${JSON.stringify(job.sourceUrl)}`);
    }
    if (urlJobId && idMatch && urlJobId !== idMatch[1]) {
      out.push(`${prefix} id/sourceUrl requisition mismatch: ${id} vs ${urlJobId}`);
    }
    if (url) {
      if (urls.has(url)) out.push(`${prefix} duplicates sourceUrl ${url}`);
      else urls.add(url);
    }

    if (!Number.isFinite(Date.parse(String(job.postedAt || '')))) {
      out.push(`${prefix} is missing a valid postedAt timestamp`);
    }
  }
}

function validateParity(authoritative, published, out) {
  const authoritativeById = new Map(authoritative.map(job => [job.id, job]));
  const publishedById = new Map(published.map(job => [job.id, job]));

  for (const id of authoritativeById.keys()) {
    if (!publishedById.has(id)) out.push(`authoritative AWS role ${id} is missing from the public feed`);
  }
  for (const id of publishedById.keys()) {
    if (!authoritativeById.has(id)) out.push(`public AWS role ${id} is missing from the authoritative snapshot`);
  }

  const parityFields = ['title', 'company', 'location', 'type', 'experience', 'source', 'sourceUrl', 'active', 'demo', 'postedAt'];
  for (const [id, expected] of authoritativeById.entries()) {
    const actual = publishedById.get(id);
    if (!actual) continue;
    for (const field of parityFields) {
      if (actual[field] !== expected[field]) {
        out.push(`${id} field ${field} differs between authoritative snapshot and public feed`);
      }
    }
  }
}
