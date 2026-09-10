import { readFile } from 'node:fs/promises';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const slugify = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'job';
const jobSlug = job => `${slugify(job.title)}-${slugify(job.company).slice(0, 32)}-${String(job.id || '').replace(/[^a-zA-Z0-9]/g, '').slice(-10)}`;
const errors = [];
const requireOk = (condition, message) => { if (!condition) errors.push(message); };

const domain = clean(await readFile('CNAME', 'utf8')).replace(/^https?:\/\//, '').replace(/\/$/, '');
const baseUrl = `https://${domain}`;
const jobs = JSON.parse(await readFile('data/jobs.json', 'utf8'));
const careerEvents = JSON.parse(await readFile('data/career-events.json', 'utf8'));
const sitemap = await readFile('sitemap.xml', 'utf8');
const today = new Date().toISOString().slice(0, 10);

requireOk(domain === 'datacentercareers.us', `Unexpected canonical domain: ${domain}`);
requireOk(Array.isArray(jobs), 'data/jobs.json must contain an array.');
requireOk(Array.isArray(careerEvents), 'data/career-events.json must contain an array.');
requireOk(!/dailyblip\.github\.io/i.test(sitemap), 'Search sitemap must not contain the old GitHub Pages domain.');

const listingContracts = [
  {
    path: 'jobs/index.html',
    url: `${baseUrl}/jobs/`,
    h1: 'Data center jobs',
    title: 'Data Center Jobs',
    count: jobs.length,
    countLabel: 'current opportunities',
    links: ['/no-experience/', '/trainee-jobs/', '/apprenticeships/', '/career-events/']
  },
  {
    path: 'apprenticeships/index.html',
    url: `${baseUrl}/apprenticeships/`,
    h1: 'Data center apprenticeships',
    title: 'Data Center Apprenticeships',
    count: jobs.filter(job => job.type === 'apprenticeship' || job.type === 'trainee').length,
    countLabel: 'current opportunities',
    links: ['/how-to-get-a-data-center-apprenticeship/', '/trainee-jobs/', '/no-experience/', '/entry-level/']
  },
  {
    path: 'entry-level/index.html',
    url: `${baseUrl}/entry-level/`,
    h1: 'Entry-level data center jobs',
    title: 'Entry-Level Data Center Jobs',
    count: jobs.filter(job => job.experience === 'no-experience' || job.experience === '0-2-years').length,
    countLabel: 'current opportunities',
    links: ['/no-experience/', '/trainee-jobs/', '/apprenticeships/']
  },
  {
    path: 'no-experience/index.html',
    url: `${baseUrl}/no-experience/`,
    h1: 'Data center jobs with no experience required',
    title: 'Data Center Jobs With No Experience',
    count: jobs.filter(job => job.experience === 'no-experience').length,
    countLabel: 'current opportunities',
    links: ['/trainee-jobs/', '/apprenticeships/', '/entry-level/', '/how-to-get-a-data-center-job/']
  },
  {
    path: 'trainee-jobs/index.html',
    url: `${baseUrl}/trainee-jobs/`,
    h1: 'Data center trainee jobs',
    title: 'Data Center Trainee Jobs',
    count: jobs.filter(job => job.type === 'trainee').length,
    countLabel: 'current opportunities',
    links: ['/apprenticeships/', '/no-experience/', '/entry-level/', '/how-to-get-a-data-center-apprenticeship/']
  }
];

function pageTitle(html) {
  return clean(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]);
}

function metaDescription(html) {
  return clean(html.match(/<meta\s+name="description"\s+content="([^"]*)"/i)?.[1]);
}

function h1Text(html) {
  return clean(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1].replace(/<[^>]+>/g, ' '));
}

function listingCount(html, label) {
  const pattern = new RegExp(`<strong>(\\d+) ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</strong>`, 'i');
  const match = html.match(pattern);
  return match ? Number(match[1]) : null;
}

