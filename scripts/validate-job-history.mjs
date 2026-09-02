import { readFile } from 'node:fs/promises';

const jobs = JSON.parse(await readFile('data/jobs.json', 'utf8'));
const history = JSON.parse(await readFile('data/job-history.json', 'utf8'));
const now = Date.now();
const futureGrace = 6 * 60 * 60 * 1000;

if (!Array.isArray(jobs) || !jobs.length) throw new Error('Job history validation requires a non-empty jobs feed.');
if (history?.version !== 1) throw new Error('data/job-history.json must use version 1.');
if (!Number.isFinite(Date.parse(history?.initializedAt || ''))) throw new Error('Job history is missing a valid initializedAt timestamp.');
if (!history?.jobs || typeof history.jobs !== 'object' || Array.isArray(history.jobs)) throw new Error('Job history jobs map is invalid.');

const ids = new Set();
for (const job of jobs) {
  const id = String(job?.id || '').trim();
  if (!id) throw new Error('Published job is missing id.');
  if (ids.has(id)) throw new Error(`Duplicate published job id: ${id}`);
  ids.add(id);

  const firstSeenAt = String(job?.firstSeenAt || '');
  const parsed = Date.parse(firstSeenAt);
  if (!Number.isFinite(parsed)) throw new Error(`Job ${id} is missing a valid firstSeenAt timestamp.`);
  if (parsed > now + futureGrace) throw new Error(`Job ${id} has a firstSeenAt timestamp too far in the future.`);

  const historyFirstSeen = String(history.jobs[id]?.firstSeenAt || '');
  if (firstSeenAt !== historyFirstSeen) throw new Error(`Job ${id} firstSeenAt does not match data/job-history.json.`);
}

console.log(`Job history validation passed for ${jobs.length} published jobs and ${Object.keys(history.jobs).length} tracked IDs.`);
