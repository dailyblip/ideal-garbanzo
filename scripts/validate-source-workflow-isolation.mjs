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

// These writers have completed the migration away from destructive site-wide
// QA inside a source-specific refresh. Keep that isolation from regressing as
// the remaining shared writers are migrated independently.
const liveQaIsolatedWriters = new Set([
  '.github/workflows/cloudhq-bootstrap.yml',
  '.github/workflows/cologix-bootstrap.yml',
  '.github/workflows/compass-bootstrap.yml',
  '.github/workflows/coreweave-bootstrap.yml',
  '.github/workflows/databank-bootstrap.yml',
  '.github/workflows/digital-realty-bootstrap.yml',
  '.github/workflows/flexential-bootstrap.yml',
  '.github/workflows/switch-bootstrap.yml'
]);

// Retained as a compatibility contract for the stale-prune isolation validator.
// The main source guard no longer relies on this list for discovery.
const scheduledPrimaryWriters = new Set([
  '.github/workflows/aws-detail-recovery.yml',
  '.github/workflows/compass-bootstrap.yml',
  '.github/workflows/iron-mountain-bootstrap.yml',
  '.github/workflows/meta-bootstrap.yml',
  '.github/workflows/microsoft-bootstrap.yml',
  '.github/workflows/oracle-bootstrap.yml',
  '.github/workflows/sabey-bootstrap.yml',
  '.github/workflows/tierpoint-bootstrap.yml'
]);

const raceSafeMarkers = [
  'rebuild_from_latest_main()',
  'git reset --hard origin/main',
  'for attempt in 1 2 3',
  'if git push origin HEAD:main; then'
];

// All previously baselined schedule collisions have been removed. Keep this
// set as an explicit escape hatch only if a future migration needs to land in
// stages; any newly introduced collision otherwise fails CI immediately.
const knownCollisionGroups = new Set();

const sourceWriterNamePattern = /(bootstrap|fallback|skillbridge|targeted-recovery|verified-evidence|detail-recovery)/i;
const violations = [];
const scheduleSlots = new Map();
const warnings = [];

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
      const match = base.match(/^(\d+)-(\d+)$/);
      if (!match) throw new Error(`unsupported cron field ${part}`);
      start = Number(match[1]);
      end = Number(match[2]);
    }

    if (start < min || end > max || start > end) throw new Error(`cron field ${part} is outside ${min}-${max}`);
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

function isRecurringSourceFeedWriter(path, text) {
  return sourceWriterNamePattern.test(path)
    && /^\s*schedule:\s*$/m.test(text)
    && text.includes('data/jobs.json')
    && /git\s+push\s+origin\s+HEAD:main/.test(text);
}

const workflowNames = await readdir(workflowDir);
const workflowTexts = new Map();
for (const name of workflowNames.filter((name) => name.endsWith('.yml')).sort()) {
  const path = `${workflowDir}/${name}`;
  workflowTexts.set(path, await readFile(path, 'utf8'));
}

// Discover recurring source-specific public-feed writers from what they actually
// do rather than a hand-maintained list. New collectors and watchdogs therefore
// inherit race, trigger-isolation and schedule checks automatically.
const feedWriters = [...workflowTexts.entries()]
  .filter(([path, text]) => path !== fullRefreshPath && isRecurringSourceFeedWriter(path, text))
  .map(([path]) => path);
const feedWriterSet = new Set(feedWriters);

for (const requiredPath of sharedWriterQueue) {
  if (!feedWriterSet.has(requiredPath)) {
    violations.push(`${requiredPath}: expected shared-queue writer was not discovered as a recurring source-feed writer`);
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
    if (onBlock.includes(sharedPath)) violations.push(`${path}: push trigger includes shared pipeline path ${sharedPath}`);
  }

  if (sharedWriterQueue.has(path) && !/group:\s*careers-source-writers\b/.test(text)) {
    violations.push(`${path}: staggered shared-feed writer must use careers-source-writers concurrency`);
  }
  if (sharedWriterQueue.has(path) && !/queue:\s*max\b/.test(text)) {
    violations.push(`${path}: shared-feed writer must use queue: max so pending employer refreshes are not replaced`);
  }
  if (liveQaIsolatedWriters.has(path) && /scripts\/qa-site\.mjs/.test(text)) {
    violations.push(`${path}: isolated source writer must not run site-wide live QA; destructive cross-employer pruning belongs to the full refresh/deploy pipeline`);
  }

  const crons = [...onBlock.matchAll(/cron:\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
  if (!crons.length) violations.push(`${path}: recurring source-feed writer must have a scheduled refresh`);
  for (const cron of crons) addSchedule(path, cron);

  if (!/cancel-in-progress:\s*false\b/.test(text)) {
    violations.push(`${path}: source refreshes must not cancel an in-progress run`);
  }

  for (const marker of raceSafeMarkers) {
    if (!text.includes(marker)) violations.push(`${path}: race-safe source publication is missing ${marker}`);
  }
  if (/git\s+rebase\s+origin\/main/.test(text)) {
    violations.push(`${path}: generated source data must rebuild from latest main instead of rebasing a stale snapshot`);
  }
}

const seenKnownCollisionGroups = new Set();
for (const [slot, paths] of scheduleSlots) {
  if (paths.size <= 1) continue;
  const names = [...paths].map((path) => path.split('/').pop()).sort();
  const groupKey = names.join('|');
  if (knownCollisionGroups.has(groupKey)) {
    seenKnownCollisionGroups.add(groupKey);
    warnings.push(`known scheduled source-feed collision at ${slot} UTC: ${names.join(', ')}`);
  } else {
    violations.push(`NEW scheduled source-feed collision at ${slot} UTC: ${names.join(', ')}`);
  }
}

for (const group of knownCollisionGroups) {
  if (!seenKnownCollisionGroups.has(group)) {
    violations.push(`remove resolved collision baseline from knownCollisionGroups: ${group}`);
  }
}

const fullRefreshText = workflowTexts.get(fullRefreshPath) || await readFile(fullRefreshPath, 'utf8');
for (const marker of raceSafeMarkers) {
  if (!fullRefreshText.includes(marker)) violations.push(`${fullRefreshPath}: race-safe full-refresh publication is missing ${marker}`);
}
if (/git\s+rebase\s+origin\/main/.test(fullRefreshText)) {
  violations.push(`${fullRefreshPath}: generated full-refresh data must rebuild from latest main instead of rebasing a stale snapshot`);
}

for (const warning of warnings) console.warn(`Source workflow isolation warning: ${warning}`);
if (violations.length) {
  for (const violation of violations) console.error(`Source workflow isolation violation: ${violation}`);
  throw new Error(`Blocked ${violations.length} source-workflow isolation regression(s).`);
}

console.log(`Source workflow isolation guard passed for ${feedWriters.length} auto-discovered recurring source-feed writers. New writer omissions and new exact UTC schedule collisions are blocked; ${knownCollisionGroups.size} pre-existing collision groups remain explicitly baselined for removal.`);
