import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const jobs = JSON.parse(await readFile('data/jobs.json', 'utf8'));
const history = JSON.parse(await readFile('data/job-history.json', 'utf8'));
const now = Date.now();
const futureGrace = 6 * 60 * 60 * 1000;

function validIso(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedPostedAt(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
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
    postedAt: normalizedPostedAt(job?.postedAt),
    source: String(job?.source || '').trim(),
    sourceUrl: String(job?.sourceUrl || '').trim()
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 24);
}

if (!Array.isArray(jobs) || !jobs.length) throw new Error('Job history validation requires a non-empty jobs feed.');
if (history?.version !== 2) throw new Error('data/job-history.json must use version 2.');
if (!Number.isFinite(Date.parse(history?.initializedAt || ''))) throw new Error('Job history is missing a valid initializedAt timestamp.');
if (!history?.jobs || typeof history.jobs !== 'object' || Array.isArray(history.jobs)) throw new Error('Job history jobs map is invalid.');

const ids = new Set();
for (const job of jobs) {
  const id = String(job?.id || '').trim();
  if (!id) throw new Error('Published job is missing id.');
  if (ids.has(id)) throw new Error(`Duplicate published job id: ${id}`);
  ids.add(id);

  const firstSeenAt = String(job?.firstSeenAt || '');
  const firstSeenMs = validIso(firstSeenAt);
  if (firstSeenMs === null) throw new Error(`Job ${id} is missing a valid firstSeenAt timestamp.`);
  if (firstSeenMs > now + futureGrace) throw new Error(`Job ${id} has a firstSeenAt timestamp too far in the future.`);

  const lastChangedAt = String(job?.lastChangedAt || '');
  const lastChangedMs = validIso(lastChangedAt);
  if (lastChangedMs === null) throw new Error(`Job ${id} is missing a valid lastChangedAt timestamp.`);
  if (lastChangedMs > now + futureGrace) throw new Error(`Job ${id} has a lastChangedAt timestamp too far in the future.`);
  if (lastChangedMs < firstSeenMs) throw new Error(`Job ${id} lastChangedAt predates firstSeenAt.`);

  const historyEntry = history.jobs[id];
  if (!historyEntry || typeof historyEntry !== 'object') throw new Error(`Job ${id} is missing from data/job-history.json.`);
  if (firstSeenAt !== String(historyEntry.firstSeenAt || '')) throw new Error(`Job ${id} firstSeenAt does not match data/job-history.json.`);
  if (lastChangedAt !== String(historyEntry.lastChangedAt || '')) throw new Error(`Job ${id} lastChangedAt does not match data/job-history.json.`);

  const expectedFingerprint = jobFingerprint(job);
  if (expectedFingerprint !== String(historyEntry.fingerprint || '')) throw new Error(`Job ${id} content fingerprint does not match data/job-history.json.`);
}

console.log(`Job history validation passed for ${jobs.length} published jobs and ${Object.keys(history.jobs).length} tracked IDs with meaningful-change timestamps.`);
