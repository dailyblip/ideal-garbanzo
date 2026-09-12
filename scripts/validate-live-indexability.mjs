const base = String(process.env.LIVE_SITE_BASE || 'https://datacentercareers.us').replace(/\/$/, '');
const revision = String(process.env.DEPLOYMENT_SHA || Date.now()).trim();
const cache = `indexability-${revision}-${Date.now()}`;
const errors = [];

const fail = message => errors.push(message);
const canonicalFor = path => `${base}${path}`;

async function get(path, { html = false, cacheBust = true, exactUrl = false } = {}) {
  const canonicalUrl = `${base}${path}`;
  const separator = path.includes('?') ? '&' : '?';
  const requestUrl = cacheBust ? `${canonicalUrl}${separator}deploy=${encodeURIComponent(cache)}` : canonicalUrl;
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
    return { response:null, text:'', requestUrl };
  }

  if (!response.ok) fail(`${path} returned HTTP ${response.status}.`);
  if (!response.url.startsWith(`${base}/`) && response.url !== base) {
    fail(`${path} redirected away from the canonical domain to ${response.url}.`);
  }
  if (exactUrl && response.url !== canonicalUrl) {
    fail(`${path} did not resolve at its exact canonical URL; final URL was ${response.url}.`);
  }

  const xRobots = response.headers.get('x-robots-tag') || '';
  if (/\bnoindex\b/i.test(xRobots)) fail(`${path} is blocked by X-Robots-Tag: ${xRobots}`);

  const text = await response.text();
  if (html) {
    const robotsMeta = [...text.matchAll(/<meta\s+[^>]*name=["']robots["'][^>]*>/gi)].map(match => match[0]).join(' ');
    if (/\bnoindex\b/i.test(robotsMeta)) fail(`${path} contains a noindex robots meta tag.`);
  }

  return { response, text, requestUrl };
}

async function getBytes(path) {
  const canonicalUrl = `${base}${path}`;
  const separator = path.includes('?') ? '&' : '?';
  const requestUrl = `${canonicalUrl}${separator}deploy=${encodeURIComponent(cache)}`;
  let response;
  try {
    response = await fetch(requestUrl, {
      redirect: 'follow',
      headers: {
        'cache-control': 'no-cache',
        'user-agent': 'DataCenterCareersHeroGuard/1.0'
      },
      signal: AbortSignal.timeout(30000)
    });
  } catch (error) {
    fail(`${path} could not be fetched: ${error.message}`);
    return { response:null, bytes:new Uint8Array(), requestUrl };
  }

  if (!response.ok) fail(`${path} returned HTTP ${response.status}.`);
  if (!response.url.startsWith(`${base}/`)) fail(`${path} redirected away from the canonical domain to ${response.url}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { response, bytes, requestUrl };
}

function jpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const sofMarkers = new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) break;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) break;
    if (sofMarkers.has(marker) && length >= 7) {
      return {
        height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        width: (bytes[offset + 5] << 8) | bytes[offset + 6]
      };
    }
    offset += length;
  }
  return null;
}

function requireCanonical(path, html) {
  const expected = canonicalFor(path);
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`<link\\s+rel=["']canonical["']\\s+href=["']${escaped}["']`, 'i').test(html)
      && !new RegExp(`<link\\s+href=["']${escaped}["']\\s+rel=["']canonical["']`, 'i').test(html)) {
    fail(`${path} is missing its canonical link to ${expected}.`);
  }
}

// Search engines request these exact well-known URLs. Do not cache-bust them here: a
// successful query-string variant must not hide a redirect, HTML fallback, or fetch
// failure on the URL submitted to Search Console.
const robotsResult = await get('/robots.txt', { cacheBust:false, exactUrl:true });
const robots = robotsResult.text;
if (!/User-agent:\s*\*/i.test(robots)) fail('robots.txt is missing the default User-agent rule.');
if (!/Allow:\s*\//i.test(robots)) fail('robots.txt does not explicitly allow the public site.');
if (/^\s*Disallow:\s*\/\s*$/im.test(robots)) fail('robots.txt globally disallows crawling.');
if (!robots.includes(`Sitemap: ${base}/sitemap.xml`)) fail('robots.txt does not advertise the canonical sitemap.');
if (/dailyblip\.github\.io/i.test(robots)) fail('robots.txt still references the GitHub Pages hostname.');
if (/<html\b|<!doctype\s+html/i.test(robots)) fail('robots.txt returned HTML instead of crawler directives.');

const sitemapResult = await get('/sitemap.xml', { cacheBust:false, exactUrl:true });
const sitemap = sitemapResult.text;
if (/<html\b|<!doctype\s+html/i.test(sitemap)) fail('sitemap.xml returned HTML instead of XML.');
if (!/^\s*(?:<\?xml[^>]*\?>\s*)?<urlset\b/i.test(sitemap)) fail('sitemap.xml does not begin with a valid XML URL set.');
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
let homepageHtml = '';

for (const [path, label] of htmlChecks) {
  const result = await get(path, { html:true });
  if (!result.text) continue;
  if (path === '/') homepageHtml = result.text;
  requireCanonical(path, result.text);
  if (!/<h1\b/i.test(result.text)) fail(`${label} is missing an h1.`);
}

const heroSrc = homepageHtml.match(/<figure\b[^>]*class=["'][^"']*hero-media[^"']*["'][^>]*>[\s\S]*?<img\b[^>]*src=["']([^"']+)["']/i)?.[1] || '';
if (!/^\/hero\.jpg\?v=[0-9a-f]{12}$/i.test(heroSrc)) {
  fail(`Homepage hero source is missing or not cache-busted correctly: ${heroSrc || '(none)'}.`);
} else {
  const heroResult = await getBytes(heroSrc);
  const contentType = heroResult.response?.headers.get('content-type') || '';
  if (!/^image\/jpeg\b/i.test(contentType)) fail(`Homepage hero returned unexpected content type: ${contentType || '(none)'}.`);
  if (heroResult.bytes.length < 100000) fail(`Homepage hero returned only ${heroResult.bytes.length} bytes.`);
  if (!(heroResult.bytes[0] === 0xff && heroResult.bytes[1] === 0xd8
      && heroResult.bytes[heroResult.bytes.length - 2] === 0xff && heroResult.bytes[heroResult.bytes.length - 1] === 0xd9)) {
    fail('Homepage hero response is not an intact JPEG.');
  }
  const dimensions = jpegDimensions(heroResult.bytes);
  if (!dimensions || dimensions.width !== 1536 || dimensions.height !== 1024) {
    fail(`Homepage hero dimensions are ${dimensions ? `${dimensions.width}x${dimensions.height}` : 'unreadable'}; expected 1536x1024.`);
  }
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

console.log(`Live indexability validation passed: exact robots.txt and sitemap.xml fetches clean, homepage hero JPEG is live at 1536x1024, ${sitemapLocs.length} sitemap URLs, ${jobLocs.length} live job detail URLs, canonicals/noindex checks clean.`);
