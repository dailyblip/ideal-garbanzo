import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';

const ALLOWED_TYPES = new Set(['entry-level', 'internship', 'apprenticeship', 'trainee']);
const ALLOWED_EXPERIENCE = new Set(['no-experience', '0-2-years', '2-5-years']);

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

function explicitProgramType(title = '') {
  const value = clean(title);
  if (/\bintern(?:ship)?\b/i.test(value)) return 'internship';
  if (/\bapprentice(?:ship)?\b/i.test(value)) return 'apprenticeship';
  if (/\btrainee\b/i.test(value)) return 'trainee';
  return '';
}

function classificationReason(job = {}) {
  const type = clean(job?.type);
  const experience = clean(job?.experience);
  if (!ALLOWED_TYPES.has(type)) return 'unsupported job type';
  if (!ALLOWED_EXPERIENCE.has(experience)) return 'unsupported experience band';

  // filter-mission-fit.mjs normalizes explicit internships, apprenticeships and
  // trainee titles before this guard runs. Keep this second check fail-closed so
  // source-taxonomy drift cannot label an obvious program as a generic role.
  const expectedProgramType = explicitProgramType(job?.title);
  if (expectedProgramType && type !== expectedProgramType) return 'explicit program type mismatch';
  return '';
}

function partition(records = []) {
  const kept = [];
  const removed = [];
  for (const job of records) {
    const reason = classificationReason(job);
    if (!reason) {
      kept.push(job);
      continue;
    }
    removed.push({
      id: clean(job?.id),
      company: clean(job?.company),
      title: clean(job?.title),
      type: clean(job?.type),
      experience: clean(job?.experience),
      reason
    });
  }
  return { kept, removed };
}

function countsBy(records, field) {
  return records.reduce((counts, record) => {
    const value = clean(record?.[field]) || 'unknown';
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

function runSelfTest() {
  const sample = [
    { id: 'valid-entry', title: 'Data Center Technician I', type: 'entry-level', experience: '0-2-years' },
    { id: 'valid-intern', title: 'Data Center Operations Intern', type: 'internship', experience: 'no-experience' },
    { id: 'invalid-band', title: 'Critical Facilities Engineer', type: 'entry-level', experience: '5-plus-years' },
    { id: 'missing-band', title: 'Critical Facilities Technician', type: 'entry-level', experience: '' },
    { id: 'invalid-type', title: 'Data Center Technician', type: 'experienced', experience: '2-5-years' },
    { id: 'program-mismatch', title: 'Data Center Technician Apprenticeship', type: 'entry-level', experience: 'no-experience' }
  ];
  const result = partition(sample);
  if (result.kept.length !== 2) throw new Error(`classification guard self-test kept ${result.kept.length} records instead of 2`);
  const reasons = new Map(result.removed.map(item => [item.id, item.reason]));
  if (reasons.get('invalid-band') !== 'unsupported experience band') throw new Error('5+ experience drift was not rejected');
  if (reasons.get('missing-band') !== 'unsupported experience band') throw new Error('missing experience drift was not rejected');
  if (reasons.get('invalid-type') !== 'unsupported job type') throw new Error('unsupported type drift was not rejected');
  if (reasons.get('program-mismatch') !== 'explicit program type mismatch') throw new Error('explicit apprenticeship mismatch was not rejected');
  console.log('Early-career publication classification regression tests passed.');
}

if (process.argv.includes('--test')) {
  runSelfTest();
  process.exit(0);
}

const jobs = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
if (!Array.isArray(jobs)) throw new Error(`${JOBS_PATH} must contain an array.`);

const result = partition(jobs);
if (!result.removed.length) {
  console.log(`Early-career classification guard passed for ${jobs.length} published jobs.`);
  process.exit(0);
}

await writeFile(JOBS_PATH, JSON.stringify(result.kept, null, 2) + '\n');

try {
  const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
  status.jobs = result.kept.length;
  status.countsByType = countsBy(result.kept, 'type');
  status.countsByExperience = countsBy(result.kept, 'experience');
  status.classificationPublicationGuard = {
    checkedAt: new Date().toISOString(),
    removedCount: result.removed.length,
    removedByReason: result.removed.reduce((counts, item) => {
      counts[item.reason] = (counts[item.reason] || 0) + 1;
      return counts;
    }, {}),
    removed: result.removed.slice(0, 50),
    policy: 'Publish only supported early-career job types and no-experience through 2-5-year experience bands; explicit internship, apprenticeship and trainee titles must use their matching program type.'
  };
  await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
} catch {}

console.warn(`Early-career classification guard removed ${result.removed.length} unsupported role(s); ${result.kept.length} jobs remain.`);
for (const item of result.removed.slice(0, 20)) {
  console.warn(`Removed ${item.company || 'Unknown company'}: ${item.title || item.id} [${item.reason}; type=${item.type || 'missing'}; experience=${item.experience || 'missing'}]`);
}
