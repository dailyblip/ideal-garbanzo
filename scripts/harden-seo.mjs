import { readFile, writeFile, access } from 'node:fs/promises';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const slugify = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'job';
const jobSlug = job => `${slugify(job.title)}-${slugify(job.company).slice(0,32)}-${String(job.id || '').replace(/[^a-zA-Z0-9]/g,'').slice(-10)}`;
const PAGE_SIZE = 25;

const stateCodes = new Map(Object.entries({
  Alabama:'AL',Alaska:'AK',Arizona:'AZ',Arkansas:'AR',California:'CA',Colorado:'CO',Connecticut:'CT',Delaware:'DE',Florida:'FL',Georgia:'GA',Hawaii:'HI',Idaho:'ID',Illinois:'IL',Indiana:'IN',Iowa:'IA',Kansas:'KS',Kentucky:'KY',Louisiana:'LA',Maine:'ME',Maryland:'MD',Massachusetts:'MA',Michigan:'MI',Minnesota:'MN',Mississippi:'MS',Missouri:'MO',Montana:'MT',Nebraska:'NE',Nevada:'NV','New Hampshire':'NH','New Jersey':'NJ','New Mexico':'NM','New York':'NY','North Carolina':'NC','North Dakota':'ND',Ohio:'OH',Oklahoma:'OK',Oregon:'OR',Pennsylvania:'PA','Rhode Island':'RI','South Carolina':'SC','South Dakota':'SD',Tennessee:'TN',Texas:'TX',Utah:'UT',Vermont:'VT',Virginia:'VA',Washington:'WA','West Virginia':'WV',Wisconsin:'WI',Wyoming:'WY','District of Columbia':'DC'
}));

