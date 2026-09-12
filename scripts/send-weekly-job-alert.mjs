import fs from 'node:fs/promises';

const JOBS_PATH = new URL('../data/jobs.json', import.meta.url);
const API_BASE = 'https://api.buttondown.com/v1';
const API_VERSION = '2026-04-01';
const ALERT_TAG = 'weekly-job-alerts';
const WINDOW_DAYS = 7;
const MAX_ALL_US = 16;
const MAX_PER_REGION = 10;
const SITE_BASE = 'https://datacentercareers.us';
const EARLY_TYPES = new Set(['internship', 'apprenticeship', 'trainee']);
const EARLY_EXPERIENCE = new Set(['no-experience', '0-2-years']);
const REGION_LABELS = new Map([
  ['mid-atlantic', 'Northern Virginia / Mid-Atlantic'],
  ['texas', 'Texas'],
  ['southwest', 'Southwest'],
  ['midwest', 'Midwest'],
  ['southeast', 'Southeast'],
  ['northeast', 'Northeast'],
  ['west', 'West']
]);

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
const jobSlug = job => `${slugify(job.title)}-${slugify(job.company).slice(0, 32)}-${String(job.id || '').replace(/[^a-zA-Z0-9]/g, '').slice(-10)}`;
const escapeMd = value => clean(value).replace(/([\\[\]*_`])/g, '\\$1');
const ALERT_REGION_TERMS = {
  'mid-atlantic':['district of columbia','delaware','maryland','virginia','west virginia',', dc',', de',', md',', va',', wv','ashburn','manassas'],
  texas:['texas',', tx','dallas','austin','fort worth','san antonio','houston'],
  southwest:['arizona','new mexico','nevada','oklahoma',', az',', nm',', nv',', ok','phoenix','mesa'],
  midwest:['illinois','indiana','iowa','kansas','michigan','minnesota','missouri','nebraska','north dakota','ohio','south dakota','wisconsin',', il',', in',', ia',', ks',', mi',', mn',', mo',', ne',', nd',', oh',', sd',', wi'],
  southeast:['alabama','arkansas','florida','georgia','kentucky','louisiana','mississippi','north carolina','south carolina','tennessee',', al',', ar',', fl',', ga',', ky',', la',', ms',', nc',', sc',', tn'],
  northeast:['connecticut','maine','massachusetts','new hampshire','new jersey','new york','pennsylvania','rhode island','vermont',', ct',', me',', ma',', nh',', nj',', ny',', pa',', ri',', vt'],
  west:['alaska','california','colorado','hawaii','idaho','montana','oregon','utah','washington','wyoming',', ak',', ca',', co',', hi',', id',', mt',', or',', ut',', wa',', wy']
};

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

function alertLocationMatchesRegion(location, region) {
  const value = clean(location).toLowerCase();
  if (/^(?:united states|usa|us)$/.test(value)) return true;
  if (value.includes('washington, dc') || value.includes('washington, d.c.')) return region === 'mid-atlantic';
  return (ALERT_REGION_TERMS[region] || []).some(term => value.includes(term));
}

function alertJobMatchesRegion(job, region) {
  if (!region) return true;
  if (job?.region === 'nationwide') return true;
  if (Array.isArray(job?.regions) && job.regions.includes(region)) return true;
  if (job?.region === region) return true;
  const location = clean(job?.location);
  if (!job?.region || location.includes(';')) return alertLocationMatchesRegion(location, region);
  return false;
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

  console.log('Weekly alert employer-diverse selection passed 4 regression cases.');
}

function formatJob(job) {
  const title = escapeMd(job.title);
  const company = escapeMd(job.company);
  const location = escapeMd(job.location);
  const pay = clean(job.pay) ? ` · ${escapeMd(job.pay)}` : '';
  const badge = isEarlyCareer(job) ? ' · Early-career fit' : '';
  return `- **[${title}](${jobDetailUrl(job)})** — ${company} · ${location}${pay}${badge}`;
}

function listBlock(jobs, emptyMessage) {
  const browseUrl = trackedSiteUrl('/jobs/', 'browse-all');
  if (!jobs.length) return `${emptyMessage}\n\n[Browse current openings](${browseUrl})`;
  return `${jobs.map(formatJob).join('\n')}\n\n[Browse all current openings](${browseUrl})`;
}

function focusBlock(allJobs, earlyJobs, label) {
  return [
    `{% if subscriber.metadata.focus == 'early-career' %}`,
    `### ${label}`,
    listBlock(earlyJobs, 'No new internships, apprenticeships or beginner-friendly openings were added in this area during the last seven days.'),
    '{% else %}',
    `### ${label}`,
    listBlock(allJobs, 'No new mission-fit openings were added in this area during the last seven days.'),
    '{% endif %}'
  ].join('\n\n');
}

function buildBody(newJobs) {
  const allUs = diversifyJobs(newJobs, MAX_ALL_US);
  const allUsEarly = diversifyJobs(newJobs.filter(isEarlyCareer), MAX_ALL_US);
  const blocks = [];

  blocks.push('{% if not subscriber.metadata.region or subscriber.metadata.region == \'all\' %}');
  blocks.push(focusBlock(allUs, allUsEarly, 'New openings across the U.S.'));

  for (const [region, label] of REGION_LABELS) {
    const regionalCandidates = newJobs.filter(job => alertJobMatchesRegion(job, region));
    const regionalEarlyCandidates = regionalCandidates.filter(isEarlyCareer);
    const regional = diversifyJobs(regionalCandidates, MAX_PER_REGION);
    const regionalEarly = diversifyJobs(regionalEarlyCandidates, MAX_PER_REGION);
    blocks.push(`{% elif subscriber.metadata.region == '${region}' %}`);
    blocks.push(focusBlock(regional, regionalEarly, `New openings: ${label}`));
  }

  blocks.push('{% else %}');
  blocks.push(focusBlock(allUs, allUsEarly, 'New openings across the U.S.'));
  blocks.push('{% endif %}');

  return [
    '<!-- buttondown-editor-mode: plaintext -->',
    '# This week in data center careers',
    '',
    'These are employer-direct openings added to Data Center Careers during the last seven days. Open a role to see its details, then continue to the verified employer career page to apply.',
    '',
    blocks.join('\n\n'),
    '',
    'Want to change what you receive? Use your Buttondown subscriber portal to update your preferences or unsubscribe.',
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
  // Buttondown supports metadata filtering on subscribers, not on /emails.
  // Narrow the email list to the target publish date using supported filters,
  // then compare our idempotency key client-side so a retry cannot double-send.
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
  const regionalCounts = Object.fromEntries([...REGION_LABELS.keys()].map(region => [region, newJobs.filter(job => alertJobMatchesRegion(job, region)).length]));
  const body = buildBody(newJobs);

  if (!body.includes("subscriber.metadata.region") || !body.includes("subscriber.metadata.focus")) {
    throw new Error('Digest body lost subscriber preference templating.');
  }
  if (!body.includes(`${SITE_BASE}/jobs/`) || !body.includes('utm_source=weekly-email')) {
    throw new Error('Digest body is missing tracked Data Center Careers job links.');
  }
  const directEmployerLinks = newJobs.filter(job => body.includes(`](${job.sourceUrl})`));
  if (directEmployerLinks.length) {
    throw new Error(`Digest body bypasses the site for ${directEmployerLinks.length} job link(s).`);
  }

  console.log(JSON.stringify({ totalJobs: jobs.length, newJobs: newJobs.length, earlyCareerNewJobs: earlyCount, regionalCounts }, null, 2));

  if (dryRun || !schedule) {
    console.log(`Weekly alert dry-run passed; generated ${body.length} characters of personalized Markdown with tracked site links.`);
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

  const subject = `${newJobs.length} new data center openings this week`;
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
      },
      filters: {
        filters: [{ field: 'subscriber.tags', operator: 'contains', value: ALERT_TAG }],
        groups: [],
        predicate: 'and'
      }
    })
  });

  if (!payload?.id) throw new Error('Buttondown created the email without returning an id.');
  console.log(`Scheduled weekly job alert ${payload.id} for ${sendAt.toISOString()} with ${newJobs.length} new jobs.`);
}

if (testSelection) runSelectionTests();
else await main();