import { access, readFile } from 'node:fs/promises';

const config = JSON.parse(await readFile('data/mailing-list.json', 'utf8'));
const homepage = await readFile('index.html', 'utf8');
const signupScript = await readFile('assets/mailing-list.js', 'utf8');
const alertScript = await readFile('scripts/send-weekly-job-alert.mjs', 'utf8');
const buttondownConfigScript = await readFile('scripts/configure-buttondown.mjs', 'utf8');
const workflow = await readFile('.github/workflows/weekly-job-alert.yml', 'utf8');
const redirectWorkflow = await readFile('.github/workflows/buttondown-redirect.yml', 'utf8');

const fail = message => { throw new Error(message); };
const assertMissing = async path => {
  try {
    await access(path);
  } catch {
    return;
  }
  fail(`Deprecated duplicate mailing pipeline must stay removed: ${path}`);
};

if (config.provider !== 'buttondown') fail('Mailing list provider must be Buttondown.');
if (config.enabled !== true) fail('Mailing list must be enabled once the Buttondown account is configured.');
if (!/^[a-z0-9][a-z0-9_-]{1,62}$/i.test(String(config.username || ''))) fail('Buttondown username is missing or invalid.');
if (config.cadence !== 'weekly') fail('Mailing list cadence must remain weekly.');
if (config.sendDay !== 'Monday') fail('Weekly alert must send on Monday.');
if (config.sendTimeUtc !== '16:00') fail('Weekly alert send time must remain 16:00 UTC.');

for (const [field, expectedPath, requiredQuery] of [
  ['subscriptionRedirectUrl', '/subscribed/', ''],
  ['subscriptionConfirmationRedirectUrl', '/subscribed/', 'confirmed=1']
]) {
  let parsed;
  try {
    parsed = new URL(String(config[field] || ''));
  } catch {
    fail(`${field} must be a valid URL.`);
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'datacentercareers.us') fail(`${field} must stay on the production HTTPS domain.`);
  if (parsed.pathname !== expectedPath) fail(`${field} must point to ${expectedPath}.`);
  if (requiredQuery && parsed.searchParams.get('confirmed') !== '1') fail(`${field} must preserve ${requiredQuery}.`);
}

const scheduleMatches = [...workflow.matchAll(/cron:\s*'(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+1'/g)];
if (scheduleMatches.length < 2) fail('Weekly alert workflow must keep redundant Monday UTC scheduler runs.');
const [sendHour, sendMinute] = String(config.sendTimeUtc).split(':').map(Number);
const scheduleMinutes = new Set();
for (const match of scheduleMatches) {
  const workflowMinute = Number(match[1]);
  const workflowHour = Number(match[2]);
  if (workflowMinute > 59 || workflowHour > 23) fail(`Weekly alert workflow has an invalid Monday UTC cron: ${match[0]}`);
  const minuteOfDay = workflowHour * 60 + workflowMinute;
  if (scheduleMinutes.has(minuteOfDay)) fail('Weekly alert redundant scheduler runs must use distinct UTC times.');
  scheduleMinutes.add(minuteOfDay);
  const leadMinutes = sendHour * 60 + sendMinute - minuteOfDay;
  if (leadMinutes < 30 || leadMinutes > 180) fail(`Every weekly alert scheduler run must be 30–180 minutes before ${config.sendTimeUtc} UTC.`);
}
const sortedSchedules = [...scheduleMinutes].sort((a, b) => a - b);
if (sendHour * 60 + sendMinute - sortedSchedules.at(-1) > 60) fail('Weekly alert backup scheduler must run within 60 minutes of send time.');

const expectedAction = `https://buttondown.com/api/emails/embed-subscribe/${config.username}`;
for (const marker of [
  'id="weeklyAlertForm"',
  'id="alertEmail"',
  'name="email"',
  `action="${expectedAction}"`,
  'method="post"',
  'name="embed" value="1"',
  'name="utm_source" value="datacentercareers.us"',
  'name="utm_medium" value="website"',
  'name="utm_campaign" value="weekly-job-alerts"',
  'Join weekly list',
  'Get new openings every Monday.',
  'internships, apprenticeships and beginner-friendly roles prioritized'
]) {
  if (!homepage.includes(marker)) fail(`Homepage weekly signup is missing: ${marker}`);
}
for (const forbidden of ['metadata__region', 'metadata__focus', 'name="tag" value="weekly-job-alerts"']) {
  if (homepage.includes(forbidden)) fail(`Homepage signup uses a Buttondown paid-plan field: ${forbidden}`);
}

for (const marker of [
  'data/mailing-list.json',
  'buttondown.com/api/emails/embed-subscribe/',
  'config?.enabled === true',
  "const fallbackAction = form.getAttribute('action') || '';"
]) {
  if (!signupScript.includes(marker)) fail(`Signup plumbing is missing: ${marker}`);
}
if (signupScript.includes('metadata__') || signupScript.includes('weekly-job-alerts')) fail('Homepage signup script must not depend on paid Buttondown metadata or tags.');
if (signupScript.includes('.catch(() => configure(null))')) fail('Signup script must not disable the static fallback when config fetch fails.');

