import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const EVENTS_PATH = 'data/career-events.json';
const REPORT_PATH = 'data/qa-report.json';
const STATUS_PATH = 'data/collector-status.json';
const INDEX_PATH = 'index.html';
const CONCURRENCY = 10;
const TIMEOUT_MS = 15000;
const LIVE_BASE = 'https://dailyblip.github.io/ideal-garbanzo/';
const CRITICAL_SITE_URLS = [
  LIVE_BASE,
  `${LIVE_BASE}assets/styles.css`,
  `${LIVE_BASE}assets/app.js`,
  `${LIVE_BASE}hero.jpg`,
  `${LIVE_BASE}jobs/`,
  `${LIVE_BASE}apprenticeships/`,
  `${LIVE_BASE}internships/`,
  `${LIVE_BASE}entry-level/`,
  `${LIVE_BASE}career-events/`,
  `${LIVE_BASE}how-to-get-a-data-center-job/`,
  `${LIVE_BASE}how-to-get-a-data-center-internship/`,
  `${LIVE_BASE}assets/guides/data-center-career-guide-mentor.webp`,
  `${LIVE_BASE}assets/guides/data-center-internship-training.webp`
];

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const lower = value => clean(value).toLowerCase();
const normalize = value => lower(value).replace(/&amp;/g, '&').replace(/[^a-z0-9]+/g, ' ').trim();
const todayIso = () => new Date().toISOString().slice(0, 10);

