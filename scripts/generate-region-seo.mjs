import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';

const PAGE_SIZE = 25;
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const slugify = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'job';
const jobSlug = job => `${slugify(job.title)}-${slugify(job.company).slice(0, 32)}-${String(job.id || '').replace(/[^a-zA-Z0-9]/g, '').slice(-10)}`;
const json = value => JSON.stringify(value).replace(/</g, '\\u003c');

const domain = clean(await readFile('CNAME', 'utf8')).replace(/^https?:\/\//, '').replace(/\/$/, '');
if (!domain) throw new Error('CNAME is required for regional SEO generation.');
const baseUrl = `https://${domain}`;
const jobs = JSON.parse(await readFile('data/jobs.json', 'utf8'));
if (!Array.isArray(jobs)) throw new Error('data/jobs.json must contain an array.');

const regions = [
  {
    key: 'mid-atlantic', slug: 'northern-virginia-mid-atlantic', label: 'Northern Virginia / Mid-Atlantic',
    title: 'Mid-Atlantic Data Center Jobs | Northern Virginia & More',
    h1: 'Data center jobs in Northern Virginia and the Mid-Atlantic',
    description: 'Browse current employer-direct data center jobs across Northern Virginia and the Mid-Atlantic, including technician, facilities, electrical and operations roles.',
    intro: 'Current openings across Virginia, Maryland, Washington, D.C., Delaware and West Virginia, with Northern Virginia highlighted as a major data center market.'
  },
  {
    key: 'texas', slug: 'texas', label: 'Texas',
    title: 'Texas Data Center Jobs | Entry-Level & Early-Career Roles',
    h1: 'Data center jobs in Texas',
    description: 'Browse current employer-direct data center jobs in Texas, including technician, critical facilities, electrical, operations and early-career roles.',
    intro: 'Current data center opportunities across Texas from employer career sites, with beginner-friendly and 0-5 year roles prioritized.'
  },
  {
    key: 'southwest', slug: 'southwest', label: 'Southwest',
    title: 'Southwest Data Center Jobs | Early-Career Infrastructure Roles',
    h1: 'Data center jobs in the Southwest',
    description: 'Browse current employer-direct data center jobs in Arizona, Nevada, New Mexico and Oklahoma, including facilities, operations and technician roles.',
    intro: 'Current data center opportunities across the Southwest, focused on hands-on infrastructure work and roles appropriate for 0-5 years of experience.'
  },
  {
    key: 'midwest', slug: 'midwest', label: 'Midwest',
    title: 'Midwest Data Center Jobs | Technician & Facilities Roles',
    h1: 'Data center jobs in the Midwest',
    description: 'Browse current employer-direct data center jobs across the Midwest, including technician, critical facilities, electrical and operations openings.',
    intro: 'Current data center opportunities across Midwestern markets, with apprenticeships, training routes and early-career infrastructure roles prioritized.'
  },
  {
    key: 'southeast', slug: 'southeast', label: 'Southeast',
    title: 'Southeast Data Center Jobs | Early-Career Infrastructure Roles',
    h1: 'Data center jobs in the Southeast',
    description: 'Browse current employer-direct data center jobs across the Southeast, including operations, technician, electrical and critical facilities roles.',
    intro: 'Current data center opportunities across Southeastern markets, focused on real employer openings and roles appropriate for 0-5 years of experience.'
  },
  {
    key: 'northeast', slug: 'northeast', label: 'Northeast',
    title: 'Northeast Data Center Jobs | Technician & Operations Roles',
    h1: 'Data center jobs in the Northeast',
    description: 'Browse current employer-direct data center jobs across the Northeast, including technician, facilities, electrical and operations opportunities.',
    intro: 'Current data center opportunities across Northeastern markets from employer career sites, with early-career and appropriate mid-level roles prioritized.'
  },
  {
    key: 'west', slug: 'west', label: 'West',
    title: 'Western U.S. Data Center Jobs | Early-Career Infrastructure Roles',
    h1: 'Data center jobs in the Western U.S.',
    description: 'Browse current employer-direct data center jobs across the Western U.S., including technician, facilities, electrical and operations openings.',
    intro: 'Current data center opportunities across Western markets from employer career sites, focused on hands-on roles requiring no more than five years of experience.'
  }
];

const typeLabel = type => ({ internship: 'Internship', apprenticeship: 'Apprenticeship', trainee: 'Trainee program', 'entry-level': 'Entry-level job' })[type] || 'Data center job';
const experienceLabel = exp => ({ 'no-experience': 'No experience required', '0-2-years': '0-2 years', '2-5-years': '2-5 years' })[exp] || exp;
const earlyRank = job => {
  const type = { apprenticeship: 0, internship: 1, trainee: 2, 'entry-level': 3 }[job.type] ?? 4;
  const exp = { 'no-experience': 0, '0-2-years': 1, '2-5-years': 4 }[job.experience] ?? 2;
  return type * 10 + exp;
};
const orderedJobs = [...jobs].sort((a, b) => earlyRank(a) - earlyRank(b) || (a.postedHours ?? 9999) - (b.postedHours ?? 9999));

function dateOnly(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
}
function jobLastmod(job) {
  return dateOnly(job.lastChangedAt) || dateOnly(job.firstSeenAt) || dateOnly(job.postedAt);
}
function maxLastmod(list) {
  const dates = list.map(jobLastmod).filter(Boolean).sort();
  return dates.length ? dates.at(-1) : null;
}
function postedLabel(hours) {
  if (!Number.isFinite(hours) || hours >= 9999) return 'Recently listed';
  if (hours < 24) return `${Math.max(1, hours)}h ago`;
  return `${Math.max(1, Math.round(hours / 24))}d ago`;
}
function regionUrl(region, page = 1) {
  return page === 1 ? `${baseUrl}/locations/${region.slug}/` : `${baseUrl}/locations/${region.slug}/page/${page}/`;
}
function head({ title, description, canonical, schema, prev = '', next = '' }) {
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n<title>${esc(title)}</title>\n<meta name="description" content="${esc(description)}">\n<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1">\n<link rel="canonical" href="${canonical}">\n${prev ? `<link rel="prev" href="${prev}">` : ''}\n${next ? `<link rel="next" href="${next}">` : ''}\n<meta property="og:type" content="website">\n<meta property="og:title" content="${esc(title)}">\n<meta property="og:description" content="${esc(description)}">\n<meta property="og:url" content="${canonical}">\n<meta name="twitter:card" content="summary">\n<meta name="twitter:title" content="${esc(title)}">\n<meta name="twitter:description" content="${esc(description)}">\n<link rel="stylesheet" href="${baseUrl}/assets/seo.css">\n<script type="application/ld+json">${json(schema)}</script>\n</head>`;
}
function siteHeader() {
  return `<header class="seo-header"><div class="seo-header-inner"><a class="seo-brand" href="${baseUrl}/"><small>LAUNCH YOUR</small><strong>DATA CENTER CAREER</strong></a><nav class="seo-nav" aria-label="Primary"><a href="${baseUrl}/">Home</a><a href="${baseUrl}/jobs/">All jobs</a><a href="${baseUrl}/apprenticeships/">Apprenticeships</a><a href="${baseUrl}/internships/">Internships</a><a href="${baseUrl}/entry-level/">Entry-level</a><a href="${baseUrl}/career-events/">Career events</a></nav></div></header>`;
}
function footer() {
  return `<footer class="seo-footer"><div><strong>Launch Your Data Center Career</strong><span>Employer-direct data center jobs, internships and apprenticeships.</span></div><a href="${baseUrl}/jobs/">Browse all jobs</a></footer>`;
}
function jobCard(job) {
  const internal = `${baseUrl}/jobs/${jobSlug(job)}/`;
  return `<article class="seo-job-card"><div class="seo-job-main"><span class="seo-kicker">${esc(typeLabel(job.type))}</span><h2><a href="${internal}">${esc(job.title)}</a></h2><p class="seo-meta"><strong>${esc(job.company)}</strong> · ${esc(job.location)}</p><div class="seo-tags"><span>${esc(experienceLabel(job.experience))}</span>${(job.tags || []).map(tag => `<span>${esc(tag)}</span>`).join('')}</div><p class="seo-pay">${esc(job.pay || 'Pay not listed')}</p></div><div class="seo-job-side"><span>${esc(postedLabel(job.postedHours))}</span><a href="${internal}">Job details →</a></div></article>`;
}
async function writeHtml(path, html) {
  await mkdir(path.replace(/\/[^/]+$/, ''), { recursive: true });
  await writeFile(path, html);
}

await rm('locations', { recursive: true, force: true });
const sitemapEntries = [];
const hubLinks = regions.map(region => `<a href="${baseUrl}/locations/${region.slug}/">${esc(region.label)} →</a>`).join('');
const hubCanonical = `${baseUrl}/locations/`;
const hubSchema = {
  '@context': 'https://schema.org', '@type': 'ItemList', name: 'Data center jobs by region',
  itemListElement: regions.map((region, index) => ({ '@type': 'ListItem', position: index + 1, url: `${baseUrl}/locations/${region.slug}/`, name: region.label }))
};
const hubHtml = `${head({ title: 'Data Center Jobs by Region | Data Center Careers', description: 'Browse employer-direct data center jobs by U.S. region, including Texas, Northern Virginia, the Midwest, Southeast, Southwest, Northeast and West.', canonical: hubCanonical, schema: hubSchema })}<body>${siteHeader()}<main class="seo-shell"><nav class="breadcrumbs"><a href="${baseUrl}/">Home</a> / <a href="${baseUrl}/jobs/">Jobs</a> / <span>Regions</span></nav><header class="seo-page-head"><span class="seo-kicker">BROWSE BY REGION</span><h1>Data center jobs by region</h1><p>Choose a region to see current employer-direct openings. The same early-career and 0-5 year mission-fit rules apply on every regional page.</p></header><section class="seo-related" aria-label="Data center job regions"><h2>Find opportunities near you</h2>${hubLinks}</section></main>${footer()}</body></html>`;
await writeHtml('locations/index.html', hubHtml);
sitemapEntries.push({ url: hubCanonical, lastmod: maxLastmod(orderedJobs) });

for (const region of regions) {
  const list = orderedJobs.filter(job => job.region === region.key);
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const regionLastmod = maxLastmod(list);
  for (let page = 1; page <= pages; page += 1) {
    const start = (page - 1) * PAGE_SIZE;
    const subset = list.slice(start, start + PAGE_SIZE);
    const canonical = regionUrl(region, page);
    const prev = page > 1 ? regionUrl(region, page - 1) : '';
    const next = page < pages ? regionUrl(region, page + 1) : '';
    const pageTitle = page === 1 ? region.title : `${region.title} - Page ${page}`;
    const itemList = {
      '@context': 'https://schema.org', '@type': 'ItemList', name: region.h1, numberOfItems: subset.length,
      itemListElement: subset.map((job, index) => ({ '@type': 'ListItem', position: start + index + 1, url: `${baseUrl}/jobs/${jobSlug(job)}/`, name: job.title }))
    };
    const pagination = pages > 1 ? `<nav class="seo-pagination" aria-label="Pagination">${page > 1 ? `<a href="${prev}">← Previous</a>` : '<span></span>'}<span>Page ${page} of ${pages}</span>${page < pages ? `<a href="${next}">Next →</a>` : '<span></span>'}</nav>` : '';
    const empty = subset.length ? subset.map(jobCard).join('') : '<p>No current openings are listed in this region. Browse all jobs or check back after the next employer refresh.</p>';
    const html = `${head({ title: pageTitle, description: region.description, canonical, schema: itemList, prev, next })}<body>${siteHeader()}<main class="seo-shell"><nav class="breadcrumbs"><a href="${baseUrl}/">Home</a> / <a href="${baseUrl}/jobs/">Jobs</a> / <a href="${hubCanonical}">Regions</a> / <span>${esc(region.label)}</span></nav><header class="seo-page-head"><span class="seo-kicker">EMPLOYER-DIRECT OPPORTUNITIES</span><h1>${esc(region.h1)}</h1><p>${esc(region.intro)}</p><strong>${list.length} current opportunities</strong></header><section class="seo-list" aria-label="${esc(region.h1)}">${empty}</section>${pagination}<aside class="seo-related"><h2>Explore another region</h2>${regions.filter(item => item.key !== region.key).slice(0, 4).map(item => `<a href="${baseUrl}/locations/${item.slug}/">${esc(item.label)} →</a>`).join('')}<a href="${baseUrl}/locations/">All regions →</a></aside></main>${footer()}</body></html>`;
    const out = page === 1 ? `locations/${region.slug}/index.html` : `locations/${region.slug}/page/${page}/index.html`;
    await writeHtml(out, html);
    sitemapEntries.push({ url: canonical, lastmod: regionLastmod });
  }
}

let jobsIndex = await readFile('jobs/index.html', 'utf8');
if (!jobsIndex.includes('id="browse-regions"')) {
  const regionHub = `<aside class="seo-related" id="browse-regions"><h2>Browse data center jobs by region</h2>${hubLinks}<a href="${hubCanonical}">All regions →</a></aside>`;
  jobsIndex = jobsIndex.replace('</main>', `${regionHub}</main>`);
  await writeFile('jobs/index.html', jobsIndex);
}

let sitemap = await readFile('sitemap.xml', 'utf8');
for (const entry of sitemapEntries) {
  if (sitemap.includes(`<loc>${entry.url}</loc>`)) continue;
  const lastmod = entry.lastmod ? `<lastmod>${entry.lastmod}</lastmod>` : '';
  sitemap = sitemap.replace('</urlset>', `  <url><loc>${entry.url}</loc>${lastmod}</url>\n</urlset>`);
}
await writeFile('sitemap.xml', sitemap);

console.log(`Regional SEO generated: ${regions.length} region landing pages plus pagination and a locations hub for ${jobs.length} jobs.`);
