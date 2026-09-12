import { readFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';

// These patterns intentionally cover only employer-direct sources whose current
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
  ['Aligned Data Centers', /\/job\//i],
  ['CoreSite', /^\/jobs\/\d+(?:[-/]|$)/i],
  ['Iron Mountain', /\/job\//i],
  ['Cologix', /^\/cologix\/[0-9a-f-]{36}\/?$/i],
  ['DataBank', /^\/clients\/\d+\/posting\/\d+\/?$/i],
  ['Flexential', /^\/flexentialcorp\/jobs\/\d+\/?$/i],
  ['T5 Data Centers', /^\/t5datacenters\/[0-9a-f-]{36}\/?$/i],
  ['TierPoint', /^\/jobs\/\d+\/[^/]+\/job\/?$/i],
  ['Sabey Data Centers', /^\/jobs\/\d+\/[^/]+\/job\/?$/i]
]);

const dedicatedSnapshots = [
  'data/amazon-jobs.json',
  'data/google-jobs.json',
  'data/microsoft-jobs.json',
  'data/meta-jobs.json',
  'data/oracle-jobs.json',
  'data/digital-realty-jobs.json',
  'data/iron-mountain-jobs.json',
  'data/cologix-jobs.json',
  'data/databank-jobs.json',
  'data/flexential-jobs.json',
  'data/t5-data-centers-jobs.json',
  'data/tierpoint-jobs.json',
  'data/sabey-jobs.json'
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
  ['Vantage Data Centers', 'https://vantagedc.wd1.myworkdayjobs.com/en-US/Vantage', false],
  ['CoreSite', 'https://jobs.coresite.com/jobs/18130151-critical-operations-engineer-i-swing-de3', true],
  ['CoreSite', 'https://jobs.coresite.com/', false],
  ['Iron Mountain', 'https://ironmountain.wd5.myworkdayjobs.com/en-US/iron-mountain-jobs/job/US--FL--Miami--2925-Northwest-120th-Terrace/Critical-Facility-Technician-Sun-Wed--12pm-10pm-_J0104983', true],
  ['Iron Mountain', 'https://ironmountain.wd5.myworkdayjobs.com/en-US/iron-mountain-jobs', false],
  ['Cologix', 'https://jobs.lever.co/cologix/3caaef1b-97bc-4a26-8185-8f529380356a', true],
  ['Cologix', 'https://jobs.lever.co/cologix', false],
  ['DataBank', 'https://www.databankcareers.com/clients/14459/posting/11119357', true],
  ['DataBank', 'https://www.databankcareers.com/', false],
  ['Flexential', 'https://job-boards.greenhouse.io/flexentialcorp/jobs/4401183009', true],
  ['Flexential', 'https://job-boards.greenhouse.io/flexentialcorp', false],
  ['T5 Data Centers', 'https://jobs.lever.co/t5datacenters/290bc834-72f8-4134-bfad-5ed5fb1c2ef5', true],
  ['T5 Data Centers', 'https://jobs.lever.co/t5datacenters', false],
  ['TierPoint', 'https://careers-tierpoint.icims.com/jobs/3045/operations-technician-i/job', true],
  ['TierPoint', 'https://careers-tierpoint.icims.com/jobs/search', false],
  ['Sabey Data Centers', 'https://careers2-anothersource.icims.com/jobs/102555/data-center-mechanical-project-engineer---sabey-data-centers/job?in_iframe=1', true],
  ['Sabey Data Centers', 'https://careers2-anothersource.icims.com/jobs/search', false]
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
  throw new Error(`Blocked ${violations.length} generic or non-detail employer link(s).`);
}

const covered = [...directRolePatterns.keys()].join(', ');
console.log(`Direct-role link guard passed for employer-direct sources: ${covered}.`);
