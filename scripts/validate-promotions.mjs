import { readFile } from 'node:fs/promises';

const products = JSON.parse(await readFile('data/employer-products.json', 'utf8'));
const activations = JSON.parse(await readFile('data/featured-jobs.json', 'utf8'));
const jobs = JSON.parse(await readFile('data/jobs.json', 'utf8'));
const homepage = await readFile('index.html', 'utf8');

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

if (!Array.isArray(activations)) throw new Error('featured-jobs.json must contain an array');
const jobsById = new Map(jobs.map(job => [String(job.id), job]));
const seen = new Set();
for (const [index, activation] of activations.entries()) {
  const jobId = String(activation?.jobId || '').trim();
  if (!jobId) throw new Error(`Promotion activation ${index} missing jobId`);
  const tier = tiers[activation.tier];
  if (!tier) throw new Error(`Promotion activation ${jobId} has unsupported tier: ${activation.tier || 'missing'}`);
  const job = jobsById.get(jobId);
  if (!job) throw new Error(`Promotion activation points to missing job: ${jobId}`);
  if (seen.has(jobId)) throw new Error(`Job has more than one active promotion record: ${jobId}`);
  seen.add(jobId);

  if (job.active === false) throw new Error(`Promotion ${jobId} points to an inactive job`);
  if (job.demo === true) throw new Error(`Promotion ${jobId} points to a demo job`);
  if (!allowedTypes.has(job.type)) throw new Error(`Promotion ${jobId} points to unsupported role type: ${job.type || 'missing'}`);
  if (!allowedExperience.has(job.experience)) throw new Error(`Promotion ${jobId} points to unsupported experience level: ${job.experience || 'missing'}`);
  if (!/^https:\/\//i.test(String(job.sourceUrl || ''))) throw new Error(`Promotion ${jobId} requires an HTTPS employer apply URL`);

  if (!activation.startsAt) throw new Error(`Promotion ${jobId} missing startsAt`);
  if (!activation.expiresAt) throw new Error(`Promotion ${jobId} missing expiresAt`);
  const starts = Date.parse(activation.startsAt);
  const expires = Date.parse(activation.expiresAt);
  if (!Number.isFinite(starts)) throw new Error(`Promotion ${jobId} has invalid startsAt`);
  if (!Number.isFinite(expires)) throw new Error(`Promotion ${jobId} has invalid expiresAt`);
  if (expires <= starts) throw new Error(`Promotion ${jobId} expires before it starts`);
  if (expires <= now) throw new Error(`Promotion ${jobId} is expired and must be removed`);

  const durationMs = expires - starts;
  const maxDurationMs = tier.durationDays * DAY_MS;
  if (durationMs > maxDurationMs) {
    throw new Error(`Promotion ${jobId} exceeds the ${tier.durationDays}-day ${activation.tier} term`);
  }
}

if (/\$(?:99|149)\b/.test(homepage)) throw new Error('Promotion prices belong in checkout, not on the homepage');
for (const label of ['Highlighted Job', 'Spotlight Position']) {
  if (!homepage.includes(label)) throw new Error(`Homepage employer card missing promotion option: ${label}`);
}

console.log(`Promotion validation passed: ${checkoutOptions.length} checkout tiers and ${activations.length} scheduled/active promotion records.`);
