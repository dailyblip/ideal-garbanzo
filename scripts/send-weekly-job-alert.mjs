import fs from 'node:fs/promises';

const JOBS_PATH = new URL('../data/jobs.json', import.meta.url);
const API_BASE = 'https://api.buttondown.com/v1';
const API_VERSION = '2026-04-01';
const ALERT_TAG = 'weekly-job-alerts';
const WINDOW_DAYS = 7;
const MAX_ALL_US = 16;
const MAX_PER_REGION = 10;
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
if (dryRun && schedule) throw new Error('Choose either --dry-run or --schedule.');

const asTime = value => {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? time : 0;
};

const jobSeenTime = job => asTime(job.firstSeenAt) || asTime(job.postedAt);
const isEarlyCareer = job => EARLY_TYPES.has(job.type) || EARLY_EXPERIENCE.has(job.experience);
const isPublishable = job => job?.active === true && job?.demo !== true && /^https:\/\//i.test(String(job?.sourceUrl || ''));
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const escapeMd = value => clean(value).replace(/([\\[\]*_`])/g, '\\$1');

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

function formatJob(job) {
  const title = escapeMd(job.title);
  const company = escapeMd(job.company);
  const location = escapeMd(job.location);
  const pay = clean(job.pay) ? ` · ${escapeMd(job.pay)}` : '';
  const badge = isEarlyCareer(job) ? ' · Early-career fit' : '';
  return `- **[${title}](${job.sourceUrl})** — ${company} · ${location}${pay}${badge}`;
}

function listBlock(jobs, emptyMessage) {
  if (!jobs.length) return `${emptyMessage}\n\n[Browse current openings](https://datacentercareers.us/jobs/)`;
  return `${jobs.map(formatJob).join('\n')}\n\n[Browse all current openings](https://datacentercareers.us/jobs/)`;
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
  const allUs = newJobs.slice(0, MAX_ALL_US);
  const allUsEarly = newJobs.filter(isEarlyCareer).slice(0, MAX_ALL_US);
  const blocks = [];

  blocks.push('{% if not subscriber.metadata.region or subscriber.metadata.region == \'all\' %}');
  blocks.push(focusBlock(allUs, allUsEarly, 'New openings across the U.S.'));

  for (const [region, label] of REGION_LABELS) {
    const regional = newJobs.filter(job => job.region === region).slice(0, MAX_PER_REGION);
    const regionalEarly = newJobs.filter(job => job.region === region && isEarlyCareer(job)).slice(0, MAX_PER_REGION);
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
    'These are employer-direct openings added to Data Center Careers during the last seven days. We keep the list focused on internships, apprenticeships, skilled trades, critical facilities, operations and appropriate 0–5 year infrastructure roles.',
    '',
    blocks.join('\n\n'),
    '',
    'Want to change what you receive? Use your Buttondown subscriber portal to update your preferences or unsubscribe.',
    '',
    'Data Center Careers · [datacentercareers.us](https://datacentercareers.us/)'
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
  const params = new URLSearchParams({ page_size: '20' });
  params.set("metadata['dcc_digest_key']", digestKey);
  const payload = await buttondownRequest(`/emails?${params.toString()}`);
  const emails = Array.isArray(payload) ? payload : Array.isArray(payload?.results) ? payload.results : [];
  return emails.find(email => email?.metadata?.dcc_digest_key === digestKey) || null;
}

async function main() {
  const raw = await fs.readFile(JOBS_PATH, 'utf8');
  const jobs = JSON.parse(raw);
  if (!Array.isArray(jobs)) throw new Error('data/jobs.json must contain an array.');

  const now = new Date();
  const newJobs = selectNewJobs(jobs, now.getTime());
  const earlyCount = newJobs.filter(isEarlyCareer).length;
  const regionalCounts = Object.fromEntries([...REGION_LABELS.keys()].map(region => [region, newJobs.filter(job => job.region === region).length]));
  const body = buildBody(newJobs);

  if (!body.includes("subscriber.metadata.region") || !body.includes("subscriber.metadata.focus")) {
    throw new Error('Digest body lost subscriber preference templating.');
  }
  if (!body.includes('https://datacentercareers.us/jobs/')) throw new Error('Digest body is missing the jobs browse link.');

  console.log(JSON.stringify({ totalJobs: jobs.length, newJobs: newJobs.length, earlyCareerNewJobs: earlyCount, regionalCounts }, null, 2));

  if (dryRun || !schedule) {
    console.log(`Weekly alert dry-run passed; generated ${body.length} characters of personalized Markdown.`);
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

await main();
