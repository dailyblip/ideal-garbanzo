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

function normalizePayFields(job) {
  const pay = normalizePay(job.pay);
  if (typeof pay !== 'string' || !pay) return { ...job, pay };

  // Some employer descriptions end a compensation range with sentence
  // punctuation before the unit (for example "$35.00-$47.00. / hr").
  // The upstream parser can still produce the display string while losing the
  // numeric maximum. Repair only explicit two-sided ranges so salary sorting
  // never depends on a guess.
  const range = pay.match(/^\$([\d,]+(?:\.\d+)?)\s*(?:-|–|to)\s*\$?([\d,]+(?:\.\d+)?)[.,]?\s*\/\s*(hr|hour|year|yr)\b/i);
  if (!range) return { ...job, pay };

  const min = Number(range[1].replace(/,/g, ''));
  const max = Number(range[2].replace(/,/g, ''));
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) return { ...job, pay };

  const annual = /year|yr/i.test(range[3]);
  return {
    ...job,
    pay: `$${range[1]}–$${range[2]} / ${annual ? 'year' : 'hr'}`,
    salaryMin: min,
    salaryMax: max,
    salarySortMax: annual ? max : Math.round(max * 2080)
  };
}

function normalizeJob(job) {
  const compensation = normalizePayFields(job);
  return {
    ...compensation,
    title: normalizeText(compensation.title),
    company: normalizeText(compensation.company),
    location: normalizeText(compensation.location),
    tags: Array.isArray(compensation.tags) ? compensation.tags.map(normalizeText) : compensation.tags
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

  const malformedHourly = normalizeJob({ pay: '$35.00–$47.00. / hr', salaryMin: 35, salaryMax: null, salarySortMax: null });
  if (malformedHourly.pay !== '$35.00–$47.00 / hr' || malformedHourly.salaryMin !== 35 || malformedHourly.salaryMax !== 47 || malformedHourly.salarySortMax !== 97760) {
    throw new Error('Malformed hourly compensation punctuation was not repaired safely.');
  }

  const malformedAnnual = normalizeJob({ pay: '$110,000–$115,000. / year', salaryMin: 110000, salaryMax: null, salarySortMax: null });
  if (malformedAnnual.pay !== '$110,000–$115,000 / year' || malformedAnnual.salaryMin !== 110000 || malformedAnnual.salaryMax !== 115000 || malformedAnnual.salarySortMax !== 115000) {
    throw new Error('Malformed annual compensation punctuation was not repaired safely.');
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
