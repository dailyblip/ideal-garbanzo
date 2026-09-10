import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const JOBS_PATH = 'data/jobs.json';
const HISTORY_PATH = 'data/job-history.json';
const STATUS_PATH = 'data/collector-status.json';
const FUTURE_GRACE_MS = 6 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const repairOnly = process.argv.includes('--repair-only');

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function validIso(value, nowMs) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) && parsed <= nowMs + FUTURE_GRACE_MS ? new Date(parsed).toISOString() : null;
}

function isWorkdayJob(job = {}) {
  return /^workday-/i.test(String(job?.id || '').trim()) || /myworkdayjobs\.com/i.test(String(job?.sourceUrl || ''));
}

// Workday search endpoints often report relative labels such as "Today" or
// "2 days ago" rather than an exact posting timestamp. Some collectors have to
// turn those labels into an ISO timestamp at collection time. Keeping the exact
// collection clock makes an unchanged job look newly modified on later runs and
// can distort job-alert recency and sitemap lastmod dates. Workday postings are
// therefore treated as date-granularity evidence and normalized to UTC midnight.
function canonicalPostedAt(job, nowMs) {
  const postedAt = validIso(job?.postedAt, nowMs);
  if (!postedAt || !isWorkdayJob(job)) return postedAt;
  return `${postedAt.slice(0, 10)}T00:00:00.000Z`;
}

const postingDateRegressionCases = [
  {
    job: {
      id: 'workday-qtsdatacenters-R2026-2018',
      sourceUrl: 'https://qtsdatacenters.wd5.myworkdayjobs.com/en-US/QTS/job/Richmond-VA/example',
      postedAt: '2026-09-09T16:58:38.378Z'
    },
    expected: '2026-09-09T00:00:00.000Z'
  },
  {
    job: {
      id: 'generic-123',
      sourceUrl: 'https://example.com/jobs/123',
      postedAt: '2026-09-09T16:58:38.378Z'
    },
    expected: '2026-09-09T16:58:38.378Z'
  },
  {
    job: {
      id: 'other-123',
      sourceUrl: 'https://example.wd1.myworkdayjobs.com/en-US/Careers/job/example',
      postedAt: '2026-09-08T23:12:00.000Z'
    },
    expected: '2026-09-08T00:00:00.000Z'
  }
];
for (const testCase of postingDateRegressionCases) {
  const actual = canonicalPostedAt(testCase.job, Date.parse('2026-09-10T12:00:00.000Z'));
  if (actual !== testCase.expected) {
    throw new Error(`Workday posting-date regression: expected ${testCase.expected}, got ${actual}`);
  }
}

function initialSeenAt(job, nowMs, nowIso) {
  const postedAt = validIso(job?.postedAt, nowMs);
  if (postedAt) return postedAt;

  const postedHours = Number(job?.postedHours);
  if (Number.isFinite(postedHours) && postedHours >= 0 && postedHours <= 24 * 365) {
    return new Date(nowMs - postedHours * HOUR_MS).toISOString();
  }
  return nowIso;
}

function jobFingerprint(job) {
  const stable = {
    title: String(job?.title || '').trim(),
    company: String(job?.company || '').trim(),
    location: String(job?.location || '').trim(),
    type: String(job?.type || '').trim(),
    experience: String(job?.experience || '').trim(),
    tags: Array.isArray(job?.tags) ? job.tags.map(value => String(value).trim()) : [],
    pay: String(job?.pay || '').trim(),
    salaryMin: Number.isFinite(Number(job?.salaryMin)) ? Number(job.salaryMin) : null,
    salaryMax: Number.isFinite(Number(job?.salaryMax)) ? Number(job.salaryMax) : null,
    postedAt: validIso(job?.postedAt, Number.POSITIVE_INFINITY),
    source: String(job?.source || '').trim(),
    sourceUrl: String(job?.sourceUrl || '').trim()
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 24);
}

const jobs = await readJson(JOBS_PATH, []);
if (!Array.isArray(jobs) || !jobs.length) throw new Error('Cannot stamp job history: data/jobs.json is empty or invalid.');

const rawHistory = await readJson(HISTORY_PATH, {});
const rawEntries = rawHistory?.jobs && typeof rawHistory.jobs === 'object' && !Array.isArray(rawHistory.jobs)
  ? rawHistory.jobs
  : {};
const historyEntries = { ...rawEntries };
const nowMs = Date.now();
const nowIso = new Date(nowMs).toISOString();
const priorInitializedAt = validIso(rawHistory?.initializedAt, nowMs);
const initializing = !priorInitializedAt;
const initializedAt = priorInitializedAt || nowIso;

let added = 0;
let seeded = 0;
let repaired = 0;
let changed = 0;
let migrated = 0;
let recencyRepaired = 0;
let firstSeenRecencyFallbacks = 0;
let normalizedWorkdayPostingDates = 0;

