import { access, readFile } from 'node:fs/promises';

const config = JSON.parse(await readFile('data/mailing-list.json', 'utf8'));
const homepage = await readFile('index.html', 'utf8');
const signupScript = await readFile('assets/mailing-list.js', 'utf8');
const alertScript = await readFile('scripts/send-weekly-job-alert.mjs', 'utf8');
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
  "cron: '5 5 * * 1'",
  "run: node scripts/validate-mailing-list.mjs",
  "run: node scripts/send-weekly-job-alert.mjs --dry-run",
  'BUTTONDOWN_API_KEY: ${{ secrets.BUTTONDOWN_API_KEY }}',
  'run: node scripts/send-weekly-job-alert.mjs --schedule',
  "- 'index.html'",
  "- 'assets/mailing-list.js'",
  "- 'scripts/validate-mailing-list.mjs'"
]) {
  if (!workflow.includes(marker)) fail(`Weekly alert workflow is missing: ${marker}`);
}

for (const marker of [
  "const ALERT_TAG = 'weekly-job-alerts';",
  "const SITE_BASE = 'https://datacentercareers.us';",
  "const EARLY_TYPES = new Set(['internship', 'apprenticeship', 'trainee']);",
  "const EARLY_EXPERIENCE = new Set(['no-experience', '0-2-years']);",
  'subscriber.metadata.region',
  'subscriber.metadata.focus',
  'utm_source',
  'weekly-email',
  'function jobDetailUrl(job)',
  'function nextMonday1600Utc(now = new Date())',
  'function findExistingDigest(digestKey)',
  'dcc_digest_key',
  "status: 'scheduled'",
  'publish_date: sendAt.toISOString()',
  "filters: [{ field: 'subscriber.tags', operator: 'contains', value: ALERT_TAG }]",
  'Digest body bypasses the site'
]) {
  if (!alertScript.includes(marker)) fail(`Weekly alert sender is missing: ${marker}`);
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

console.log(`Mailing-list validation passed for Buttondown newsletter ${config.username}: one tagged, personalized Monday alert pipeline scheduled for ${config.sendTimeUtc} UTC with tracked Data Center Careers job links.`);
