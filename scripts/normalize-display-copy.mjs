import { readFile, writeFile } from 'node:fs/promises';

const files = ['data/jobs.json', 'data/career-events.json'];

function normalizeText(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/\s*\u2014\s*/g, ' - ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function normalizeJob(job) {
  return {
    ...job,
    title: normalizeText(job.title),
    company: normalizeText(job.company),
    location: normalizeText(job.location),
    pay: normalizeText(job.pay),
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

for (const path of files) {
  const original = await readFile(path, 'utf8');
  const parsed = JSON.parse(original);
  if (!Array.isArray(parsed)) throw new Error(`${path} must contain an array.`);

  const normalized = path.endsWith('jobs.json')
    ? parsed.map(normalizeJob)
    : parsed.map(normalizeEvent);

  const output = JSON.stringify(normalized, null, 2) + '\n';
  if (output !== original) {
    await writeFile(path, output);
    console.log(`Normalized display punctuation in ${path}.`);
  } else {
    console.log(`No display punctuation changes needed in ${path}.`);
  }
}
