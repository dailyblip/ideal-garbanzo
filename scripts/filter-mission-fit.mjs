import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

// This is deliberately a narrow backstop, not a replacement for source-specific
// relevance scoring. It removes role families that can match "data center" text
// while clearly falling outside the site's infrastructure/operations mission.
const obviousNonMissionTitlePattern = /\b(?:administrative business partner|software engineer|software developer|site reliability engineer|machine learning engineer|ml engineer|data scientist|product manager|program manager|talent acquisition|human resources|recruiter|account executive|sales representative|sales manager|marketing manager|marketing specialist|legal counsel|corporate counsel)\b/i;

const jobs = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
if (!Array.isArray(jobs)) throw new Error('jobs.json must contain an array');

const kept = [];
const removed = [];
for (const job of jobs) {
  const title = clean(job?.title);
  if (obviousNonMissionTitlePattern.test(title)) {
    removed.push({ id: job?.id || '', company: job?.company || '', title });
    continue;
  }
  kept.push(job);
}

const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
status.jobs = kept.length;
status.missionFit = {
  checkedAt: new Date().toISOString(),
  removedCount: removed.length,
  removed
};

await writeFile(JOBS_PATH, JSON.stringify(kept, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');

console.log(`Mission-fit backstop removed ${removed.length} obvious office/software role(s); ${kept.length} jobs remain.`);
if (removed.length) {
  console.log(`Removed: ${removed.map(item => `${item.company}: ${item.title}`).join(' | ')}`);
}
