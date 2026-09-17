import { readFile, writeFile } from 'node:fs/promises';

const COMPANY = 'Meta';
const SNAPSHOT_PATH = 'data/meta-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const PREVIOUS_SNAPSHOT_PATH = process.env.META_PREVIOUS_SNAPSHOT_PATH || '/tmp/meta-jobs-before.json';
const PREVIOUS_JOBS_PATH = process.env.META_PREVIOUS_JOBS_PATH || '/tmp/meta-jobs-public-before.json';
const MIN_DETAIL_ATTEMPTS = 10;
const MIN_HEALTHY_SITEMAP_JOBS = 50;

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

function metaRole(job) {
  return clean(job?.company) === COMPANY;
}

function canonicalId(job) {
  const id = clean(job?.id).match(/^meta-(\d+)$/i)?.[1];
  if (id) return id;
  try {
    const parsed = new URL(clean(job?.sourceUrl));
    if (!/(^|\.)metacareers\.com$/i.test(parsed.hostname)) return '';
    return parsed.pathname.match(/\/(?:profile\/job_details|jobs)\/(\d+)/i)?.[1] || '';
  } catch {
    return '';
  }
}

function healthState(metaStatus = {}) {
  const diagnostics = metaStatus?.diagnostics || {};
  const attempts = Number(diagnostics.detailAttempted || 0);
  const succeeded = Number(diagnostics.detailSucceeded || 0);
  const fetchDrops = Number(diagnostics?.drops?.fetch || 0);
  const discoveryHealthy = Number(diagnostics.searchPagesSucceeded || 0) > 0 ||
    (diagnostics.sitemapFetched === true && Number(diagnostics.sitemapJobs || 0) >= MIN_HEALTHY_SITEMAP_JOBS);
  const detailVerificationHealthy = attempts > 0 ? succeeded > 0 : null;
  const collapsed = discoveryHealthy && attempts >= MIN_DETAIL_ATTEMPTS && succeeded === 0 && fetchDrops >= attempts;
  return { attempts, succeeded, fetchDrops, discoveryHealthy, detailVerificationHealthy, collapsed };
}

function restoreMetaState(currentJobs, previousJobs, previousSnapshot) {
  const previousIds = new Set(previousSnapshot.map(canonicalId).filter(Boolean));
  const priorPublicById = new Map(
    previousJobs
      .filter(metaRole)
      .map(job => [canonicalId(job), job])
      .filter(([id]) => id && previousIds.has(id))
  );
  const restoredMeta = previousSnapshot.map(job => {
    const id = canonicalId(job);
    return priorPublicById.get(id) || job;
  });
  return [...currentJobs.filter(job => !metaRole(job)), ...restoredMeta];
}

function recalcCounts(status, jobs) {
  status.jobs = jobs.length;
  status.countsByType = jobs.reduce((acc, job) => {
    const key = clean(job?.type) || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  status.countsByExperience = jobs.reduce((acc, job) => {
    const key = clean(job?.experience) || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function runSelfTest() {
  const collapsed = healthState({ diagnostics: {
    searchPagesSucceeded: 2,
    sitemapFetched: true,
    sitemapJobs: 992,
    detailAttempted: 40,
    detailSucceeded: 0,
    drops: { fetch: 40 }
  }});
  if (!collapsed.collapsed || collapsed.detailVerificationHealthy !== false) {
    throw new Error('Meta detail-collapse detector did not fail closed on total detail failure.');
  }

  const partial = healthState({ diagnostics: {
    sitemapFetched: true,
    sitemapJobs: 992,
    detailAttempted: 40,
    detailSucceeded: 3,
    drops: { fetch: 37 }
  }});
  if (partial.collapsed || partial.detailVerificationHealthy !== true) {
    throw new Error('Meta detail-collapse detector rejected a partially verified refresh.');
  }

  const priorSnapshot = [{ id: 'meta-123', company: COMPANY, title: 'Critical Facility Engineer', sourceUrl: 'https://www.metacareers.com/profile/job_details/123/' }];
  const priorJobs = [{ ...priorSnapshot[0], region: 'texas' }, { id: 'other-1', company: 'Other' }];
  const restored = restoreMetaState([{ id: 'other-2', company: 'Other' }], priorJobs, priorSnapshot);
  if (restored.length !== 2 || restored.filter(metaRole).length !== 1 || restored.find(metaRole)?.region !== 'texas') {
    throw new Error('Meta prior verified public state was not restored exactly once.');
  }

  console.log('Meta detail-collapse failover regression tests passed.');
}

if (process.argv.includes('--test')) {
  runSelfTest();
  process.exit(0);
}

const status = await readJson(STATUS_PATH, {});
const currentJobs = await readJson(JOBS_PATH, []);
const currentSnapshot = await readJson(SNAPSHOT_PATH, []);
const previousSnapshot = await readJson(PREVIOUS_SNAPSHOT_PATH, []);
const previousJobs = await readJson(PREVIOUS_JOBS_PATH, []);

if (!status || typeof status !== 'object' || Array.isArray(status)) throw new Error(`${STATUS_PATH} must contain an object.`);
if (!Array.isArray(currentJobs) || !Array.isArray(currentSnapshot) || !Array.isArray(previousSnapshot) || !Array.isArray(previousJobs)) {
  throw new Error('Meta detail-collapse failover inputs must all be JSON arrays.');
}

const metaStatus = status.metaCareers || {};
const health = healthState(metaStatus);
status.metaCareers = {
  ...metaStatus,
  discoveryHealthy: health.discoveryHealthy,
  detailVerificationHealthy: health.detailVerificationHealthy
};

if (!health.collapsed) {
  status.metaCareers.detailVerificationCollapse = false;
  await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
  console.log(`Meta detail verification did not collapse (${health.succeeded}/${health.attempts} detail requests succeeded).`);
  process.exit(0);
}

const restoredJobs = restoreMetaState(currentJobs, previousJobs, previousSnapshot);
status.metaCareers = {
  ...status.metaCareers,
  sourceHealthy: false,
  qualifyingRoles: previousSnapshot.length,
  usedPreviousSnapshot: previousSnapshot.length > 0,
  detailVerificationCollapse: true,
  degradedReason: `Official Meta discovery remained reachable, but all ${health.attempts} attempted detail verifications failed. Prior verified roles were retained pending detail recovery and liveness pruning.`
};

const collapseMessage = `Meta Careers: detail verification collapsed (${health.succeeded}/${health.attempts} succeeded); publication is using only the prior verified Meta snapshot until detail verification recovers.`;
status.errors = [
  ...(Array.isArray(status.errors) ? status.errors : []).filter(error => !String(error).startsWith('Meta Careers: detail verification collapsed')),
  collapseMessage
];
recalcCounts(status, restoredJobs);

await writeFile(SNAPSHOT_PATH, JSON.stringify(previousSnapshot, null, 2) + '\n');
await writeFile(JOBS_PATH, JSON.stringify(restoredJobs, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');

console.warn(`Meta detail verification collapsed after ${health.attempts} attempts; restored ${previousSnapshot.length} previously verified Meta role(s) and marked the source degraded.`);
