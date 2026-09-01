import { readFile, writeFile } from 'node:fs/promises';

const jobs = JSON.parse(await readFile('data/jobs.json','utf8'));
let status = {};
try { status = JSON.parse(await readFile('data/collector-status.json','utf8')); } catch {}

const typoFixes = [
  [/\bVirgina\b/g, 'Virginia']
];

function fromWorkdayUrl(sourceUrl = '') {
  let pathname = '';
  try { pathname = new URL(sourceUrl).pathname; } catch { return null; }
  const match = pathname.match(/\/job\/([^/]+)\//i);
  if (!match) return null;
  let slug = decodeURIComponent(match[1]).replace(/_/g, '-').replace(/-+/g, '-');
  const stateMatch = slug.match(/^(.+)-([A-Z]{2})$/);
  if (!stateMatch) return null;
  const city = stateMatch[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
  return city ? `${city}, ${stateMatch[2]}` : null;
}

function normalize(job) {
  let location = String(job.location || '').trim();
  for (const [pattern, replacement] of typoFixes) location = location.replace(pattern, replacement);

  if (/^\d+\s+locations?$/i.test(location) || /^location not listed$/i.test(location)) {
    const derived = fromWorkdayUrl(job.sourceUrl);
    if (derived) location = derived;
  }

  return location;
}

const changes = [];
for (const job of jobs) {
  const before = String(job.location || '');
  const after = normalize(job);
  if (after && after !== before) {
    job.location = after;
    changes.push({ id:job.id, before, after });
  }
}

await writeFile('data/jobs.json', JSON.stringify(jobs, null, 2) + '\n');
await writeFile('data/collector-status.json', JSON.stringify({
  ...status,
  locationNormalization:{
    updatedAt:new Date().toISOString(),
    changed:changes.length,
    samples:changes.slice(0,8)
  }
}, null, 2) + '\n');

console.log(`Location normalization updated ${changes.length} job records.`);
