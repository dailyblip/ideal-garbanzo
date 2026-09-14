import { readFile } from 'node:fs/promises';

const sourceWorkflows = [
  '.github/workflows/aws-detail-recovery.yml',
  '.github/workflows/aws-stale-fallback-watch.yml',
  '.github/workflows/cologix-bootstrap.yml',
  '.github/workflows/compass-bootstrap.yml',
  '.github/workflows/coresite-stale-fallback-watch.yml',
  '.github/workflows/coreweave-bootstrap.yml',
  '.github/workflows/databank-bootstrap.yml',
  '.github/workflows/digital-realty-bootstrap.yml',
  '.github/workflows/digital-realty-stale-fallback-watch.yml',
  '.github/workflows/edgeconnex-bootstrap.yml',
  '.github/workflows/equinix-bootstrap.yml',
  '.github/workflows/equinix-stale-fallback-watch.yml',
  '.github/workflows/equinix-verified-evidence-watch.yml',
  '.github/workflows/flexential-bootstrap.yml',
  '.github/workflows/flexential-stale-fallback-watch.yml',
  '.github/workflows/generic-ats-stale-fallback-watch.yml',
  '.github/workflows/google-bootstrap.yml',
  '.github/workflows/google-stale-fallback-watch.yml',
  '.github/workflows/iron-mountain-bootstrap.yml',
  '.github/workflows/meta-bootstrap.yml',
  '.github/workflows/meta-stale-fallback-watch.yml',
  '.github/workflows/microsoft-bootstrap.yml',
  '.github/workflows/microsoft-stale-fallback-watch.yml',
  '.github/workflows/novva-bootstrap.yml',
  '.github/workflows/oracle-bootstrap.yml',
  '.github/workflows/oracle-stale-fallback-watch.yml',
  '.github/workflows/sabey-bootstrap.yml',
  '.github/workflows/stream-data-centers-bootstrap.yml',
  '.github/workflows/switch-bootstrap.yml',
  '.github/workflows/t5-data-centers-bootstrap.yml',
  '.github/workflows/tierpoint-bootstrap.yml',
  '.github/workflows/major-workday-targeted-recovery.yml'
];

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
  '.github/workflows/cologix-bootstrap.yml',
  '.github/workflows/coreweave-bootstrap.yml',
  '.github/workflows/databank-bootstrap.yml',
  '.github/workflows/digital-realty-bootstrap.yml',
  '.github/workflows/edgeconnex-bootstrap.yml',
  '.github/workflows/equinix-bootstrap.yml',
  '.github/workflows/flexential-bootstrap.yml',
  '.github/workflows/google-bootstrap.yml',
  '.github/workflows/novva-bootstrap.yml',
  '.github/workflows/stream-data-centers-bootstrap.yml',
  '.github/workflows/switch-bootstrap.yml',
  '.github/workflows/t5-data-centers-bootstrap.yml'
]);

// Every workflow that rebuilds or reconciles the shared public feed must never
// rebase generated JSON from a stale checkout. If another writer moves main while
// collection is running, rebuild against that newest revision and retry the push
// so unrelated employer updates cannot be silently overwritten.
const raceSafeWriters = new Set(sourceWorkflows);

const raceSafeMarkers = [
  'rebuild_from_latest_main()',
  'git reset --hard origin/main',
  'for attempt in 1 2 3',
  'if git push origin HEAD:main; then'
];

const violations = [];
const sharedWriterScheduleSlots = new Map();

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

function addSharedSchedule(path, cron) {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    violations.push(`${path}: shared writer cron must have five fields: ${cron}`);
    return;
  }
  const [minuteField, hourField, dayOfMonth, month, dayOfWeek] = fields;
  if (dayOfMonth !== '*' || month !== '*' || dayOfWeek !== '*') {
    violations.push(`${path}: shared writer schedule must remain daily for collision checking: ${cron}`);
    return;
  }

  try {
    const minutes = expandCronField(minuteField, 0, 59);
    const hours = expandCronField(hourField, 0, 23);
    for (const hour of hours) {
      for (const minute of minutes) {
        const slot = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
        if (!sharedWriterScheduleSlots.has(slot)) sharedWriterScheduleSlots.set(slot, new Set());
        sharedWriterScheduleSlots.get(slot).add(path);
      }
    }
  } catch (error) {
    violations.push(`${path}: cannot collision-check cron ${cron}: ${error.message}`);
  }
}

for (const path of sourceWorkflows) {
  const text = await readFile(path, 'utf8');
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

  if (sharedWriterQueue.has(path)) {
    if (!/group:\s*careers-source-writers\b/.test(text)) {
      violations.push(`${path}: staggered shared-feed writer must use careers-source-writers concurrency`);
    }
    const crons = [...onBlock.matchAll(/cron:\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
    if (!crons.length) {
      violations.push(`${path}: shared-feed writer must have a scheduled refresh`);
    }
    for (const cron of crons) addSharedSchedule(path, cron);
  }

  if (!/cancel-in-progress:\s*false\b/.test(text)) {
    violations.push(`${path}: source refreshes must not cancel an in-progress run`);
  }

  if (raceSafeWriters.has(path)) {
    for (const marker of raceSafeMarkers) {
      if (!text.includes(marker)) {
        violations.push(`${path}: race-safe source publication is missing ${marker}`);
      }
    }
    if (/git\s+rebase\s+origin\/main/.test(text)) {
      violations.push(`${path}: generated source data must rebuild from latest main instead of rebasing a stale snapshot`);
    }
  }
}

for (const [slot, paths] of sharedWriterScheduleSlots) {
  if (paths.size > 1) {
    const names = [...paths].map((path) => path.split('/').pop()).sort().join(', ');
    violations.push(`scheduled careers-source-writers collision at ${slot} UTC: ${names}`);
  }
}

// The daily full refresh writes the same generated feed as the source-specific
// workflows. It may keep its deployment-oriented concurrency policy, but its
// publication path must follow the same fresh-main rebuild rule.
const fullRefreshPath = '.github/workflows/pages.yml';
const fullRefreshText = await readFile(fullRefreshPath, 'utf8');
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

console.log(`Source workflow isolation guard passed for ${sourceWorkflows.length} feed-writing workflows; all ${raceSafeWriters.size} employer-direct writers and fallback watchdogs plus the full refresh enforce fresh-main rebuilds, and ${sharedWriterQueue.size} shared-queue schedules have no exact UTC collisions.`);
