import { readdir, readFile } from 'node:fs/promises';

const workflowDir = '.github/workflows';
const fullRefreshPath = '.github/workflows/pages.yml';

const sharedPipelinePaths = [
  'data/jobs.json',
  'scripts/filter-mission-fit.mjs',
  'scripts/normalize-job-locations.mjs',
  'scripts/dedupe-normalized-jobs.mjs',
  'scripts/stamp-job-history.mjs',
  'scripts/validate-job-history.mjs',
  'scripts/validate-priority-employer-sources.mjs'
];

// These staggered source workflows intentionally share a queue. GitHub keeps at
// most one pending run per concurrency group, so exact schedule collisions can
// otherwise replace a pending employer refresh before it starts.
const sharedWriterQueue = new Set([
  '.github/workflows/cloudhq-bootstrap.yml',
  '.github/workflows/cologix-bootstrap.yml',
  '.github/workflows/coreweave-bootstrap.yml',
  '.github/workflows/databank-bootstrap.yml',
  '.github/workflows/digital-realty-bootstrap.yml',
  '.github/workflows/edgeconnex-bootstrap.yml',
  '.github/workflows/equinix-bootstrap.yml',
  '.github/workflows/flexential-bootstrap.yml',
  '.github/workflows/google-bootstrap.yml',
  '.github/workflows/major-workday-bootstrap.yml',
  '.github/workflows/novva-bootstrap.yml',
  '.github/workflows/prime-data-centers-bootstrap.yml',
  '.github/workflows/stream-data-centers-bootstrap.yml',
  '.github/workflows/switch-bootstrap.yml',
  '.github/workflows/t5-data-centers-bootstrap.yml'
]);

const raceSafeMarkers = [
  'rebuild_from_latest_main()',
  'git reset --hard origin/main',
  'for attempt in 1 2 3',
  'if git push origin HEAD:main; then'
];

const violations = [];
const scheduleSlots = new Map();

