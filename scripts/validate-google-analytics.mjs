import './validate-accessibility.mjs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Pages runs this validator after all authored and generated HTML exists.
// Keep accessibility in the same final deployment gate so a structural
// accessibility regression cannot ship just because analytics still passes.

const MEASUREMENT_ID = 'G-TD86GFYGW5';
const EVENTS_SCRIPT = '/assets/analytics-events.js';
const EXPECTED_EVENTS = [
  'job_apply_click',
  'job_detail_click',
  'job_search',
  'newsletter_signup',
  'employer_feature_click',
  'employer_job_submission'
];
const EXPECTED_SURFACE_MARKERS = [
  "form.id === 'heroSearchForm'",
  "form.id === 'weeklyAlertForm'",
  "form.id === 'jobs-newsletter-form'",
  "form.id === 'employerPlacementForm'",
  "'jobs-search'",
  "'jobs-sort'",
  "'jobs-type'",
  "'jobs-experience'",
  "'jobs-region'",
  "search_source: 'homepage_hero'",
  "search_source: 'jobs_browser'",
  "signup_source: jobsPage ? 'jobs_page_weekly_alert' : 'homepage_weekly_alert'"
];
const FORBIDDEN_ANALYTICS_MARKERS = [
  'metadata__job_url',
  'jobs-newsletter-email',
  'alertEmail',
  'form.elements.email'
];
const SKIP_DIRS = new Set(['.git', '.github', 'node_modules']);

async function htmlFiles(dir = '.') {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...await htmlFiles(join(dir, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

const files = await htmlFiles();
const missingTag = [];
const duplicateTags = [];
const missingEventsScript = [];
for (const file of files) {
  const html = await readFile(file, 'utf8');
  const count = html.split(MEASUREMENT_ID).length - 1;
  if (!count) missingTag.push(file);
  if (count > 2) duplicateTags.push(`${file} (${count} occurrences)`);
  if (!html.includes(EVENTS_SCRIPT)) missingEventsScript.push(file);
}

const eventsJs = await readFile('assets/analytics-events.js', 'utf8');
const missingEventNames = EXPECTED_EVENTS.filter(name => !eventsJs.includes(`'${name}'`));
const missingSurfaceMarkers = EXPECTED_SURFACE_MARKERS.filter(marker => !eventsJs.includes(marker));
const forbiddenSurfaceMarkers = FORBIDDEN_ANALYTICS_MARKERS.filter(marker => eventsJs.includes(marker));

if (missingTag.length || duplicateTags.length || missingEventsScript.length || missingEventNames.length || missingSurfaceMarkers.length || forbiddenSurfaceMarkers.length) {
  console.error('Google Analytics validation failed.');
  if (missingTag.length) console.error(`Missing ${MEASUREMENT_ID}:\n- ${missingTag.join('\n- ')}`);
  if (duplicateTags.length) console.error(`Possible duplicate Google tags:\n- ${duplicateTags.join('\n- ')}`);
  if (missingEventsScript.length) console.error(`Missing ${EVENTS_SCRIPT}:\n- ${missingEventsScript.join('\n- ')}`);
  if (missingEventNames.length) console.error(`Missing custom analytics events: ${missingEventNames.join(', ')}`);
  if (missingSurfaceMarkers.length) console.error(`Missing analytics funnel coverage markers: ${missingSurfaceMarkers.join(', ')}`);
  if (forbiddenSurfaceMarkers.length) console.error(`Analytics must not collect candidate/employer contact or submitted job URL values: ${forbiddenSurfaceMarkers.join(', ')}`);
  process.exit(1);
}

console.log(`Google Analytics validation passed for ${files.length} HTML pages using ${MEASUREMENT_ID}; custom events: ${EXPECTED_EVENTS.join(', ')}; homepage/jobs alert, jobs-browser and employer-submission funnel coverage verified without email or submitted-job-URL collection.`);
