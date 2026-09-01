import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const REPORT_PATH = 'data/qa-report.json';
const INDEX_PATH = 'index.html';
const CONCURRENCY = 10;
const TIMEOUT_MS = 15000;

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const lower = value => clean(value).toLowerCase();
const normalize = value => lower(value).replace(/&amp;/g, '&').replace(/[^a-z0-9]+/g, ' ').trim();

function normalizeTitle(title = '') {
  return normalize(title)
    .replace(/\b(?:remote|onsite|on site|hybrid)\b/g, ' ')
    .replace(/\b(?:phoenix|dallas|austin|irving|atlanta|memphis|sandusky|dalton|afton|ellendale|ashburn|manassas|suwanee)\s+(?:az|tx|ga|tn|oh|nd|va)?\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function reqId(url = '') {
  const value = String(url);
  const patterns = [
    /[?&](?:gh_jid|jobid|jobId|jid)=([A-Za-z0-9_-]+)/i,
    /\/jobs?\/(\d{6,})\b/i,
    /\b(R\d{4}-\d{3,})\b/i,
    /\b(JLL\d{5,})\b/i,
    /\b(JR\d{5,})\b/i,
    /\b([A-Z]\d{5,})\b/
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return match[1].toLowerCase();
  }
  return '';
}

function chooseBetter(a, b) {
  const score = job => {
    let value = 0;
    if (job.type === 'apprenticeship') value += 40;
    else if (job.type === 'internship') value += 35;
    else if (job.type === 'trainee') value += 30;
    if (job.experience === 'no-experience') value += 20;
    else if (job.experience === '0-2-years') value += 10;
    if (job.pay && job.pay !== 'Pay not listed') value += 2;
    if (job.postedAt) value += 1;
    return value;
  };
  return score(b) > score(a) ? b : a;
}

function dedupeJobs(jobs) {
  const kept = [];
  const byUrl = new Map();
  const byReq = new Map();
  const byIdentity = new Map();
  const duplicates = [];

  for (const job of jobs) {
    const url = clean(job.sourceUrl);
    const request = reqId(url);
    const identity = [normalize(job.company), normalizeTitle(job.title), normalize(job.location)].join('|');
    let priorIndex = -1;
    let reason = '';

    if (url && byUrl.has(url)) { priorIndex = byUrl.get(url); reason = 'same-url'; }
    else if (request && byReq.has(`${normalize(job.company)}|${request}`)) { priorIndex = byReq.get(`${normalize(job.company)}|${request}`); reason = 'same-requisition'; }
    else if (byIdentity.has(identity)) { priorIndex = byIdentity.get(identity); reason = 'same-company-title-location'; }

    if (priorIndex >= 0) {
      const prior = kept[priorIndex];
      const winner = chooseBetter(prior, job);
      duplicates.push({ reason, removedId: winner === prior ? job.id : prior.id, keptId: winner.id, company: job.company, title: job.title, location: job.location });
      kept[priorIndex] = winner;
      continue;
    }

    const index = kept.push(job) - 1;
    if (url) byUrl.set(url, index);
    if (request) byReq.set(`${normalize(job.company)}|${request}`, index);
    byIdentity.set(identity, index);
  }
  return { jobs: kept, duplicates };
}

async function checkUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; DataCenterCareersQA/1.0; +https://dailyblip.github.io/ideal-garbanzo/)',
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8'
      }
    });
    const status = response.status;
    if (status === 404 || status === 410) return { state: 'dead', status, finalUrl: response.url };
    if (status >= 200 && status < 400) return { state: 'ok', status, finalUrl: response.url };
    if ([401,403,405,429].includes(status)) return { state: 'blocked', status, finalUrl: response.url };
    if (status >= 500) return { state: 'transient', status, finalUrl: response.url };
    return { state: 'warning', status, finalUrl: response.url };
  } catch (error) {
    return { state: 'transient', status: null, error: error.name === 'AbortError' ? 'timeout' : String(error.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
  return results;
}

const originalJobs = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
const html = await readFile(INDEX_PATH, 'utf8');
if (!Array.isArray(originalJobs)) throw new Error('jobs.json must be an array');

const demoJobs = originalJobs.filter(job => job.demo === true);
const { jobs: dedupedJobs, duplicates } = dedupeJobs(originalJobs.filter(job => job.demo !== true));

const jobChecks = await mapLimit(dedupedJobs, CONCURRENCY, async job => ({
  id: job.id,
  company: job.company,
  title: job.title,
  url: job.sourceUrl,
  ...(await checkUrl(job.sourceUrl))
}));

const deadIds = new Set(jobChecks.filter(check => check.state === 'dead').map(check => check.id));
const finalJobs = dedupedJobs.filter(job => !deadIds.has(job.id));

const externalLinks = [...html.matchAll(/href=["'](https:\/\/[^"']+)["']/gi)].map(match => match[1]);
const eventLinks = [...new Set(externalLinks)];
const eventChecks = await mapLimit(eventLinks, Math.min(5, CONCURRENCY), async url => ({ url, ...(await checkUrl(url)) }));

const report = {
  checkedAt: new Date().toISOString(),
  jobsBefore: originalJobs.length,
  jobsAfter: finalJobs.length,
  demoJobsRemoved: demoJobs.map(job => ({ id: job.id, title: job.title })),
  duplicatesRemoved: duplicates,
  deadJobLinksRemoved: jobChecks.filter(check => check.state === 'dead'),
  blockedJobLinks: jobChecks.filter(check => check.state === 'blocked'),
  transientJobLinks: jobChecks.filter(check => check.state === 'transient'),
  warningJobLinks: jobChecks.filter(check => check.state === 'warning'),
  eventLinks: eventChecks
};

await writeFile(JOBS_PATH, JSON.stringify(finalJobs, null, 2) + '\n');
await writeFile(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');

console.log(`QA complete: ${originalJobs.length} -> ${finalJobs.length} jobs.`);
console.log(`Removed ${duplicates.length} duplicate(s), ${demoJobs.length} demo job(s), and ${deadIds.size} confirmed dead job link(s).`);
const eventDead = eventChecks.filter(check => check.state === 'dead');
if (eventDead.length) console.warn(`Confirmed dead event links: ${eventDead.map(item => item.url).join(' | ')}`);
const blocked = jobChecks.filter(check => check.state === 'blocked').length;
const transient = jobChecks.filter(check => check.state === 'transient').length;
if (blocked || transient) console.warn(`Non-destructive link warnings: ${blocked} blocked, ${transient} transient.`);