function expandCronField(field, min, max) {
  const values = new Set();
  for (const rawPart of field.split(',')) {
    const part = rawPart.trim();
    if (!part) throw new Error(`empty cron field segment in ${field}`);

    let base = part;
    let step = 1;
    if (part.includes('/')) {
      const pieces = part.split('/');
      if (pieces.length !== 2 || !/^\d+$/.test(pieces[1])) {
        throw new Error(`unsupported cron step ${part}`);
      }
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
      const match = base.match(/^(\d+)-(\d+)$/);
      if (!match) throw new Error(`unsupported cron field ${part}`);
      start = Number(match[1]);
      end = Number(match[2]);
    }

    if (start < min || end > max || start > end) {
      throw new Error(`cron field ${part} is outside ${min}-${max}`);
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return [...values];
}

function addSchedule(path, cron) {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    violations.push(`${path}: feed-writer cron must have five fields: ${cron}`);
    return;
  }
  const [minuteField, hourField, dayOfMonth, month, dayOfWeek] = fields;
  if (dayOfMonth !== '*' || month !== '*' || dayOfWeek !== '*') {
    violations.push(`${path}: feed-writer schedule must remain daily for collision checking: ${cron}`);
    return;
  }

  try {
    const minutes = expandCronField(minuteField, 0, 59);
    const hours = expandCronField(hourField, 0, 23);
    for (const hour of hours) {
      for (const minute of minutes) {
        const slot = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
        if (!scheduleSlots.has(slot)) scheduleSlots.set(slot, new Set());
        scheduleSlots.get(slot).add(path);
      }
    }
  } catch (error) {
    violations.push(`${path}: cannot collision-check cron ${cron}: ${error.message}`);
  }
}

function isRecurringPublicFeedWriter(text) {
  return /^\s*schedule:\s*$/m.test(text)
    && text.includes('data/jobs.json')
    && /git\s+push\s+origin\s+HEAD:main/.test(text);
}

const workflowNames = await readdir(workflowDir);
const workflowTexts = new Map();
for (const name of workflowNames.filter((name) => name.endsWith('.yml')).sort()) {
  const path = `${workflowDir}/${name}`;
  workflowTexts.set(path, await readFile(path, 'utf8'));
}

// Discover recurring public-feed writers from what they actually do rather than
// from a hand-maintained allowlist. This keeps new collectors, fallback watches,
// enrichers, and maintenance jobs from silently bypassing race/collision guards.
const feedWriters = [...workflowTexts.entries()]
  .filter(([path, text]) => path !== fullRefreshPath && isRecurringPublicFeedWriter(text))
  .map(([path]) => path);
const feedWriterSet = new Set(feedWriters);

for (const requiredPath of sharedWriterQueue) {
  if (!feedWriterSet.has(requiredPath)) {
    violations.push(`${requiredPath}: expected shared-queue writer was not discovered as a recurring public-feed writer`);
  }
}

for (const path of feedWriters) {
  const text = workflowTexts.get(path);
  const onBlock = text.match(/^on:\s*\n([\s\S]*?)^permissions:/m)?.[1] || '';
  if (!onBlock) {
    violations.push(`${path}: could not isolate the trigger block`);
    continue;
  }

  for (const sharedPath of sharedPipelinePaths) {
    if (onBlock.includes(sharedPath)) {
      violations.push(`${path}: push trigger includes shared pipeline path ${sharedPath}`);
    }
  }

  if (sharedWriterQueue.has(path) && !/group:\s*careers-source-writers\b/.test(text)) {
    violations.push(`${path}: staggered shared-feed writer must use careers-source-writers concurrency`);
  }
  if (sharedWriterQueue.has(path) && !/queue:\s*max\b/.test(text)) {
    violations.push(`${path}: shared-feed writer must use queue: max so pending employer refreshes are not replaced`);
  }

  const crons = [...onBlock.matchAll(/cron:\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
  if (!crons.length) {
    violations.push(`${path}: recurring public-feed writer must have a scheduled refresh`);
  }
  for (const cron of crons) addSchedule(path, cron);

  if (!/cancel-in-progress:\s*false\b/.test(text)) {
    violations.push(`${path}: source refreshes must not cancel an in-progress run`);
  }

  for (const marker of raceSafeMarkers) {
    if (!text.includes(marker)) {
      violations.push(`${path}: race-safe source publication is missing ${marker}`);
    }
  }
  if (/git\s+rebase\s+origin\/main/.test(text)) {
    violations.push(`${path}: generated source data must rebuild from latest main instead of rebasing a stale snapshot`);
  }
}

for (const [slot, paths] of scheduleSlots) {
  if (paths.size > 1) {
    const names = [...paths].map((path) => path.split('/').pop()).sort().join(', ');
    violations.push(`scheduled public-feed collision at ${slot} UTC: ${names}`);
  }
}

// The full refresh writes the same generated feed as the source-specific
// workflows. It may keep its deployment-oriented concurrency policy, but its
// publication path must follow the same fresh-main rebuild rule.
const fullRefreshText = workflowTexts.get(fullRefreshPath) || await readFile(fullRefreshPath, 'utf8');
for (const marker of raceSafeMarkers) {
  if (!fullRefreshText.includes(marker)) {
    violations.push(`${fullRefreshPath}: race-safe full-refresh publication is missing ${marker}`);
  }
}
if (/git\s+rebase\s+origin\/main/.test(fullRefreshText)) {
  violations.push(`${fullRefreshPath}: generated full-refresh data must rebuild from latest main instead of rebasing a stale snapshot`);
}

if (violations.length) {
  for (const violation of violations) console.error(`Source workflow isolation violation: ${violation}`);
  throw new Error(`Blocked ${violations.length} source-workflow isolation regression(s).`);
}

console.log(`Source workflow isolation guard passed for ${feedWriters.length} auto-discovered recurring public-feed writers; all enforce fresh-main rebuilds and have no exact UTC schedule collisions. ${sharedWriterQueue.size} shared-queue writers retain the guarded careers-source-writers queue with queue: max.`);
