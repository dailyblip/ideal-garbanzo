import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const JOBS_PATH = 'data/jobs.json';
const MAJOR_PATH = 'data/major-jobs.json';
const STATUS_PATH = 'data/collector-status.json';

async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

async function readCommittedJson(path) {
  try {
    const { stdout } = await exec('git', ['show', `HEAD:${path}`], { maxBuffer: 20 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function companyCounts(jobs = []) {
  const counts = new Map();
  for (const job of jobs) {
    const company = String(job?.company || '').trim();
    if (!company) continue;
    counts.set(company, (counts.get(company) || 0) + 1);
  }
  return counts;
}

function fieldCounts(jobs = [], field) {
  const counts = new Map();
  for (const job of jobs) {
    const value = String(job?.[field] || '').trim();
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return counts;
}

function pct(current, previous) {
  return previous > 0 ? Math.round((current / previous) * 100) : 100;
}

const currentJobs = await readJson(JOBS_PATH, []);
const currentMajor = await readJson(MAJOR_PATH, []);
const status = await readJson(STATUS_PATH, {});
const previousJobs = await readCommittedJson(JOBS_PATH);
const previousMajor = await readCommittedJson(MAJOR_PATH);
const previousStatus = await readCommittedJson(STATUS_PATH);

if (!Array.isArray(currentJobs) || !Array.isArray(currentMajor)) {
  throw new Error('Refresh health check requires jobs.json and major-jobs.json arrays.');
}

const problems = [];
const warnings = [];

if (Array.isArray(previousJobs) && previousJobs.length >= 50) {
  const ratio = currentJobs.length / previousJobs.length;
  if (ratio < 0.60) {
    problems.push(`Total feed collapsed from ${previousJobs.length} to ${currentJobs.length} jobs (${pct(currentJobs.length, previousJobs.length)}% of prior snapshot).`);
  }

  // The product is specifically for people entering the field. A healthy total
  // job count can hide a broken internship/apprenticeship collector, so protect
  // those opportunity types independently from the overall feed-size guard.
  const beforeTypes = fieldCounts(previousJobs, 'type');
  const afterTypes = fieldCounts(currentJobs, 'type');
  for (const type of ['apprenticeship', 'internship', 'trainee']) {
    const previousCount = beforeTypes.get(type) || 0;
    const currentCount = afterTypes.get(type) || 0;
    if (previousCount >= 2 && currentCount === 0) {
      problems.push(`${type} opportunities dropped from ${previousCount} to zero in one refresh.`);
    } else if (previousCount >= 4 && currentCount < Math.ceil(previousCount * 0.40)) {
      warnings.push(`${type} opportunities dropped from ${previousCount} to ${currentCount}; verify the early-career collectors.`);
    }
  }

  const beforeExperience = fieldCounts(previousJobs, 'experience');
  const afterExperience = fieldCounts(currentJobs, 'experience');
  for (const experience of ['no-experience', '0-2-years']) {
    const previousCount = beforeExperience.get(experience) || 0;
    const currentCount = afterExperience.get(experience) || 0;
    if (previousCount >= 5 && currentCount < Math.ceil(previousCount * 0.35)) {
      problems.push(`${experience} opportunities dropped from ${previousCount} to ${currentCount} in one refresh.`);
    }
  }
}

if (Array.isArray(previousMajor) && previousMajor.length >= 30) {
  const ratio = currentMajor.length / previousMajor.length;
  if (ratio < 0.50) {
    problems.push(`Major-employer feed collapsed from ${previousMajor.length} to ${currentMajor.length} jobs (${pct(currentMajor.length, previousMajor.length)}% of prior snapshot).`);
  }

  const before = companyCounts(previousMajor);
  const after = companyCounts(currentMajor);
  for (const [company, previousCount] of before) {
    const currentCount = after.get(company) || 0;
    if (previousCount >= 8 && currentCount === 0) {
      problems.push(`${company} dropped from ${previousCount} qualifying jobs to zero in one refresh.`);
      continue;
    }
    if (previousCount >= 15 && currentCount < Math.ceil(previousCount * 0.25)) {
      problems.push(`${company} dropped from ${previousCount} to ${currentCount} qualifying jobs in one refresh.`);
    }
  }
}

const attempted = Number(status?.majorSources?.attempted || 0);
const succeeded = Number(status?.majorSources?.succeeded || 0);
if (attempted && succeeded < attempted) {
  warnings.push(`Major-employer source health: ${succeeded}/${attempted} collectors succeeded; failed sources should be running from their retained snapshot.`);
}

const expectedMajorEmployers = [
  'Vantage Data Centers',
  'QTS Data Centers',
  'CyrusOne',
  'STACK Infrastructure',
  'NTT Global Data Centers',
  'Aligned Data Centers'
];
const configuredMajorEmployers = new Set(Array.isArray(status?.majorSources?.employers) ? status.majorSources.employers : []);
for (const employer of expectedMajorEmployers) {
  if (!configuredMajorEmployers.has(employer)) {
    problems.push(`Priority major-employer coverage is missing ${employer} from collector status.`);
  }
}

// Dedicated official-source collectors are the backbone for the largest
// operators. Missing status entirely means a collector did not execute or its
// result was overwritten, which is different from a healthy collector finding
// zero qualifying 0–5 year roles on a given day.
const dedicatedSources = [
  ['AWS', status?.amazonDatacenter, previousStatus?.amazonDatacenter],
  ['Microsoft', status?.microsoftDatacenter, previousStatus?.microsoftDatacenter],
  ['Google Careers', status?.googleCareers, previousStatus?.googleCareers],
  ['Meta Careers', status?.metaCareers, previousStatus?.metaCareers],
  ['Oracle Careers', status?.oracleCareers, previousStatus?.oracleCareers],
  ['Digital Realty', status?.digitalRealty, previousStatus?.digitalRealty],
  ['Equinix', status?.priorityEmployerExpansion?.Equinix, previousStatus?.priorityEmployerExpansion?.Equinix]
];

for (const [label, source, previousSource] of dedicatedSources) {
  if (!source || typeof source !== 'object') {
    problems.push(`${label} official-source collector status is missing after refresh.`);
    continue;
  }

  if (source.sourceHealthy === false) {
    warnings.push(`${label} source reported degraded health and should retain its previous snapshot.`);
  }

  if (label === 'Equinix') {
    const listingAttempted = Number(source.listingPagesAttempted || 0);
    const listingSucceeded = Number(source.listingPagesSucceeded || 0);
    if (listingAttempted > 0 && listingSucceeded === 0) {
      warnings.push('Equinix listing pages all failed during this refresh.');
    }
  }

  const currentQualifying = Number(source.qualifyingRoles);
  const previousQualifying = Number(previousSource?.qualifyingRoles);
  if (Number.isFinite(previousQualifying) && previousQualifying >= 3 && Number.isFinite(currentQualifying) && currentQualifying === 0) {
    warnings.push(`${label} dropped from ${previousQualifying} qualifying roles to zero; confirm this is a real hiring change rather than parser drift.`);
  }
}

const equinixEarly = status?.priorityEmployerExpansion?.EquinixEarlyCareer;
if (!equinixEarly || typeof equinixEarly !== 'object') {
  problems.push('Equinix early-career recovery collector status is missing after refresh.');
} else {
  const attemptedPages = Number(equinixEarly.listingPagesAttempted || 0);
  const succeededPages = Number(equinixEarly.listingPagesSucceeded || 0);
  if (attemptedPages > 0 && succeededPages === 0) {
    warnings.push('Equinix early-career listing pages all failed during this refresh.');
  }
}

const regionAssigned = Number(status?.locationNormalization?.regionAssigned || 0);
const regionMissing = Number(status?.locationNormalization?.regionMissing || 0);
const regionTotal = regionAssigned + regionMissing;
if (regionTotal >= 50) {
  const coverage = regionAssigned / regionTotal;
  if (coverage < 0.80) {
    problems.push(`Regional filter coverage fell to ${Math.round(coverage * 100)}% (${regionAssigned}/${regionTotal} jobs).`);
  } else if (coverage < 0.95) {
    warnings.push(`Regional filter coverage fell below the 95% quality target: ${Math.round(coverage * 100)}% (${regionAssigned}/${regionTotal} jobs); review locationNormalization.missingSamples.`);
  }
}

console.log(`Refresh health: ${currentJobs.length} total jobs; ${currentMajor.length} major-employer jobs.`);
if (Array.isArray(previousJobs)) console.log(`Previous committed feed: ${previousJobs.length} total jobs.`);
if (Array.isArray(previousMajor)) console.log(`Previous committed major-employer feed: ${previousMajor.length} jobs.`);
if (regionTotal) console.log(`Regional filter coverage: ${regionAssigned}/${regionTotal} jobs (${Math.round((regionAssigned / regionTotal) * 100)}%).`);
for (const warning of warnings) console.warn(`Refresh health warning: ${warning}`);

if (problems.length) {
  for (const problem of problems) console.error(`Refresh health failure: ${problem}`);
  throw new Error('Refresh regression guard blocked a likely source/parser failure.');
}

console.log('Refresh regression guard passed.');
