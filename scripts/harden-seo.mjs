import { readFile, writeFile, access, mkdir } from 'node:fs/promises';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const slugify = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'job';
const jobSlug = job => `${slugify(job.title)}-${slugify(job.company).slice(0,32)}-${String(job.id || '').replace(/[^a-zA-Z0-9]/g,'').slice(-10)}`;
const PAGE_SIZE = 25;

const stateCodes = new Map(Object.entries({
  Alabama:'AL',Alaska:'AK',Arizona:'AZ',Arkansas:'AR',California:'CA',Colorado:'CO',Connecticut:'CT',Delaware:'DE',Florida:'FL',Georgia:'GA',Hawaii:'HI',Idaho:'ID',Illinois:'IL',Indiana:'IN',Iowa:'IA',Kansas:'KS',Kentucky:'KY',Louisiana:'LA',Maine:'ME',Maryland:'MD',Massachusetts:'MA',Michigan:'MI',Minnesota:'MN',Mississippi:'MS',Missouri:'MO',Montana:'MT',Nebraska:'NE',Nevada:'NV','New Hampshire':'NH','New Jersey':'NJ','New Mexico':'NM','New York':'NY','North Carolina':'NC','North Dakota':'ND',Ohio:'OH',Oklahoma:'OK',Oregon:'OR',Pennsylvania:'PA','Rhode Island':'RI','South Carolina':'SC','South Dakota':'SD',Tennessee:'TN',Texas:'TX',Utah:'UT',Vermont:'VT',Virginia:'VA',Washington:'WA','West Virginia':'WV',Wisconsin:'WI',Wyoming:'WY','District of Columbia':'DC'
}));

const typeLabels = {
  internship: 'Internship',
  apprenticeship: 'Apprenticeship',
  trainee: 'Trainee program',
  'entry-level': 'Data center job'
};
const experienceLabels = {
  'no-experience': 'no prior experience required',
  '0-2-years': '0–2 years of experience',
  '2-5-years': '2–5 years of experience'
};
const presentationTags = new Set([
  'Internship', 'Apprenticeship', 'Trainee', 'No Experience Needed', '0–2 Years', '2–5 Years'
]);

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

const FUTURE_DATE_GRACE_MS = 6 * 60 * 60 * 1000;

function validSchemaDate(value) {
  const parsed = Date.parse(String(value || ''));
  if (!Number.isFinite(parsed) || parsed > Date.now() + FUTURE_DATE_GRACE_MS) return null;
  return new Date(parsed).toISOString();
}

