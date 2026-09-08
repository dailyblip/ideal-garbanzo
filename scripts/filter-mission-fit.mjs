import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const MAJOR_PATH = 'data/major-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const SNAPSHOT_SOURCES = [
  { path: 'data/tierpoint-jobs.json', company: 'TierPoint' },
  { path: 'data/novva-jobs.json', company: 'Novva Data Centers' },
  { path: 'data/stream-data-centers-jobs.json', company: 'Stream Data Centers' },
  { path: 'data/switch-jobs.json', company: 'Switch' },
  { path: 'data/flexential-jobs.json', company: 'Flexential' },
  { path: 'data/t5-data-centers-jobs.json', company: 'T5 Data Centers' }
];

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

// These are deliberately narrow backstops, not replacements for source-specific
// relevance and experience scoring. They catch obvious role families that can
// leak through when an employer changes its career-site markup or job taxonomy.
// Corporate uses of "operations" are intentionally named here instead of
// blocking the word globally, because hands-on critical/data-center operations
// roles are a core part of the product.
const obviousNonMissionTitlePattern = /\b(?:administrative business partner|business analyst|financial operations|financial analyst|finance analyst|procurement|purchasing|cost management|cost estimator|cost analyst|cost controls|security operations|security engineer|security analyst|security specialist|security technician|security officer|security guard|physical security|global security operations center|gsoc|wireless intrusion detection|cybersecurity|information security|software engineer|software developer|site reliability engineer|machine learning engineer|ml engineer|data scientist|product manager|program manager|talent acquisition|human resources|recruiter|account executive|sales representative|sales manager|marketing manager|marketing specialist|legal counsel|corporate counsel|enterprise it support|enterprise applications|process analytics)\b/i;
// Keep this publication-time filter aligned with validate.mjs. If these roles are
// allowed through here, the final deployment validator rejects the same feed and
// turns ordinary source-taxonomy drift into an avoidable site deployment failure.
const obviousSeniorTitlePattern = /\b(?:senior|sr\.?|lead|principal|chief|manager|mgr\.?|director|vice president|vp|head of|staff engineer|staff technician|supervisor|superintendent|foreman|architect)\b/i;

function obviousTitleReason(title = '') {
  const normalized = clean(title);
  if (obviousNonMissionTitlePattern.test(normalized)) return 'non-mission role family';
  if (obviousSeniorTitlePattern.test(normalized)) return 'senior/executive title';
  return '';
}

const titleRegressionCases = [
  { title: 'Business Analyst, Budget Planning & Financial Operations, Global', reason: 'non-mission role family' },
  { title: 'Data Center Business Operations Business Analyst', reason: 'non-mission role family' },
  { title: 'Data Center Development Cost Management', reason: 'non-mission role family' },
  { title: 'Purchasing Operations Specialist, NA', reason: 'non-mission role family' },
  { title: 'Security Operations Engineer', reason: 'non-mission role family' },
  { title: 'Data Center Security Engineer - WIDS', reason: 'non-mission role family' },
  { title: 'GSOC Operator (WIDS)', reason: 'non-mission role family' },
  { title: 'Summer 2027 Internship: Enterprise IT Support', reason: 'non-mission role family' },
  { title: 'Summer 2027 Internship: Enterprise Applications (SharePoint Access) Intern', reason: 'non-mission role family' },
  { title: 'Summer 2027 Internship: Process Analytics - Technology Delivery Team', reason: 'non-mission role family' },
  { title: 'Data Center Facilities Manager', reason: 'senior/executive title' },
  { title: 'Critical Operations Supervisor', reason: 'senior/executive title' },
  { title: 'Data Center Architect', reason: 'senior/executive title' },
  { title: 'Critical Operations Technician I', reason: '' },
  { title: 'Data Center Operations Technician', reason: '' },
  { title: 'Critical Facilities Engineer', reason: '' },
  { title: 'Summer 2027 Internship: Facilities Engineering and Commissioning', reason: '' },
  { title: 'Summer 2027 Internship: Data Center Infrastructure Management (DCIM)', reason: '' }
];
for (const testCase of titleRegressionCases) {
  const actual = obviousTitleReason(testCase.title);
  if (actual !== testCase.reason) {
    throw new Error(`Mission-fit title regression for ${testCase.title}: expected "${testCase.reason}", got "${actual}"`);
  }
}

// The product is U.S.-only. Keep a publication-time geography backstop here as
// well as in QA so a clearly foreign record cannot reach the live site simply
// because a deploy-only run skips the full refresh QA pass. Province codes are
// anchored after a comma to avoid confusing U.S. cities such as Ontario, CA.
const canadianProvinceCodePattern = /,\s*(?:AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)\b(?:\s*,?\s*Canada)?\s*$/i;
const canadianProvinceNamePattern = /,\s*(?:Alberta|British Columbia|Manitoba|New Brunswick|Newfoundland(?: and Labrador)?|Nova Scotia|Northwest Territories|Nunavut|Ontario|Prince Edward Island|Quebec|Saskatchewan|Yukon)\b(?:\s*,?\s*Canada)?\s*$/i;
const foreignCountryPattern = /(?:^|[,;]\s*)(?:Canada|Mexico|Ireland|United Kingdom|UK|England|Germany|France|Netherlands|Switzerland|India|Japan|Taiwan|Singapore|Australia|China|Malaysia|Indonesia|Thailand|Brazil|South Africa|United Arab Emirates)\s*$/i;

