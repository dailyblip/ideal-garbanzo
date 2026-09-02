import { readFile, writeFile } from 'node:fs/promises';

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

for (const job of jobs) {
  const id = String(job?.id || '').trim();
  if (!id) throw new Error('Cannot stamp job history: published job is missing id.');

  const existing = validIso(historyEntries[id]?.firstSeenAt, nowMs);
  let firstSeenAt = existing;

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

  historyEntries[id] = { firstSeenAt };
  job.firstSeenAt = firstSeenAt;
}

const sortedEntries = Object.fromEntries(
  Object.entries(historyEntries).sort(([a], [b]) => a.localeCompare(b))
);
const history = {
  version: 1,
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
  seededExistingThisRun: initializing ? seeded : 0,
  repairedEntriesThisRun: repaired,
  updatedAt: nowIso
};
await writeFile(STATUS_PATH, `${JSON.stringify(status, null, 2)}\n`);

console.log(
  initializing
    ? `Initialized job history for ${seeded} existing jobs without marking the current feed as newly discovered.`
    : `Job history updated: ${added} newly discovered jobs, ${jobs.length} current jobs, ${Object.keys(sortedEntries).length} tracked IDs.`
);