for (const contract of listingContracts) {
  let html = '';
  try { html = await readFile(contract.path, 'utf8'); }
  catch (error) {
    errors.push(`Missing generated search page ${contract.path}: ${error.message}`);
    continue;
  }

  requireOk(html.includes(`<link rel="canonical" href="${contract.url}">`), `${contract.path} has an incorrect canonical URL.`);
  requireOk(sitemap.includes(`<loc>${contract.url}</loc>`), `Sitemap is missing ${contract.url}.`);
  requireOk((html.match(/<h1\b/gi) || []).length === 1, `${contract.path} must contain exactly one h1.`);
  requireOk(h1Text(html) === contract.h1, `${contract.path} h1 changed from the search-intent contract.`);
  requireOk(pageTitle(html).includes(contract.title), `${contract.path} title no longer targets "${contract.title}".`);
  requireOk(!/<meta\s+name="robots"\s+content="[^"]*noindex/i.test(html), `${contract.path} must remain indexable.`);

  const description = metaDescription(html);
  requireOk(description.length >= 80 && description.length <= 180, `${contract.path} meta description should remain 80-180 characters; got ${description.length}.`);

  const actualCount = listingCount(html, contract.countLabel);
  requireOk(actualCount === contract.count, `${contract.path} displays ${actualCount} opportunities but the current feed contains ${contract.count}.`);

  for (const href of contract.links) {
    requireOk(html.includes(`href="${baseUrl}${href}"`), `${contract.path} is missing the internal search-intent link ${href}.`);
  }

  const schemaMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
  requireOk(Boolean(schemaMatch), `${contract.path} is missing ItemList JSON-LD.`);
  if (schemaMatch) {
    try {
      const schema = JSON.parse(schemaMatch[1]);
      requireOk(schema?.['@type'] === 'ItemList', `${contract.path} JSON-LD must remain ItemList.`);
      requireOk(Number.isInteger(schema?.numberOfItems), `${contract.path} ItemList must include numberOfItems.`);
    } catch {
      errors.push(`${contract.path} contains invalid JSON-LD.`);
    }
  }
}

const activeEvents = careerEvents.filter(event => clean(event?.date) >= today);
let eventsHtml = '';
try { eventsHtml = await readFile('career-events/index.html', 'utf8'); }
catch (error) { errors.push(`Missing generated career-events page: ${error.message}`); }
if (eventsHtml) {
  const url = `${baseUrl}/career-events/`;
  requireOk(eventsHtml.includes(`<link rel="canonical" href="${url}">`), 'career-events/index.html has an incorrect canonical URL.');
  requireOk(sitemap.includes(`<loc>${url}</loc>`), `Sitemap is missing ${url}.`);
  requireOk(h1Text(eventsHtml) === 'Data center hiring events', 'Career events h1 must remain aligned to the hiring-event search query.');
  requireOk(pageTitle(eventsHtml).includes('Data Center Hiring Events'), 'Career events title must remain aligned to the hiring-event search query.');
  requireOk(listingCount(eventsHtml, 'upcoming verified events') === activeEvents.length, 'Career events visible count does not match current verified future events.');
  for (const href of ['/no-experience/', '/trainee-jobs/', '/apprenticeships/', '/jobs/']) {
    requireOk(eventsHtml.includes(`href="${baseUrl}${href}"`), `career-events/index.html is missing the internal search-intent link ${href}.`);
  }
}

if (jobs.length) {
  const sample = jobs[0];
  const detailPath = `jobs/${jobSlug(sample)}/index.html`;
  let detail = '';
  try { detail = await readFile(detailPath, 'utf8'); }
  catch (error) { errors.push(`Missing sample generated job page ${detailPath}: ${error.message}`); }
  if (detail) {
    for (const href of ['/trainee-jobs/', '/no-experience/', '/apprenticeships/', '/entry-level/', '/jobs/']) {
      requireOk(detail.includes(`href="${baseUrl}${href}"`), `Generated job pages are missing the supporting internal link ${href}.`);
    }
  }
}

const sitemapUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
requireOk(new Set(sitemapUrls).size === sitemapUrls.length, 'Sitemap contains duplicate URLs after search-page generation.');

if (errors.length) {
  console.error('Search landing validation failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Search landing validation passed: ${jobs.length} jobs, ${jobs.filter(job => job.type === 'trainee').length} trainee roles, ${jobs.filter(job => job.experience === 'no-experience').length} no-experience roles, and ${activeEvents.length} upcoming verified events.`);
