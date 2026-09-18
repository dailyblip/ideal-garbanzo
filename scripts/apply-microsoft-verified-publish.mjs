import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const COMPANY = 'Microsoft';
const OFFICIAL_HOST = 'apply.careers.microsoft.com';
const DEFAULT_MAX_TRANSFER_AGE_MINUTES = 90;

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const isMicrosoft = job => clean(job?.company) === COMPANY || /^https:\/\/apply\.careers\.microsoft\.com\//i.test(clean(job?.sourceUrl));

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' && fallback !== null) return fallback;
    throw error;
  }
}

function maxTransferAgeMs() {
  const configured = Number(process.env.MICROSOFT_PUBLISH_SNAPSHOT_MAX_AGE_MINUTES || DEFAULT_MAX_TRANSFER_AGE_MINUTES);
  const minutes = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_TRANSFER_AGE_MINUTES;
  return minutes * 60 * 1000;
}

function validateSnapshot(snapshot, now = Date.now()) {
  if (!snapshot || !Array.isArray(snapshot.jobs) || !snapshot.jobs.length) {
    throw new Error('Verified Microsoft publication snapshot must contain at least one role.');
  }

  const verifiedAt = Date.parse(snapshot.verifiedAt);
  const expiresAt = Date.parse(snapshot.expiresAt);
  if (!Number.isFinite(verifiedAt) || !Number.isFinite(expiresAt) || expiresAt <= verifiedAt) {
    throw new Error('Verified Microsoft publication snapshot has invalid timestamps.');
  }
  if (verifiedAt > now + 5 * 60 * 1000) {
    throw new Error('Verified Microsoft publication snapshot is dated in the future.');
  }
  if (now - verifiedAt > maxTransferAgeMs()) {
    throw new Error('Verified Microsoft publication snapshot is too old to transplant onto a newer main revision.');
  }
  if (now >= expiresAt) {
    throw new Error('Verified Microsoft publication snapshot has already expired.');
  }

  const ids = new Set();
  for (const job of snapshot.jobs) {
    if (!job || typeof job !== 'object') throw new Error('Verified Microsoft publication snapshot contains a non-object role.');
    if (clean(job.company) !== COMPANY) throw new Error(`Unexpected company in Microsoft publication snapshot: ${job.company || '(missing)'}`);

    const id = clean(job.id);
    if (!/^microsoft-\d+$/i.test(id)) throw new Error(`Microsoft publication snapshot has a non-canonical id: ${id || '(missing)'}`);
    if (ids.has(id)) throw new Error(`Microsoft publication snapshot contains duplicate id ${id}.`);
    ids.add(id);

    let url;
    try { url = new URL(clean(job.sourceUrl)); }
    catch { throw new Error(`Microsoft publication snapshot has an invalid source URL for ${id}.`); }
    const requisition = url.pathname.match(/^\/careers\/job\/(\d+)\/?$/i)?.[1];
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== OFFICIAL_HOST || !requisition) {
      throw new Error(`Microsoft publication snapshot role ${id} is not tied to a canonical employer-direct detail URL.`);
    }
    if (id.toLowerCase() !== `microsoft-${requisition}`.toLowerCase()) {
      throw new Error(`Microsoft publication snapshot id ${id} does not match requisition ${requisition}.`);
    }
    if (!['internship', 'apprenticeship', 'trainee', 'entry-level'].includes(job.type)) {
      throw new Error(`Microsoft publication snapshot role ${id} has unsupported type ${job.type || '(missing)'}.`);
    }
    if (!['no-experience', '0-2-years', '2-5-years'].includes(job.experience)) {
      throw new Error(`Microsoft publication snapshot role ${id} has unsupported experience ${job.experience || '(missing)'}.`);
    }
    if (job.active !== true || job.demo === true) {
      throw new Error(`Microsoft publication snapshot role ${id} is not an active production role.`);
    }
    if (clean(job.source) !== 'Official Microsoft Careers') {
      throw new Error(`Microsoft publication snapshot role ${id} has unexpected source label ${clean(job.source) || '(missing)'}.`);
    }
  }

  return snapshot.jobs;
}

function validateVerifiedStatus(status) {
  const microsoft = status?.microsoftDatacenter;
  if (!microsoft || microsoft.sourceHealthy !== true || microsoft.sourceMode === 'retained-previous') {
    throw new Error('Microsoft publication transplant requires a freshly healthy employer-direct collector status.');
  }
  if (Number(microsoft.detailAttempts || 0) > 0 && Number(microsoft.detailVerified || 0) !== Number(microsoft.detailAttempts || 0)) {
    throw new Error(`Microsoft publication transplant refused incomplete detail verification (${microsoft.detailVerified || 0}/${microsoft.detailAttempts || 0}).`);
  }
  return microsoft;
}

function counts(records, key) {
  return records.reduce((out, job) => {
    const value = clean(job?.[key]);
    if (value) out[value] = (out[value] || 0) + 1;
    return out;
  }, {});
}

