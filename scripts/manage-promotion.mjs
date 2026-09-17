import { readFile, writeFile } from 'node:fs/promises';

const DAY_MS = 24 * 60 * 60 * 1000;
const JOBS_PATH = 'data/jobs.json';
const ACTIVATIONS_PATH = 'data/featured-jobs.json';
const PRODUCTS_PATH = 'data/employer-products.json';
const allowedTypes = new Set(['internship', 'apprenticeship', 'trainee', 'entry-level']);
const allowedExperience = new Set(['no-experience', '0-2-years', '2-5-years']);
const paidTiers = new Set(['highlightedJob', 'spotlightJob']);

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const asTime = value => {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : NaN;
};

function eligibleJob(job) {
  if (!job) return 'job is not present in the current verified feed';
  if (job.active !== true) return 'job is not active';
  if (job.demo === true) return 'demo jobs cannot be promoted';
  if (!allowedTypes.has(job.type)) return `unsupported role type: ${job.type || 'missing'}`;
  if (!allowedExperience.has(job.experience)) return `unsupported experience level: ${job.experience || 'missing'}`;
  if (!/^https:\/\//i.test(clean(job.sourceUrl))) return 'job does not have an HTTPS employer source URL';
  return '';
}

function normalizeProducts(products) {
  const normalized = new Map();
  for (const tier of paidTiers) {
    const product = products?.[tier];
    const days = Number(product?.durationDays);
    if (!product || !Number.isInteger(days) || days < 1 || days > 30) {
      throw new Error(`Promotion product ${tier} must define a duration from 1 to 30 days.`);
    }
    normalized.set(tier, { durationDays: days, priceUsd: Number(product.priceUsd) });
  }
  return normalized;
}

function activeForJob(activations, jobId, nowMs) {
  return activations.filter(item => {
    if (clean(item?.jobId) !== jobId) return false;
    const starts = asTime(item?.startsAt);
    const expires = asTime(item?.expiresAt);
    return Number.isFinite(starts) && Number.isFinite(expires) && starts <= nowMs && expires > nowMs;
  });
}

function plannedChange({ action, jobId, tier, nowMs, jobs, activations, products }) {
  if (!['activate', 'replace', 'deactivate'].includes(action)) {
    throw new Error('PROMOTION_ACTION must be activate, replace, or deactivate.');
  }
  if (!jobId) throw new Error('PROMOTION_JOB_ID is required.');
  if (!Array.isArray(jobs)) throw new Error('jobs.json must contain an array.');
  if (!Array.isArray(activations)) throw new Error('featured-jobs.json must contain an array.');
  if (!Number.isFinite(nowMs)) throw new Error('Promotion clock is invalid.');

  const jobsById = new Map(jobs.map(job => [clean(job?.id), job]));
  const job = jobsById.get(jobId);
  const eligibilityError = eligibleJob(job);
  if (eligibilityError && action !== 'deactivate') {
    throw new Error(`Cannot promote ${jobId}: ${eligibilityError}.`);
  }

  const current = activeForJob(activations, jobId, nowMs);
  if (action === 'deactivate') {
    const remaining = activations.filter(item => clean(item?.jobId) !== jobId);
    if (remaining.length === activations.length) {
      throw new Error(`No promotion record exists for ${jobId}; refusing a no-op deactivation.`);
    }
    return { activations: remaining, summary: `Deactivated promotion for ${jobId}.` };
  }

  if (!paidTiers.has(tier)) throw new Error('PROMOTION_TIER must be highlightedJob or spotlightJob.');
  const productMap = normalizeProducts(products);
  if (action === 'activate' && current.length) {
    throw new Error(`Job ${jobId} already has an active promotion; use replace for an intentional tier or term reset.`);
  }

  // Remove all prior records for the target job. For activate this only clears
  // expired/orphaned history; replace is the explicit path for resetting a live term.
  const remaining = activations.filter(item => clean(item?.jobId) !== jobId);
  const product = productMap.get(tier);
  const startsAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + product.durationDays * DAY_MS).toISOString();
  const activation = { jobId, tier, startsAt, expiresAt };
  return {
    activations: [...remaining, activation],
    summary: `${action === 'replace' ? 'Replaced' : 'Activated'} ${tier} for ${jobId} through ${expiresAt}.`
  };
}