function normalizeTitle(title = '') {
  return normalize(title)
    .replace(/^\d{2,5}\s+/, ' ')
    .replace(/\bcbqe\b/g, ' ')
    .replace(/\b(?:remote|onsite|on site|hybrid)\b/g, ' ')
    .replace(/\b(?:phoenix|dallas|austin|irving|atlanta|memphis|sandusky|dalton|afton|ellendale|ashburn|manassas|suwanee)\s+(?:az|tx|ga|tn|oh|nd|va)?\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const clearlyForeignLocationTerms = [
  'malaysia', 'india', 'japan', 'taiwan', 'germany', 'england', 'united kingdom', 'netherlands',
  'switzerland', 'ireland', 'canada', 'hong kong', 'china', 'singapore', 'australia', 'france',
  'spain', 'italy', 'poland', 'sweden', 'norway', 'denmark', 'belgium', 'austria', 'portugal',
  'brazil', 'mexico', 'south africa', 'united arab emirates',
  'montreal, quebec', 'toronto, on', 'frankfurt', 'amsterdam', 'bengaluru', 'noida',
  'navi mumbai', 'mumbai', 'osaka', 'taipei', 'cyberjaya', 'munich', 'zurich'
];

function clearlyOutsideUnitedStates(job) {
  const text = lower(`${job.location || ''} ${job.sourceUrl || ''}`);
  return clearlyForeignLocationTerms.some(term => text.includes(term));
}

function unresolvedLocation(job) {
  const location = clean(job?.location);
  if (!location) return true;
  return /^\d+\s+locations?$/i.test(location) || /^location not listed$/i.test(location) || /^multiple locations?$/i.test(location);
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
    if (!/^\s*\d{2,5}\s*[-–—]/.test(String(job.title || ''))) value += 4;
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
const originalEvents = JSON.parse(await readFile(EVENTS_PATH, 'utf8'));
const collectorStatus = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
const html = await readFile(INDEX_PATH, 'utf8');
if (!Array.isArray(originalJobs)) throw new Error('jobs.json must be an array');
if (!Array.isArray(originalEvents)) throw new Error('career-events.json must be an array');

const demoJobs = originalJobs.filter(job => job.demo === true);
const nonUsJobs = originalJobs.filter(job => job.demo !== true && clearlyOutsideUnitedStates(job));
const unresolvedLocationJobs = originalJobs.filter(job => job.demo !== true && !clearlyOutsideUnitedStates(job) && unresolvedLocation(job));
const eligibleJobs = originalJobs.filter(job => job.demo !== true && !clearlyOutsideUnitedStates(job) && !unresolvedLocation(job));
const { jobs: dedupedJobs, duplicates } = dedupeJobs(eligibleJobs);

const jobChecks = await mapLimit(dedupedJobs, CONCURRENCY, async job => ({
  id: job.id,
  company: job.company,
  title: job.title,
  url: job.sourceUrl,
  ...(await checkUrl(job.sourceUrl))
}));

const deadIds = new Set(jobChecks.filter(check => check.state === 'dead').map(check => check.id));
const finalJobs = dedupedJobs.filter(job => !deadIds.has(job.id));

const today = todayIso();
const expiredCareerEvents = originalEvents.filter(event => clean(event?.date) && clean(event.date) < today);
const upcomingCareerEvents = originalEvents.filter(event => !clean(event?.date) || clean(event.date) >= today);
const careerEventChecks = await mapLimit(upcomingCareerEvents, Math.min(5, CONCURRENCY), async event => ({
  id: event.id,
  name: event.name,
  date: event.date,
  url: event.url,
  ...(await checkUrl(event.url))
}));
const deadCareerEventIds = new Set(careerEventChecks.filter(check => check.state === 'dead').map(check => check.id));
const finalCareerEvents = upcomingCareerEvents.filter(event => !deadCareerEventIds.has(event.id));

const externalLinks = [...html.matchAll(/href=["'](https:\/\/[^"']+)["']/gi)].map(match => match[1]);
const homepageExternalUrls = [...new Set(externalLinks)];
const homepageExternalChecks = await mapLimit(homepageExternalUrls, Math.min(5, CONCURRENCY), async url => ({ url, ...(await checkUrl(url)) }));
const siteChecks = await mapLimit(CRITICAL_SITE_URLS, Math.min(5, CONCURRENCY), async url => ({ url, ...(await checkUrl(url)) }));

const checkedAt = new Date().toISOString();
const countBy = (items, key) => items.reduce((counts, item) => {
  const value = clean(item?.[key]);
  if (value) counts[value] = (counts[value] || 0) + 1;
  return counts;
}, {});

collectorStatus.jobs = finalJobs.length;
collectorStatus.countsByType = countBy(finalJobs, 'type');
collectorStatus.countsByExperience = countBy(finalJobs, 'experience');
collectorStatus.postQa = {
  checkedAt,
  publishedJobs: finalJobs.length,
  removedJobs: originalJobs.length - finalJobs.length,
  activeCareerEvents: finalCareerEvents.length
};
if (collectorStatus.locationNormalization && typeof collectorStatus.locationNormalization === 'object') {
  const jobsWithRegion = finalJobs.filter(job => clean(job.region));
  collectorStatus.locationNormalization.regionAssigned = jobsWithRegion.length;
  collectorStatus.locationNormalization.regionMissing = finalJobs.length - jobsWithRegion.length;
  collectorStatus.locationNormalization.countsByRegion = countBy(jobsWithRegion, 'region');
}

const report = {
  checkedAt,
  jobsBefore: originalJobs.length,
  jobsAfter: finalJobs.length,
  demoJobsRemoved: demoJobs.map(job => ({ id: job.id, title: job.title })),
  nonUsJobsRemoved: nonUsJobs.map(job => ({ id: job.id, company: job.company, title: job.title, location: job.location })),
  unresolvedLocationJobsRemoved: unresolvedLocationJobs.map(job => ({ id: job.id, company: job.company, title: job.title, location: job.location })),
  duplicatesRemoved: duplicates,
  deadJobLinksRemoved: jobChecks.filter(check => check.state === 'dead'),
  blockedJobLinks: jobChecks.filter(check => check.state === 'blocked'),
  transientJobLinks: jobChecks.filter(check => check.state === 'transient'),
  warningJobLinks: jobChecks.filter(check => check.state === 'warning'),
  careerEventsBefore: originalEvents.length,
  careerEventsAfter: finalCareerEvents.length,
  expiredCareerEventsRemoved: expiredCareerEvents.map(event => ({ id: event.id, name: event.name, date: event.date, url: event.url })),
  deadCareerEventLinksRemoved: careerEventChecks.filter(check => check.state === 'dead'),
  blockedCareerEventLinks: careerEventChecks.filter(check => check.state === 'blocked'),
  transientCareerEventLinks: careerEventChecks.filter(check => check.state === 'transient'),
  warningCareerEventLinks: careerEventChecks.filter(check => check.state === 'warning'),
  homepageExternalLinks: homepageExternalChecks,
  criticalSiteLinks: siteChecks
};

await writeFile(JOBS_PATH, JSON.stringify(finalJobs, null, 2) + '\n');
await writeFile(EVENTS_PATH, JSON.stringify(finalCareerEvents, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(collectorStatus, null, 2) + '\n');
await writeFile(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');

console.log(`QA complete: ${originalJobs.length} -> ${finalJobs.length} jobs; ${originalEvents.length} -> ${finalCareerEvents.length} career events.`);
console.log(`Removed ${duplicates.length} duplicate(s), ${demoJobs.length} demo job(s), ${nonUsJobs.length} clearly non-US job(s), ${unresolvedLocationJobs.length} unresolved-location job(s), and ${deadIds.size} confirmed dead job link(s).`);
console.log(`Removed ${expiredCareerEvents.length} expired career event(s) and ${deadCareerEventIds.size} event(s) with confirmed dead organizer links.`);
const eventWarnings = careerEventChecks.filter(check => check.state !== 'ok' && check.state !== 'dead');
if (eventWarnings.length) console.warn(`Career event link warnings: ${eventWarnings.map(item => `${item.status ?? item.state} ${item.url}`).join(' | ')}`);
const siteProblems = siteChecks.filter(check => check.state !== 'ok');
if (siteProblems.length) console.warn(`Critical site link warnings: ${siteProblems.map(item => `${item.status ?? item.state} ${item.url}`).join(' | ')}`);
const blocked = jobChecks.filter(check => check.state === 'blocked').length;
const transient = jobChecks.filter(check => check.state === 'transient').length;
if (blocked || transient) console.warn(`Non-destructive job link warnings: ${blocked} blocked, ${transient} transient.`);
