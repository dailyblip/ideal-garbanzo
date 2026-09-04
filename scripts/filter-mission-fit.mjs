import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const TIERPOINT_PATH = 'data/tierpoint-jobs.json';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

// These are deliberately narrow backstops, not replacements for source-specific
// relevance and experience scoring. They catch obvious role families that can
// leak through when an employer changes its career-site markup or job taxonomy.
const obviousNonMissionTitlePattern = /\b(?:administrative business partner|software engineer|software developer|site reliability engineer|machine learning engineer|ml engineer|data scientist|product manager|program manager|talent acquisition|human resources|recruiter|account executive|sales representative|sales manager|marketing manager|marketing specialist|legal counsel|corporate counsel)\b/i;
const obviousSeniorTitlePattern = /\b(?:senior|sr\.?|principal|staff engineer|staff technician|director|vice president|vp|chief|head of)\b/i;

let jobs = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
if (!Array.isArray(jobs)) throw new Error('jobs.json must contain an array');

// TierPoint's official iCIMS source is refreshed through a dedicated collector.
// The generic ATS pass runs earlier and rebuilds jobs.json, so restore the latest
// verified TierPoint snapshot here before the global mission-fit and dedupe gates.
// This keeps a transient iCIMS outage from erasing already-verified openings.
try {
  const tierPointJobs = JSON.parse(await readFile(TIERPOINT_PATH, 'utf8'));
  if (Array.isArray(tierPointJobs) && tierPointJobs.length) {
    jobs = [
      ...jobs.filter(job => String(job?.company || '').trim() !== 'TierPoint'),
      ...tierPointJobs
    ];
  }
} catch {}

const kept = [];
const removed = [];
for (const job of jobs) {
  const title = clean(job?.title);
  let reason = '';
  if (obviousNonMissionTitlePattern.test(title)) reason = 'non-mission role family';
  else if (obviousSeniorTitlePattern.test(title)) reason = 'senior/executive title';

  if (reason) {
    removed.push({ id: job?.id || '', company: job?.company || '', title, reason });
    continue;
  }
  kept.push(job);
}

const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
status.jobs = kept.length;
status.missionFit = {
  checkedAt: new Date().toISOString(),
  removedCount: removed.length,
  removedByReason: removed.reduce((acc, item) => {
    acc[item.reason] = (acc[item.reason] || 0) + 1;
    return acc;
  }, {}),
  removed
};

await writeFile(JOBS_PATH, JSON.stringify(kept, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');

console.log(`Mission-fit backstop removed ${removed.length} obvious out-of-scope role(s); ${kept.length} jobs remain.`);
if (removed.length) {
  console.log(`Removed: ${removed.map(item => `${item.company}: ${item.title} [${item.reason}]`).join(' | ')}`);
}
