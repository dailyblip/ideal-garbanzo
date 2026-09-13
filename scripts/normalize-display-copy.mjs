import { readFile, writeFile } from 'node:fs/promises';

const jobFiles = new Set(['data/jobs.json', 'data/major-jobs.json']);
const files = [...jobFiles, 'data/career-events.json'];
const missingPayPattern = /^pay not listed$/i;

function normalizeText(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/\s*\u2014\s*/g, ' - ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function normalizePay(value) {
  const normalized = normalizeText(value);
  return typeof normalized === 'string' && missingPayPattern.test(normalized) ? '' : normalized;
}

function normalizeJob(job) {
  return {
    ...job,
    title: normalizeText(job.title),
    company: normalizeText(job.company),
    location: normalizeText(job.location),
    pay: normalizePay(job.pay),
    tags: Array.isArray(job.tags) ? job.tags.map(normalizeText) : job.tags
  };
}

function normalizeEvent(event) {
  return {
    ...event,
    name: normalizeText(event.name),
    location: normalizeText(event.location),
    organizer: normalizeText(event.organizer)
  };
}

function runSelfTest() {
  const missing = normalizeJob({ pay: ' Pay not listed ' });
  if (missing.pay !== '') throw new Error('Missing compensation placeholder was not normalized to blank.');

  const hourly = normalizeJob({ pay: '$34.00–$35.50 / hr', salaryMin: 34, salaryMax: 35.5, salarySortMax: 73840 });
  if (hourly.pay !== '$34.00–$35.50 / hr' || hourly.salaryMin !== 34 || hourly.salaryMax !== 35.5 || hourly.salarySortMax !== 73840) {
    throw new Error('Published compensation was modified during display normalization.');
  }

  const absent = normalizeJob({ pay: '', salaryMin: null, salaryMax: null, salarySortMax: null });
  if (absent.pay !== '' || absent.salaryMin !== null || absent.salaryMax !== null || absent.salarySortMax !== null) {
    throw new Error('Blank compensation fields were not preserved.');
  }

  console.log('Display and compensation normalization regression tests passed.');
}

if (process.argv.includes('--test')) {
  runSelfTest();
  process.exit(0);
}

for (const path of files) {
  const original = await readFile(path, 'utf8');
  const parsed = JSON.parse(original);
  if (!Array.isArray(parsed)) throw new Error(`${path} must contain an array.`);

  const normalized = jobFiles.has(path)
    ? parsed.map(normalizeJob)
    : parsed.map(normalizeEvent);

  const output = JSON.stringify(normalized, null, 2) + '\n';
  if (output !== original) {
    await writeFile(path, output);
    console.log(`Normalized display copy in ${path}.`);
  } else {
    console.log(`No display copy changes needed in ${path}.`);
  }
}
