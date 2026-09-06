import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';

const normalizeIdentity = value => String(value ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const hasNumericReqPrefix = title => /^\s*\d{2,5}\s*[-–—]/u.test(String(title || ''));

function canonicalTitle(job) {
  let title = String(job.title || '').trim();
  const location = normalizeIdentity(job.location);
  const locationTokens = new Set(location.split(' ').filter(token => token.length > 1));
  const tailBelongsToLocation = tail => {
    const tokens = normalizeIdentity(tail).split(' ').filter(token => token.length > 1);
    return tokens.length > 0 && tokens.every(token => locationTokens.has(token));
  };
  // Some Workday boards prepend internal numeric requisition labels to otherwise
  // identical public titles (for example, "989 - Data Center Technician L1").
  title = title.replace(/^\s*\d{2,5}\s*[-–—]\s*/u, '');
  // Some employers append a location to the public title. Treat that as display
  // metadata rather than a distinct role identity.
  title = title.replace(/\s+[-–—]\s+([^|]+)$/u, (full, tail) => tailBelongsToLocation(tail) ? '' : full);
  title = title.replace(/\s*\(([^)]+)\)\s*$/u, (full, tail) => tailBelongsToLocation(tail) ? '' : full);
  // Shift-only suffixes make cards look duplicated even when the employer has
  // published separate requisitions. Keep one representative role per title.
  title = title.replace(/\s*[-–—,:()]?\s*(?:day|night|overnight|weekend)\s+shift(?:\s*\d+)?\s*$/iu, '');
  return normalizeIdentity(title);
}

function requisitionId(url = '') {
  const value = String(url);
  const patterns = [
    /[?&](?:gh_jid|jobid|jobId|jid)=([A-Za-z0-9_-]+)/i,
    /\/jobs?\/(\d{6,})\b/i,
    /\b(R\d{4}-\d{3,})\b/i,
    /\b(JLL\d{5,})\b/i,
    /\b(JR\d{5,})\b/i,
    /\b([A-Z]\d{5,})\b/
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return match[1].toLowerCase();
  }
  return '';
}

function hasListedPay(job) {
  const pay = String(job?.pay || '').trim();
  return Boolean(pay) && !/^pay not listed$/i.test(pay);
}

function qualityScore(job) {
  let score = 0;
  if (job.type === 'apprenticeship') score += 40;
  else if (job.type === 'internship') score += 35;
  else if (job.type === 'trainee') score += 30;
  if (job.experience === 'no-experience') score += 20;
  else if (job.experience === '0-2-years') score += 10;
  // Prefer the representative posting that actually includes compensation.
  if (hasListedPay(job)) score += 8;
  if (Number.isFinite(Number(job.salaryMax))) score += 4;
  if (Number.isFinite(Number(job.salaryMin))) score += 2;
  if (job.postedAt) score += 2;
  if (job.region) score += 1;
  // Prefer the clean public-facing title when a duplicate carries an internal
  // numeric requisition prefix.
  if (!hasNumericReqPrefix(job.title)) score += 4;
  return score;
}

function chooseBetter(a, b) {
  const aScore = qualityScore(a);
  const bScore = qualityScore(b);
  if (aScore !== bScore) return bScore > aScore ? b : a;

  const aPosted = Date.parse(a.postedAt || '') || 0;
  const bPosted = Date.parse(b.postedAt || '') || 0;
  if (aPosted !== bPosted) return bPosted > aPosted ? b : a;

  const aHours = Number(a.postedHours ?? Number.POSITIVE_INFINITY);
  const bHours = Number(b.postedHours ?? Number.POSITIVE_INFINITY);
  if (aHours !== bHours) return bHours < aHours ? b : a;
  return a;
}

