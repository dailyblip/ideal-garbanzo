import { readFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const FALLBACK_PATH = 'data/coresite-verified-fallback.json';
const COMPANY = 'CoreSite';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const normalize = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const isCoreSite = job => clean(job?.company) === COMPANY || /(^|\.)jobs\.coresite\.com\//i.test(clean(job?.sourceUrl));
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

async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }

function validateFallback(payload) {
  const violations = [];
  if (!payload || !Array.isArray(payload.jobs) || !payload.jobs.length) {
    violations.push('verified fallback must contain at least one role');
    return { violations, verifiedAt: NaN, expiresAt: NaN };
  }
  const verifiedAt = Date.parse(payload.verifiedAt);
  const expiresAt = Date.parse(payload.expiresAt);
  if (!Number.isFinite(verifiedAt) || !Number.isFinite(expiresAt) || expiresAt <= verifiedAt) violations.push('verifiedAt/expiresAt timestamps are invalid');
  const ids = new Set(), urls = new Set();
  for (const job of payload.jobs) {
    const id = clean(job?.id), url = clean(job?.sourceUrl);
    if (job?.company !== COMPANY) violations.push(`${id || '(missing id)'} has unexpected company ${job?.company || '(missing)'}`);
    if (!/^https:\/\/jobs\.coresite\.com\/jobs\/\d+/i.test(url)) violations.push(`${id || '(missing id)'} is not an official CoreSite job URL`);
    if (!['internship', 'apprenticeship', 'trainee', 'entry-level'].includes(job?.type)) violations.push(`${id || '(missing id)'} has unsupported type ${job?.type || '(missing)'}`);
    if (!['no-experience', '0-2-years', '2-5-years'].includes(job?.experience)) violations.push(`${id || '(missing id)'} has unsupported experience ${job?.experience || '(missing)'}`);
    if (!id) violations.push('fallback role is missing an id'); else if (ids.has(id)) violations.push(`duplicate fallback id ${id}`); else ids.add(id);
    if (!url) violations.push(`${id || '(missing id)'} is missing sourceUrl`); else if (urls.has(url)) violations.push(`duplicate fallback URL ${url}`); else urls.add(url);
  }
  return { violations, verifiedAt, expiresAt };
}

const [jobs, status, fallback] = await Promise.all([readJson(JOBS_PATH), readJson(STATUS_PATH), readJson(FALLBACK_PATH)]);
if (!Array.isArray(jobs)) throw new Error('CoreSite fallback guard requires data/jobs.json to be an array.');
const { violations, verifiedAt, expiresAt } = validateFallback(fallback);
const now = Date.now();
const fallbackActive = Number.isFinite(verifiedAt) && Number.isFinite(expiresAt) && now >= verifiedAt && now <= expiresAt;
const sourceHealthy = status?.coreSite?.sourceHealthy === true;
const publicCoreSite = jobs.filter(isCoreSite);
const fallbackTitles = new Set((fallback?.jobs || []).map(canonicalTitle).filter(Boolean));
const publicTitles = new Set(publicCoreSite.map(canonicalTitle).filter(Boolean));

if (!sourceHealthy && fallbackActive && Array.isArray(fallback?.jobs)) {
  const missingTitles = [...fallbackTitles].filter(title => !publicTitles.has(title));
  if (missingTitles.length) violations.push(`active fallback lost ${missingTitles.length}/${fallbackTitles.size} unique verified role title(s)`);
  for (const job of publicCoreSite) {
    if (!/^https:\/\/jobs\.coresite\.com\/jobs\/\d+/i.test(clean(job?.sourceUrl))) violations.push(`public CoreSite card ${clean(job?.id) || clean(job?.title)} is not employer-direct`);
  }
  const fallbackStatus = status?.coreSite?.verifiedFallback;
  if (fallbackStatus?.active !== true) violations.push('collector status does not mark the active CoreSite fallback as active');
  if (Number(fallbackStatus?.roles) !== fallback.jobs.length) violations.push(`collector status reports ${fallbackStatus?.roles ?? 0} fallback roles; expected ${fallback.jobs.length}`);
  if (clean(fallbackStatus?.verifiedAt) !== clean(fallback.verifiedAt)) violations.push('collector status verifiedAt does not match the fallback file');
  if (clean(fallbackStatus?.expiresAt) !== clean(fallback.expiresAt)) violations.push('collector status expiresAt does not match the fallback file');
}

if (!sourceHealthy && !fallbackActive && Array.isArray(fallback?.jobs)) {
  const staleIds = new Set(fallback.jobs.map(job => clean(job?.id)).filter(Boolean));
  const staleUrls = new Set(fallback.jobs.map(job => clean(job?.sourceUrl)).filter(Boolean));
  const stalePublished = publicCoreSite.filter(job => staleIds.has(clean(job?.id)) || staleUrls.has(clean(job?.sourceUrl)));
  if (stalePublished.length) violations.push(`expired fallback still exposes ${stalePublished.length} stale CoreSite role(s)`);
  if (status?.coreSite?.verifiedFallback?.active === true) violations.push('collector status still marks an expired CoreSite fallback as active');
}

if (violations.length) {
  for (const violation of violations) console.error(`CoreSite fallback violation: ${violation}`);
  throw new Error(`Blocked ${violations.length} CoreSite fallback integrity violation(s).`);
}
if (sourceHealthy) console.log(`CoreSite fallback guard passed: direct source is healthy; ${publicTitles.size} clean public CoreSite role title(s).`);
else if (fallbackActive) console.log(`CoreSite fallback guard passed: ${fallback.jobs.length} verified requisitions represented by ${publicTitles.size} clean public role title(s) through ${fallback.expiresAt}.`);
else console.log('CoreSite fallback guard passed: fallback is inactive/expired and no stale verified fallback roles remain.');
