import { access, readFile } from 'node:fs/promises';

const config = JSON.parse(await readFile('data/mailing-list.json', 'utf8'));
const homepage = await readFile('index.html', 'utf8');
const signupScript = await readFile('assets/mailing-list.js', 'utf8');
const alertScript = await readFile('scripts/send-weekly-job-alert.mjs', 'utf8');
const buttondownConfigScript = await readFile('scripts/configure-buttondown.mjs', 'utf8');
const workflow = await readFile('.github/workflows/weekly-job-alert.yml', 'utf8');

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
  const scheduleLeadMinutes = sendHour * 60 + sendMinute - minuteOfDay;
  if (scheduleLeadMinutes < 30 || scheduleLeadMinutes > 180) {
    fail(`Every weekly alert scheduler run must be 30–180 minutes before ${config.sendTimeUtc} UTC so the digest uses fresh jobs without risking a missed send.`);
  }
}

const sortedSchedules = [...scheduleMinutes].sort((a, b) => a - b);
const finalLeadMinutes = sendHour * 60 + sendMinute - sortedSchedules.at(-1);
if (finalLeadMinutes > 60) fail('Weekly alert backup scheduler must run within 60 minutes of the configured send time.');

const expectedAction = `https://buttondown.com/api/emails/embed-subscribe/${config.username}`;
for (const marker of [
  'id="weeklyAlertForm"',
  'id="alertEmail"',
  'name="email"',
  `action="${expectedAction}"`,
  'method="post"',
  'id="alertRegion"',
  'id="alertRegionValue" name="metadata__region" value="all"',
  'id="alertFocus"',
  'id="alertFocusValue" name="metadata__focus" value="all"',
  '<option value="early-career">Internships, apprenticeships &amp; beginner-friendly roles</option>',
  '<option value="mid-atlantic">Northern Virginia / Mid-Atlantic</option>',
  '<option value="texas">Texas</option>',
  '<option value="west">West</option>',
  'name="embed" value="1"',
  'name="tag" value="weekly-job-alerts"',
  'name="utm_source" value="datacentercareers.us"',
  'name="utm_medium" value="website"',
  'name="utm_campaign" value="weekly-job-alerts"',
  'Join weekly list',
  'Get new openings every Monday.'
]) {
  if (!homepage.includes(marker)) fail(`Homepage weekly signup is missing: ${marker}`);
}

for (const marker of [
  'data/mailing-list.json',
  'buttondown.com/api/emails/embed-subscribe/',
  'config?.enabled === true',
  "const fallbackAction = form.getAttribute('action') || '';",
  "document.getElementById('alertRegion')",
  "document.getElementById('alertRegionValue')",
  "document.getElementById('alertFocus')",
  "document.getElementById('alertFocusValue')",
  "const allowedFocus = new Set(['all', 'early-career']);",
  'syncRegionPreference();',
  'syncFocusPreference();',
  'syncPreferences();'
]) {
  if (!signupScript.includes(marker)) fail(`Signup plumbing is missing: ${marker}`);
}
if (signupScript.includes('.catch(() => configure(null))')) fail('Signup script must not disable the static fallback when config fetch fails.');

for (const marker of [
  "const ALERT_TAG = 'weekly-job-alerts';",
  "enabledFeatures.add('portal');",
  "'X-Buttondown-Collision-Behavior': 'overwrite'",
  "name: ALERT_TAG",
  "subscriber_editable: false",
  'subscription_redirect_url: REDIRECT_URL',
  'subscription_confirmation_redirect_url:',
  'Buttondown did not confirm the ${ALERT_TAG} audience tag.'
]) {
  if (!buttondownConfigScript.includes(marker)) fail(`Buttondown service configuration is missing: ${marker}`);
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
  "- 'scripts/validate-mailing-list.mjs'",
  "- 'scripts/validate-alert-job-detail-parity.mjs'"
]) {
  if (!workflow.includes(marker)) fail(`Weekly alert workflow is missing: ${marker}`);
}

for (const marker of [
  "const ALERT_TAG = 'weekly-job-alerts';",
  "const SITE_BASE = 'https://datacentercareers.us';",
  "const EARLY_TYPES = new Set(['internship', 'apprenticeship', 'trainee']);",
  "const EARLY_EXPERIENCE = new Set(['no-experience', '0-2-years']);",
  "const testSelection = args.has('--test-selection');",
  'subscriber.metadata.region',
  'subscriber.metadata.focus',
  'utm_source',
  'weekly-email',
  'function jobDetailUrl(job)',
  'function diversifyJobs(jobs, limit)',
  'const allUs = diversifyJobs(newJobs, MAX_ALL_US);',
  'const regional = diversifyJobs(regionalCandidates, MAX_PER_REGION);',
  'Weekly alert employer-diverse selection passed 4 regression cases.',
  'function nextMonday1600Utc(now = new Date())',
  'function resolveButtondownTagId(tagName)',
  'buttondownRequest(`/tags?${params.toString()}`)',
  'refusing to schedule an unfiltered weekly alert',
  'function findExistingDigest(digestKey)',
  'publish_date__start',
  'publish_date__end',
  "ordering: '-creation_date'",
  'dcc_digest_key',
  "status: 'scheduled'",
  'publish_date: sendAt.toISOString()',
  'const alertTagId = await resolveButtondownTagId(ALERT_TAG);',
  "filters: [{ field: 'subscriber.tags', operator: 'contains', value: alertTagId }]",
  'Digest body bypasses the site'
]) {
  if (!alertScript.includes(marker)) fail(`Weekly alert sender is missing: ${marker}`);
}
if (alertScript.includes("metadata['dcc_digest_key']")) {
  fail('Weekly alert duplicate detection must not use unsupported metadata filtering on the Buttondown /emails endpoint.');
}
if (alertScript.includes("filters: [{ field: 'subscriber.tags', operator: 'contains', value: ALERT_TAG }]")) {
  fail('Weekly alert must resolve the Buttondown tag identifier instead of sending the human-readable tag name as an API filter value.');
}

for (const marker of [
  'function alertJobMatchesRegion(job, region)',
  "if (job?.region === 'nationwide') return true;",
  'Array.isArray(job?.regions) && job.regions.includes(region)',
  "location.includes(';')",
  'alertLocationMatchesRegion(location, region)',
  'newJobs.filter(job => alertJobMatchesRegion(job, region))'
]) {
  if (!alertScript.includes(marker)) fail(`Regional alert matching is missing: ${marker}`);
}

await assertMissing('.github/workflows/weekly-digest.yml');
await assertMissing('scripts/send-weekly-digest.mjs');

// Every deployment path already invokes mailing-list validation. Chain the
// job-detail URL and cross-surface preference contracts here so deploy-only
// and bot-driven main builds cannot ship broken weekly alert links or signup drift.
await import('./validate-alert-job-detail-parity.mjs');
await import('./validate-alert-signup-parity.mjs');

console.log(`Mailing-list validation passed for Buttondown newsletter ${config.username}: one tagged, personalized Monday alert pipeline with ${scheduleMatches.length} redundant scheduler runs before the ${config.sendTimeUtc} UTC send, tracked Data Center Careers job links, employer-diverse selection, a configured subscriber portal and a pre-provisioned audience tag.`);
