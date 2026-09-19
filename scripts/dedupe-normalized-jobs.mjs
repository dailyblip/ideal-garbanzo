import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';

const normalizeIdentity = value => String(value ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const hasNumericReqPrefix = title => /^\s*\d{2,5}\s*[-–—]/u.test(String(title || ''));
// Audited employer shorthand that has appeared both with and without the
// parenthetical on otherwise identical requisitions. Keep this list explicit
// so meaningful discipline qualifiers such as HVAC or MEP are never collapsed.
const NON_DISTINCT_TITLE_QUALIFIERS = new Set(['cbqe']);

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
  title = title.replace(/\s*\(([^)]+)\)\s*$/u, (full, tail) =>
    tailBelongsToLocation(tail) || NON_DISTINCT_TITLE_QUALIFIERS.has(normalizeIdentity(tail)) ? '' : full
  );
  // Shift qualifiers are applicant-significant schedule differences. Keep day,
  // night, overnight, and weekend shift labels in the semantic identity so a
  // same-site opening on another shift is never discarded as a duplicate.
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

function identityKeys(job) {
  const id = String(job?.id || '').trim();
  const url = String(job?.sourceUrl || '').trim();
  const company = normalizeIdentity(job?.company);
  const title = canonicalTitle(job || {});
  const req = requisitionId(url);
  return {
    id,
    url,
    reqKey: req ? `${company}|${req}` : '',
    semanticKey: [company, title, normalizeIdentity(job?.location)].join('|')
  };
}

function registerKeys(maps, keys, index) {
  if (keys.id) maps.byId.set(keys.id, index);
  if (keys.url) maps.byUrl.set(keys.url, index);
  if (keys.reqKey) maps.byReq.set(keys.reqKey, index);
  if (keys.semanticKey) maps.bySemantic.set(keys.semanticKey, index);
}

function unregisterKeys(maps, keys, index) {
  // A replacement must stop owning every alias that belonged only to the
  // discarded record. Otherwise a later, distinct opening that legitimately
  // reuses an old source ID/URL/requisition can be collapsed into the winner.
  for (const [map, key] of [
    [maps.byId, keys.id],
    [maps.byUrl, keys.url],
    [maps.byReq, keys.reqKey],
    [maps.bySemantic, keys.semanticKey]
  ]) {
    if (key && map.get(key) === index) map.delete(key);
  }
}

function dedupeRecords(records) {
  const kept = [];
  const maps = {
    byId: new Map(),
    byUrl: new Map(),
    byReq: new Map(),
    bySemantic: new Map()
  };
  const removed = [];

  for (const rawJob of records) {
    const job = { ...rawJob };
    if (/^pay not listed$/i.test(String(job.pay || '').trim())) job.pay = '';
    const keys = identityKeys(job);

    let priorIndex = -1;
    let reason = '';
    if (keys.id && maps.byId.has(keys.id)) { priorIndex = maps.byId.get(keys.id); reason = 'same-id'; }
    else if (keys.url && maps.byUrl.has(keys.url)) { priorIndex = maps.byUrl.get(keys.url); reason = 'same-url'; }
    else if (keys.reqKey && maps.byReq.has(keys.reqKey)) { priorIndex = maps.byReq.get(keys.reqKey); reason = 'same-requisition'; }
    else if (keys.semanticKey && maps.bySemantic.has(keys.semanticKey)) { priorIndex = maps.bySemantic.get(keys.semanticKey); reason = 'same-company-title-location'; }

    if (priorIndex >= 0) {
      const prior = kept[priorIndex];
      const winner = chooseBetter(prior, job);
      const loser = winner === prior ? job : prior;

      if (winner !== prior) {
        unregisterKeys(maps, identityKeys(prior), priorIndex);
        kept[priorIndex] = winner;
      }
      registerKeys(maps, identityKeys(winner), priorIndex);
      removed.push({ reason, removedId: loser.id, keptId: winner.id, company: winner.company, title: winner.title, location: winner.location });
      continue;
    }

    const index = kept.push(job) - 1;
    registerKeys(maps, keys, index);
  }

  return { kept, removed };
}

