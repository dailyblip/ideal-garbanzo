import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const MEASUREMENT_ID = 'G-TD86GFYGW5';
const EVENTS_SCRIPT = '/assets/analytics-events.js';
const EXPECTED_EVENTS = ['job_apply_click', 'job_search', 'newsletter_signup', 'employer_feature_click'];
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

if (missingTag.length || duplicateTags.length || missingEventsScript.length || missingEventNames.length) {
  console.error('Google Analytics validation failed.');
  if (missingTag.length) console.error(`Missing ${MEASUREMENT_ID}:\n- ${missingTag.join('\n- ')}`);
  if (duplicateTags.length) console.error(`Possible duplicate Google tags:\n- ${duplicateTags.join('\n- ')}`);
  if (missingEventsScript.length) console.error(`Missing ${EVENTS_SCRIPT}:\n- ${missingEventsScript.join('\n- ')}`);
  if (missingEventNames.length) console.error(`Missing custom analytics events: ${missingEventNames.join(', ')}`);
  process.exit(1);
}

console.log(`Google Analytics validation passed for ${files.length} HTML pages using ${MEASUREMENT_ID}; custom events: ${EXPECTED_EVENTS.join(', ')}.`);