const baseDomain = clean(await readFile('CNAME', 'utf8')).replace(/^https?:\/\//, '').replace(/\/$/, '');
if (!baseDomain) throw new Error('CNAME is required for SEO hardening.');
const baseUrl = `https://${baseDomain}`;
const jobs = JSON.parse(await readFile('data/jobs.json', 'utf8'));

function parsePlace(value) {
  let text = clean(value)
    .replace(/,\s*(?:United States(?: of America)?|USA|US)$/i, '')
    .replace(/\s*\((?:on[- ]?site|onsite|hybrid)\)$/i, '')
    .trim();
  if (!text) return null;

  const stateOnly = /^[A-Z]{2}$/.test(text) ? text : stateCodes.get(text);
  if (stateOnly) {
    return {
      '@type': 'Place',
      address: {
        '@type': 'PostalAddress',
        addressRegion: stateOnly,
        addressCountry: 'US'
      }
    };
  }

  const match = text.match(/^(.+?),\s*([^,]+)$/);
  if (!match) return null;
  const locality = clean(match[1]);
  const stateRaw = clean(match[2]);
  const region = /^[A-Z]{2}$/.test(stateRaw) ? stateRaw : stateCodes.get(stateRaw);
  if (!locality || !region) return null;
  return {
    '@type': 'Place',
    address: {
      '@type': 'PostalAddress',
      addressLocality: locality,
      addressRegion: region,
      addressCountry: 'US'
    }
  };
}

function locationFields(location) {
  const value = clean(location);
  if (!value) return {};
  if (/\bremote\b/i.test(value)) {
    return {
      jobLocationType: 'TELECOMMUTE',
      applicantLocationRequirements: { '@type': 'Country', name: 'United States' }
    };
  }
  const places = value.split(/\s*(?:;|\|)\s*/).map(parsePlace).filter(Boolean);
  if (!places.length) return {};
  return { jobLocation: places.length === 1 ? places[0] : places };
}

function dateOnly(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
}

function jobLastmod(job) {
  return dateOnly(job.lastChangedAt) || dateOnly(job.firstSeenAt) || dateOnly(job.postedAt);
}

function earlyRank(job) {
  const t = {apprenticeship:0,internship:1,trainee:2,'entry-level':3}[job.type] ?? 4;
  const e = {'no-experience':0,'0-2-years':1,'2-5-years':4}[job.experience] ?? 2;
  return t * 10 + e;
}

function pagePath(root, page) {
  if (page === 1) return `${baseUrl}/${root}/`;
  return `${baseUrl}/${root}/page/${page}/`;
}

function maxLastmod(list) {
  const dates = list.map(jobLastmod).filter(Boolean).sort();
  return dates.length ? dates[dates.length - 1] : null;
}

function sitemapLastmods() {
  const map = new Map();
  const orderedJobs = [...jobs].sort((a,b) => earlyRank(a)-earlyRank(b) || (a.postedHours ?? 9999)-(b.postedHours ?? 9999));

  for (const job of orderedJobs) {
    const lastmod = jobLastmod(job);
    if (lastmod) map.set(`${baseUrl}/jobs/${jobSlug(job)}/`, lastmod);
  }

  const listings = [
    ['jobs', () => true],
    ['apprenticeships', job => job.type === 'apprenticeship' || job.type === 'trainee'],
    ['internships', job => job.type === 'internship'],
    ['entry-level', job => job.experience === 'no-experience' || job.experience === '0-2-years'],
    ['no-experience', job => job.experience === 'no-experience']
  ];

  for (const [root, filter] of listings) {
    const list = orderedJobs.filter(filter);
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    for (let page = 1; page <= pages; page += 1) {
      const subset = list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
      const lastmod = maxLastmod(subset);
      if (lastmod) map.set(pagePath(root, page), lastmod);
    }
  }
  return map;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applySitemapLastmod(xml, url, lastmod) {
  const pattern = new RegExp(`(<url><loc>${escapeRegExp(url)}</loc><lastmod>)([^<]+)(<\\/lastmod><\\/url>)`, 'g');
  return xml.replace(pattern, `$1${lastmod}$3`);
}

let enhancedLocations = 0;
for (const job of jobs) {
  const path = `jobs/${jobSlug(job)}/index.html`;
  try { await access(path); } catch { continue; }
  let html = await readFile(path, 'utf8');
  const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
  if (!match) continue;
  let schema;
  try { schema = JSON.parse(match[1]); } catch { continue; }
  if (schema?.['@type'] !== 'JobPosting') continue;

  schema.identifier = { '@type': 'PropertyValue', name: job.company, value: String(job.id) };
  schema.industry = 'Data center infrastructure';
  if (job.type === 'internship') schema.employmentType = 'INTERN';

  const fields = locationFields(job.location);
  if (fields.jobLocation || fields.jobLocationType) enhancedLocations += 1;
  Object.assign(schema, fields);

  const replacement = `<script type="application/ld+json">${JSON.stringify(schema).replace(/</g, '\\u003c')}</script>`;
  html = html.replace(match[0], replacement);
  await writeFile(path, html);
}

let sitemap = await readFile('sitemap.xml', 'utf8');
const lastmods = sitemapLastmods();
let correctedLastmods = 0;
for (const [url, lastmod] of lastmods) {
  const before = sitemap;
  sitemap = applySitemapLastmod(sitemap, url, lastmod);
  if (sitemap !== before) correctedLastmods += 1;
}

const employerUrl = `${baseUrl}/employers/`;
if (!sitemap.includes(`<loc>${employerUrl}</loc>`)) {
  // This page is static; omit lastmod rather than falsely marking it as changed on every deploy.
  sitemap = sitemap.replace('</urlset>', `  <url><loc>${employerUrl}</loc></url>\n</urlset>`);
}
await writeFile('sitemap.xml', sitemap);
await writeFile('robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${baseUrl}/sitemap.xml\n`);

console.log(`SEO hardening complete: ${enhancedLocations}/${jobs.length} job pages received structured location data; ${correctedLastmods} sitemap URLs use meaningful change dates; employer page included in sitemap.`);