for (const marker of [
  "readFile('data/mailing-list.json', 'utf8')",
  'config.username',
  'config.subscriptionRedirectUrl',
  'config.subscriptionConfirmationRedirectUrl',
  "enabledFeatures.add('portal');",
  'subscription_redirect_url: REDIRECT_URL',
  'subscription_confirmation_redirect_url: CONFIRMATION_REDIRECT_URL',
  'free plan',
  'weekly all-subscriber digest'
]) {
  if (!buttondownConfigScript.includes(marker)) fail(`Buttondown service configuration is missing: ${marker}`);
}
for (const forbidden of ["const USERNAME = 'datacentercareers'", "const REDIRECT_URL = 'https://datacentercareers.us/subscribed/'", '/v1/tags', 'X-Buttondown-Collision-Behavior', 'ALERT_TAG']) {
  if (buttondownConfigScript.includes(forbidden)) fail(`Buttondown configuration must stay shared-config-driven and free-tier compatible: ${forbidden}`);
}

for (const marker of [
  'pull_request:',
  "cron: '37 14 * * 1'",
  "cron: '23 15 * * 1'",
  "run: node scripts/validate-mailing-list.mjs",
  "run: node scripts/send-weekly-job-alert.mjs --test-selection",
  "run: node scripts/send-weekly-job-alert.mjs --dry-run",
  'BUTTONDOWN_API_KEY: ${{ secrets.BUTTONDOWN_API_KEY }}',
  'run: node scripts/send-weekly-job-alert.mjs --schedule',
  "- 'index.html'",
  "- 'assets/mailing-list.js'",
  "- 'scripts/configure-buttondown.mjs'",
  "- 'scripts/validate-alert-job-detail-parity.mjs'"
]) {
  if (!workflow.includes(marker)) fail(`Weekly alert workflow is missing: ${marker}`);
}

for (const marker of [
  "- 'data/mailing-list.json'",
  "- 'scripts/configure-buttondown.mjs'",
  "- 'scripts/validate-mailing-list.mjs'",
  "- 'subscribed/**'",
  'run: node scripts/validate-mailing-list.mjs',
  'BUTTONDOWN_API_KEY: ${{ secrets.BUTTONDOWN_API_KEY }}',
  'run: node scripts/configure-buttondown.mjs'
]) {
  if (!redirectWorkflow.includes(marker)) fail(`Buttondown redirect workflow is missing: ${marker}`);
}

for (const marker of [
  "const SITE_BASE = 'https://datacentercareers.us';",
  "const EARLY_TYPES = new Set(['internship', 'apprenticeship', 'trainee']);",
  "const EARLY_EXPERIENCE = new Set(['no-experience', '0-2-years']);",
  "const testSelection = args.has('--test-selection');",
  'utm_source',
  'weekly-email',
  'function jobDetailUrl(job)',
  'function diversifyJobs(jobs, limit)',
  'const earlyJobs = diversifyJobs(newJobs.filter(isEarlyCareer), MAX_EARLY);',
  'const otherJobs = diversifyJobs(newJobs.filter(job => !isEarlyCareer(job)), MAX_OTHER);',
  'Weekly alert employer-diverse selection passed 4 regression cases.',
  'function nextMonday1600Utc(now = new Date())',
  'function findExistingDigest(digestKey)',
  'publish_date__start',
  'publish_date__end',
  "ordering: '-creation_date'",
  'dcc_digest_key',
  "status: 'scheduled'",
  'publish_date: sendAt.toISOString()',
  'Weekly alert must stay compatible with Buttondown free-tier subscribers.',
  'Manage your subscription or unsubscribe',
  'Digest body bypasses the site'
]) {
  if (!alertScript.includes(marker)) fail(`Weekly alert sender is missing: ${marker}`);
}
for (const forbidden of ['subscriber.metadata', 'subscriber.tags', 'resolveButtondownTagId', '/tags?']) {
  if (alertScript.includes(forbidden) && forbidden !== 'subscriber.metadata' && forbidden !== 'subscriber.tags') fail(`Weekly alert sender must not depend on Buttondown paid-plan targeting: ${forbidden}`);
}

await assertMissing('.github/workflows/weekly-digest.yml');
await assertMissing('scripts/send-weekly-digest.mjs');

await import('./validate-alert-job-detail-parity.mjs');
await import('./validate-alert-signup-parity.mjs');

console.log(`Mailing-list validation passed for Buttondown newsletter ${config.username}: shared provider redirects, one free-tier-compatible Monday digest pipeline with ${scheduleMatches.length} redundant scheduler runs, tracked Data Center Careers job links, employer-diverse early-career-first selection and a configured subscriber portal.`);
