import { readFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';

// These patterns intentionally cover employer-direct sources whose current
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
  ['Sabey Data Centers', /^\/jobs\/\d+\/[^/]+\/job\/?$/i],
  ['Stream Data Centers', /^\/stream-dc\/j\/[a-z0-9]+\/?$/i],
  ['Switch', /^\/employment\/view\.php$/i],
  ['Novva Data Centers', /^\/portfolio\/[^/]+\/?$/i],
  ['CoreWeave', /^\/careers\/?$/i],
  ['EdgeConneX', /^\/edgeconnex\/jobs\/[0-9a-f-]{36}\/?$/i]
]);

const directRoleHosts = new Map([
  ['Amazon Web Services', new Set(['amazon.jobs', 'www.amazon.jobs'])],
  ['Google', new Set(['www.google.com'])],
  ['Microsoft', new Set(['apply.careers.microsoft.com'])],
  ['Meta', new Set(['metacareers.com', 'www.metacareers.com'])],
  ['Oracle', new Set(['eeho.fa.us2.oraclecloud.com'])],
  ['Digital Realty', new Set(['hdep.fa.us2.oraclecloud.com'])],
  ['Vantage Data Centers', new Set(['vantagedc.wd1.myworkdayjobs.com'])],
  ['QTS Data Centers', new Set(['qtsdatacenters.wd5.myworkdayjobs.com'])],
  ['CyrusOne', new Set(['cyrusone.wd1.myworkdayjobs.com'])],
  ['STACK Infrastructure', new Set(['stackinfra.wd108.myworkdayjobs.com'])],
  ['NTT Global Data Centers', new Set(['nttglobaldatacenters.wd501.myworkdayjobs.com'])],
  ['Aligned Data Centers', new Set(['aligneddc.wd12.myworkdayjobs.com'])],
  ['CoreSite', new Set(['jobs.coresite.com'])],
  ['Iron Mountain', new Set(['ironmountain.wd5.myworkdayjobs.com'])],
  ['Cologix', new Set(['jobs.lever.co'])],
  ['DataBank', new Set(['www.databankcareers.com'])],
  ['Flexential', new Set(['job-boards.greenhouse.io'])],
  ['T5 Data Centers', new Set(['jobs.lever.co'])],
  ['TierPoint', new Set(['careers-tierpoint.icims.com'])],
  ['Sabey Data Centers', new Set(['careers2-anothersource.icims.com'])],
  ['Stream Data Centers', new Set(['apply.workable.com'])],
  ['Switch', new Set(['switchltd.hrmdirect.com'])],
  ['Novva Data Centers', new Set(['novva.com', 'www.novva.com'])],
  ['CoreWeave', new Set(['coreweave.com', 'www.coreweave.com'])],
  ['EdgeConneX', new Set(['ats.rippling.com'])]
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
  'data/sabey-jobs.json',
  'data/stream-data-centers-jobs.json',
  'data/switch-jobs.json',
  'data/novva-jobs.json',
  'data/coreweave-jobs.json',
  'data/edgeconnex-jobs.json'
];

async function readJobs(path) {
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.jobs)) return parsed.jobs;
  throw new Error(`${path} must contain a job array or an object with a jobs array.`);
}

function hasRequiredTargeting(company, url) {
  if (company === 'CoreWeave') {
    return /^\d+$/.test(String(url.searchParams.get('gh_jid') || '').trim());
  }
  if (company === 'Switch') {
    return /^\d+$/.test(String(url.searchParams.get('req') || '').trim());
  }
  return true;
}

function isDirectRoleUrl(company, sourceUrl) {
  const pattern = directRolePatterns.get(company);
  if (!pattern) return true;
  try {
    const url = new URL(String(sourceUrl || ''));
    const allowedHosts = directRoleHosts.get(company);
    return url.protocol === 'https:' &&
      Boolean(allowedHosts?.has(url.hostname.toLowerCase())) &&
      pattern.test(url.pathname) &&
      hasRequiredTargeting(company, url);
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
  ['Sabey Data Centers', 'https://careers2-anothersource.icims.com/jobs/search', false],
  ['Stream Data Centers', 'https://apply.workable.com/stream-dc/j/62B4F3BCF5/', true],
  ['Stream Data Centers', 'https://apply.workable.com/stream-dc/', false],
  ['Switch', 'https://switchltd.hrmdirect.com/employment/view.php?req=3430787', true],
  ['Switch', 'https://switchltd.hrmdirect.com/employment/view.php', false],
  ['Novva Data Centers', 'https://www.novva.com/portfolio/command-center-operator-utah/', true],
  ['Novva Data Centers', 'https://www.novva.com/careers/', false],
  ['CoreWeave', 'https://www.coreweave.com/careers?gh_jid=4711724006', true],
  ['CoreWeave', 'https://www.coreweave.com/careers', false],
  ['EdgeConneX', 'https://ats.rippling.com/edgeconnex/jobs/2302b6e9-fd8f-4ede-b107-eb76a1a24af5', true],
  ['EdgeConneX', 'https://ats.rippling.com/edgeconnex/jobs', false],
  ['CoreSite', 'https://example.com/jobs/18130151-critical-operations-engineer-i-swing-de3', false]
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
  throw new Error(`Blocked ${violations.length} generic, non-official, or non-detail employer link(s).`);
}

const covered = [...directRolePatterns.keys()].join(', ');
console.log(`Direct-role link guard passed for employer-direct sources: ${covered}.`);
