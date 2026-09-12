import { readFile } from 'node:fs/promises';

const config = JSON.parse(await readFile('data/mailing-list.json', 'utf8'));
const homepage = await readFile('index.html', 'utf8');
const jobsBrowser = await readFile('assets/jobs-listing.js', 'utf8');
const signupScript = await readFile('assets/mailing-list.js', 'utf8');
const workflow = await readFile('.github/workflows/weekly-job-alert.yml', 'utf8');

const fail = message => { throw new Error(message); };
const expectedRegions = ['all', 'mid-atlantic', 'texas', 'southwest', 'midwest', 'southeast', 'northeast', 'west'];
const expectedFocus = ['all', 'early-career'];

if (config.provider !== 'buttondown' || config.enabled !== true) {
  fail('Alert signup parity requires the enabled Buttondown mailing-list configuration.');
}

const username = String(config.username || '').trim();
if (!username) fail('Buttondown username is required.');
const endpoint = `https://buttondown.com/api/emails/embed-subscribe/${username}`;

function selectValues(source, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const select = source.match(new RegExp(`<select[^>]*id=["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/select>`, 'i'));
  if (!select) fail(`Missing alert preference select: ${id}`);
  return [...select[1].matchAll(/<option\s+value=["']([^"']*)["']/gi)].map(match => match[1]);
}

function assertExact(label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} drifted. Expected ${expected.join(', ')}, got ${actual.join(', ') || '(none)'}.`);
  }
}

assertExact('Homepage alert regions', selectValues(homepage, 'alertRegion'), expectedRegions);
assertExact('Jobs-page alert regions', selectValues(jobsBrowser, 'jobs-newsletter-region'), expectedRegions);
assertExact('Homepage alert focus choices', selectValues(homepage, 'alertFocus'), expectedFocus);
assertExact('Jobs-page alert focus choices', selectValues(jobsBrowser, 'jobs-newsletter-focus'), expectedFocus);

for (const [label, source] of [
  ['Homepage alert form', homepage],
  ['Jobs-page alert form', jobsBrowser]
]) {
  for (const marker of [
    endpoint,
    'name="email"',
    'name="tag" value="weekly-job-alerts"'
  ]) {
    if (!source.includes(marker)) fail(`${label} is missing ${marker}.`);
  }
}

for (const marker of [
  'id="alertRegionValue" name="metadata__region" value="all"',
  'id="alertFocusValue" name="metadata__focus" value="all"'
]) {
  if (!homepage.includes(marker)) fail(`Homepage alert fallback metadata is missing: ${marker}`);
}

for (const marker of [
  'id="jobs-newsletter-region" name="metadata__region"',
  'id="jobs-newsletter-focus" name="metadata__focus"'
]) {
  if (!jobsBrowser.includes(marker)) fail(`Jobs-page alert metadata is missing: ${marker}`);
}

for (const region of expectedRegions) {
  if (!signupScript.includes(`'${region}'`)) fail(`Homepage alert synchronization does not allow region ${region}.`);
}
for (const focus of expectedFocus) {
  if (!signupScript.includes(`'${focus}'`)) fail(`Homepage alert synchronization does not allow focus ${focus}.`);
}

for (const marker of [
  "- 'assets/jobs-listing.js'",
  'run: node scripts/validate-alert-signup-parity.mjs'
]) {
  if (!workflow.includes(marker)) fail(`Weekly alert workflow is missing parity coverage: ${marker}`);
}

console.log(`Alert signup parity passed: homepage and jobs page share ${expectedRegions.length} regions, ${expectedFocus.length} focus choices, the ${username} Buttondown endpoint, and the weekly-job-alerts tag.`);