// Regression: when a better representative replaces an earlier duplicate, the
// discarded record's aliases must not remain live. The third record deliberately
// reuses the discarded ID for a different site/title; it must survive. The fourth
// record is a true duplicate of the current winner and still must collapse.
const aliasRegression = dedupeRecords([
  {
    id: 'legacy-a',
    title: '989 - Data Center Technician L1',
    company: 'Example Data Centers',
    location: 'Phoenix, AZ',
    sourceUrl: 'https://jobs.example.com/jobs/123456',
    type: 'entry-level',
    experience: '2-5-years',
    pay: ''
  },
  {
    id: 'winner-b',
    title: 'Data Center Technician L1',
    company: 'Example Data Centers',
    location: 'Phoenix, AZ',
    sourceUrl: 'https://jobs.example.com/jobs/999999',
    type: 'apprenticeship',
    experience: 'no-experience',
    pay: '$24 / hour'
  },
  {
    id: 'legacy-a',
    title: 'Critical Facilities Engineer',
    company: 'Example Data Centers',
    location: 'Dallas, TX',
    sourceUrl: 'https://jobs.example.com/jobs/222222',
    type: 'entry-level',
    experience: '2-5-years',
    pay: ''
  },
  {
    id: 'duplicate-current',
    title: 'Data Center Technician L1 - Phoenix, AZ',
    company: 'Example Data Centers',
    location: 'Phoenix, AZ',
    sourceUrl: 'https://jobs.example.com/jobs/333333',
    type: 'entry-level',
    experience: '2-5-years',
    pay: ''
  }
]);
if (aliasRegression.kept.length !== 2 ||
    !aliasRegression.kept.some(job => job.id === 'winner-b') ||
    !aliasRegression.kept.some(job => job.id === 'legacy-a' && job.location === 'Dallas, TX')) {
  throw new Error('Post-normalization dedupe alias regression: stale loser aliases can collapse a distinct later role.');
}

// Regression from production: QTS has published the same controls-quality role
// at the same site both with and without its internal "CBQE" shorthand. The
// broader nightly QA correctly treated those as one opening; the publication
// deduper must do the same before a source workflow can push the shared feed.
const auditedQualifierRegression = dedupeRecords([
  {
    id: 'workday-qtsdatacenters-R2026-0768',
    title: 'Regional Data Center Controls Quality Engineer',
    company: 'QTS Data Centers',
    location: 'Suwanee, GA',
    sourceUrl: 'https://qtsdatacenters.wd5.myworkdayjobs.com/en-US/QTS/job/Suwanee-GA/Regional-Data-Center-Controls-Quality-Engineer_R2026-0768',
    type: 'entry-level',
    experience: '0-2-years',
    pay: ''
  },
  {
    id: 'workday-qtsdatacenters-R2026-0881',
    title: 'Regional Data Center Controls Quality Engineer (CBQE)',
    company: 'QTS Data Centers',
    location: 'Suwanee, GA',
    sourceUrl: 'https://qtsdatacenters.wd5.myworkdayjobs.com/en-US/QTS/job/Suwanee-GA/Regional-Data-Center-Controls-Quality-Engineer-CBQE_R2026-0881',
    type: 'entry-level',
    experience: '0-2-years',
    pay: ''
  }
]);
if (auditedQualifierRegression.kept.length !== 1 || auditedQualifierRegression.removed.length !== 1) {
  throw new Error('Post-normalization dedupe qualifier regression: audited CBQE title aliases must collapse to one opening.');
}

// Regression: different shifts at the same facility are distinct opportunities
// for applicants and must survive semantic dedupe. A true duplicate on the same
// shift should still collapse normally.
const shiftRegression = dedupeRecords([
  {
    id: 'day-opening',
    title: 'Critical Engineering Technician, Day Shift',
    company: 'Example Data Centers',
    location: 'San Antonio, TX',
    sourceUrl: 'https://jobs.example.com/jobs/444444',
    type: 'entry-level',
    experience: '0-2-years',
    pay: ''
  },
  {
    id: 'night-opening',
    title: 'Critical Engineering Technician, Night Shift',
    company: 'Example Data Centers',
    location: 'San Antonio, TX',
    sourceUrl: 'https://jobs.example.com/jobs/555555',
    type: 'entry-level',
    experience: '0-2-years',
    pay: ''
  },
  {
    id: 'night-duplicate',
    title: 'Critical Engineering Technician, Night Shift',
    company: 'Example Data Centers',
    location: 'San Antonio, TX',
    sourceUrl: 'https://jobs.example.com/jobs/666666',
    type: 'entry-level',
    experience: '0-2-years',
    pay: ''
  }
]);
if (shiftRegression.kept.length !== 2 || shiftRegression.removed.length !== 1 ||
    !shiftRegression.kept.some(job => job.id === 'day-opening') ||
    !shiftRegression.kept.some(job => job.id === 'night-opening')) {
  throw new Error('Post-normalization dedupe shift regression: distinct day/night openings must not collapse together.');
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

const { kept, removed } = dedupeRecords(jobs);
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
    policy: 'one representative posting per normalized employer + shift-aware title + location',
    examples: removed.slice(0, 20)
  };
  await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
} catch {}

console.log(`Post-normalization dedupe removed ${removed.length} duplicate-looking listing${removed.length === 1 ? '' : 's'}; ${kept.length} jobs remain.`);
