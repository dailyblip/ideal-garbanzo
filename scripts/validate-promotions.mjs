import { readFile } from 'node:fs/promises';

const products = JSON.parse(await readFile('data/employer-products.json', 'utf8'));
const activations = JSON.parse(await readFile('data/featured-jobs.json', 'utf8'));
const jobs = JSON.parse(await readFile('data/jobs.json', 'utf8'));
const homepage = await readFile('index.html', 'utf8');
const employerPage = await readFile('employers/index.html', 'utf8');

const tiers = {
  highlightedJob: { priceUsd: 99, durationDays: 30, label: 'Highlighted Job' },
  spotlightJob: { priceUsd: 149, durationDays: 30, label: 'Spotlight Position' }
};
const allowedTypes = new Set(['internship', 'apprenticeship', 'trainee', 'entry-level']);
const allowedExperience = new Set(['no-experience', '0-2-years', '2-5-years']);
const now = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;

for (const [key, expected] of Object.entries(tiers)) {
  const product = products?.[key];
  if (!product) throw new Error(`Missing employer promotion tier: ${key}`);
  if (Number(product.priceUsd) !== expected.priceUsd) throw new Error(`${key} must cost $${expected.priceUsd}`);
  if (Number(product.durationDays) !== expected.durationDays) throw new Error(`${key} must run for ${expected.durationDays} days`);
  if (!Array.isArray(product.benefits) || product.benefits.length < 2) throw new Error(`${key} must define promotion benefits`);
}

const checkoutOptions = Array.isArray(products?.checkoutOptions) ? products.checkoutOptions : [];
for (const key of Object.keys(tiers)) {
  if (!checkoutOptions.includes(key)) throw new Error(`Checkout options missing ${key}`);
}
if (new Set(checkoutOptions).size !== checkoutOptions.length) throw new Error('Duplicate employer checkout option');

const checkout = products?.checkout;
if (checkout) {
  if (typeof checkout.enabled !== 'boolean') throw new Error('Employer checkout enabled flag must be boolean');
  if (checkout.enabled && !/^https:\/\//i.test(String(checkout.url || ''))) throw new Error('Enabled employer checkout requires an HTTPS URL');
}

const inquiry = products?.inquiry;
if (!inquiry || inquiry.enabled !== true) throw new Error('Employer placement inquiry must be enabled while checkout is unavailable');
if (inquiry.provider !== 'buttondown') throw new Error('Employer inquiry provider must be Buttondown');
if (!/^https:\/\//i.test(String(inquiry.endpoint || ''))) throw new Error('Employer inquiry endpoint must use HTTPS');
if (inquiry.tag !== 'employer-inquiries') throw new Error('Employer inquiry must use the employer-inquiries tag');
if (!employerPage.includes(`action="${inquiry.endpoint}"`)) throw new Error('Employer page inquiry form is not wired to the configured endpoint');
if (!employerPage.includes(`name="tag" value="${inquiry.tag}"`)) throw new Error('Employer page inquiry form is missing the configured tag');
if (!/type="email"[^>]*name="email"|name="email"[^>]*type="email"/i.test(employerPage)) throw new Error('Employer inquiry must require an email address');
if (!/type="url"[^>]*name="metadata__job_url"|name="metadata__job_url"[^>]*type="url"/i.test(employerPage)) throw new Error('Employer inquiry must collect an official job URL');
if (!employerPage.includes('name="metadata__interest" value="employer-promotion"')) throw new Error('Employer inquiry is missing promotion-interest metadata');
if (employerPage.includes('value="weekly-job-alerts"')) throw new Error('Employer inquiry must not opt advertisers into candidate job alerts');
if (!employerPage.includes('id="request-placement"')) throw new Error('Employer placement CTAs must have a request-placement destination');
if ((employerPage.match(/href="#request-placement"/g) || []).length < 2) throw new Error('Both employer promotion tiers must point to the placement inquiry');

if (!Array.isArray(activations)) throw new Error('featured-jobs.json must contain an array');
const jobsById = new Map(jobs.map(job => [String(job.id), job]));
const seen = new Set();
let lifecycleStale = 0;

for (const [index, activation] of activations.entries()) {
  const jobId = String(activation?.jobId || '').trim();
  if (!jobId) throw new Error(`Promotion activation ${index} missing jobId`);
  const tier = tiers[activation.tier];
  if (!tier) throw new Error(`Promotion activation ${jobId} has unsupported tier: ${activation.tier || 'missing'}`);

  if (!activation.startsAt) throw new Error(`Promotion ${jobId} missing startsAt`);
  if (!activation.expiresAt) throw new Error(`Promotion ${jobId} missing expiresAt`);
  const starts = Date.parse(activation.startsAt);
  const expires = Date.parse(activation.expiresAt);
  if (!Number.isFinite(starts)) throw new Error(`Promotion ${jobId} has invalid startsAt`);
  if (!Number.isFinite(expires)) throw new Error(`Promotion ${jobId} has invalid expiresAt`);
  if (expires <= starts) throw new Error(`Promotion ${jobId} expires before it starts`);

  const durationMs = expires - starts;
  const maxDurationMs = tier.durationDays * DAY_MS;
  if (durationMs > maxDurationMs) {
    throw new Error(`Promotion ${jobId} exceeds the ${tier.durationDays}-day ${activation.tier} term`);
  }

  // Expired or orphaned lifecycle records are harmless to candidates and are
  // removed by prune-promotions.mjs. They should not take the entire site
  // offline if a deploy lands before the cleanup workflow runs.
  if (expires <= now) {
    lifecycleStale += 1;
    continue;
  }

  const job = jobsById.get(jobId);
  if (!job || job.active === false || job.demo === true) {
    lifecycleStale += 1;
    continue;
  }

  if (seen.has(jobId)) throw new Error(`Job has more than one active promotion record: ${jobId}`);
  seen.add(jobId);

  if (!allowedTypes.has(job.type)) throw new Error(`Promotion ${jobId} points to unsupported role type: ${job.type || 'missing'}`);
  if (!allowedExperience.has(job.experience)) throw new Error(`Promotion ${jobId} points to unsupported experience level: ${job.experience || 'missing'}`);
  if (!/^https:\/\//i.test(String(job.sourceUrl || ''))) throw new Error(`Promotion ${jobId} requires an HTTPS employer apply URL`);
}

if (/\$(?:99|149)\b/.test(homepage)) throw new Error('Promotion prices belong in checkout, not on the homepage');
for (const label of ['Highlighted Job', 'Spotlight Position']) {
  if (!homepage.includes(label)) throw new Error(`Homepage employer card missing promotion option: ${label}`);
}

if (lifecycleStale) {
  console.warn(`Promotion lifecycle warning: ${lifecycleStale} expired/orphaned record(s) await cleanup.`);
}
console.log(`Promotion validation passed: ${checkoutOptions.length} checkout tiers, employer inquiry active, ${seen.size} live/scheduled promotion records, ${lifecycleStale} lifecycle-stale records.`);
