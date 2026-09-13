import { readFile } from 'node:fs/promises';

const senderSource = await readFile('scripts/send-weekly-job-alert.mjs', 'utf8');
const seoSource = await readFile('scripts/generate-seo.mjs', 'utf8');
const jobs = JSON.parse(await readFile('data/jobs.json', 'utf8'));

const fail = message => { throw new Error(message); };

function extractArrowDeclaration(source, name, label) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*([^\\n]+);`));
  if (!match) fail(`${label} is missing the ${name} helper used by job-detail URLs.`);
  return `const ${name} = ${match[1]};`;
}

function buildSlugger(source, label) {
  const declarations = ['clean', 'slugify', 'jobSlug']
    .map(name => extractArrowDeclaration(source, name, label))
    .join('\n');
  try {
    return Function(`${declarations}\nreturn jobSlug;`)();
  } catch (error) {
    fail(`${label} job slug helper could not be evaluated: ${error.message}`);
  }
}

if (!Array.isArray(jobs)) fail('data/jobs.json must contain an array.');
if (!senderSource.includes('return trackedSiteUrl(`/jobs/${jobSlug(job)}/`')) {
  fail('Weekly alert job links must route through the generated Data Center Careers job-detail page.');
}
if (!seoSource.includes('await writeHtml(`jobs/${jobSlug(job)}/index.html`,html);')) {
  fail('SEO generation must write the same job-detail path used by weekly alerts.');
}

const senderSlug = buildSlugger(senderSource, 'Weekly alert sender');
const seoSlug = buildSlugger(seoSource, 'SEO generator');
const fixtures = [
  { id: 'aws:123-ABC', title: 'Data Center Technician I', company: 'Amazon Web Services' },
  { id: 'meta/9876543210', title: 'Critical Facilities Engineer (Early Career)', company: 'Meta Platforms, Inc.' },
  { id: 'qts-00000000000042', title: 'Electrical Apprentice – Data Center', company: 'QTS Data Centers' },
  { id: 'fixture-long-title-1234567890', title: `${'Very Long Data Center Operations Technician '.repeat(4)}Night Shift`, company: `${'Infrastructure Operator '.repeat(3)}LLC` }
];

for (const job of [...fixtures, ...jobs]) {
  const senderValue = senderSlug(job);
  const seoValue = seoSlug(job);
  if (!senderValue || senderValue !== seoValue) {
    fail(`Weekly alert/SEO job-detail slug drift for ${job?.id || job?.title || 'unknown job'}: ${senderValue || '(empty)'} != ${seoValue || '(empty)'}.`);
  }
}

const seen = new Map();
for (const job of jobs) {
  const slug = seoSlug(job);
  const prior = seen.get(slug);
  if (prior && prior !== job.id) {
    fail(`Generated job-detail slug collision: ${prior} and ${job.id} both resolve to /jobs/${slug}/.`);
  }
  seen.set(slug, job.id);
}

console.log(`Weekly alert job-detail parity passed for ${jobs.length} current jobs plus ${fixtures.length} edge-case fixtures; email links and generated SEO pages share one collision-free URL shape.`);