for (const job of jobs) {
  const id = String(job?.id || '').trim();
  if (!id) throw new Error('Cannot stamp job history: published job is missing id.');

  const normalizedPostedAt = canonicalPostedAt(job, nowMs);
  if (normalizedPostedAt && normalizedPostedAt !== job.postedAt) {
    job.postedAt = normalizedPostedAt;
    normalizedWorkdayPostingDates += 1;
  }

  const existingEntry = historyEntries[id] && typeof historyEntries[id] === 'object' ? historyEntries[id] : {};
  const existingFirstSeen = validIso(existingEntry.firstSeenAt, nowMs);
  let firstSeenAt = existingFirstSeen;

  if (!firstSeenAt) {
    if (historyEntries[id]) repaired += 1;
    if (initializing) {
      firstSeenAt = initialSeenAt(job, nowMs, nowIso);
      seeded += 1;
    } else {
      firstSeenAt = nowIso;
      added += 1;
    }
  }

  const fingerprint = jobFingerprint(job);
  const existingFingerprint = String(existingEntry.fingerprint || '').trim();
  let lastChangedAt = validIso(existingEntry.lastChangedAt, nowMs);

  if (!existingFingerprint) {
    // Version-1 history did not track content changes. Seed the first reliable
    // change date from when the job was first discovered rather than falsely
    // marking every unchanged job as modified on every build.
    lastChangedAt = firstSeenAt;
    migrated += 1;
  } else if (existingFingerprint !== fingerprint) {
    lastChangedAt = nowIso;
    changed += 1;
  } else if (!lastChangedAt) {
    lastChangedAt = firstSeenAt;
    repaired += 1;
  }

  historyEntries[id] = { firstSeenAt, lastChangedAt, fingerprint };
  job.firstSeenAt = firstSeenAt;
  job.lastChangedAt = lastChangedAt;

  // postedHours is the UI/sort recency field. Prefer the employer's posting date
  // when it is available; otherwise age the role from our persistent first-seen
  // timestamp instead of leaving verified jobs at the legacy 9999-hour sentinel.
  // Publication-guard repair mode fixes only missing/invalid sentinel values so a
  // clean feed does not produce clock-only commits every few minutes. Real jobs
  // can legitimately be older than 9,000 hours, so age alone is never invalid.
  const postedAt = validIso(job?.postedAt, nowMs);
  const recencyAt = postedAt || firstSeenAt;
  if (!postedAt) firstSeenRecencyFallbacks += 1;
  const expectedPostedHours = Math.max(0, Math.round((nowMs - Date.parse(recencyAt)) / HOUR_MS));
  const rawPostedHours = job?.postedHours;
  const existingPostedHours = rawPostedHours === null || rawPostedHours === undefined || rawPostedHours === ''
    ? Number.NaN
    : Number(rawPostedHours);
  const legacySentinel = !postedAt && existingPostedHours === 9999 && expectedPostedHours !== 9999;
  if (!repairOnly) {
    job.postedHours = expectedPostedHours;
  } else if (!Number.isFinite(existingPostedHours) || existingPostedHours < 0 || legacySentinel) {
    job.postedHours = expectedPostedHours;
    recencyRepaired += 1;
  }
}

const sortedEntries = Object.fromEntries(
  Object.entries(historyEntries).sort(([a], [b]) => a.localeCompare(b))
);
const history = {
  version: 2,
  initializedAt,
  jobs: sortedEntries
};

await writeFile(JOBS_PATH, `${JSON.stringify(jobs, null, 2)}\n`);
await writeFile(HISTORY_PATH, `${JSON.stringify(history, null, 2)}\n`);

const status = await readJson(STATUS_PATH, {});
status.jobHistory = {
  initializedAt,
  trackedJobs: Object.keys(sortedEntries).length,
  currentJobs: jobs.length,
  newJobsThisRun: initializing ? 0 : added,
  changedJobsThisRun: changed,
  migratedEntriesThisRun: migrated,
  seededExistingThisRun: initializing ? seeded : 0,
  repairedEntriesThisRun: repaired,
  recencySentinelsRepairedThisRun: recencyRepaired,
  normalizedWorkdayPostingDatesThisRun: normalizedWorkdayPostingDates,
  firstSeenRecencyFallbackJobs: firstSeenRecencyFallbacks,
  updatedAt: nowIso
};
await writeFile(STATUS_PATH, `${JSON.stringify(status, null, 2)}\n`);

console.log(
  repairOnly
    ? `Job history repair pass: ${added} missing IDs added, ${repaired} invalid entries repaired, ${recencyRepaired} recency sentinels repaired, ${normalizedWorkdayPostingDates} Workday posting dates normalized, ${changed} content changes tracked; healthy postedHours left unchanged.`
    : initializing
      ? `Initialized job history for ${seeded} existing jobs without marking the current feed as newly discovered.`
      : `Job history updated: ${added} new, ${changed} meaningfully changed, ${jobs.length} current jobs, ${Object.keys(sortedEntries).length} tracked IDs, ${normalizedWorkdayPostingDates} Workday posting dates normalized, ${firstSeenRecencyFallbacks} using first-seen recency.`
);
