import fs from 'node:fs/promises';

const JOBS_PATH = new URL('../data/jobs.json', import.meta.url);
const API_BASE = 'https://api.buttondown.com/v1';
const API_VERSION = '2026-04-01';
const WINDOW_DAYS = 7;
const MAX_EARLY = 12;
const MAX_OTHER = 12;
const SITE_BASE = 'https://datacentercareers.us';
const EARLY_TYPES = new Set(['internship', 'apprenticeship', 'trainee']);
const EARLY_EXPERIENCE = new Set(['no-experience', '0-2-years']);

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const schedule = args.has('--schedule');
const testSelection = args.has('--test-selection');
if ([dryRun, schedule, testSelection].filter(Boolean).length > 1) {
  throw new Error('Choose only one of --dry-run, --schedule or --test-selection.');
}

const asTime = value => {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? time : 0;
};

const jobSeenTime = job => asTime(job.firstSeenAt) || asTime(job.postedAt);
const isEarlyCareer = job => EARLY_TYPES.has(job.type) || EARLY_EXPERIENCE.has(job.experience);
const isPublishable = job => job?.active === true && job?.demo !== true && /^https:\/\//i.test(String(job?.sourceUrl || ''));
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const slugify = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'job';
const jobSlug = job => `${slugify(job.title)}-${slugify(job.company).slice(0, 32)}-${String(job.id || '').replace(/[^a-zA-Z0-9]/g,'').slice(-10)}`;
const escapeMd = value => clean(value).replace(/([\\[\]*_`])/g, '\\$1');

function trackedSiteUrl(path, content = '') {
  const url = new URL(path, `${SITE_BASE}/`);
  url.searchParams.set('utm_source', 'weekly-email');
  url.searchParams.set('utm_medium', 'email');
  url.searchParams.set('utm_campaign', 'weekly-job-alerts');
  if (content) url.searchParams.set('utm_content', content);
  return url.toString();
}

function jobDetailUrl(job) {
  return trackedSiteUrl(`/jobs/${jobSlug(job)}/`, clean(job.id) || jobSlug(job));
}

function rankJobs(a, b) {
  const earlyDelta = Number(isEarlyCareer(b)) - Number(isEarlyCareer(a));
  if (earlyDelta) return earlyDelta;
  const timeDelta = jobSeenTime(b) - jobSeenTime(a);
  if (timeDelta) return timeDelta;
  return clean(a.company).localeCompare(clean(b.company)) || clean(a.title).localeCompare(clean(b.title));
}

function uniqueJobs(jobs) {
  const seen = new Set();
  return jobs.filter(job => {
    const key = clean(job.id) || `${clean(job.company)}|${clean(job.title)}|${clean(job.location)}|${clean(job.sourceUrl)}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function selectNewJobs(jobs, nowMs) {
  const cutoff = nowMs - WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const futureTolerance = nowMs + 60 * 60 * 1000;
  return uniqueJobs(jobs)
    .filter(isPublishable)
    .filter(job => {
      const seen = jobSeenTime(job);
      return seen >= cutoff && seen <= futureTolerance;
    })
    .sort(rankJobs);
}

// Keep the digest useful when one large employer posts many roles at once.
// The input is already relevance-ranked, so preserve that ordering inside
// each employer bucket and round-robin across employers until the slot limit
// is filled. If only one employer has inventory, every available slot can
// still be used.
function diversifyJobs(jobs, limit) {
  const max = Math.max(0, Number(limit) || 0);
  if (!max || !jobs.length) return [];

  const buckets = new Map();
  for (const job of jobs) {
    const employer = clean(job?.company).toLowerCase() || 'unknown employer';
    if (!buckets.has(employer)) buckets.set(employer, []);
    buckets.get(employer).push(job);
  }

  const queues = [...buckets.values()];
  const selected = [];
  let round = 0;
  while (selected.length < max) {
    let added = 0;
    for (const queue of queues) {
      const job = queue[round];
      if (!job) continue;
      selected.push(job);
      added += 1;
      if (selected.length >= max) break;
    }
    if (!added) break;
    round += 1;
  }
  return selected;
}

function runSelectionTests() {
  const fixture = [
    { id:'aws-1', company:'AWS' },
    { id:'aws-2', company:'AWS' },
    { id:'aws-3', company:'AWS' },
    { id:'core-1', company:'CoreSite' },
    { id:'core-2', company:'CoreSite' },
    { id:'meta-1', company:'Meta' }
  ];
  const diversified = diversifyJobs(fixture, 5).map(job => job.id);
  const expected = ['aws-1', 'core-1', 'meta-1', 'aws-2', 'core-2'];
  if (JSON.stringify(diversified) !== JSON.stringify(expected)) {
    throw new Error(`Employer-diverse selection regression: expected ${expected.join(', ')}, got ${diversified.join(', ')}`);
  }

  const singleEmployer = diversifyJobs(fixture.slice(0, 3), 2).map(job => job.id);
  if (singleEmployer.join(',') !== 'aws-1,aws-2') {
    throw new Error(`Single-employer fallback regression: got ${singleEmployer.join(', ')}`);
  }

  const normalizedEmployer = diversifyJobs([
    { id:'a', company:'AWS' },
    { id:'b', company:'aws' },
    { id:'c', company:'Meta' }
  ], 3).map(job => job.id);
  if (normalizedEmployer.join(',') !== 'a,c,b') {
    throw new Error(`Employer normalization regression: got ${normalizedEmployer.join(', ')}`);
  }

  if (diversifyJobs(fixture, 0).length !== 0) {
    throw new Error('Zero-slot employer-diverse selection must return no jobs.');
  }

  const nowMs = Date.parse('2026-09-18T16:00:00.000Z');
  const common = { company:'Test', title:'Technician', location:'Dallas, TX', active:true, demo:false, sourceUrl:'https://example.com/job', type:'entry-level', experience:'2-5-years' };
  const selected = selectNewJobs([
    { ...common, id:'recent-first-seen', firstSeenAt:'2026-09-18T15:00:00.000Z', postedAt:'2026-08-01T00:00:00.000Z' },
    { ...common, id:'posted-fallback', postedAt:'2026-09-17T12:00:00.000Z' },
    { ...common, id:'future', firstSeenAt:'2026-09-18T18:00:00.000Z' },
    { ...common, id:'stale', firstSeenAt:'2026-09-10T15:59:59.000Z' },
    { ...common, id:'inactive', active:false, firstSeenAt:'2026-09-18T14:00:00.000Z' },
    { ...common, id:'demo', demo:true, firstSeenAt:'2026-09-18T13:00:00.000Z' },
    { ...common, id:'bad-url', sourceUrl:'http://example.com/job', firstSeenAt:'2026-09-18T12:00:00.000Z' }
  ], nowMs).map(job => job.id);
  const expectedSelected = ['recent-first-seen', 'posted-fallback'];
  if (JSON.stringify(selected) !== JSON.stringify(expectedSelected)) {
    throw new Error(`Seven-day alert-window regression: expected ${expectedSelected.join(', ')}, got ${selected.join(', ')}`);
  }

  console.log('Weekly alert employer-diverse selection passed 4 regression cases.');
  console.log('Weekly alert seven-day-window selection passed.');
}

function formatJob(job) {
  const title = escapeMd(job.title);
  const company = escapeMd(job.company);
  const location = escapeMd(job.location);
  const pay = clean(job.pay) ? ` · ${escapeMd(job.pay)}` : '';
  return `- **[${title}](${jobDetailUrl(job)})** — ${company} · ${location}${pay}`;
}

function listBlock(jobs, emptyMessage) {
  const browseUrl = trackedSiteUrl('/jobs/', 'browse-all');
  if (!jobs.length) return `${emptyMessage}\n\n[Browse current openings](${browseUrl})`;
  return `${jobs.map(formatJob).join('\n')}\n\n[Browse all current openings](${browseUrl})`;
}

function buildBody(newJobs) {
  const earlyJobs = diversifyJobs(newJobs.filter(isEarlyCareer), MAX_EARLY);
  const otherJobs = diversifyJobs(newJobs.filter(job => !isEarlyCareer(job)), MAX_OTHER);

  return [
    '<!-- buttondown-editor-mode: plaintext -->',
    '# This week in data center careers',
    '',
    'These are employer-direct openings added to Data Center Careers during the last seven days. Internships, apprenticeships and beginner-friendly roles come first.',
    '',
    '### Start here: early-career openings',
    listBlock(earlyJobs, 'No new internships, apprenticeships or beginner-friendly openings were added during the last seven days.'),
    '',
    '### More openings for workers with up to 5 years of experience',
    listBlock(otherJobs, 'No additional 0–5 year openings were added during the last seven days.'),
    '',
    '[Manage your subscription or unsubscribe]({{ manage_subscription_url }})',
    '',
    `Data Center Careers · [datacentercareers.us](${trackedSiteUrl('/', 'footer-home')})`
  ].join('\n');
}

function nextMonday1600Utc(now = new Date()) {
  const result = new Date(now);
  result.setUTCSeconds(0, 0);
  const day = result.getUTCDay();
  const daysUntilMonday = (8 - day) % 7;
  result.setUTCDate(result.getUTCDate() + daysUntilMonday);
  result.setUTCHours(16, 0, 0, 0);
  if (result.getTime() <= now.getTime() + 5 * 60 * 1000) result.setUTCDate(result.getUTCDate() + 7);
  return result;
}

function digestKeyFor(sendAt) {
  return `weekly-job-alert-${sendAt.toISOString().slice(0, 10)}`;
}

async function buttondownRequest(path, options = {}) {
  const apiKey = clean(process.env.BUTTONDOWN_API_KEY);
  if (!apiKey) throw new Error('BUTTONDOWN_API_KEY is required for --schedule.');
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'application/json',
      'X-API-Version': API_VERSION,
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!response.ok) throw new Error(`Buttondown ${options.method || 'GET'} ${path} failed (${response.status}): ${text.slice(0, 800)}`);
  return payload;
}

async function findExistingDigest(digestKey) {
  const publishDate = digestKey.match(/\d{4}-\d{2}-\d{2}$/)?.[0];
  if (!publishDate) throw new Error(`Invalid weekly digest key: ${digestKey}`);
  const params = new URLSearchParams({
    publish_date__start: publishDate,
    publish_date__end: publishDate,
    ordering: '-creation_date'
  });
  let seen = 0;
  for (let page = 1; page <= 25; page += 1) {
    params.set('page', String(page));
    const payload = await buttondownRequest(`/emails?${params.toString()}`);
    const emails = Array.isArray(payload) ? payload : Array.isArray(payload?.results) ? payload.results : [];
    const existing = emails.find(email => email?.metadata?.dcc_digest_key === digestKey);
    if (existing) return existing;
    seen += emails.length;
    const total = Number(payload?.count);
    if (!emails.length || (Number.isFinite(total) && seen >= total)) return null;
  }
  throw new Error(`Buttondown email lookup exceeded 25 pages for ${publishDate}; refusing to risk a duplicate weekly alert.`);
}

async function main() {
  const raw = await fs.readFile(JOBS_PATH, 'utf8');
  const jobs = JSON.parse(raw);
  if (!Array.isArray(jobs)) throw new Error('data/jobs.json must contain an array.');

  const now = new Date();
  const newJobs = selectNewJobs(jobs, now.getTime());
  const earlyCount = newJobs.filter(isEarlyCareer).length;
  const body = buildBody(newJobs);

  if (body.includes('subscriber.metadata') || body.includes('subscriber.tags')) {
    throw new Error('Weekly alert must stay compatible with Buttondown free-tier subscribers.');
  }
  if (!body.includes(`${SITE_BASE}/jobs/`) || !body.includes('utm_source=weekly-email')) {
    throw new Error('Digest body is missing tracked Data Center Careers job links.');
  }
  const directEmployerLinks = newJobs.filter(job => body.includes(`](${job.sourceUrl})`));
  if (directEmployerLinks.length) {
    throw new Error(`Digest body bypasses the site for ${directEmployerLinks.length} job link(s).`);
  }

  console.log(JSON.stringify({ totalJobs: jobs.length, newJobs: newJobs.length, earlyCareerNewJobs: earlyCount }, null, 2));

  if (dryRun || !schedule) {
    console.log(`Weekly alert dry-run passed; generated ${body.length} characters of employer-diverse Markdown with early-career roles prioritized.`);
    return;
  }

  if (!newJobs.length) {
    console.log('No newly seen jobs in the seven-day window; no weekly email scheduled.');
    return;
  }

  const sendAt = nextMonday1600Utc(now);
  const digestKey = digestKeyFor(sendAt);
  const existing = await findExistingDigest(digestKey);
  if (existing) {
    console.log(`Weekly alert already exists for ${sendAt.toISOString()} (${existing.id}, ${existing.status}).`);
    return;
  }

  const subject = 'New data center openings this week';
  const payload = await buttondownRequest('/emails', {
    method: 'POST',
    body: JSON.stringify({
      subject,
      body,
      status: 'scheduled',
      publish_date: sendAt.toISOString(),
      description: 'Employer-direct weekly data center job alert from Data Center Careers.',
      metadata: {
        dcc_digest_key: digestKey,
        dcc_window_days: WINDOW_DAYS,
        dcc_new_job_count: newJobs.length,
        dcc_early_career_count: earlyCount
      }
    })
  });

  if (!payload?.id) throw new Error('Buttondown created the email without returning an id.');
  console.log(`Scheduled weekly job alert ${payload.id} for ${sendAt.toISOString()} with ${newJobs.length} new jobs.`);
}

if (testSelection) runSelectionTests();
else await main();