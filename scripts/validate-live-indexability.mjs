const base = String(process.env.LIVE_SITE_BASE || 'https://datacentercareers.us').replace(/\/$/, '');
const revision = String(process.env.DEPLOYMENT_SHA || Date.now()).trim();
const cache = `indexability-${revision}-${Date.now()}`;
const errors = [];

const fail = message => errors.push(message);
const canonicalFor = path => `${base}${path}`;

async function get(path, { html = false } = {}) {
  const separator = path.includes('?') ? '&' : '?';
  const requestUrl = `${base}${path}${separator}deploy=${encodeURIComponent(cache)}`;
  let response;
  try {
    response = await fetch(requestUrl, {
      redirect: 'follow',
      headers: {
        'cache-control': 'no-cache',
        'user-agent': 'DataCenterCareersIndexabilityGuard/1.0'
      },
      signal: AbortSignal.timeout(30000)
    });
  } catch (error) {
    fail(`${path} could not be fetched: ${error.message}`);
    return { response:null, text:'' };
  }

  if (!response.ok) fail(`${path} returned HTTP ${response.status}.`);
  if (!response.url.startsWith(`${base}/`) && response.url !== base) {
    fail(`${path} redirected away from the canonical domain to ${response.url}.`);
  }

  const xRobots = response.headers.get('x-robots-tag') || '';
  if (/\bnoindex\b/i.test(xRobots)) fail(`${path} is blocked by X-Robots-Tag: ${xRobots}`);

  const text = await response.text();
  if (html) {
    const robotsMeta = [...text.matchAll(/<meta\s+[^>]*name=["']robots["'][^>]*>/gi)].map(match => match[0]).join(' ');
    if (/\bnoindex\b/i.test(robotsMeta)) fail(`${path} contains a noindex robots meta tag.`);
  }

  return { response, text };
}

function requireCanonical(path, html) {
  const expected = canonicalFor(path);
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`<link\\s+rel=["']canonical["']\\s+href=["']${escaped}["']`, 'i').test(html)
      && !new RegExp(`<link\\s+href=["']${escaped}["']\\s+rel=["']canonical["']`, 'i').test(html)) {
    fail(`${path} is missing its canonical link to ${expected}.`);
  }
}

const robotsResult = await get('/robots.txt');
const robots = robotsResult.text;
if (!/User-agent:\s*\*/i.test(robots)) fail('robots.txt is missing the default User-agent rule.');
if (!/Allow:\s*\//i.test(robots)) fail('robots.txt does not explicitly allow the public site.');
if (/^\s*Disallow:\s*\/\s*$/im.test(robots)) fail('robots.txt globally disallows crawling.');
if (!robots.includes(`Sitemap: ${base}/sitemap.xml`)) fail('robots.txt does not advertise the canonical sitemap.');
if (/dailyblip\.github\.io/i.test(robots)) fail('robots.txt still references the GitHub Pages hostname.');

const sitemapResult = await get('/sitemap.xml');
const sitemap = sitemapResult.text;
if (!/<urlset\b/i.test(sitemap)) fail('sitemap.xml does not contain a URL set.');
if (/dailyblip\.github\.io/i.test(sitemap)) fail('sitemap.xml contains the old GitHub Pages hostname.');

const requiredPaths = [
  '/',
  '/jobs/',
  '/entry-level/',
  '/no-experience/',
  '/internships/',
  '/apprenticeships/',
  '/locations/',
  '/career-events/',
  '/how-to-get-a-data-center-job/',
  '/how-to-get-a-data-center-internship/'
];

for (const path of requiredPaths) {
  const url = canonicalFor(path);
  if (!sitemap.includes(`<loc>${url}</loc>`)) fail(`sitemap.xml is missing ${url}.`);
}

const liveJobsResult = await get('/data/jobs.json');
let liveJobs = [];
try {
  liveJobs = JSON.parse(liveJobsResult.text);
  if (!Array.isArray(liveJobs) || !liveJobs.length) fail('Live jobs feed is empty or not an array.');
} catch (error) {
  fail(`Live jobs feed is not valid JSON: ${error.message}`);
}

const sitemapLocs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
const jobLocs = sitemapLocs.filter(url => url.startsWith(`${base}/jobs/`) && url !== `${base}/jobs/` && !/\/page\/\d+\/$/.test(url));
if (Array.isArray(liveJobs) && liveJobs.length && jobLocs.length !== liveJobs.length) {
  fail(`Live sitemap exposes ${jobLocs.length} job detail URLs for ${liveJobs.length} published jobs.`);
}

const htmlChecks = [
  ['/', 'homepage'],
  ['/jobs/', 'jobs hub'],
  ['/entry-level/', 'entry-level landing page'],
  ['/locations/', 'locations hub'],
  ['/how-to-get-a-data-center-job/', 'career guide']
];

for (const [path, label] of htmlChecks) {
  const result = await get(path, { html:true });
  if (!result.text) continue;
  requireCanonical(path, result.text);
  if (!/<h1\b/i.test(result.text)) fail(`${label} is missing an h1.`);
}

if (!jobLocs.length) {
  fail('sitemap.xml contains no crawlable job detail URLs.');
} else {
  const representativeUrl = jobLocs[0];
  const representativePath = new URL(representativeUrl).pathname;
  const result = await get(representativePath, { html:true });
  if (result.text) {
    requireCanonical(representativePath, result.text);
    if (!/"@type"\s*:\s*"JobPosting"/i.test(result.text)) fail(`${representativePath} is missing JobPosting structured data.`);
  }
}

if (errors.length) {
  console.error('Live indexability validation failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Live indexability validation passed: ${sitemapLocs.length} sitemap URLs, ${jobLocs.length} live job detail URLs, robots/canonicals/noindex checks clean.`);
