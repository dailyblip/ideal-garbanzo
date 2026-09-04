import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const JOBS_PATH = 'data/jobs.json';
const HISTORY_PATH = 'data/job-history.json';
const STATUS_PATH = 'data/collector-status.json';
const FUTURE_GRACE_MS = 6 * 60 * 60 * 1000;

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

function initialSeenAt(job, nowMs, nowIso) {
  const postedAt = validIso(job?.postedAt, nowMs);
  if (postedAt) return postedAt;

  const postedHours = Number(job?.postedHours);
  if (Number.isFinite(postedHours) && postedHours >= 0 && postedHours <= 24 * 365) {
    return new Date(nowMs - postedHours * 60 * 60 * 1000).toISOString();
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

for (const job of jobs) {
  const id = String(job?.id || '').trim();
  if (!id) throw new Error('Cannot stamp job history: published job is missing id.');

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
  updatedAt: nowIso
};
await writeFile(STATUS_PATH, `${JSON.stringify(status, null, 2)}\n`);

console.log(
  initializing
    ? `Initialized job history for ${seeded} existing jobs without marking the current feed as newly discovered.`
    : `Job history updated: ${added} new, ${changed} meaningfully changed, ${jobs.length} current jobs, ${Object.keys(sortedEntries).length} tracked IDs.`
);
