import { readFile } from 'node:fs/promises';

const products = JSON.parse(await readFile('data/employer-products.json', 'utf8'));
const activations = JSON.parse(await readFile('data/featured-jobs.json', 'utf8'));
const jobs = JSON.parse(await readFile('data/jobs.json', 'utf8'));
const homepage = await readFile('index.html', 'utf8');

const tiers = {
  highlightedJob: { priceUsd: 99, durationDays: 30, label: 'Highlighted Job' },
  spotlightJob: { priceUsd: 149, durationDays: 30, label: 'Spotlight Position' }
};

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
const jobIds = new Set(jobs.map(job => String(job.id)));
const seen = new Set();
for (const [index, activation] of activations.entries()) {
  const jobId = String(activation?.jobId || '').trim();
  if (!jobId) throw new Error(`Promotion activation ${index} missing jobId`);
  if (!tiers[activation.tier]) throw new Error(`Promotion activation ${jobId} has unsupported tier: ${activation.tier || 'missing'}`);
  if (!jobIds.has(jobId)) throw new Error(`Promotion activation points to missing job: ${jobId}`);
  if (seen.has(jobId)) throw new Error(`Job has more than one active promotion record: ${jobId}`);
  seen.add(jobId);

  const starts = activation.startsAt ? Date.parse(activation.startsAt) : null;
  const expires = activation.expiresAt ? Date.parse(activation.expiresAt) : null;
  if (activation.startsAt && !Number.isFinite(starts)) throw new Error(`Promotion ${jobId} has invalid startsAt`);
  if (activation.expiresAt && !Number.isFinite(expires)) throw new Error(`Promotion ${jobId} has invalid expiresAt`);
  if (starts && expires && expires <= starts) throw new Error(`Promotion ${jobId} expires before it starts`);
}

if (/\$(?:99|149)\b/.test(homepage)) throw new Error('Promotion prices belong in checkout, not on the homepage');
for (const label of ['Highlighted Job', 'Spotlight Position']) {
  if (!homepage.includes(label)) throw new Error(`Homepage employer card missing promotion option: ${label}`);
}

console.log(`Promotion validation passed: ${checkoutOptions.length} checkout tiers and ${activations.length} active promotion records.`);
