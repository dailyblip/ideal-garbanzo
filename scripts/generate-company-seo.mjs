import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';

const PAGE_SIZE = 25;
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const slugify = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'company';
const jobSlug = job => `${slugify(job.title)}-${slugify(job.company).slice(0, 32)}-${String(job.id || '').replace(/[^a-zA-Z0-9]/g, '').slice(-10)}`;
const json = value => JSON.stringify(value).replace(/</g, '\\u003c');

const domain = clean(await readFile('CNAME', 'utf8')).replace(/^https?:\/\//, '').replace(/\/$/, '');
if (!domain) throw new Error('CNAME is required for company SEO generation.');
const baseUrl = `https://${domain}`;
const jobs = JSON.parse(await readFile('data/jobs.json', 'utf8'));
if (!Array.isArray(jobs) || !jobs.length) throw new Error('data/jobs.json must contain a non-empty array.');

const priorityOrder = [
  'Meta', 'Google', 'Microsoft', 'Amazon Web Services', 'Oracle', 'Equinix', 'Digital Realty',
  'QTS Data Centers', 'Vantage Data Centers', 'CyrusOne', 'STACK Infrastructure',
  'Aligned Data Centers', 'NTT Global Data Centers'
];
const priorityRank = new Map(priorityOrder.map((name, index) => [name, index]));

const typeLabel = type => ({ internship: 'Internship', apprenticeship: 'Apprenticeship', trainee: 'Trainee program', 'entry-level': 'Entry-level job' })[type] || 'Data center job';
const experienceLabel = exp => ({ 'no-experience': 'No experience required', '0-2-years': '0–2 years', '2-5-years': '2–5 years' })[exp] || exp;
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
function companySlug(company) {
  return slugify(company);
}
function companyUrl(company, page = 1) {
  const root = `${baseUrl}/companies/${companySlug(company)}/`;
  return page === 1 ? root : `${root}page/${page}/`;
}
function head({ title, description, canonical, schema, prev = '', next = '' }) {
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n<title>${esc(title)}</title>\n<meta name="description" content="${esc(description)}">\n<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1">\n<link rel="canonical" href="${canonical}">\n${prev ? `<link rel="prev" href="${prev}">` : ''}\n${next ? `<link rel="next" href="${next}">` : ''}\n<meta property="og:type" content="website">\n<meta property="og:title" content="${esc(title)}">\n<meta property="og:description" content="${esc(description)}">\n<meta property="og:url" content="${canonical}">\n<meta name="twitter:card" content="summary">\n<meta name="twitter:title" content="${esc(title)}">\n<meta name="twitter:description" content="${esc(description)}">\n<link rel="stylesheet" href="${baseUrl}/assets/seo.css">\n<script type="application/ld+json">${json(schema)}</script>\n</head>`;
}
function siteHeader() {
  return `<header class="seo-header"><div class="seo-header-inner"><a class="seo-brand" href="${baseUrl}/"><small>LAUNCH YOUR</small><strong>DATA CENTER CAREER</strong></a><nav class="seo-nav" aria-label="Primary"><a href="${baseUrl}/">Home</a><a href="${baseUrl}/jobs/">All jobs</a><a href="${baseUrl}/companies/">Companies</a><a href="${baseUrl}/apprenticeships/">Apprenticeships</a><a href="${baseUrl}/internships/">Internships</a><a href="${baseUrl}/entry-level/">Entry-level</a><a href="${baseUrl}/career-events/">Career events</a></nav></div></header>`;
}
function footer() {
  return `<footer class="seo-footer"><div><strong>Launch Your Data Center Career</strong><span>Employer-direct data center jobs, internships and apprenticeships.</span></div><a href="${baseUrl}/jobs/">Browse all jobs</a></footer>`;
}
function jobCard(job) {
  const internal = `${baseUrl}/jobs/${jobSlug(job)}/`;
  const pay = clean(job.pay) && !/^pay not listed$/i.test(clean(job.pay)) ? `<p class="seo-pay">${esc(job.pay)}</p>` : '';
  return `<article class="seo-job-card"><div class="seo-job-main"><span class="seo-kicker">${esc(typeLabel(job.type))}</span><h2><a href="${internal}">${esc(job.title)}</a></h2><p class="seo-meta"><strong>${esc(job.company)}</strong> · ${esc(job.location)}</p><div class="seo-tags"><span>${esc(experienceLabel(job.experience))}</span>${(job.tags || []).map(tag => `<span>${esc(tag)}</span>`).join('')}</div>${pay}</div><div class="seo-job-side"><span>${esc(postedLabel(job.postedHours))}</span><a href="${internal}">Job details →</a></div></article>`;
}
async function writeHtml(path, html) {
  await mkdir(path.replace(/\/[^/]+$/, ''), { recursive: true });
  await writeFile(path, html);
}

const grouped = new Map();
for (const job of orderedJobs) {
  const company = clean(job.company);
  if (!company) continue;
  if (!grouped.has(company)) grouped.set(company, []);
  grouped.get(company).push(job);
}
if (!grouped.size) throw new Error('No companies could be derived from the current job feed.');

const slugOwners = new Map();
for (const company of grouped.keys()) {
  const slug = companySlug(company);
  const owner = slugOwners.get(slug);
  if (owner && owner !== company) throw new Error(`Company slug collision: ${owner} and ${company} both map to ${slug}`);
  slugOwners.set(slug, company);
}

const companies = [...grouped.entries()].sort(([a, aJobs], [b, bJobs]) => {
  const aPriority = priorityRank.has(a) ? priorityRank.get(a) : Number.MAX_SAFE_INTEGER;
  const bPriority = priorityRank.has(b) ? priorityRank.get(b) : Number.MAX_SAFE_INTEGER;
  if (aPriority !== bPriority) return aPriority - bPriority;
  return bJobs.length - aJobs.length || a.localeCompare(b);
});

await rm('companies', { recursive: true, force: true });
const sitemapEntries = [];
const hubCanonical = `${baseUrl}/companies/`;
const hubSchema = {
  '@context': 'https://schema.org',
  '@type': 'ItemList',
  name: 'Companies hiring for data center roles',
  numberOfItems: companies.length,
  itemListElement: companies.map(([company, companyJobs], index) => ({
    '@type': 'ListItem',
    position: index + 1,
    url: companyUrl(company),
    name: company,
    description: `${companyJobs.length} current mission-fit role${companyJobs.length === 1 ? '' : 's'}`
  }))
};
const companyLinks = companies.map(([company, companyJobs]) => `<a href="${companyUrl(company)}"><strong>${esc(company)}</strong><span>${companyJobs.length} current role${companyJobs.length === 1 ? '' : 's'}</span></a>`).join('');
const hubHtml = `${head({ title: 'Data Center Jobs by Company | Current Employer-Direct Openings', description: 'Browse current employer-direct data center jobs by company, including major operators, hyperscalers and infrastructure employers with active mission-fit openings.', canonical: hubCanonical, schema: hubSchema })}<body>${siteHeader()}<main class="seo-shell"><nav class="breadcrumbs"><a href="${baseUrl}/">Home</a> / <a href="${baseUrl}/jobs/">Jobs</a> / <span>Companies</span></nav><header class="seo-page-head"><span class="seo-kicker">BROWSE BY EMPLOYER</span><h1>Companies hiring for data center roles</h1><p>These employers currently have at least one role in our employer-direct job feed. Open a company to see the current mission-fit opportunities we have verified from employer career sources.</p><strong>${companies.length} employers with current openings</strong></header><section class="seo-related" aria-label="Companies with current data center openings"><h2>Browse current openings by company</h2>${companyLinks}</section></main>${footer()}</body></html>`;
await writeHtml('companies/index.html', hubHtml);
sitemapEntries.push({ url: hubCanonical, lastmod: maxLastmod(orderedJobs) });

for (const [company, list] of companies) {
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const companyLastmod = maxLastmod(list);
  for (let page = 1; page <= pages; page += 1) {
    const start = (page - 1) * PAGE_SIZE;
    const subset = list.slice(start, start + PAGE_SIZE);
    const canonical = companyUrl(company, page);
    const prev = page > 1 ? companyUrl(company, page - 1) : '';
    const next = page < pages ? companyUrl(company, page + 1) : '';
    const titleBase = `${company} Data Center Jobs | Current Openings`;
    const pageTitle = page === 1 ? titleBase : `${titleBase} - Page ${page}`;
    const description = `Browse ${list.length} current employer-direct data center role${list.length === 1 ? '' : 's'} from ${company}, filtered for hands-on infrastructure work and appropriate 0-5 year opportunities.`;
    const itemList = {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: `${company} data center jobs`,
      numberOfItems: subset.length,
      itemListElement: subset.map((job, index) => ({ '@type': 'ListItem', position: start + index + 1, url: `${baseUrl}/jobs/${jobSlug(job)}/`, name: job.title }))
    };
    const pagination = pages > 1 ? `<nav class="seo-pagination" aria-label="Pagination">${page > 1 ? `<a href="${prev}">← Previous</a>` : '<span></span>'}<span>Page ${page} of ${pages}</span>${page < pages ? `<a href="${next}">Next →</a>` : '<span></span>'}</nav>` : '';
    const related = page === 1 ? `<aside class="seo-related"><h2>Keep exploring</h2><a href="${hubCanonical}">Browse all companies</a><a href="${baseUrl}/entry-level/">Entry-level data center jobs</a><a href="${baseUrl}/no-experience/">Jobs with no experience required</a><a href="${baseUrl}/jobs/">All current jobs</a></aside>` : '';
    const html = `${head({ title: pageTitle, description, canonical, schema: itemList, prev, next })}<body>${siteHeader()}<main class="seo-shell"><nav class="breadcrumbs"><a href="${baseUrl}/">Home</a> / <a href="${baseUrl}/jobs/">Jobs</a> / <a href="${hubCanonical}">Companies</a> / <span>${esc(company)}</span></nav><header class="seo-page-head"><span class="seo-kicker">EMPLOYER-DIRECT OPPORTUNITIES</span><h1>${esc(company)} data center jobs</h1><p>Current roles from ${esc(company)} in our mission-fit feed. We include data center, facilities, critical-environment, electrical, operations, internship, apprenticeship, trainee and appropriate 0-5 year infrastructure roles when the employer's published requirements fit.</p><strong>${list.length} current opportunit${list.length === 1 ? 'y' : 'ies'}</strong></header><section class="seo-list" aria-label="${esc(company)} current data center jobs">${subset.map(jobCard).join('')}</section>${pagination}${related}</main>${footer()}</body></html>`;
    const output = page === 1 ? `companies/${companySlug(company)}/index.html` : `companies/${companySlug(company)}/page/${page}/index.html`;
    await writeHtml(output, html);
    sitemapEntries.push({ url: canonical, lastmod: companyLastmod });
  }
}

let jobsIndex = await readFile('jobs/index.html', 'utf8');
if (!jobsIndex.includes('id="browse-companies"')) {
  const topCompanies = companies.slice(0, 12).map(([company, companyJobs]) => `<a href="${companyUrl(company)}">${esc(company)} <span>(${companyJobs.length})</span> →</a>`).join('');
  const companyHub = `<aside class="seo-related" id="browse-companies"><h2>Browse data center jobs by company</h2>${topCompanies}<a href="${hubCanonical}">All companies →</a></aside>`;
  jobsIndex = jobsIndex.replace('</main>', `${companyHub}</main>`);
  await writeFile('jobs/index.html', jobsIndex);
}

let linkedJobPages = 0;
for (const job of orderedJobs) {
  const path = `jobs/${jobSlug(job)}/index.html`;
  let html = await readFile(path, 'utf8');
  const company = clean(job.company);
  const href = companyUrl(company);
  if (!html.includes(`href="${href}"`)) {
    const companyMarkup = `<strong>${esc(company)}</strong>`;
    const linkedMarkup = `<a href="${href}">${companyMarkup}</a>`;
    if (!html.includes(companyMarkup)) throw new Error(`Could not add company link to generated job page: ${path}`);
    html = html.replace(companyMarkup, linkedMarkup);
    await writeFile(path, html);
  }
  linkedJobPages += 1;
}

let sitemap = await readFile('sitemap.xml', 'utf8');
for (const entry of sitemapEntries) {
  if (sitemap.includes(`<loc>${entry.url}</loc>`)) continue;
  const lastmod = entry.lastmod ? `<lastmod>${entry.lastmod}</lastmod>` : '';
  sitemap = sitemap.replace('</urlset>', `  <url><loc>${entry.url}</loc>${lastmod}</url>\n</urlset>`);
}
await writeFile('sitemap.xml', sitemap);

const firstPages = companies.map(([company]) => `companies/${companySlug(company)}/index.html`);
for (let index = 0; index < companies.length; index += 1) {
  const [company] = companies[index];
  const html = await readFile(firstPages[index], 'utf8');
  const canonical = companyUrl(company);
  if (!html.includes(`<link rel="canonical" href="${canonical}">`)) throw new Error(`Company page canonical missing for ${company}.`);
  if (!sitemap.includes(`<loc>${canonical}</loc>`)) throw new Error(`Company page missing from sitemap for ${company}.`);
}
if (!sitemap.includes(`<loc>${hubCanonical}</loc>`)) throw new Error('Company hub is missing from sitemap.');
if (linkedJobPages !== orderedJobs.length) throw new Error(`Linked ${linkedJobPages}/${orderedJobs.length} job pages to company landings.`);

console.log(`Company SEO generated: ${companies.length} employer landing pages plus pagination and a companies hub; linked ${linkedJobPages} job detail pages.`);
