import { readFile } from 'node:fs/promises';

const requiredFiles = ['index.html','employers/index.html','assets/styles.css','assets/app.js','data/jobs.json','data/amazon-jobs.json','data/google-jobs.json','data/career-events.json','data/featured-jobs.json','data/employer-products.json'];
for (const file of requiredFiles) {
  const value = await readFile(file, 'utf8');
  if (!value.trim()) throw new Error(`${file} is empty`);
}

const jobs = JSON.parse(await readFile('data/jobs.json', 'utf8'));
if (!Array.isArray(jobs)) throw new Error('jobs.json must contain an array');

await import('./validate-priority-employer-sources.mjs');
await import('./validate-data-freshness.mjs');

const amazonJobs = JSON.parse(await readFile('data/amazon-jobs.json', 'utf8'));
if (!Array.isArray(amazonJobs)) throw new Error('amazon-jobs.json must contain an array');
for (const [i, job] of amazonJobs.entries()) {
  if (job.company !== 'Amazon Web Services') throw new Error(`AWS snapshot job ${i} has unexpected company: ${job.company}`);
  if (!/^https:\/\/(?:www\.)?amazon\.jobs\//i.test(String(job.sourceUrl || ''))) throw new Error(`AWS snapshot job ${i} has non-Amazon sourceUrl`);
}
const googleJobs = JSON.parse(await readFile('data/google-jobs.json', 'utf8'));
if (!Array.isArray(googleJobs)) throw new Error('google-jobs.json must contain an array');
for (const [i, job] of googleJobs.entries()) {
  if (job.company !== 'Google') throw new Error(`Google snapshot job ${i} has unexpected company: ${job.company}`);
  if (!/^https:\/\/www\.google\.com\/about\/careers\/applications\/jobs\/results\//i.test(String(job.sourceUrl || ''))) throw new Error(`Google snapshot job ${i} has non-Google Careers sourceUrl`);
}

const careerEvents = JSON.parse(await readFile('data/career-events.json', 'utf8'));
if (!Array.isArray(careerEvents)) throw new Error('career-events.json must contain an array');
const careerEventIds = new Set();
const isoDate = value => {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,10) === text;
};
for (const [i, event] of careerEvents.entries()) {
  for (const key of ['id','date','name','location','organizer','url','verifiedAt','source']) {
    if (!String(event?.[key] || '').trim()) throw new Error(`Career event ${i} missing ${key}`);
  }
  if (careerEventIds.has(event.id)) throw new Error(`Duplicate career event id: ${event.id}`);
  careerEventIds.add(event.id);
  if (!isoDate(event.date)) throw new Error(`Career event ${event.id} has invalid date`);
  if (!isoDate(event.verifiedAt)) throw new Error(`Career event ${event.id} has invalid verifiedAt date`);
  if (!/^https:\/\//i.test(String(event.url))) throw new Error(`Career event ${event.id} requires an HTTPS organizer URL`);
  if (event.source !== 'Organizer page') throw new Error(`Career event ${event.id} must be verified from an organizer page`);
}
await import('./validate-career-event-freshness.mjs');

const normalizeIdentity = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const seniorTitlePattern = /\b(?:senior|sr\.?|lead|principal|chief|manager|mgr\.?|director|vice president|vp|head of|staff engineer|supervisor|superintendent|foreman|counsel|attorney|architect|recruiter|sales|account executive)\b/i;
const allowedRegions = new Set(['mid-atlantic','texas','southwest','midwest','southeast','northeast','west','nationwide']);
function canonicalTitle(job) {
  let title = String(job.title || '').trim();
  const location = normalizeIdentity(job.location);
  const locationTokens = new Set(location.split(' ').filter(token => token.length > 1));
  const tailBelongsToLocation = tail => {
    const tokens = normalizeIdentity(tail).split(' ').filter(token => token.length > 1);
    return tokens.length > 0 && tokens.every(token => locationTokens.has(token));
  };
  title = title.replace(/^\s*\d{2,5}\s*[-–—]\s*/u, '');
  title = title.replace(/\s+[-–—]\s+([^|]+)$/u, (full, tail) => tailBelongsToLocation(tail) ? '' : full);
  title = title.replace(/\s*\(([^)]+)\)\s*$/u, (full, tail) => tailBelongsToLocation(tail) ? '' : full);
  title = title.replace(/\s*[-–—,:()]?\s*(?:day|night|overnight|weekend)\s+shift(?:\s*\d+)?\s*$/iu, '');
  return normalizeIdentity(title);
}

const ids = new Set();
const urls = new Set();
const semanticJobs = new Set();
const companyTitleJobs = new Set();
let regionalJobs = 0;
for (const [i, job] of jobs.entries()) {
  for (const key of ['id','title','company','location','type','experience']) {
    if (!String(job[key] || '').trim()) throw new Error(`Job ${i} missing ${key}`);
  }
  if (ids.has(job.id)) throw new Error(`Duplicate job id: ${job.id}`);
  ids.add(job.id);
  if (!['entry-level','internship','apprenticeship','trainee'].includes(job.type)) throw new Error(`Unsupported job type: ${job.type}`);
  if (!['no-experience','0-2-years','2-5-years'].includes(job.experience)) throw new Error(`Unsupported experience band: ${job.experience}`);
  if (job.demo) throw new Error(`Demo job cannot be published: ${job.id}`);
  if (seniorTitlePattern.test(String(job.title || ''))) throw new Error(`Senior-title drift in early-career feed: ${job.title}`);
  if (!/^https:\/\//.test(job.sourceUrl || '')) throw new Error(`Real job ${job.id} missing valid sourceUrl`);
  if (urls.has(job.sourceUrl)) throw new Error(`Duplicate job URL: ${job.sourceUrl}`);
  urls.add(job.sourceUrl);
  if (job.active !== true) throw new Error(`Published real job ${job.id} is not active`);
  if (/^pay not listed$/i.test(String(job.pay || '').trim())) throw new Error(`Missing pay must be blank, not placeholder text: ${job.id}`);
  if (job.region) {
    if (!allowedRegions.has(job.region)) throw new Error(`Unsupported job region: ${job.region}`);
    regionalJobs += 1;
  }

  const company = normalizeIdentity(job.company);
  const title = canonicalTitle(job);
  const companyTitleKey = [company, title].join('|');
  if (companyTitleJobs.has(companyTitleKey)) throw new Error(`Duplicate-looking published job title: ${job.company} / ${job.title}`);
  companyTitleJobs.add(companyTitleKey);

  const semanticKey = [company, title, normalizeIdentity(job.location)].join('|');
  if (semanticJobs.has(semanticKey)) throw new Error(`Near-duplicate published job: ${job.company} / ${job.title} / ${job.location}`);
  semanticJobs.add(semanticKey);
}
if (jobs.length >= 50 && regionalJobs / jobs.length < 0.95) {
  throw new Error(`Regional filter coverage below 95%: ${regionalJobs}/${jobs.length} published jobs have a supported region.`);
}

const products = JSON.parse(await readFile('data/employer-products.json','utf8'));
const highlightedProduct = products?.highlightedJob;
const spotlightProduct = products?.spotlightJob;
if (!highlightedProduct || !spotlightProduct) throw new Error('Both employer promotion tiers are required');
if (Number(highlightedProduct.priceUsd) !== 99) throw new Error('Highlighted Job must be priced at $99');
if (Number(spotlightProduct.priceUsd) !== 149) throw new Error('Spotlight Position must be priced at $149');
for (const [key, product] of [['highlightedJob', highlightedProduct], ['spotlightJob', spotlightProduct]]) {
  if (!Number.isInteger(Number(product.durationDays)) || Number(product.durationDays) !== 30) throw new Error(`${key} must run for 30 days`);
  if (!Array.isArray(product.benefits) || product.benefits.length < 3) throw new Error(`${key} must define promotion benefits`);
}
if (products.landingPage !== 'employers/') throw new Error('Employer promotion landing page must be employers/');
if (!Array.isArray(products.checkoutOptions) || !products.checkoutOptions.includes('highlightedJob') || !products.checkoutOptions.includes('spotlightJob')) throw new Error('Checkout options must include both promotion tiers');
const featuredProduct = products?.featuredJob;
if (!featuredProduct) throw new Error('Featured-job compatibility product is missing');
if (!Number.isFinite(Number(featuredProduct.priceUsd)) || Number(featuredProduct.priceUsd) <= 0) throw new Error('Featured-job price must be positive');
if (!Number.isInteger(Number(featuredProduct.durationDays)) || Number(featuredProduct.durationDays) <= 0) throw new Error('Featured-job duration must be positive');
if (typeof featuredProduct.checkoutEnabled !== 'boolean') throw new Error('Featured-job checkoutEnabled must be boolean');
if (featuredProduct.checkoutEnabled && !/^https:\/\//.test(String(featuredProduct.checkoutUrl || ''))) throw new Error('Enabled featured-job checkout requires HTTPS');

const featuredJobs = JSON.parse(await readFile('data/featured-jobs.json','utf8'));
if (!Array.isArray(featuredJobs)) throw new Error('featured-jobs.json must contain an array');
const featuredIds = new Set();
const allowedPromotionTiers = new Set(['highlightedJob','spotlightJob']);
for (const [i, record] of featuredJobs.entries()) {
  if (!record || !String(record.jobId || '').trim()) throw new Error(`Featured job ${i} missing jobId`);
  const id = String(record.jobId);
  if (featuredIds.has(id)) throw new Error(`Duplicate featured job activation: ${id}`);
  featuredIds.add(id);
  if (!allowedPromotionTiers.has(record.tier)) throw new Error(`Featured activation ${id} has unsupported tier: ${record.tier}`);
  if (!ids.has(id) && record.example !== true) throw new Error(`Paid featured activation points to missing job: ${id}`);
  const starts = record.startsAt ? Date.parse(record.startsAt) : null;
  const expires = record.expiresAt ? Date.parse(record.expiresAt) : null;
  if (record.startsAt && !Number.isFinite(starts)) throw new Error(`Featured job ${id} has invalid startsAt`);
  if (record.expiresAt && !Number.isFinite(expires)) throw new Error(`Featured job ${id} has invalid expiresAt`);
  if (starts && expires && expires <= starts) throw new Error(`Featured job ${id} expires before it starts`);
}

const html = await readFile('index.html','utf8');
for (const phrase of ['DATA CENTER CAREER','Search jobs','CURRENT OPENINGS','CAREER EVENTS','JOB ALERTS','FOR EMPLOYERS']) {
  if (!html.includes(phrase)) throw new Error(`Required product marker missing: ${phrase}`);
}
for (const phrase of ['SKILLED WORK · MODERN INFRASTRUCTURE · REAL OPPORTUNITY','Build your future in <em>data centers.</em>','Real openings for interns, apprentices, first-time applicants and workers ready for their next step.']) {
  if (!html.includes(phrase)) throw new Error(`Approved hero copy changed: ${phrase}`);
}
if (!html.includes('id="eventsList"')) throw new Error('Homepage must render verified career events from shared data');
if (!html.includes('href="employers/">Feature a job →</a>')) throw new Error('Homepage Feature a job CTA must link to employers/');
if (/FEATURED OPPORTUNITY\s*·?\s*DEMO|Summit Data Centers/i.test(html)) throw new Error('Demo featured opportunity must not appear on the production homepage');
if (/<style[\s>]/i.test(html)) throw new Error('Inline style blocks are prohibited');
if (/\sstyle=["']/i.test(html)) throw new Error('Inline style attributes are prohibited on the homepage');
if (/hero-overrides\.css/i.test(html)) throw new Error('Obsolete hero-overrides.css must not be linked');
const stylesheetLinks = [...html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi)];
if (stylesheetLinks.length !== 1 || !stylesheetLinks[0][0].includes('assets/styles.css')) throw new Error('Homepage must use exactly one stylesheet: assets/styles.css');

const employerHtml = await readFile('employers/index.html','utf8');
for (const phrase of ['FEATURE A JOB','$99','$149','HIGHLIGHTED JOB','SPOTLIGHT POSITION','LIVE PLACEMENT EXAMPLES']) {
  if (!employerHtml.includes(phrase)) throw new Error(`Employer promotion page missing: ${phrase}`);
}
if (/<style[\s>]/i.test(employerHtml) || /\sstyle=["']/i.test(employerHtml)) throw new Error('Employer promotion page must not use inline styles');
const employerStylesheets = [...employerHtml.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi)];
if (employerStylesheets.length !== 1 || !employerStylesheets[0][0].includes('../assets/styles.css')) throw new Error('Employer promotion page must use the shared assets/styles.css stylesheet');

console.log(`Validation passed: ${jobs.length} jobs, ${amazonJobs.length} AWS jobs, ${googleJobs.length} Google jobs, ${careerEvents.length} verified career events, ${featuredJobs.length} promotion activations, ${regionalJobs} region-classified jobs, and ${requiredFiles.length} required files.`);
