import { readFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';

// These patterns intentionally cover only priority sources whose current official
// career systems expose stable requisition/detail URLs. A correct hostname is not
// enough: published job cards should take applicants to a specific opening rather
// than a generic careers homepage or search page.
const directRolePatterns = new Map([
  ['Amazon Web Services', /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?jobs\/\d+(?:\/|$)/i],
  ['Google', /^\/about\/careers\/applications\/jobs\/results\/\d+(?:[-/]|$)/i],
  ['Microsoft', /^\/careers\/job\/\d+(?:\/|$)/i],
  ['Meta', /^\/profile\/job_details\/\d+\/?$/i],
  ['Oracle', /^\/hcmui\/candidateexperience\/[^/]+\/sites\/[^/]+\/job\/\d+(?:\/|$)/i],
  ['Digital Realty', /^\/hcmui\/candidateexperience\/[^/]+\/sites\/[^/]+\/job\/\d+(?:\/|$)/i],
  ['Vantage Data Centers', /\/job\//i],
  ['QTS Data Centers', /\/job\//i],
  ['CyrusOne', /\/job\//i],
  ['STACK Infrastructure', /\/job\//i],
  ['NTT Global Data Centers', /\/job\//i],
  ['Aligned Data Centers', /\/job\//i]
]);

const dedicatedSnapshots = [
  'data/amazon-jobs.json',
  'data/google-jobs.json',
  'data/microsoft-jobs.json',
  'data/meta-jobs.json',
  'data/oracle-jobs.json',
  'data/digital-realty-jobs.json'
];

async function readJobs(path) {
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.jobs)) return parsed.jobs;
  throw new Error(`${path} must contain a job array or an object with a jobs array.`);
}

function isDirectRoleUrl(company, sourceUrl) {
  const pattern = directRolePatterns.get(company);
  if (!pattern) return true;
  try {
    const url = new URL(String(sourceUrl || ''));
    return url.protocol === 'https:' && pattern.test(url.pathname);
  } catch {
    return false;
  }
}

const regressionCases = [
  ['Amazon Web Services', 'https://www.amazon.jobs/en/jobs/10536759/work-based-learning-program-data-center-operations-technician', true],
  ['Amazon Web Services', 'https://www.amazon.jobs/en/search', false],
  ['Google', 'https://www.google.com/about/careers/applications/jobs/results/81243295409152710-data-center-technician-operations', true],
  ['Google', 'https://www.google.com/about/careers/applications/jobs/results/', false],
  ['Microsoft', 'https://apply.careers.microsoft.com/careers/job/1970393556642872', true],
  ['Microsoft', 'https://apply.careers.microsoft.com/careers', false],
  ['Meta', 'https://www.metacareers.com/profile/job_details/1685872255913876/', true],
  ['Meta', 'https://www.metacareers.com/jobs', false],
  ['Oracle', 'https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/344461', true],
  ['Digital Realty', 'https://hdep.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/8666', true],
  ['Vantage Data Centers', 'https://vantagedc.wd1.myworkdayjobs.com/en-US/Vantage/job/San-Antonio-Texas/Critical-Facilities-Engineer--NA_R24063', true],
  ['Vantage Data Centers', 'https://vantagedc.wd1.myworkdayjobs.com/en-US/Vantage', false]
];
for (const [company, url, expected] of regressionCases) {
  const actual = isDirectRoleUrl(company, url);
  if (actual !== expected) throw new Error(`Direct-role URL regression for ${company}: ${url}`);
}

const publicJobs = await readJobs(JOBS_PATH);
const majorJobs = await readJobs('data/major-jobs.json');
const snapshots = [];
for (const path of dedicatedSnapshots) snapshots.push(...await readJobs(path));

const violations = [];
function inspect(records, context) {
  for (const job of records) {
    const company = String(job?.company || '').trim();
    if (!directRolePatterns.has(company)) continue;
    if (!isDirectRoleUrl(company, job?.sourceUrl)) {
      violations.push(`${context}: ${company} / ${job?.id || '(missing id)'} must point to a direct official job detail URL, not ${job?.sourceUrl || '(missing URL)'}`);
    }
  }
}

inspect(publicJobs, 'Public feed');
inspect(snapshots, 'Dedicated snapshot');
inspect(majorJobs, 'Major Workday snapshot');

if (violations.length) {
  violations.forEach(violation => console.error(`Direct-role link guard: ${violation}`));
  throw new Error(`Blocked ${violations.length} generic or non-detail priority employer link(s).`);
}

const covered = [...directRolePatterns.keys()].join(', ');
console.log(`Direct-role link guard passed for priority sources: ${covered}.`);
