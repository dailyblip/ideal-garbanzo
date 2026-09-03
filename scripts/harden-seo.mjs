import { readFile, writeFile, access } from 'node:fs/promises';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const slugify = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'job';
const jobSlug = job => `${slugify(job.title)}-${slugify(job.company).slice(0, 32)}-${String(job.id || '').replace(/[^a-zA-Z0-9]/g, '').slice(-10)}`;

const stateCodes = new Map(Object.entries({
  Alabama:'AL',Alaska:'AK',Arizona:'AZ',Arkansas:'AR',California:'CA',Colorado:'CO',Connecticut:'CT',Delaware:'DE',Florida:'FL',Georgia:'GA',Hawaii:'HI',Idaho:'ID',Illinois:'IL',Indiana:'IN',Iowa:'IA',Kansas:'KS',Kentucky:'KY',Louisiana:'LA',Maine:'ME',Maryland:'MD',Massachusetts:'MA',Michigan:'MI',Minnesota:'MN',Mississippi:'MS',Missouri:'MO',Montana:'MT',Nebraska:'NE',Nevada:'NV','New Hampshire':'NH','New Jersey':'NJ','New Mexico':'NM','New York':'NY','North Carolina':'NC','North Dakota':'ND',Ohio:'OH',Oklahoma:'OK',Oregon:'OR',Pennsylvania:'PA','Rhode Island':'RI','South Carolina':'SC','South Dakota':'SD',Tennessee:'TN',Texas:'TX',Utah:'UT',Vermont:'VT',Virginia:'VA',Washington:'WA','West Virginia':'WV',Wisconsin:'WI',Wyoming:'WY','District of Columbia':'DC'
}));

const baseDomain = clean(await readFile('CNAME', 'utf8')).replace(/^https?:\/\//, '').replace(/\/$/, '');
if (!baseDomain) throw new Error('CNAME is required for SEO hardening.');
const baseUrl = `https://${baseDomain}`;
const jobs = JSON.parse(await readFile('data/jobs.json', 'utf8'));

function parsePlace(value) {
  const text = clean(value);
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
  const places = value.split(/\s*;\s*/).map(parsePlace).filter(Boolean);
  if (!places.length) return {};
  return { jobLocation: places.length === 1 ? places[0] : places };
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
const employerUrl = `${baseUrl}/employers/`;
if (!sitemap.includes(`<loc>${employerUrl}</loc>`)) {
  const lastmod = new Date().toISOString().slice(0, 10);
  sitemap = sitemap.replace('</urlset>', `  <url><loc>${employerUrl}</loc><lastmod>${lastmod}</lastmod></url>\n</urlset>`);
}
await writeFile('sitemap.xml', sitemap);
await writeFile('robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${baseUrl}/sitemap.xml\n`);

console.log(`SEO hardening complete: ${enhancedLocations}/${jobs.length} job pages received structured location data; employer page included in sitemap.`);