function clearlyNonUsLocation(location = '') {
  return String(location || '').split(';').map(part => part.trim()).filter(Boolean).some(segment =>
    canadianProvinceCodePattern.test(segment) ||
    canadianProvinceNamePattern.test(segment) ||
    foreignCountryPattern.test(segment)
  );
}

const geographyRegressionCases = [
  { location: 'Cambridge, ON', nonUs: true },
  { location: 'Toronto, Ontario', nonUs: true },
  { location: 'Richmond, BC', nonUs: true },
  { location: 'Dublin, Ireland', nonUs: true },
  { location: 'Cambridge, MA', nonUs: false },
  { location: 'Ontario, CA', nonUs: false },
  { location: 'Indianapolis, IN', nonUs: false },
  { location: 'Remote - OK', nonUs: false }
];
for (const testCase of geographyRegressionCases) {
  const actual = clearlyNonUsLocation(testCase.location);
  if (actual !== testCase.nonUs) {
    throw new Error(`Mission-fit geography regression for ${testCase.location}: expected nonUs=${testCase.nonUs}, got ${actual}`);
  }
}

function removalReason(job = {}) {
  const titleReason = obviousTitleReason(job?.title);
  if (titleReason) return titleReason;
  if (clearlyNonUsLocation(clean(job?.location))) return 'non-US location';
  return '';
}

function partitionMissionFit(records = []) {
  const kept = [];
  const removed = [];
  for (const job of records) {
    const title = clean(job?.title);
    const location = clean(job?.location);
    const reason = removalReason(job);
    if (reason) {
      removed.push({ id: job?.id || '', company: job?.company || '', title, location, reason });
      continue;
    }
    kept.push(job);
  }
  return { kept, removed };
}

function countsBy(records, field) {
  return records.reduce((acc, job) => {
    const value = clean(job?.[field]) || 'unknown';
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

let jobs = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
if (!Array.isArray(jobs)) throw new Error('jobs.json must contain an array');

// Dedicated employer collectors write verified snapshots. Generic ATS passes run
// earlier and can rebuild jobs.json, so restore those snapshots before the global
// mission-fit and dedupe gates. This prevents transient source outages from
// erasing openings that were already verified directly with the employer.
for (const { path, company } of SNAPSHOT_SOURCES) {
  try {
    const snapshotJobs = JSON.parse(await readFile(path, 'utf8'));
    if (Array.isArray(snapshotJobs) && snapshotJobs.length) {
      jobs = [
        ...jobs.filter(job => String(job?.company || '').trim() !== company),
        ...snapshotJobs
      ];
    }
  } catch {}
}

const publicResult = partitionMissionFit(jobs);
let majorResult = { kept: [], removed: [] };
let majorSnapshotPresent = false;
let majorOriginalCount = 0;
try {
  const majorJobs = JSON.parse(await readFile(MAJOR_PATH, 'utf8'));
  if (!Array.isArray(majorJobs)) throw new Error('major-jobs.json must contain an array');
  majorSnapshotPresent = true;
  majorOriginalCount = majorJobs.length;
  majorResult = partitionMissionFit(majorJobs);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
status.jobs = publicResult.kept.length;
status.countsByType = countsBy(publicResult.kept, 'type');
status.countsByExperience = countsBy(publicResult.kept, 'experience');
status.missionFit = {
  checkedAt: new Date().toISOString(),
  removedCount: publicResult.removed.length,
  removedByReason: publicResult.removed.reduce((acc, item) => {
    acc[item.reason] = (acc[item.reason] || 0) + 1;
    return acc;
  }, {}),
  removed: publicResult.removed,
  majorSnapshotRemovedCount: majorResult.removed.length,
  majorSnapshotRemoved: majorResult.removed
};

// Apply the same publication backstop to the major Workday snapshot so every
// public major-employer card still traces to a mission-fit source record. Keep
// the pre-existing reconciliation mode intact: targeted recovery can make the
// snapshot intentionally larger than the last strict reconciliation, and this
// filter must not accidentally turn that state into exact-title parity.
if (majorSnapshotPresent && majorResult.removed.length) {
  const reconciliation = status?.majorSources?.reconciliation;
  if (reconciliation && typeof reconciliation === 'object') {
    const priorPublished = Number(reconciliation.publishedUsJobs);
    const wasExactParity = Number.isFinite(priorPublished) && priorPublished === majorOriginalCount;
    if (Number.isFinite(priorPublished)) {
      if (wasExactParity) {
        reconciliation.publishedUsJobs = majorResult.kept.length;
      } else {
        const adjustedPrior = Math.max(0, priorPublished - majorResult.removed.length);
        reconciliation.publishedUsJobs = majorResult.kept.length > 0
          ? Math.min(adjustedPrior, majorResult.kept.length - 1)
          : 0;
      }
    }
    reconciliation.missionFitRemoved = majorResult.removed.length;
    reconciliation.missionFitPreservedParityMode = wasExactParity ? 'exact' : 'coverage';
  }
  await writeFile(MAJOR_PATH, JSON.stringify(majorResult.kept, null, 2) + '\n');
}

await writeFile(JOBS_PATH, JSON.stringify(publicResult.kept, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');

console.log(`Mission-fit backstop removed ${publicResult.removed.length} obvious out-of-scope role(s); ${publicResult.kept.length} jobs remain.`);
if (publicResult.removed.length) {
  console.log(`Removed: ${publicResult.removed.map(item => `${item.company}: ${item.title} [${item.reason}]`).join(' | ')}`);
}
if (majorResult.removed.length) {
  console.log(`Pruned ${majorResult.removed.length} matching out-of-scope role(s) from the major Workday snapshot.`);
}
