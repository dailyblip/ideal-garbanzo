import { readFile } from 'node:fs/promises';

const SITE_URL = 'https://dailyblip.github.io/ideal-garbanzo';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_JOBS = 50;
const REGION_LABELS = {
  'mid-atlantic': 'Northern Virginia / Mid-Atlantic',
  texas: 'Texas',
  southwest: 'Southwest',
  midwest: 'Midwest',
  southeast: 'Southeast',
  northeast: 'Northeast',
  west: 'West'
};
const TYPE_RANK = { apprenticeship: 0, internship: 1, trainee: 2, 'entry-level': 3 };
const PROMOTION_RANK = { spotlightJob: 0, highlightedJob: 1 };

const jobs = JSON.parse(await readFile('data/jobs.json', 'utf8'));
const promotions = JSON.parse(await readFile('data/featured-jobs.json', 'utf8'));
const config = JSON.parse(await readFile('data/mailing-list.json', 'utf8'));
const dryRun = String(process.env.DRY_RUN || '').toLowerCase() === 'true';

if (config.provider !== 'buttondown') throw new Error(`Unsupported mailing-list provider: ${config.provider}`);
if (!config.enabled && !dryRun) {
  console.log('Weekly mailing list is not enabled yet; skipping send.');
  process.exit(0);
}

const now = Date.now();
const cutoff = now - WEEK_MS;
const futureGrace = 6 * 60 * 60 * 1000;
const activePaidPromotions = new Map();
for (const record of Array.isArray(promotions) ? promotions : []) {
  if (!record?.jobId || record.example === true) continue;
  const starts = record.startsAt ? Date.parse(record.startsAt) : null;
  const expires = record.expiresAt ? Date.parse(record.expiresAt) : null;
  if (starts && starts > now) continue;
  if (expires && expires <= now) continue;
  activePaidPromotions.set(String(record.jobId), record.tier);
}

const inWeeklyWindow = value => {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) && parsed >= cutoff && parsed <= now + futureGrace;
};

const isNewThisWeek = job => {
  // firstSeenAt is stamped from persistent discovery history after each refresh.
  // This captures jobs that are genuinely new to this site even when the employer
  // posting itself is older than seven days. postedAt/postedHours remain fallbacks
  // for the transition period before discovery history has been initialized.
  if (job?.firstSeenAt) return inWeeklyWindow(job.firstSeenAt);
  if (job?.postedAt) return inWeeklyWindow(job.postedAt);
  const hours = Number(job?.postedHours);
  return Number.isFinite(hours) && hours >= 0 && hours <= 168;
};

const slugify = value => String(value ?? '')
  .trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'job';
const jobSlug = job => `${slugify(job.title)}-${slugify(job.company).slice(0, 32)}-${String(job.id || '').replace(/[^a-zA-Z0-9]/g, '').slice(-10)}`;
const promotionRank = job => PROMOTION_RANK[activePaidPromotions.get(String(job.id))] ?? 9;
const experienceRank = job => ({ 'no-experience': 0, '0-2-years': 1, '2-5-years': 2 })[job.experience] ?? 3;
const discoverySort = job => {
  const firstSeen = Date.parse(job.firstSeenAt || '');
  if (Number.isFinite(firstSeen)) return firstSeen;
  const posted = Date.parse(job.postedAt || '');
  if (Number.isFinite(posted)) return posted;
  return now - Number(job.postedHours || 9999) * 3600000;
};

let weeklyJobs = jobs
  .filter(job => job?.active === true && !job.demo && isNewThisWeek(job))
  .sort((a, b) =>
    promotionRank(a) - promotionRank(b) ||
    (TYPE_RANK[a.type] ?? 9) - (TYPE_RANK[b.type] ?? 9) ||
    experienceRank(a) - experienceRank(b) ||
    discoverySort(b) - discoverySort(a)
  );

if (!weeklyJobs.length) {
  console.log('No jobs were newly added to the site in the last seven days; no weekly email sent.');
  process.exit(0);
}

const totalJobs = weeklyJobs.length;
weeklyJobs = weeklyJobs.slice(0, MAX_JOBS);
const grouped = new Map();
for (const job of weeklyJobs) {
  const region = REGION_LABELS[job.region] || 'Other / Nationwide';
  if (!grouped.has(region)) grouped.set(region, []);
  grouped.get(region).push(job);
}

const lines = [
  '# New data center jobs this week',
  '',
  `We added **${totalJobs} new ${totalJobs === 1 ? 'opportunity' : 'opportunities'}** to Data Center Careers over the last seven days.`,
  ''
];

for (const [region, regionJobs] of grouped) {
  lines.push(`## ${region}`, '');
  for (const job of regionJobs) {
    const tier = activePaidPromotions.get(String(job.id));
    const badge = tier === 'spotlightJob' ? ' **SPOTLIGHT**' : tier === 'highlightedJob' ? ' **HIGHLIGHTED**' : '';
    const detailsUrl = `${SITE_URL}/jobs/${jobSlug(job)}/`;
    const tags = Array.isArray(job.tags) && job.tags.length ? ` · ${job.tags.slice(0, 3).join(' · ')}` : '';
    const pay = job.pay && job.pay !== 'Pay not listed' ? ` · ${job.pay}` : '';
    lines.push(`- [**${job.title}**](${detailsUrl})${badge} — ${job.company} · ${job.location}${pay}${tags}`);
  }
  lines.push('');
}

if (totalJobs > MAX_JOBS) lines.push(`Plus ${totalJobs - MAX_JOBS} more newly added roles on the site.`, '');
lines.push(
  `[Browse all current data center jobs](${SITE_URL}/jobs/)`,
  '',
  'Data Center Careers focuses on internships, apprenticeships, trainee opportunities and appropriate early-to-mid-career infrastructure roles.',
  ''
);

const subject = `${totalJobs} new data center ${totalJobs === 1 ? 'job' : 'jobs'} this week`;
const body = lines.join('\n');

if (dryRun) {
  console.log(`DRY RUN: ${subject}\n\n${body}`);
  process.exit(0);
}

const apiKey = String(process.env.BUTTONDOWN_API_KEY || '').trim();
if (!apiKey) throw new Error('BUTTONDOWN_API_KEY GitHub Actions secret is required before weekly sending is enabled.');

const headers = {
  Authorization: `Token ${apiKey}`,
  'Content-Type': 'application/json',
  'X-Buttondown-Live-Dangerously': 'true'
};
const create = await fetch('https://api.buttondown.com/v1/emails', {
  method: 'POST',
  headers,
  body: JSON.stringify({ subject, body, status: 'draft' })
});
if (!create.ok) throw new Error(`Buttondown draft creation failed (${create.status}): ${await create.text()}`);
const email = await create.json();
if (!email?.id) throw new Error('Buttondown did not return an email ID.');

const publish = await fetch(`https://api.buttondown.com/v1/emails/${encodeURIComponent(email.id)}/publish`, {
  method: 'POST',
  headers,
  body: JSON.stringify({})
});
if (!publish.ok) throw new Error(`Buttondown publish failed (${publish.status}): ${await publish.text()}`);

console.log(`Sent Monday weekly digest ${email.id} with ${totalJobs} newly added jobs.`);
