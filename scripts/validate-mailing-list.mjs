import { readFile } from 'node:fs/promises';

const config = JSON.parse(await readFile('data/mailing-list.json', 'utf8'));
const homepage = await readFile('index.html', 'utf8');
const signupScript = await readFile('assets/mailing-list.js', 'utf8');
const digestScript = await readFile('scripts/send-weekly-digest.mjs', 'utf8');
const workflow = await readFile('.github/workflows/weekly-digest.yml', 'utf8');

const fail = message => { throw new Error(message); };

if (config.provider !== 'buttondown') fail('Mailing list provider must be Buttondown.');
if (config.enabled !== true) fail('Mailing list must be enabled once the Buttondown account is configured.');
if (!/^[a-z0-9][a-z0-9_-]{1,62}$/i.test(String(config.username || ''))) fail('Buttondown username is missing or invalid.');
if (config.cadence !== 'weekly') fail('Mailing list cadence must remain weekly.');
if (config.sendDay !== 'Monday') fail('Weekly digest must send on Monday.');
if (config.sendTimeUtc !== '16:00') fail('Weekly digest send time must remain 16:00 UTC.');

const expectedAction = `https://buttondown.com/api/emails/embed-subscribe/${config.username}`;
for (const marker of [
  'id="weeklyAlertForm"',
  'id="alertEmail"',
  'name="email"',
  `action="${expectedAction}"`,
  'method="post"',
  'id="alertRegion"',
  'id="alertRegionValue" name="metadata__region" value="all"',
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

if (!signupScript.includes('data/mailing-list.json')) fail('Signup script must load the mailing-list configuration.');
if (!signupScript.includes('buttondown.com/api/emails/embed-subscribe/')) fail('Signup script must submit to Buttondown embedded subscribe.');
if (!signupScript.includes('config?.enabled === true')) fail('Signup script must respect the enabled flag.');
if (!signupScript.includes("const fallbackAction = form.getAttribute('action') || '';")) fail('Signup script must preserve the static Buttondown fallback action.');
if (!signupScript.includes("document.getElementById('alertRegion')")) fail('Signup script must read the regional alert preference.');
if (!signupScript.includes("document.getElementById('alertRegionValue')")) fail('Signup script must persist the regional alert preference to Buttondown metadata.');
if (!signupScript.includes('syncRegionPreference();')) fail('Signup script must synchronize the regional preference before submission.');
if (signupScript.includes('.catch(() => configure(null))')) fail('Signup script must not disable the static fallback when config fetch fails.');

if (!workflow.includes("cron: '0 16 * * 1'")) fail('Weekly digest workflow must run Mondays at 16:00 UTC.');
if (!workflow.includes('BUTTONDOWN_API_KEY: ${{ secrets.BUTTONDOWN_API_KEY }}')) fail('Weekly digest workflow must use the Buttondown API secret.');
if (!workflow.includes('default: true')) fail('Manual weekly digest runs must default to dry-run mode.');
if (!workflow.includes("- 'index.html'")) fail('Weekly digest preflight must run when the signup form changes.');
if (!workflow.includes("- 'assets/mailing-list.js'")) fail('Weekly digest preflight must run when signup plumbing changes.');

for (const marker of ['BUTTONDOWN_API_KEY', 'X-Buttondown-Live-Dangerously', '/v1/emails', '/publish', "status: 'draft'"]) {
  if (!digestScript.includes(marker)) fail(`Weekly digest sender is missing safety/integration marker: ${marker}`);
}
if (!digestScript.includes("if (!config.enabled && !dryRun)")) fail('Weekly digest sender must stop when the mailing list is disabled.');
if (!digestScript.includes('if (!weeklyJobs.length)')) fail('Weekly digest sender must skip empty newsletters.');
if (!digestScript.includes('subscriber.metadata.region')) fail('Weekly digest sender must personalize content from the saved regional preference.');
if (!digestScript.includes("job.region === region || job.region === 'nationwide'")) fail('Regional digests must include matching and nationwide roles.');
if (!digestScript.includes('regional_personalization: true')) fail('Weekly digest must stamp regional personalization metadata.');

console.log(`Mailing-list validation passed for Buttondown newsletter ${config.username}: resilient tagged signup with regional subscriber metadata and personalized Monday digests at ${config.sendTimeUtc} UTC.`);