function countBy(values, key) {
  return values.reduce((counts, item) => {
    const value = String(item?.[key] || '').trim();
    if (value) counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

const jobs = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
if (!Array.isArray(jobs)) throw new Error('data/jobs.json must contain an array.');

const kept = [];
const byId = new Map();
const byUrl = new Map();
const byReq = new Map();
const byCompanyTitle = new Map();
const bySemantic = new Map();
const removed = [];

for (const rawJob of jobs) {
  const job = { ...rawJob };
  if (/^pay not listed$/i.test(String(job.pay || '').trim())) job.pay = '';

  const id = String(job.id || '').trim();
  const url = String(job.sourceUrl || '').trim();
  const company = normalizeIdentity(job.company);
  const title = canonicalTitle(job);
  const req = requisitionId(url);
  const reqKey = req ? `${company}|${req}` : '';
  const companyTitleKey = company && title ? `${company}|${title}` : '';
  const semanticKey = [company, title, normalizeIdentity(job.location)].join('|');

  let priorIndex = -1;
  let reason = '';
  if (id && byId.has(id)) { priorIndex = byId.get(id); reason = 'same-id'; }
  else if (url && byUrl.has(url)) { priorIndex = byUrl.get(url); reason = 'same-url'; }
  else if (reqKey && byReq.has(reqKey)) { priorIndex = byReq.get(reqKey); reason = 'same-requisition'; }
  else if (companyTitleKey && byCompanyTitle.has(companyTitleKey)) { priorIndex = byCompanyTitle.get(companyTitleKey); reason = 'same-company-title'; }
  else if (semanticKey && bySemantic.has(semanticKey)) { priorIndex = bySemantic.get(semanticKey); reason = 'same-company-title-location'; }

  if (priorIndex >= 0) {
    const prior = kept[priorIndex];
    const winner = chooseBetter(prior, job);
    const loser = winner === prior ? job : prior;
    kept[priorIndex] = winner;
    removed.push({ reason, removedId: loser.id, keptId: winner.id, company: winner.company, title: winner.title, location: winner.location });

    const winnerId = String(winner.id || '').trim();
    const winnerUrl = String(winner.sourceUrl || '').trim();
    const winnerReq = requisitionId(winnerUrl);
    const winnerCompany = normalizeIdentity(winner.company);
    const winnerTitle = canonicalTitle(winner);
    const winnerReqKey = winnerReq ? `${winnerCompany}|${winnerReq}` : '';
    const winnerCompanyTitleKey = winnerCompany && winnerTitle ? `${winnerCompany}|${winnerTitle}` : '';
    const winnerSemantic = [winnerCompany, winnerTitle, normalizeIdentity(winner.location)].join('|');
    if (winnerId) byId.set(winnerId, priorIndex);
    if (winnerUrl) byUrl.set(winnerUrl, priorIndex);
    if (winnerReqKey) byReq.set(winnerReqKey, priorIndex);
    if (winnerCompanyTitleKey) byCompanyTitle.set(winnerCompanyTitleKey, priorIndex);
    if (winnerSemantic) bySemantic.set(winnerSemantic, priorIndex);
    continue;
  }

  const index = kept.push(job) - 1;
  if (id) byId.set(id, index);
  if (url) byUrl.set(url, index);
  if (reqKey) byReq.set(reqKey, index);
  if (companyTitleKey) byCompanyTitle.set(companyTitleKey, index);
  if (semanticKey) bySemantic.set(semanticKey, index);
}

await writeFile(JOBS_PATH, JSON.stringify(kept, null, 2) + '\n');

try {
  const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
  status.jobs = kept.length;
  status.countsByType = countBy(kept, 'type');
  status.countsByExperience = countBy(kept, 'experience');
  status.normalizationDedupe = {
    checkedAt: new Date().toISOString(),
    before: jobs.length,
    after: kept.length,
    removed: removed.length,
    policy: 'one representative posting per normalized employer + title',
    examples: removed.slice(0, 20)
  };
  await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
} catch {}

console.log(`Post-normalization dedupe removed ${removed.length} duplicate-looking listing${removed.length === 1 ? '' : 's'}; ${kept.length} jobs remain.`);
