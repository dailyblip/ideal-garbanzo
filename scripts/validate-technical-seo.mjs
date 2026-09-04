import { readFile, readdir } from 'node:fs/promises';

const clean = value => String(value ?? '').trim();
const slugify = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'job';
const jobSlug = job => `${slugify(job.title)}-${slugify(job.company).slice(0,32)}-${String(job.id || '').replace(/[^a-zA-Z0-9]/g,'').slice(-10)}`;
const errors = [];
const requireOk = (condition, message) => { if (!condition) errors.push(message); };
const PAGE_SIZE = 25;
const regions = [
  { key: 'mid-atlantic', slug: 'northern-virginia-mid-atlantic' },
  { key: 'texas', slug: 'texas' },
  { key: 'southwest', slug: 'southwest' },
  { key: 'midwest', slug: 'midwest' },
  { key: 'southeast', slug: 'southeast' },
  { key: 'northeast', slug: 'northeast' },
  { key: 'west', slug: 'west' }
];

const domain = clean(await readFile('CNAME', 'utf8')).replace(/^https?:\/\//, '').replace(/\/$/, '');
const baseUrl = `https://${domain}`;
const robots = await readFile('robots.txt', 'utf8');
const sitemap = await readFile('sitemap.xml', 'utf8');
const homepage = await readFile('index.html', 'utf8');
const employerPage = await readFile('employers/index.html', 'utf8');
const subscribedPage = await readFile('subscribed/index.html', 'utf8');
const jobsPage = await readFile('jobs/index.html', 'utf8');
const locationsPage = await readFile('locations/index.html', 'utf8');
const jobs = JSON.parse(await readFile('data/jobs.json', 'utf8'));

requireOk(domain === 'datacentercareers.us', `Unexpected canonical domain: ${domain}`);
requireOk(/User-agent:\s*\*/i.test(robots), 'robots.txt must define a default crawler policy.');
requireOk(/Allow:\s*\//i.test(robots), 'robots.txt must allow crawling of the public site.');
requireOk(robots.includes(`Sitemap: ${baseUrl}/sitemap.xml`), 'robots.txt must advertise the canonical sitemap URL.');
requireOk(!/dailyblip\.github\.io/i.test(robots), 'robots.txt must not advertise the old GitHub Pages URL.');

const requiredUrls = [
  `${baseUrl}/`,
  `${baseUrl}/jobs/`,
  `${baseUrl}/apprenticeships/`,
  `${baseUrl}/internships/`,
  `${baseUrl}/entry-level/`,
  `${baseUrl}/no-experience/`,
  `${baseUrl}/career-events/`,
  `${baseUrl}/employers/`,
  `${baseUrl}/locations/`,
  ...regions.map(region => `${baseUrl}/locations/${region.slug}/`),
  `${baseUrl}/how-to-get-a-data-center-job/`,
  `${baseUrl}/how-to-get-a-data-center-internship/`
];
for (const url of requiredUrls) requireOk(sitemap.includes(`<loc>${url}</loc>`), `Sitemap missing ${url}`);
requireOk(!sitemap.includes(`${baseUrl}/subscribed/`), 'Confirmation page must not be listed in sitemap.xml.');
requireOk(!/dailyblip\.github\.io/i.test(sitemap), 'Sitemap must not contain the old GitHub Pages domain.');
const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
requireOk(new Set(locs).size === locs.length, 'Sitemap contains duplicate URLs.');

const sitemapEntries = new Map();
for (const match of sitemap.matchAll(/<url><loc>([^<]+)<\/loc>(?:<lastmod>([^<]+)<\/lastmod>)?<\/url>/g)) {
  sitemapEntries.set(match[1], match[2] || null);
  if (!match[2]) continue;
  const parsed = Date.parse(`${match[2]}T00:00:00Z`);
  requireOk(/^\d{4}-\d{2}-\d{2}$/.test(match[2]) && Number.isFinite(parsed), `Sitemap has invalid lastmod for ${match[1]}: ${match[2]}`);
  requireOk(parsed <= Date.now() + 24 * 60 * 60 * 1000, `Sitemap lastmod is in the future for ${match[1]}: ${match[2]}`);
}

function dateOnly(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
}
function meaningfulLastmod(job) {
  return dateOnly(job.lastChangedAt) || dateOnly(job.firstSeenAt) || dateOnly(job.postedAt);
}
function maxLastmod(list) {
  const dates = list.map(meaningfulLastmod).filter(Boolean).sort();
  return dates.length ? dates.at(-1) : null;
}

for (const job of jobs) {
  const url = `${baseUrl}/jobs/${jobSlug(job)}/`;
  const expected = new Date(job.lastChangedAt).toISOString().slice(0, 10);
  requireOk(sitemapEntries.has(url), `Sitemap missing generated job URL ${url}`);
  requireOk(sitemapEntries.get(url) === expected, `Sitemap lastmod for ${job.id} must match meaningful job change date ${expected}.`);
}

requireOk(homepage.includes(`<link rel="canonical" href="${baseUrl}/">`), 'Homepage canonical URL is incorrect.');
requireOk(homepage.includes(`<meta property="og:url" content="${baseUrl}/">`), 'Homepage Open Graph URL is incorrect.');
requireOk(/<meta name="description" content="[^\"]{80,180}">/i.test(homepage), 'Homepage meta description should be descriptive and search-friendly.');
requireOk(employerPage.includes(`<link rel="canonical" href="${baseUrl}/employers/">`), 'Employer page canonical URL is incorrect.');
requireOk(/<meta name="robots" content="noindex,follow">/i.test(subscribedPage), 'Signup confirmation page must remain noindex,follow.');
requireOk(jobsPage.includes('id="browse-regions"'), 'All-jobs page must link to regional job landing pages.');
requireOk(locationsPage.includes(`<link rel="canonical" href="${baseUrl}/locations/">`), 'Locations hub canonical URL is incorrect.');
requireOk((locationsPage.match(/<h1\b/gi) || []).length === 1, 'Locations hub must contain exactly one h1.');
const hubLastmod = maxLastmod(jobs);
if (hubLastmod) requireOk(sitemapEntries.get(`${baseUrl}/locations/`) === hubLastmod, 'Locations hub sitemap lastmod must reflect the newest meaningful job change.');

let regionPageCount = 0;
for (const region of regions) {
  const list = jobs.filter(job => job.region === region.key);
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const expectedLastmod = maxLastmod(list);
  for (let page = 1; page <= pages; page += 1) {
    const url = page === 1 ? `${baseUrl}/locations/${region.slug}/` : `${baseUrl}/locations/${region.slug}/page/${page}/`;
    const path = page === 1 ? `locations/${region.slug}/index.html` : `locations/${region.slug}/page/${page}/index.html`;
    let html = '';
    try { html = await readFile(path, 'utf8'); }
    catch (error) {
      errors.push(`Regional SEO page missing: ${path} (${error.message})`);
      continue;
    }
    regionPageCount += 1;
    requireOk(html.includes(`<link rel="canonical" href="${url}">`), `Regional page ${path} has an incorrect canonical URL.`);
    requireOk((html.match(/<h1\b/gi) || []).length === 1, `Regional page ${path} must contain exactly one h1.`);
    requireOk(sitemapEntries.has(url), `Sitemap missing regional URL ${url}`);
    if (expectedLastmod) requireOk(sitemapEntries.get(url) === expectedLastmod, `Regional sitemap lastmod for ${url} must match meaningful region job changes.`);
    const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
    if (!match) {
      errors.push(`Regional page ${path} is missing ItemList JSON-LD.`);
    } else {
      try {
        const schema = JSON.parse(match[1]);
        requireOk(schema?.['@type'] === 'ItemList', `Regional page ${path} JSON-LD must be ItemList.`);
      } catch {
        errors.push(`Regional page ${path} contains invalid JSON-LD.`);
      }
    }
  }
}

const jobDirs = await readdir('jobs', { withFileTypes: true });
const detailDirs = jobDirs.filter(entry => entry.isDirectory() && entry.name !== 'page');
requireOk(detailDirs.length === jobs.length, `Generated job-page count ${detailDirs.length} does not match feed count ${jobs.length}.`);

let jobPostingCount = 0;
let structuredLocationCount = 0;
for (const entry of detailDirs) {
  const html = await readFile(`jobs/${entry.name}/index.html`, 'utf8');
  requireOk(html.includes(`<link rel="canonical" href="${baseUrl}/jobs/`), `Job page ${entry.name} has a noncanonical URL.`);
  const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
  if (!match) {
    errors.push(`Job page ${entry.name} is missing JSON-LD.`);
    continue;
  }
  try {
    const schema = JSON.parse(match[1]);
    if (schema?.['@type'] !== 'JobPosting') {
      errors.push(`Job page ${entry.name} JSON-LD is not JobPosting.`);
      continue;
    }
    jobPostingCount += 1;
    requireOk(Boolean(schema.title), `Job page ${entry.name} schema is missing title.`);
    requireOk(Boolean(schema.hiringOrganization?.name), `Job page ${entry.name} schema is missing hiringOrganization.`);
    requireOk(String(schema.url || '').startsWith(`${baseUrl}/jobs/`), `Job page ${entry.name} schema URL is not canonical.`);
    requireOk(Boolean(schema.identifier?.value), `Job page ${entry.name} schema is missing a stable identifier.`);
    if (schema.jobLocation || schema.jobLocationType === 'TELECOMMUTE') structuredLocationCount += 1;
  } catch {
    errors.push(`Job page ${entry.name} contains invalid JSON-LD.`);
  }
}

requireOk(jobPostingCount === jobs.length, `Only ${jobPostingCount}/${jobs.length} job pages contain valid JobPosting structured data.`);
if (jobs.length) {
  const coverage = structuredLocationCount / jobs.length;
  // Do not invent city/state values for source listings whose location text is too ambiguous.
  // This floor catches regressions while preserving source fidelity for the remaining records.
  requireOk(coverage >= 0.8, `Structured job-location coverage is ${(coverage * 100).toFixed(1)}%; expected at least 80%.`);
}

if (errors.length) {
  console.error('Technical SEO validation failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Technical SEO validation passed: ${locs.length} sitemap URLs, ${jobPostingCount} JobPosting pages, ${regionPageCount} regional pages, ${structuredLocationCount}/${jobs.length} with structured locations, meaningful lastmod dates verified.`);