function mergeVerifiedState(currentJobs, currentStatus, snapshot, verifiedStatusDocument, now = new Date()) {
  const verifiedJobs = validateSnapshot(snapshot, now.getTime());
  const verifiedMicrosoftStatus = validateVerifiedStatus(verifiedStatusDocument);
  const mergedJobs = [
    ...currentJobs.filter(job => !isMicrosoft(job)),
    ...verifiedJobs.map(job => ({ ...job, active: true, demo: false }))
  ];

  const currentErrors = Array.isArray(currentStatus?.errors) ? currentStatus.errors : [];
  const verifiedErrors = Array.isArray(verifiedStatusDocument?.errors) ? verifiedStatusDocument.errors : [];
  const nonMicrosoftErrors = currentErrors.filter(error => !String(error).startsWith('Microsoft Datacenter:'));
  const microsoftErrors = verifiedErrors.filter(error => String(error).startsWith('Microsoft Datacenter:'));

  return {
    jobs: mergedJobs,
    status: {
      ...currentStatus,
      updatedAt: now.toISOString(),
      jobs: mergedJobs.length,
      countsByType: counts(mergedJobs, 'type'),
      countsByExperience: counts(mergedJobs, 'experience'),
      microsoftDatacenter: verifiedMicrosoftStatus,
      errors: [...nonMicrosoftErrors, ...microsoftErrors]
    }
  };
}

function runTests() {
  const now = new Date('2026-09-18T18:00:00.000Z');
  const verifiedRole = {
    id: 'microsoft-123456789',
    title: 'Data Center Technician',
    company: COMPANY,
    location: 'Boydton, VA',
    type: 'entry-level',
    experience: '0-2-years',
    source: 'Official Microsoft Careers',
    sourceUrl: 'https://apply.careers.microsoft.com/careers/job/123456789',
    active: true,
    demo: false
  };
  const snapshot = {
    verifiedAt: '2026-09-18T17:45:00.000Z',
    expiresAt: '2026-09-22T17:45:00.000Z',
    jobs: [verifiedRole]
  };
  const verifiedStatus = {
    microsoftDatacenter: {
      sourceHealthy: true,
      sourceMode: 'eightfold-pcsx',
      detailAttempts: 1,
      detailVerified: 1,
      qualifyingRoles: 1
    },
    errors: []
  };
  const currentJobs = [
    { id: 'aws-1', title: 'Data Center Technician', company: 'Amazon Web Services', type: 'entry-level', experience: '0-2-years' },
    { ...verifiedRole, id: 'microsoft-999999999', sourceUrl: 'https://apply.careers.microsoft.com/careers/job/999999999' }
  ];
  const { jobs, status } = mergeVerifiedState(currentJobs, { errors: ['Other source: warning'] }, snapshot, verifiedStatus, now);

  if (jobs.length !== 2) throw new Error(`Microsoft publication transplant regression expected 2 merged jobs, got ${jobs.length}.`);
  if (!jobs.some(job => job.id === 'aws-1')) throw new Error('Microsoft publication transplant regression erased an unrelated employer role.');
  if (!jobs.some(job => job.id === verifiedRole.id)) throw new Error('Microsoft publication transplant regression did not install the verified Microsoft role.');
  if (jobs.some(job => job.id === 'microsoft-999999999')) throw new Error('Microsoft publication transplant regression retained stale Microsoft roles.');
  if (status.microsoftDatacenter.sourceHealthy !== true) throw new Error('Microsoft publication transplant regression lost verified collector health.');
  if (!status.errors.includes('Other source: warning')) throw new Error('Microsoft publication transplant regression erased an unrelated source warning.');

  let rejectedIncomplete = false;
  try {
    mergeVerifiedState(currentJobs, {}, snapshot, {
      microsoftDatacenter: { sourceHealthy: true, sourceMode: 'eightfold-pcsx', detailAttempts: 2, detailVerified: 1 }
    }, now);
  } catch {
    rejectedIncomplete = true;
  }
  if (!rejectedIncomplete) throw new Error('Microsoft publication transplant regression accepted incomplete detail verification.');

  console.log('Microsoft race-safe publication transplant passed regression checks.');
}

if (process.argv.includes('--test')) {
  runTests();
  process.exit(0);
}

const snapshotPath = process.argv[2];
const verifiedStatusPath = process.argv[3];
if (!snapshotPath || !verifiedStatusPath) {
  throw new Error('Usage: node scripts/apply-microsoft-verified-publish.mjs <verified-snapshot.json> <verified-status.json>');
}

const currentJobs = await readJson(JOBS_PATH);
const currentStatus = await readJson(STATUS_PATH, {});
const snapshot = await readJson(snapshotPath);
const verifiedStatusDocument = await readJson(verifiedStatusPath);
if (!Array.isArray(currentJobs)) throw new Error('data/jobs.json must contain an array.');

const merged = mergeVerifiedState(currentJobs, currentStatus, snapshot, verifiedStatusDocument);
await writeFile(JOBS_PATH, JSON.stringify(merged.jobs, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(merged.status, null, 2) + '\n');
await writeFile('data/microsoft-jobs.json', JSON.stringify(snapshot, null, 2) + '\n');

console.log(`Applied ${snapshot.jobs.length} freshly verified Microsoft role(s) onto the latest main revision without another employer crawl.`);
