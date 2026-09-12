import { readFile } from 'node:fs/promises';

const products = JSON.parse(await readFile('data/employer-products.json', 'utf8'));
const activations = JSON.parse(await readFile('data/featured-jobs.json', 'utf8'));
const jobs = JSON.parse(await readFile('data/jobs.json', 'utf8'));
const homepage = await readFile('index.html', 'utf8');
const employerPage = await readFile('employers/index.html', 'utf8');
const inquiryScript = await readFile('assets/employer-inquiry.js', 'utf8');

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
if (inquiry.provider !== 'email') throw new Error('Employer inquiry must use a direct email handoff, not a newsletter subscription form');
const inquiryEmail = String(inquiry.email || '').trim();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inquiryEmail)) throw new Error('Employer inquiry requires a valid contact email');
if (!employerPage.includes('id="employerPlacementForm"')) throw new Error('Employer placement form is missing its runtime hook');
if (!employerPage.includes(`data-inquiry-email="${inquiryEmail}"`)) throw new Error('Employer page is not wired to the configured inquiry email');
if (!employerPage.includes(`href="mailto:${inquiryEmail}"`)) throw new Error('Employer page is missing a direct-email fallback link');
if (!employerPage.includes('src="../assets/employer-inquiry.js"')) throw new Error('Employer page is missing the inquiry email handoff script');
if (!inquiryScript.includes('event.submitter') || !inquiryScript.includes('window.location.href') || !inquiryScript.includes('mailto:')) {
  throw new Error('Employer inquiry script must preserve the selected tier and open a mailto handoff');
}
if (/buttondown\.com\/api\/emails\/embed-subscribe/i.test(employerPage)) throw new Error('Employer inquiries must not use the candidate newsletter subscription endpoint');
if (/name="tag"/i.test(employerPage)) throw new Error('Employer inquiry form must not silently attach newsletter subscriber tags');
if (!employerPage.includes('does not subscribe your address to candidate job alerts')) throw new Error('Employer inquiry must clearly state that it does not subscribe advertisers to candidate alerts');
if (!/type="email"[^>]*name="email"|name="email"[^>]*type="email"/i.test(employerPage)) throw new Error('Employer inquiry must require an email address');
if (!/type="url"[^>]*name="metadata__job_url"|name="metadata__job_url"[^>]*type="url"/i.test(employerPage)) throw new Error('Employer inquiry must collect an official job URL');
if (!employerPage.includes('id="request-placement"')) throw new Error('Employer placement CTAs must have a request-placement destination');
if ((employerPage.match(/href="#request-placement"/g) || []).length < 2) throw new Error('Both employer promotion tiers must point to the placement inquiry');
for (const key of Object.keys(tiers)) {
  const tierPattern = new RegExp(`type="submit"[^>]*name="metadata__tier"[^>]*value="${key}"|name="metadata__tier"[^>]*value="${key}"[^>]*type="submit"|value="${key}"[^>]*name="metadata__tier"[^>]*type="submit"`, 'i');
  if (!tierPattern.test(employerPage)) throw new Error(`Employer inquiry must submit the selected promotion tier: ${key}`);
}

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

// Every deployment path already invokes promotion validation. Chain the free
// standard-listing contract here so deploy-only and bot-driven main builds cannot
// bypass the same employer-submission rules that PR CI enforces.
await import('./validate-employer-submissions.mjs');

if (lifecycleStale) {
  console.warn(`Promotion lifecycle warning: ${lifecycleStale} expired/orphaned record(s) await cleanup.`);
}
console.log(`Promotion validation passed: ${checkoutOptions.length} checkout tiers, direct-email employer inquiry, ${seen.size} live/scheduled promotion records, ${lifecycleStale} lifecycle-stale records.`);