function jobDatePosted(job) {
  const employerDate = validSchemaDate(job?.postedAt);
  if (employerDate) return employerDate;

  // When an employer source omits its original posting date, use the persistent
  // first-seen timestamp as the publication date of our own verified job page.
  const firstSeenDate = validSchemaDate(job?.firstSeenAt);
  if (firstSeenDate) return firstSeenDate;

  throw new Error(`Job ${job?.id || 'unknown'} is missing valid postedAt and firstSeenAt evidence for JobPosting datePosted.`);
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
    ['no-experience', job => job.experience === 'no-experience'],
    ['trainee-jobs', job => job.type === 'trainee']
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

function readableList(items) {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

function focusAreas(job) {
  return [...new Set((job.tags || [])
    .map(clean)
    .filter(tag => tag && !presentationTags.has(tag)))];
}

function roleOverview(job) {
  const opportunity = typeLabels[job.type] || 'Data center opportunity';
  const experience = experienceLabels[job.experience] || 'an early- to mid-career experience level';
  const focus = focusAreas(job);
  const sentences = [
    `${job.title} at ${job.company} is a ${opportunity.toLowerCase()} in ${job.location}.`,
    `We classify this opening for candidates with ${experience}, using the employer listing and role level.`,
    focus.length
      ? `The listing is associated with ${readableList(focus.map(tag => tag.toLowerCase()))}.`
      : 'The role is part of hands-on data center infrastructure work.'
  ];
  if (clean(job.pay) && clean(job.pay).toLowerCase() !== 'pay not listed') {
    sentences.push(`The employer listing shows ${clean(job.pay)}.`);
  }
  sentences.push('Review the employer career page for the complete duties, qualifications, schedule, and application details.');
  return clean(sentences.join(' '));
}

function overviewHtml(job, overview) {
  const focus = focusAreas(job);
  const opportunity = typeLabels[job.type] || 'Data center opportunity';
  const experience = experienceLabels[job.experience] || 'Early- to mid-career';
  return `<section class="seo-role-overview" aria-labelledby="role-overview-heading"><h2 id="role-overview-heading">At a glance</h2><p>${esc(overview)}</p><ul><li><strong>Opportunity:</strong> ${esc(opportunity)}</li><li><strong>Experience:</strong> ${esc(experience)}</li>${focus.length ? `<li><strong>Focus:</strong> ${esc(readableList(focus))}</li>` : ''}</ul></section>`;
}

function jobsBrowserHtml() {
  return `<section class="jobs-browser" data-jobs-browser aria-labelledby="jobs-tools-heading">
    <div class="jobs-tools-head"><div><span class="seo-kicker">FIND THE RIGHT OPENING</span><h2 id="jobs-tools-heading">Search and filter jobs</h2></div><button class="jobs-reset" id="jobs-reset" type="button">Reset</button></div>
    <div class="jobs-search-row">
      <label class="jobs-field jobs-search-field" for="jobs-search"><span>Search jobs</span><input id="jobs-search" type="search" inputmode="search" autocomplete="off" placeholder="Job title, company, city or skill"></label>
      <label class="jobs-field" for="jobs-sort"><span>Sort by</span><select id="jobs-sort"><option value="recommended">Best match for early career</option><option value="newest">Newest</option><option value="company">Company A–Z</option><option value="location">Location A–Z</option><option value="pay">Highest listed pay</option></select></label>
    </div>
    <div class="jobs-filter-grid">
      <label class="jobs-field" for="jobs-type"><span>Opportunity type</span><select id="jobs-type"><option value="">All types</option><option value="apprenticeship">Apprenticeships</option><option value="internship">Internships</option><option value="trainee">Trainee programs</option><option value="entry-level">Entry-level jobs</option></select></label>
      <label class="jobs-field" for="jobs-experience"><span>Experience</span><select id="jobs-experience"><option value="">All experience levels</option><option value="no-experience">No experience required</option><option value="0-2-years">0–2 years</option><option value="2-5-years">2–5 years</option></select></label>
      <label class="jobs-field" for="jobs-region"><span>Region</span><select id="jobs-region"><option value="">All U.S. regions</option><option value="mid-atlantic">Mid-Atlantic</option><option value="texas">Texas</option><option value="southwest">Southwest</option><option value="midwest">Midwest</option><option value="southeast">Southeast</option><option value="northeast">Northeast</option><option value="west">West</option></select></label>
    </div>
    <p class="jobs-results-summary" id="jobs-results-summary" aria-live="polite">Showing the current job listings below.</p>
  </section>
  <p class="jobs-results-empty" id="jobs-results-empty" hidden>No openings match those filters. Try removing a filter or using a broader search.</p>`;
}

async function enhanceJobsListing() {
  const path = 'jobs/index.html';
  let html = await readFile(path, 'utf8');
  if (!html.includes('data-jobs-browser')) {
    const listMarker = '<section class="seo-list"';
    const listIndex = html.indexOf(listMarker);
    if (listIndex < 0) throw new Error('jobs/index.html is missing the listing marker.');
    html = `${html.slice(0, listIndex)}${jobsBrowserHtml()}\n      ${html.slice(listIndex)}`;
  }
  html = html.replace('<section class="seo-list" aria-label="Data center jobs">', '<section class="seo-list" data-job-results aria-label="Data center jobs">');
  if (!html.includes('/assets/jobs-listing.css')) {
    html = html.replace('</head>', `<link rel="stylesheet" href="${baseUrl}/assets/jobs-listing.css">\n</head>`);
  }
  if (!html.includes('/assets/jobs-listing.js')) {
    html = html.replace('</body>', `<script src="${baseUrl}/assets/jobs-listing.js" defer></script></body>`);
  }
  const required = ['data-jobs-browser','id="jobs-search"','id="jobs-sort"','id="jobs-type"','id="jobs-experience"','id="jobs-region"','data-job-results','/assets/jobs-listing.css','/assets/jobs-listing.js'];
  for (const marker of required) {
    if (!html.includes(marker)) throw new Error(`jobs/index.html is missing jobs browser marker: ${marker}`);
  }
  await writeFile(path, html);
}

function isEarlyCareerTechnician(job) {
  const title = clean(job.title);
  return ['no-experience','0-2-years'].includes(job.experience)
    && /\btechnician\b|\btech\s*(?:i|1)\b/i.test(title);
}

function topTechnicianEmployers(list, limit = 6) {
  const counts = new Map();
  for (const job of list) {
    const company = clean(job.company);
    if (!company) continue;
    counts.set(company, (counts.get(company) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([company]) => company);
}

function technicianCard(job) {
  const url = `${baseUrl}/jobs/${jobSlug(job)}/`;
  const experience = job.experience === 'no-experience' ? 'No experience required' : '0–2 years';
  return `<article class="seo-job-card"><div class="seo-job-main"><span class="seo-kicker">ENTRY-LEVEL TECHNICIAN ROLE</span><h2><a href="${url}">${esc(job.title)}</a></h2><p class="seo-meta"><strong>${esc(job.company)}</strong> · ${esc(job.location)}</p><div class="seo-tags"><span>${experience}</span></div></div><div class="seo-job-side"><a href="${url}">Job details →</a></div></article>`;
}

async function generateTechnicianPages() {
  const list = [...jobs]
    .filter(isEarlyCareerTechnician)
    .sort((a,b) => earlyRank(a)-earlyRank(b) || (a.postedHours ?? 9999)-(b.postedHours ?? 9999));
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const generated = [];
  const noExperienceCount = list.filter(job => job.experience === 'no-experience').length;
  const employers = topTechnicianEmployers(list);
  const employerText = employers.length ? ` Current openings include roles from ${readableList(employers)}.` : '';

  for (let page = 1; page <= pages; page += 1) {
    const start = (page - 1) * PAGE_SIZE;
    const subset = list.slice(start, start + PAGE_SIZE);
    const canonical = pagePath('data-center-technician-jobs', page);
    const title = page === 1
      ? 'Data Center Technician Jobs | Entry Level & No Experience'
      : `Data Center Technician Jobs - Page ${page} | Data Center Careers`;
    const description = 'Browse current employer-direct data center technician jobs for entry-level candidates, including roles classified for no prior experience or 0–2 years.';
    const prev = page > 1 ? pagePath('data-center-technician-jobs', page - 1) : '';
    const next = page < pages ? pagePath('data-center-technician-jobs', page + 1) : '';
    const schema = {
      '@context':'https://schema.org',
      '@type':'ItemList',
      name:'Entry-level data center technician jobs',
      numberOfItems:subset.length,
      itemListElement:subset.map((job,index) => ({
        '@type':'ListItem',
        position:start + index + 1,
        url:`${baseUrl}/jobs/${jobSlug(job)}/`,
        name:job.title
      }))
    };
    const pagination = pages > 1
      ? `<nav class="seo-pagination" aria-label="Pagination">${page > 1 ? `<a href="${prev}">← Previous</a>` : '<span></span>'}<span>Page ${page} of ${pages}</span>${page < pages ? `<a href="${next}">Next →</a>` : '<span></span>'}</nav>`
      : '';
    const context = page === 1
      ? `<section class="guide-section" aria-labelledby="technician-no-experience-heading"><span class="seo-kicker">BEGINNER TECHNICIAN PATH</span><h2 id="technician-no-experience-heading">Can you get a data center technician job with no experience?</h2><p>Some technician openings are designed for first-time data center applicants, while others ask for up to two years of related electrical, mechanical, hardware, networking, facilities or military technical experience. We only include technician roles on this page when the published experience level is no experience or 0–2 years.${esc(employerText)}</p><p>“No experience required” refers to prior data center experience. Employers may still require a diploma, shift availability, basic technical skills, safety awareness, a license or another stated qualification. Always check the original employer posting before applying.</p><div class="guide-stats"><div><strong>${list.length}</strong><span>entry-level technician openings</span></div><div><strong>${noExperienceCount}</strong><span>classified no experience</span></div></div></section><aside class="seo-related"><h2>Related beginner routes</h2><a href="${baseUrl}/no-experience/">Data center jobs with no experience</a><a href="${baseUrl}/entry-level/">Entry-level data center jobs</a><a href="${baseUrl}/trainee-jobs/">Data center trainee jobs</a><a href="${baseUrl}/apprenticeships/">Data center apprenticeships</a><a href="${baseUrl}/internships/">Data center internships</a></aside>`
      : '';
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${esc(title)}</title><meta name="description" content="${esc(description)}"><meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1"><link rel="canonical" href="${canonical}">${prev ? `<link rel="prev" href="${prev}">` : ''}${next ? `<link rel="next" href="${next}">` : ''}<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${canonical}"><link rel="stylesheet" href="${baseUrl}/assets/seo.css"><script type="application/ld+json">${JSON.stringify(schema).replace(/</g, '\\u003c')}</script></head><body><header class="seo-header"><div class="seo-header-inner"><a class="seo-brand" href="${baseUrl}/"><small>LAUNCH YOUR</small><strong>DATA CENTER CAREER</strong></a><nav class="seo-nav" aria-label="Primary"><a href="${baseUrl}/">Home</a><a href="${baseUrl}/jobs/">All jobs</a><a href="${baseUrl}/apprenticeships/">Apprenticeships</a><a href="${baseUrl}/internships/">Internships</a><a href="${baseUrl}/entry-level/">Entry-level</a><a href="${baseUrl}/career-events/">Career events</a></nav></div></header><main class="seo-shell"><nav class="breadcrumbs"><a href="${baseUrl}/">Home</a> / <span>Data center technician jobs</span></nav><header class="seo-page-head"><span class="seo-kicker">EMPLOYER-DIRECT OPPORTUNITIES</span><h1>Entry-level data center technician jobs</h1><p>Current data center technician jobs for entry-level candidates, including openings classified for no prior data center experience or 0–2 years.</p><strong>${list.length} current opportunities</strong></header><section class="seo-list" aria-label="Entry-level data center technician jobs">${subset.map(technicianCard).join('') || '<p>No matching technician openings are currently in the verified feed. Check the related beginner routes below while new roles open.</p>'}</section>${pagination}${context}</main><footer class="seo-footer"><div><strong>Launch Your Data Center Career</strong><span>Employer-direct data center jobs, internships and apprenticeships.</span></div><a href="${baseUrl}/">Back to home</a></footer></body></html>`;
    const out = page === 1 ? 'data-center-technician-jobs/index.html' : `data-center-technician-jobs/page/${page}/index.html`;
    await mkdir(out.replace(/\/[^/]+$/, ''), { recursive: true });
    await writeFile(out, html);
    generated.push({ url: canonical, lastmod: maxLastmod(subset) });
  }
  return generated;
}

async function addTechnicianCrossLink(path) {
  let html = await readFile(path, 'utf8');
  if (html.includes('/data-center-technician-jobs/')) return;
  const markers = [
    '<aside class="seo-related"><h2>Keep exploring</h2>',
    '<aside class="seo-related"><h2>Explore more opportunities</h2>'
  ];
  const marker = markers.find(candidate => html.includes(candidate));
  if (!marker) return;
  html = html.replace(marker, `${marker}<a href="${baseUrl}/data-center-technician-jobs/">Entry-level data center technician jobs</a>`);
  await writeFile(path, html);
}

let enhancedLocations = 0;
let enrichedJobPages = 0;
let structuredDateCount = 0;
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
  schema.datePosted = jobDatePosted(job);
  structuredDateCount += 1;
  if (job.type === 'internship') schema.employmentType = 'INTERN';

  const overview = roleOverview(job);
  schema.description = overview;
  const focus = focusAreas(job);
  if (focus.length) schema.skills = focus.join(', ');

  const fields = locationFields(job.location);
  if (fields.jobLocation || fields.jobLocationType) enhancedLocations += 1;
  Object.assign(schema, fields);

  const replacement = `<script type="application/ld+json">${JSON.stringify(schema).replace(/</g, '\\u003c')}</script>`;
  html = html.replace(match[0], replacement);

  if (!html.includes('class="seo-role-overview"')) {
    const applyMarker = '<a class="seo-apply"';
    const markerIndex = html.indexOf(applyMarker);
    if (markerIndex < 0) throw new Error(`Job page ${path} is missing the employer apply link marker.`);
    html = `${html.slice(0, markerIndex)}${overviewHtml(job, overview)}\n      ${html.slice(markerIndex)}`;
  }

  if (!html.includes('/data-center-technician-jobs/')) {
    const relatedMarker = '<aside class="seo-related"><h2>Explore more opportunities</h2>';
    html = html.replace(relatedMarker, `${relatedMarker}<a href="${baseUrl}/data-center-technician-jobs/">Entry-level data center technician jobs</a>`);
  }

  if (!html.includes(esc(overview))) throw new Error(`Job page ${path} did not receive the plain-language role overview.`);
  enrichedJobPages += 1;
  await writeFile(path, html);
}

if (enrichedJobPages !== jobs.length) {
  throw new Error(`Only ${enrichedJobPages}/${jobs.length} generated job pages received SEO enrichment.`);
}
if (structuredDateCount !== jobs.length) {
  throw new Error(`Only ${structuredDateCount}/${jobs.length} generated JobPosting pages received datePosted evidence.`);
}

await enhanceJobsListing();
const technicianPages = await generateTechnicianPages();
await addTechnicianCrossLink('entry-level/index.html');
await addTechnicianCrossLink('no-experience/index.html');
await addTechnicianCrossLink('trainee-jobs/index.html');

let sitemap = await readFile('sitemap.xml', 'utf8');
for (const page of technicianPages) {
  if (sitemap.includes(`<loc>${page.url}</loc>`)) continue;
  const lastmod = page.lastmod ? `<lastmod>${page.lastmod}</lastmod>` : '';
  sitemap = sitemap.replace('</urlset>', `  <url><loc>${page.url}</loc>${lastmod}</url>\n</urlset>`);
}
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

console.log(`SEO hardening complete: ${enrichedJobPages}/${jobs.length} job pages received plain-language role context; ${structuredDateCount}/${jobs.length} JobPosting pages received datePosted evidence; ${enhancedLocations}/${jobs.length} received structured location data; ${technicianPages.length} technician search pages generated; ${correctedLastmods} sitemap URLs use meaningful change dates; employer page included in sitemap; jobs search/filter/sort controls enabled.`);
