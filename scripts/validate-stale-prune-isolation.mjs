import { readFile } from 'node:fs/promises';

const stalePrunePath = '.github/workflows/early-career-stale-prune.yml';
const sourceGuardPath = 'scripts/validate-source-workflow-isolation.mjs';
const violations = [];

function workflowPathsFromSet(source, name) {
  const match = source.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`));
  if (!match) throw new Error(`Could not find ${name} in ${sourceGuardPath}`);
  return [...match[1].matchAll(/['"](\.github\/workflows\/[^'"]+\.yml)['"]/g)].map((entry) => entry[1]);
}

function expandCronField(field, min, max) {
  const values = new Set();
  for (const rawPart of field.split(',')) {
    const part = rawPart.trim();
    if (!part) throw new Error(`empty cron field segment in ${field}`);

    let base = part;
    let step = 1;
    if (part.includes('/')) {
      const pieces = part.split('/');
      if (pieces.length !== 2 || !/^\d+$/.test(pieces[1])) throw new Error(`unsupported cron step ${part}`);
      base = pieces[0];
      step = Number(pieces[1]);
      if (step < 1) throw new Error(`invalid cron step ${part}`);
    }

    let start;
    let end;
    if (base === '*') {
      start = min;
      end = max;
    } else if (/^\d+$/.test(base)) {
      start = Number(base);
      end = Number(base);
    } else {
      const range = base.match(/^(\d+)-(\d+)$/);
      if (!range) throw new Error(`unsupported cron field ${part}`);
      start = Number(range[1]);
      end = Number(range[2]);
    }

    if (start < min || end > max || start > end) throw new Error(`cron field ${part} is outside ${min}-${max}`);
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return [...values];
}

function cronSlots(path, cron) {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`${path}: cron must have five fields: ${cron}`);
  const [minuteField, hourField, dayOfMonth, month, dayOfWeek] = fields;
  if (dayOfMonth !== '*' || month !== '*' || dayOfWeek !== '*') {
    throw new Error(`${path}: scheduled feed writer must remain daily for collision checking: ${cron}`);
  }

  const slots = [];
  for (const hour of expandCronField(hourField, 0, 23)) {
    for (const minute of expandCronField(minuteField, 0, 59)) {
      slots.push(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
    }
  }
  return slots;
}

function cronsFromWorkflow(text) {
  const onBlock = text.match(/^on:\s*\n([\s\S]*?)^permissions:/m)?.[1] || '';
  return [...onBlock.matchAll(/cron:\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

const sourceGuard = await readFile(sourceGuardPath, 'utf8');
const primaryWriters = new Set([
  ...workflowPathsFromSet(sourceGuard, 'sharedWriterQueue'),
  ...workflowPathsFromSet(sourceGuard, 'scheduledPrimaryWriters'),
  stalePrunePath
]);

const staleText = await readFile(stalePrunePath, 'utf8');
for (const marker of [
  'rebuild_from_latest_main()',
  'git reset --hard origin/main',
  'for attempt in 1 2 3',
  'if git push origin HEAD:main; then'
]) {
  if (!staleText.includes(marker)) violations.push(`${stalePrunePath}: race-safe publication is missing ${marker}`);
}
if (/git\s+rebase\s+origin\/main/.test(staleText)) {
  violations.push(`${stalePrunePath}: generated feed data must rebuild from latest main instead of rebasing a stale snapshot`);
}
if (!/cancel-in-progress:\s*false\b/.test(staleText)) {
  violations.push(`${stalePrunePath}: stale-prune must not cancel an in-progress run`);
}

const slots = new Map();
for (const path of primaryWriters) {
  const text = path === stalePrunePath ? staleText : await readFile(path, 'utf8');
  const crons = cronsFromWorkflow(text);
  if (!crons.length) {
    violations.push(`${path}: scheduled shared-feed writer must have a cron`);
    continue;
  }

  for (const cron of crons) {
    try {
      for (const slot of cronSlots(path, cron)) {
        if (!slots.has(slot)) slots.set(slot, new Set());
        slots.get(slot).add(path);
      }
    } catch (error) {
      violations.push(error.message);
    }
  }
}

for (const [slot, paths] of slots) {
  if (paths.size < 2 || !paths.has(stalePrunePath)) continue;
  const names = [...paths].map((path) => path.split('/').pop()).sort().join(', ');
  violations.push(`stale-prune shared-feed collision at ${slot} UTC: ${names}`);
}

if (violations.length) {
  for (const violation of violations) console.error(`Stale-prune isolation violation: ${violation}`);
  throw new Error(`Blocked ${violations.length} stale-prune isolation regression(s).`);
}

console.log(`Stale-prune isolation guard passed: ${stalePrunePath} uses fresh-main retry publication and has no exact UTC collision with ${primaryWriters.size - 1} scheduled employer feed writers.`);
