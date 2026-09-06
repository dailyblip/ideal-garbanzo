import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const MAX_FETCHES = 220;
const CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 10000;

const officialHosts = new Map([
  ['Amazon Web Services', new Set(['amazon.jobs', 'www.amazon.jobs'])],
  ['Google', new Set(['www.google.com'])],
  ['Microsoft', new Set(['apply.careers.microsoft.com'])],
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

const clean = value => String(value ?? '')
  .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
  .replace(/<script\b(?![^>]*application\/ld\+json)[\s\S]*?<\/script>/gi, ' ')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;|&#160;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&ndash;|&#8211;/gi, '–')
  .replace(/&mdash;|&#8212;/gi, '—')
  .replace(/\s+/g, ' ')
  .trim();

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

function missingPayLabel(value) {
  const text = String(value || '').trim();
  return !text || /^(?:pay|salary|compensation)\s+not\s+(?:listed|provided|available)$/i.test(text);
}

function officialUrl(job) {
  const hosts = officialHosts.get(String(job?.company || '').trim());
  if (!hosts) return '';
  try {
    const parsed = new URL(String(job?.sourceUrl || ''));
    return parsed.protocol === 'https:' && hosts.has(parsed.hostname.toLowerCase()) ? parsed.href : '';
  } catch { return ''; }
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5',
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': 'Mozilla/5.0 (compatible; DataCenterCareers/1.0; +https://datacentercareers.us/)'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.text();
}

function numberValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const parsed = Number(value.replace(/[$,\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function salaryUnit(value) {
  const text = String(value || '').trim();
  if (/hour|hr/i.test(text)) return 'HOUR';
  if (/year|yr|annual/i.test(text)) return 'YEAR';
  return '';
}

function plausible(value, unit) {
  if (!Number.isFinite(value) || value <= 0) return false;
  if (unit === 'HOUR') return value >= 7 && value <= 500;
  if (unit === 'YEAR') return value >= 10000 && value <= 1000000;
  return false;
}

function formatMoney(value, unit) {
  const options = unit === 'YEAR'
    ? { maximumFractionDigits: 0 }
    : { minimumFractionDigits: 0, maximumFractionDigits: 2 };
  return `$${value.toLocaleString('en-US', options)}`;
}

function payRecord(minimum, maximum, unit, source) {
  let min = numberValue(minimum);
  let max = numberValue(maximum);
  if (min == null && max == null) return null;
  if (min == null) min = max;
  if (max == null) max = min;
  if (!unit) {
    if (min >= 10000 && max >= 10000) unit = 'YEAR';
    else if (min <= 500 && max <= 500) unit = 'HOUR';
  }
  if (!plausible(min, unit) || !plausible(max, unit)) return null;
  if (min > max) [min, max] = [max, min];
  const suffix = unit === 'HOUR' ? ' / hour' : ' / year';
  return {
    pay: min === max ? `${formatMoney(min, unit)}${suffix}` : `${formatMoney(min, unit)}–${formatMoney(max, unit)}${suffix}`,
    salaryMin: min,
    salaryMax: max,
    salarySortMax: unit === 'HOUR' ? Math.round(max * 2080) : max,
    paySource: source
  };
}

function findJobPostingObjects(node, out = [], seen = new Set(), depth = 0) {
  if (!node || typeof node !== 'object' || seen.has(node) || depth > 16) return out;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) findJobPostingObjects(item, out, seen, depth + 1);
    return out;
  }
  const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
  if (types.some(type => /JobPosting/i.test(String(type || '')))) out.push(node);
  for (const value of Object.values(node)) findJobPostingObjects(value, out, seen, depth + 1);
  return out;
}

function jobPostings(html) {
  const postings = [];
  for (const match of String(html || '').matchAll(/<script\b[^>]*type=["']application\/ld\+json[^"']*["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { findJobPostingObjects(JSON.parse(match[1] || ''), postings); } catch {}
  }
  return postings;
}

function salaryFromNode(node) {
  for (const item of Array.isArray(node) ? node : [node]) {
    if (!item || typeof item !== 'object') continue;
    const currency = String(item.currency || item.value?.currency || '').trim().toUpperCase();
    if (currency && currency !== 'USD') continue;
    const value = item.value && typeof item.value === 'object' ? item.value : item;
    const unit = salaryUnit(value.unitText || value.unitCode || item.unitText || item.unitCode);
    const min = value.minValue ?? item.minValue ?? value.value ?? item.value;
    const max = value.maxValue ?? item.maxValue ?? value.value ?? item.value;
    const record = payRecord(min, max, unit, 'jobposting-jsonld');
    if (record) return record;
  }
  return null;
}

function payFromJsonLd(html) {
  for (const posting of jobPostings(html)) {
    for (const field of ['baseSalary', 'estimatedSalary']) {
      const record = salaryFromNode(posting?.[field]);
      if (record) return record;
    }
  }
  return null;
}

function payFromText(html) {
  const text = clean(html);
  const patterns = [
    /(?:base\s+(?:pay|salary)|salary\s+range|pay\s+range|compensation(?:\s+range)?)[^$]{0,180}\$([\d,]+(?:\.\d{1,2})?)\s*(?:-|–|—|to)\s*\$([\d,]+(?:\.\d{1,2})?)(?:\s*(?:\/|per|a)\s*(year|yr|hour|hr))?/i,
    /\$([\d,]+(?:\.\d{1,2})?)\s*(?:-|–|—|to)\s*\$([\d,]+(?:\.\d{1,2})?)\s*(?:\/|per|a)\s*(year|yr|hour|hr)/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const record = payRecord(match[1], match[2], salaryUnit(match[3]), 'employer-page-text');
    if (record) return record;
  }
  return null;
}

function extractPay(html) {
  return payFromJsonLd(html) || payFromText(html);
}

async function mapPool(items, worker, concurrency) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  }));
}

const jobs = await readJson(JOBS_PATH, []);
const status = await readJson(STATUS_PATH, {});
if (!Array.isArray(jobs)) throw new Error(`${JOBS_PATH} must contain an array.`);

let blankLabelsCleared = 0;
for (const job of jobs) {
  if (/^(?:pay|salary|compensation)\s+not\s+(?:listed|provided|available)$/i.test(String(job?.pay || '').trim())) {
    job.pay = '';
    job.salaryMin = null;
    job.salaryMax = null;
    job.salarySortMax = null;
    blankLabelsCleared += 1;
  }
}

const candidates = jobs
  .filter(job => officialHosts.has(String(job?.company || '').trim()) && officialUrl(job) && missingPayLabel(job?.pay))
  .sort((a, b) => (a.postedHours ?? 9999) - (b.postedHours ?? 9999))
  .slice(0, MAX_FETCHES);

const report = {
  checkedAt: new Date().toISOString(),
  candidates: candidates.length,
  fetched: 0,
  payRecovered: 0,
  jsonLdRecovered: 0,
  textRecovered: 0,
  blankLabelsCleared,
  changedRecords: blankLabelsCleared,
  byCompany: {},
  samples: [],
  errors: []
};

await mapPool(candidates, async job => {
  const company = String(job.company || '').trim();
  const companyReport = report.byCompany[company] ||= { candidates: 0, fetched: 0, recovered: 0, errors: 0 };
  companyReport.candidates += 1;
  try {
    const html = await fetchText(officialUrl(job));
    report.fetched += 1;
    companyReport.fetched += 1;
    const record = extractPay(html);
    if (!record) return;
    job.pay = record.pay;
    job.salaryMin = record.salaryMin;
    job.salaryMax = record.salaryMax;
    job.salarySortMax = record.salarySortMax;
    report.payRecovered += 1;
    report.changedRecords += 1;
    companyReport.recovered += 1;
    if (record.paySource === 'jobposting-jsonld') report.jsonLdRecovered += 1;
    else report.textRecovered += 1;
    if (report.samples.length < 12) report.samples.push({ company, title: job.title, pay: record.pay, source: record.paySource });
  } catch (error) {
    companyReport.errors += 1;
    if (report.errors.length < 20) report.errors.push(`${company}: ${job.id || job.title}: ${error.message}`);
  }
}, CONCURRENCY);

status.priorityPayEnrichment = report;
status.updatedAt = report.checkedAt;
await writeFile(JOBS_PATH, `${JSON.stringify(jobs, null, 2)}\n`);
await writeFile(STATUS_PATH, `${JSON.stringify(status, null, 2)}\n`);

console.log(`Priority pay enrichment checked ${report.candidates} employer-direct role(s), fetched ${report.fetched}, recovered ${report.payRecovered} pay range(s), and cleared ${report.blankLabelsCleared} placeholder label(s).`);
for (const [company, counts] of Object.entries(report.byCompany).sort(([a], [b]) => a.localeCompare(b))) {
  console.log(`  ${company}: ${counts.recovered}/${counts.fetched} recovered from ${counts.candidates} candidate(s); ${counts.errors} fetch error(s).`);
}
