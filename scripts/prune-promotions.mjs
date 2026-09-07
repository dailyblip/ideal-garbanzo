import { readFile, writeFile } from 'node:fs/promises';

const [jobs, activations] = await Promise.all([
  readFile('data/jobs.json', 'utf8').then(JSON.parse),
  readFile('data/featured-jobs.json', 'utf8').then(JSON.parse)
]);

if (!Array.isArray(jobs)) throw new Error('jobs.json must contain an array');
if (!Array.isArray(activations)) throw new Error('featured-jobs.json must contain an array');

const jobsById = new Map(jobs.map(job => [String(job.id), job]));
const now = Date.now();
const kept = [];
const pruned = [];

for (const activation of activations) {
  const jobId = String(activation?.jobId || '').trim();

  // Malformed promotion records are validation errors, not lifecycle cleanup.
  // Leave them in place so validate-promotions.mjs can fail loudly.
  if (!jobId) {
    kept.push(activation);
    continue;
  }

  const expiresAt = activation?.expiresAt ? Date.parse(activation.expiresAt) : NaN;
  if (Number.isFinite(expiresAt) && expiresAt <= now) {
    pruned.push({ jobId, reason: 'expired' });
    continue;
  }

  const job = jobsById.get(jobId);
  if (!job) {
    pruned.push({ jobId, reason: 'job no longer published' });
    continue;
  }
  if (job.active === false) {
    pruned.push({ jobId, reason: 'job inactive' });
    continue;
  }
  if (job.demo === true) {
    pruned.push({ jobId, reason: 'demo job' });
    continue;
  }

  kept.push(activation);
}

if (pruned.length) {
  await writeFile('data/featured-jobs.json', `${JSON.stringify(kept, null, 2)}\n`);
}

const reasons = pruned.reduce((counts, item) => {
  counts[item.reason] = (counts[item.reason] || 0) + 1;
  return counts;
}, {});

console.log(`Promotion lifecycle hygiene: ${kept.length} kept, ${pruned.length} pruned.`);
if (pruned.length) console.log(`Pruned by reason: ${JSON.stringify(reasons)}`);