function runSelfTest() {
  const nowMs = Date.parse('2026-09-17T12:00:00Z');
  const products = {
    highlightedJob: { durationDays: 30, priceUsd: 99 },
    spotlightJob: { durationDays: 30, priceUsd: 149 }
  };
  const validJob = {
    id: 'job-1', active: true, demo: false, type: 'entry-level', experience: '0-2-years',
    sourceUrl: 'https://careers.example.com/jobs/1'
  };
  const jobs = [validJob, { ...validJob, id: 'demo', demo: true }, { ...validJob, id: 'senior', experience: '8-years' }];

  const activated = plannedChange({ action: 'activate', jobId: 'job-1', tier: 'highlightedJob', nowMs, jobs, activations: [], products });
  if (activated.activations.length !== 1) throw new Error('Self-test failed: activation record not created.');
  const duration = asTime(activated.activations[0].expiresAt) - asTime(activated.activations[0].startsAt);
  if (duration !== 30 * DAY_MS) throw new Error('Self-test failed: activation term is not exactly 30 days.');

  let duplicateBlocked = false;
  try {
    plannedChange({ action: 'activate', jobId: 'job-1', tier: 'spotlightJob', nowMs, jobs, activations: activated.activations, products });
  } catch { duplicateBlocked = true; }
  if (!duplicateBlocked) throw new Error('Self-test failed: duplicate live activation was not blocked.');

  const replaced = plannedChange({ action: 'replace', jobId: 'job-1', tier: 'spotlightJob', nowMs, jobs, activations: activated.activations, products });
  if (replaced.activations.length !== 1 || replaced.activations[0].tier !== 'spotlightJob') {
    throw new Error('Self-test failed: explicit replacement did not replace the tier.');
  }

  const deactivated = plannedChange({ action: 'deactivate', jobId: 'job-1', tier: '', nowMs, jobs, activations: replaced.activations, products });
  if (deactivated.activations.length !== 0) throw new Error('Self-test failed: deactivation did not remove the record.');

  for (const blockedId of ['demo', 'senior', 'missing']) {
    let blocked = false;
    try {
      plannedChange({ action: 'activate', jobId: blockedId, tier: 'highlightedJob', nowMs, jobs, activations: [], products });
    } catch { blocked = true; }
    if (!blocked) throw new Error(`Self-test failed: ineligible job ${blockedId} was promotable.`);
  }

  const expired = [{ jobId: 'job-1', tier: 'highlightedJob', startsAt: '2026-08-01T00:00:00Z', expiresAt: '2026-08-31T00:00:00Z' }];
  const renewed = plannedChange({ action: 'activate', jobId: 'job-1', tier: 'highlightedJob', nowMs, jobs, activations: expired, products });
  if (renewed.activations.length !== 1 || renewed.activations[0].startsAt !== new Date(nowMs).toISOString()) {
    throw new Error('Self-test failed: expired target history was not safely replaced by a fresh term.');
  }

  console.log('Promotion admin self-test passed: activate, replace, deactivate, duplicate protection, eligibility gating, and expired-term renewal.');
}

const args = new Set(process.argv.slice(2));
if (args.has('--self-test')) {
  runSelfTest();
} else {
  const action = clean(process.env.PROMOTION_ACTION);
  const jobId = clean(process.env.PROMOTION_JOB_ID);
  const tier = clean(process.env.PROMOTION_TIER);
  const nowOverride = clean(process.env.PROMOTION_NOW);
  const nowMs = nowOverride ? asTime(nowOverride) : Date.now();
  const dryRun = args.has('--dry-run');

  const [jobs, activations, products] = await Promise.all([
    readFile(JOBS_PATH, 'utf8').then(JSON.parse),
    readFile(ACTIVATIONS_PATH, 'utf8').then(JSON.parse),
    readFile(PRODUCTS_PATH, 'utf8').then(JSON.parse)
  ]);

  const result = plannedChange({ action, jobId, tier, nowMs, jobs, activations, products });
  if (!dryRun) await writeFile(ACTIVATIONS_PATH, `${JSON.stringify(result.activations, null, 2)}\n`);
  console.log(`${dryRun ? '[dry-run] ' : ''}${result.summary}`);
}
