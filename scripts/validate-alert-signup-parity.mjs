import { readFile } from 'node:fs/promises';

const config = JSON.parse(await readFile('data/mailing-list.json', 'utf8'));
const homepage = await readFile('index.html', 'utf8');
const jobsBrowser = await readFile('assets/jobs-listing.js', 'utf8');
const signupScript = await readFile('assets/mailing-list.js', 'utf8');
const workflow = await readFile('.github/workflows/weekly-job-alert.yml', 'utf8');

const fail = message => { throw new Error(message); };

if (config.provider !== 'buttondown' || config.enabled !== true) {
  fail('Alert signup parity requires the enabled Buttondown mailing-list configuration.');
}

const username = String(config.username || '').trim();
if (!username) fail('Buttondown username is required.');
const endpoint = `https://buttondown.com/api/emails/embed-subscribe/${username}`;

for (const [label, source] of [
  ['Homepage alert form', homepage],
  ['Jobs-page alert form', jobsBrowser]
]) {
  for (const marker of [endpoint, 'name="email"', 'name="embed" value="1"', 'name="utm_campaign" value="weekly-job-alerts"']) {
    if (!source.includes(marker)) fail(`${label} is missing ${marker}.`);
  }
  for (const forbidden of ['metadata__region', 'metadata__focus', 'name="tag" value="weekly-job-alerts"']) {
    if (source.includes(forbidden)) fail(`${label} uses paid Buttondown targeting that is unavailable on the current plan: ${forbidden}`);
  }
}

for (const forbidden of ['alertRegionValue', 'alertFocusValue', 'syncRegionPreference', 'syncFocusPreference']) {
  if (signupScript.includes(forbidden)) fail(`Homepage alert script still carries unused paid-plan preference plumbing: ${forbidden}`);
}

for (const marker of [
  "- 'assets/jobs-listing.js'",
  'run: node scripts/validate-alert-signup-parity.mjs'
]) {
  if (!workflow.includes(marker)) fail(`Weekly alert workflow is missing parity coverage: ${marker}`);
}

console.log(`Alert signup parity passed: homepage and jobs page share the ${username} Buttondown endpoint and an email-only, free-tier-compatible signup contract.`);
