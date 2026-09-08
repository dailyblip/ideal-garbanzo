import { readFile, writeFile } from 'node:fs/promises';

const SNAPSHOT_PATH = 'data/oracle-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const COMPANY = 'Oracle';

// Oracle's broad career taxonomy can surface corporate/engineering internships
// whose descriptions mention cloud infrastructure even though the jobs are not
// hands-on data-center, facilities, electrical, critical-environment, or
// operations roles. Keep this narrow and title-based so valid technician,
// facilities, electrical, mechanical, controls, and deployment roles survive.
const CLEARLY_NON_OPERATIONAL_TITLE = /\b(?:business analyst|business operations|cost management|cost estimator|cost analyst|cost controls|procurement|purchasing|finance|financial|accounting|accountant|security operations|cybersecurity|information security|software engineer|software developer|application developer|applications developer|frontend|backend|full[ -]?stack|database engineer|database administrator|product manager|product management|ux|ui|machine learning|data scientist|legal|counsel|paralegal|recruiter|talent acquisition|marketing|sales|account executive)\b/i;

const regressionCases = [
  ['Data Center Business Operations Business Analyst', true],
  ['Data Center Development Cost Management', true],
  ['OCI Software Engineer Intern - OVIP', true],
  ['Corporate Accounting Intern', true],
  ['Data Center Technician 2', false],
  ['Critical Facilities Engineer', false],
  ['Mechanical Engineer 2', false],
  ['Electrical Engineer 2', false],
  ['Data Center Facilities Technician', false],
  ['Data Center Low Voltage Engineer III', false]
];
for (const [title, rejected] of regressionCases) {
  const actual = CLEARLY_NON_OPERATIONAL_TITLE.test(title);
  if (actual !== rejected) {
    throw new Error(`Oracle mission-fit scrub regression for "${title}": expected rejected=${rejected}, got ${actual}`);
  }
}

async function readArray(path) {
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(value)) throw new Error(`${path} must contain a JSON array`);
  return value;
}

function isOracle(job = {}) {
  return String(job?.company || '').trim() === COMPANY;
}

function removalReason(job = {}) {
  if (!isOracle(job)) return '';
  const title = String(job?.title || '').trim();
  if (CLEARLY_NON_OPERATIONAL_TITLE.test(title)) return 'non-operational role family';
  return '';
}

function partition(records = []) {
  const kept = [];
  const removed = [];
  for (const job of records) {
    const reason = removalReason(job);
    if (!reason) {
      kept.push(job);
      continue;
    }
    removed.push({
      id: String(job?.id || ''),
      title: String(job?.title || '').trim(),
      location: String(job?.location || '').trim(),
      reason
    });
  }
  return { kept, removed };
}

function countsBy(records, field) {
  return records.reduce((acc, job) => {
    const key = String(job?.[field] || 'unknown').trim() || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

const snapshot = await readArray(SNAPSHOT_PATH);
const jobs = await readArray(JOBS_PATH);
const snapshotResult = partition(snapshot);
const jobsResult = partition(jobs);

// The source-specific snapshot is authoritative for Oracle. Every role removed
// here must also be absent from the public feed; removing from both files keeps
// the subsequent global publication filter and Oracle parity guard deterministic.
if (snapshotResult.removed.length) {
  await writeFile(SNAPSHOT_PATH, JSON.stringify(snapshotResult.kept, null, 2) + '\n');
}
if (jobsResult.removed.length) {
  await writeFile(JOBS_PATH, JSON.stringify(jobsResult.kept, null, 2) + '\n');
}

if (snapshotResult.removed.length || jobsResult.removed.length) {
  const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
  status.jobs = jobsResult.kept.length;
  status.countsByType = countsBy(jobsResult.kept, 'type');
  status.countsByExperience = countsBy(jobsResult.kept, 'experience');
  status.oracleCareers = {
    ...(status.oracleCareers || {}),
    qualifyingRoles: snapshotResult.kept.length,
    missionFitScrub: {
      checkedAt: new Date().toISOString(),
      removedFromSnapshot: snapshotResult.removed.length,
      removedFromPublicFeed: jobsResult.removed.length,
      removed: snapshotResult.removed
    }
  };
  await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
}

const leftovers = snapshotResult.kept.filter(job => CLEARLY_NON_OPERATIONAL_TITLE.test(String(job?.title || '')));
if (leftovers.length) {
  throw new Error(`Oracle mission-fit scrub left ${leftovers.length} clearly non-operational role(s) in the snapshot.`);
}

console.log(`Oracle mission-fit scrub: removed ${snapshotResult.removed.length} snapshot role(s) and ${jobsResult.removed.length} public-feed role(s); ${snapshotResult.kept.length} Oracle role(s) remain.`);
if (snapshotResult.removed.length) {
  console.log(`Removed Oracle roles: ${snapshotResult.removed.map(item => item.title).join(' | ')}`);
}
