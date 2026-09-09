import { access, readFile } from 'node:fs/promises';

const errors = [];
const requireMatch = (condition, message) => {
  if (!condition) errors.push(message);
};

const browserJs = await readFile('assets/jobs-listing.js', 'utf8');
const browserCss = await readFile('assets/jobs-listing.css', 'utf8');
const hardenSeo = await readFile('scripts/harden-seo.mjs', 'utf8');

try {
  new Function(browserJs);
} catch (error) {
  errors.push(`Jobs listing JavaScript does not parse: ${error.message}`);
}

for (const marker of [
  "getElementById('jobs-search')",
  "getElementById('jobs-sort')",
  "getElementById('jobs-type')",
  "getElementById('jobs-experience')",
  "getElementById('jobs-region')",
  "getElementById('jobs-reset')",
  "new URLSearchParams(window.location.search)",
  "window.history.replaceState",
  "fetch(`${window.location.origin}/data/jobs.json`",
  "sort.value === 'newest'",
  "sort.value === 'company'",
  "sort.value === 'location'",
  "sort.value === 'pay'",
  "job.type !== selectedType",
  "job.experience !== selectedExperience",
  "matchesRegion(job, selectedRegion)"
]) {
  requireMatch(browserJs.includes(marker), `Jobs browser is missing behavior marker: ${marker}`);
}

for (const region of ['mid-atlantic','texas','southwest','midwest','southeast','northeast','west']) {
  requireMatch(browserJs.includes(`'${region}'`) || browserJs.includes(`"${region}"`), `Jobs browser is missing region support: ${region}`);
}

requireMatch(/\.jobs-field input,\.jobs-field select\{[^}]*min-height:46px/i.test(browserCss), 'Desktop jobs controls must keep large touch targets.');
const mobileStart = browserCss.indexOf('@media(max-width:760px)');
requireMatch(mobileStart >= 0, 'Jobs browser mobile breakpoint is missing.');
const mobileCss = mobileStart >= 0 ? browserCss.slice(mobileStart) : '';
requireMatch(/\.jobs-search-row,\.jobs-filter-grid\{[^}]*grid-template-columns:1fr/i.test(mobileCss), 'Jobs search and filters must stack on mobile.');
requireMatch(/\.jobs-field input,\.jobs-field select\{[^}]*min-height:48px[^}]*font-size:16px/i.test(mobileCss), 'Mobile jobs controls must use 16px text and 48px touch targets.');
requireMatch(/\.jobs-reset\{[^}]*min-height:44px/i.test(mobileCss), 'Mobile jobs reset control must keep a 44px+ touch target.');

for (const marker of [
  'Search and filter jobs',
  'id="jobs-search"',
  'id="jobs-sort"',
  'id="jobs-type"',
  'id="jobs-experience"',
  'id="jobs-region"',
  'id="jobs-results-summary" aria-live="polite"',
  '/assets/jobs-listing.css',
  '/assets/jobs-listing.js'
]) {
  requireMatch(hardenSeo.includes(marker), `SEO build no longer injects required jobs browser marker: ${marker}`);
}

try {
  await access('jobs/index.html');
  const generated = await readFile('jobs/index.html', 'utf8');
  for (const marker of [
    'data-jobs-browser',
    'data-job-results',
    'id="jobs-search"',
    'id="jobs-sort"',
    'id="jobs-type"',
    'id="jobs-experience"',
    'id="jobs-region"',
    '/assets/jobs-listing.css',
    '/assets/jobs-listing.js'
  ]) {
    requireMatch(generated.includes(marker), `Generated jobs page is missing: ${marker}`);
  }
} catch {}

if (errors.length) {
  console.error('Jobs browser contract validation failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log('Jobs search, sort, filter, URL-state, mobile and accessibility contract passed.');
