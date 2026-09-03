import { readFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';

// Priority operators should enter the public feed only through their own career
// systems. This guard prevents a future collector/merge change from quietly
// replacing employer-direct links with job-board or aggregator URLs.
const officialHostsByCompany = new Map([
  ['Amazon Web Services', new Set(['amazon.jobs', 'www.amazon.jobs'])],
  ['Google', new Set(['www.google.com'])],
  ['Microsoft', new Set(['apply.careers.microsoft.com'])],
  ['Meta', new Set(['metacareers.com', 'www.metacareers.com'])],
  ['Oracle', new Set(['eeho.fa.us2.oraclecloud.com'])],
  ['Equinix', new Set(['careers.equinix.com'])],
  ['Digital Realty', new Set(['hdep.fa.us2.oraclecloud.com'])],
  ['CoreSite', new Set(['jobs.coresite.com'])],
  ['Vantage Data Centers', new Set(['vantagedc.wd1.myworkdayjobs.com'])],
  ['QTS Data Centers', new Set(['qtsdatacenters.wd5.myworkdayjobs.com'])],
  ['CyrusOne', new Set(['cyrusone.wd1.myworkdayjobs.com'])],
  ['STACK Infrastructure', new Set(['stackinfra.wd108.myworkdayjobs.com'])],
  ['NTT Global Data Centers', new Set(['nttglobaldatacenters.wd501.myworkdayjobs.com'])],
  ['Aligned Data Centers', new Set(['aligneddc.wd12.myworkdayjobs.com'])]
]);

const jobs = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
if (!Array.isArray(jobs) || jobs.length === 0) throw new Error('Priority-source guard requires a non-empty jobs.json array.');

const counts = new Map();
const violations = [];
for (const job of jobs) {
  const company = String(job?.company || '').trim();
  const allowedHosts = officialHostsByCompany.get(company);
  if (!allowedHosts) continue;

  counts.set(company, (counts.get(company) || 0) + 1);
  let parsed;
  try { parsed = new URL(String(job?.sourceUrl || '')); }
  catch {
    violations.push(`${company}: ${job?.id || '(missing id)'} has an invalid source URL`);
    continue;
  }

  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || !allowedHosts.has(host)) {
    violations.push(`${company}: ${job?.id || '(missing id)'} points to non-official host ${host || '(missing host)'}`);
  }
}

if (violations.length) {
  for (const violation of violations) console.error(`Priority-source violation: ${violation}`);
  throw new Error(`Blocked ${violations.length} priority-employer job(s) that were not linked directly to an approved employer career host.`);
}

const represented = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
const representedCompanies = represented.length;
const priorityJobs = represented.reduce((sum, [, count]) => sum + count, 0);

// Do not require every operator to have a live opening every day; hiring can
// legitimately reach zero. A broad collapse, however, should not pass silently.
if (representedCompanies < 6) {
  throw new Error(`Priority-employer coverage collapsed to ${representedCompanies} represented operators; expected at least 6 before deployment.`);
}

console.log(`Priority employer source guard passed: ${priorityJobs} jobs from ${representedCompanies}/${officialHostsByCompany.size} priority operators use employer-direct career URLs.`);
for (const [company, count] of represented) console.log(`  ${company}: ${count}`);
