import { readFile, readdir } from 'node:fs/promises';

const clean = value => String(value ?? '').trim();
const errors = [];
const requireOk = (condition, message) => { if (!condition) errors.push(message); };

const domain = clean(await readFile('CNAME', 'utf8')).replace(/^https?:\/\//, '').replace(/\/$/, '');
const baseUrl = `https://${domain}`;
const robots = await readFile('robots.txt', 'utf8');
const sitemap = await readFile('sitemap.xml', 'utf8');
const homepage = await readFile('index.html', 'utf8');
const employerPage = await readFile('employers/index.html', 'utf8');
const subscribedPage = await readFile('subscribed/index.html', 'utf8');
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
  `${baseUrl}/how-to-get-a-data-center-job/`,
  `${baseUrl}/how-to-get-a-data-center-internship/`
];
for (const url of requiredUrls) requireOk(sitemap.includes(`<loc>${url}</loc>`), `Sitemap missing ${url}`);
requireOk(!sitemap.includes(`${baseUrl}/subscribed/`), 'Confirmation page must not be listed in sitemap.xml.');
requireOk(!/dailyblip\.github\.io/i.test(sitemap), 'Sitemap must not contain the old GitHub Pages domain.');
const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
requireOk(new Set(locs).size === locs.length, 'Sitemap contains duplicate URLs.');

requireOk(homepage.includes(`<link rel="canonical" href="${baseUrl}/">`), 'Homepage canonical URL is incorrect.');
requireOk(homepage.includes(`<meta property="og:url" content="${baseUrl}/">`), 'Homepage Open Graph URL is incorrect.');
requireOk(/<meta name="description" content="[^\"]{80,180}">/i.test(homepage), 'Homepage meta description should be descriptive and search-friendly.');
requireOk(employerPage.includes(`<link rel="canonical" href="${baseUrl}/employers/">`), 'Employer page canonical URL is incorrect.');
requireOk(/<meta name="robots" content="noindex,follow">/i.test(subscribedPage), 'Signup confirmation page must remain noindex,follow.');

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
  requireOk(coverage >= 0.9, `Structured job-location coverage is ${(coverage * 100).toFixed(1)}%; expected at least 90%.`);
}

if (errors.length) {
  console.error('Technical SEO validation failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Technical SEO validation passed: ${locs.length} sitemap URLs, ${jobPostingCount} JobPosting pages, ${structuredLocationCount}/${jobs.length} with structured locations.`);
