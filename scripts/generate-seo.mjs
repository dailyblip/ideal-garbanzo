import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';

const FALLBACK_BASE = 'https://dailyblip.github.io/ideal-garbanzo';
const PAGE_SIZE = 25;

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const clean = value => String(value ?? '').replace(/\s+/g,' ').trim();
const slugify = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,70) || 'job';
const jobSlug = job => `${slugify(job.title)}-${slugify(job.company).slice(0,32)}-${String(job.id).replace(/[^a-zA-Z0-9]/g,'').slice(-10)}`;
const json = value => JSON.stringify(value).replace(/</g,'\\u003c');

async function getBaseUrl() {
  try {
    const cname = clean(await readFile('CNAME','utf8'));
    if (cname) return `https://${cname.replace(/^https?:\/\//,'').replace(/\/$/,'')}`;
  } catch {}
  return FALLBACK_BASE;
}

const baseUrl = await getBaseUrl();
const jobs = JSON.parse(await readFile('data/jobs.json','utf8'));
const generatedAt = new Date();
const lastmod = generatedAt.toISOString().slice(0,10);
const rawCareerEvents = JSON.parse(await readFile('data/career-events.json','utf8'));

function validIsoDate(value) {
  const text = clean(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,10) === text;
}

if (!Array.isArray(rawCareerEvents)) throw new Error('data/career-events.json must contain an array.');
const eventIds = new Set();
for (const event of rawCareerEvents) {
  if (!event || typeof event !== 'object') throw new Error('Career event records must be objects.');
  const required = ['id','date','name','location','organizer','url','verifiedAt','source'];
  for (const key of required) {
    if (!clean(event[key])) throw new Error(`Career event is missing ${key}.`);
  }
  if (eventIds.has(event.id)) throw new Error(`Duplicate career event id: ${event.id}`);
  eventIds.add(event.id);
  if (!validIsoDate(event.date)) throw new Error(`Career event has invalid date: ${event.id}`);
  if (!validIsoDate(event.verifiedAt)) throw new Error(`Career event has invalid verifiedAt date: ${event.id}`);
  if (!/^https:\/\//i.test(clean(event.url))) throw new Error(`Career event must use an HTTPS organizer URL: ${event.id}`);
  if (event.source !== 'Organizer page') throw new Error(`Career event must be verified from an organizer page: ${event.id}`);
}
const events = rawCareerEvents
  .filter(event => event.date >= lastmod)
  .sort((a,b) => String(a.date).localeCompare(String(b.date)));

const typeLabel = type => ({internship:'Internship',apprenticeship:'Apprenticeship',trainee:'Trainee program','entry-level':'Entry-level job'})[type] || 'Data center job';
const experienceLabel = exp => ({'no-experience':'No experience required','0-2-years':'0–2 years','2-5-years':'2–5 years'})[exp] || exp;
const earlyRank = job => {
  const t = {apprenticeship:0,internship:1,trainee:2,'entry-level':3}[job.type] ?? 4;
  const e = {'no-experience':0,'0-2-years':1,'2-5-years':4}[job.experience] ?? 2;
  return t * 10 + e;
};
const orderedJobs = [...jobs].sort((a,b) => earlyRank(a)-earlyRank(b) || (a.postedHours ?? 9999)-(b.postedHours ?? 9999));

const nav = `
<nav class="seo-nav" aria-label="Primary">
  <a href="${baseUrl}/">Home</a>
  <a href="${baseUrl}/jobs/">All jobs</a>
  <a href="${baseUrl}/apprenticeships/">Apprenticeships</a>
  <a href="${baseUrl}/internships/">Internships</a>
  <a href="${baseUrl}/entry-level/">Entry-level</a>
  <a href="${baseUrl}/career-events/">Career events</a>
</nav>`;

function head({title,description,canonical,schema='',prev='',next=''}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1">
<link rel="canonical" href="${canonical}">
${prev ? `<link rel="prev" href="${prev}">` : ''}
${next ? `<link rel="next" href="${next}">` : ''}
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${canonical}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<link rel="stylesheet" href="${baseUrl}/assets/seo.css">
${schema ? `<script type="application/ld+json">${schema}</script>` : ''}
</head>`;
}

function siteHeader() {
  return `<header class="seo-header"><div class="seo-header-inner"><a class="seo-brand" href="${baseUrl}/"><small>LAUNCH YOUR</small><strong>DATA CENTER CAREER</strong></a>${nav}</div></header>`;
}

function footer() {
  return `<footer class="seo-footer"><div><strong>Launch Your Data Center Career</strong><span>Employer-direct data center jobs, internships and apprenticeships.</span></div><a href="${baseUrl}/">Back to home</a></footer>`;
}

function postedLabel(hours) {
  if (!Number.isFinite(hours) || hours >= 9999) return 'Recently listed';
  if (hours < 24) return `${Math.max(1,hours)}h ago`;
  return `${Math.max(1,Math.round(hours/24))}d ago`;
}

function card(job) {
  const internal = `${baseUrl}/jobs/${jobSlug(job)}/`;
  return `<article class="seo-job-card">
    <div class="seo-job-main">
      <span class="seo-kicker">${esc(typeLabel(job.type))}</span>
      <h2><a href="${internal}">${esc(job.title)}</a></h2>
      <p class="seo-meta"><strong>${esc(job.company)}</strong> · ${esc(job.location)}</p>
      <div class="seo-tags"><span>${esc(experienceLabel(job.experience))}</span>${(job.tags || []).map(tag => `<span>${esc(tag)}</span>`).join('')}</div>
      <p class="seo-pay">${esc(job.pay || 'Pay not listed')}</p>
    </div>
    <div class="seo-job-side"><span>${esc(postedLabel(job.postedHours))}</span><a href="${internal}">Job details →</a></div>
  </article>`;
}

function pagePath(root, page) {
  if (page === 1) return `${baseUrl}/${root}/`;
  return `${baseUrl}/${root}/page/${page}/`;
}

async function writeHtml(path, html) {
  await mkdir(path.replace(/\/[^/]+$/,''), {recursive:true});
  await writeFile(path, html);
}

async function generateListing({root,title,h1,description,intro,filter}) {
  const list = orderedJobs.filter(filter);
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const urls = [];
  for (let page=1; page<=pages; page++) {
    const start = (page-1)*PAGE_SIZE;
    const subset = list.slice(start,start+PAGE_SIZE);
    const canonical = pagePath(root,page);
    const pageTitle = page === 1 ? title : `${title} – Page ${page}`;
    const itemList = {
      '@context':'https://schema.org',
      '@type':'ItemList',
      name:h1,
      numberOfItems:subset.length,
      itemListElement:subset.map((job,index) => ({'@type':'ListItem',position:start+index+1,url:`${baseUrl}/jobs/${jobSlug(job)}/`,name:job.title}))
    };
    const prev = page > 1 ? pagePath(root,page-1) : '';
    const next = page < pages ? pagePath(root,page+1) : '';
    const pagination = pages > 1 ? `<nav class="seo-pagination" aria-label="Pagination">${page>1?`<a href="${prev}">← Previous</a>`:'<span></span>'}<span>Page ${page} of ${pages}</span>${page<pages?`<a href="${next}">Next →</a>`:'<span></span>'}</nav>` : '';
    const html = `${head({title:pageTitle,description,canonical,schema:json(itemList),prev,next})}<body>${siteHeader()}<main class="seo-shell">
      <nav class="breadcrumbs"><a href="${baseUrl}/">Home</a> / <span>${esc(h1)}</span></nav>
      <header class="seo-page-head"><span class="seo-kicker">EMPLOYER-DIRECT OPPORTUNITIES</span><h1>${esc(h1)}</h1><p>${esc(intro)}</p><strong>${list.length} current opportunities</strong></header>
      <section class="seo-list" aria-label="${esc(h1)}">${subset.map(card).join('')}</section>${pagination}
    </main>${footer()}</body></html>`;
    const out = page === 1 ? `${root}/index.html` : `${root}/page/${page}/index.html`;
    await writeHtml(out,html);
    urls.push(canonical);
  }
  return urls;
}

function jobLocationSchema(location) {
  const value = clean(location);
  if (/remote/i.test(value)) return {'@type':'Place','address':{'@type':'PostalAddress','addressCountry':'US'}};
  const m = value.match(/^([^,;]+),\s*([A-Z]{2})$/);
  if (!m) return undefined;
  return {'@type':'Place','address':{'@type':'PostalAddress','addressLocality':m[1],'addressRegion':m[2],'addressCountry':'US'}};
}

function salarySchema(job) {
  const min = Number(job.salaryMin), max = Number(job.salaryMax);
  if (!Number.isFinite(min) && !Number.isFinite(max)) return undefined;
  const unitText = /hr|hour/i.test(job.pay || '') ? 'HOUR' : 'YEAR';
  const value = {};
  if (Number.isFinite(min)) value.minValue = min;
  if (Number.isFinite(max)) value.maxValue = max;
  value.unitText = unitText;
  return {'@type':'MonetaryAmount','currency':'USD','value':{'@type':'QuantitativeValue',...value}};
}

async function generateJobPages() {
  const urls=[];
  for (const job of orderedJobs) {
    const canonical = `${baseUrl}/jobs/${jobSlug(job)}/`;
    const description = `${job.title} at ${job.company} in ${job.location}. ${typeLabel(job.type)} · ${experienceLabel(job.experience)}. View the verified employer listing and apply at the source.`;
    const schema = {
      '@context':'https://schema.org','@type':'JobPosting',
      title:job.title,
      description,
      datePosted:job.postedAt || undefined,
      hiringOrganization:{'@type':'Organization','name':job.company},
      jobLocation:jobLocationSchema(job.location),
      baseSalary:salarySchema(job),
      url:canonical,
      directApply:false
    };
    Object.keys(schema).forEach(key => schema[key] === undefined && delete schema[key]);
    const html = `${head({title:`${job.title} – ${job.company} | Data Center Careers`,description,canonical,schema:json(schema)})}<body>${siteHeader()}<main class="seo-shell seo-detail">
      <nav class="breadcrumbs"><a href="${baseUrl}/">Home</a> / <a href="${baseUrl}/jobs/">Jobs</a> / <span>${esc(job.title)}</span></nav>
      <article class="seo-detail-card"><span class="seo-kicker">${esc(typeLabel(job.type))}</span><h1>${esc(job.title)}</h1><p class="seo-meta"><strong>${esc(job.company)}</strong> · ${esc(job.location)}</p>
      <div class="seo-tags"><span>${esc(experienceLabel(job.experience))}</span>${(job.tags || []).map(tag=>`<span>${esc(tag)}</span>`).join('')}</div>
      <p class="seo-pay">${esc(job.pay || 'Pay not listed')}</p>
      <p>${esc(description)}</p>
      <a class="seo-apply" href="${esc(job.sourceUrl)}" rel="nofollow noopener" target="_blank">View & apply on employer site →</a>
      <p class="seo-source">Listing source: employer career site. We link directly to the employer so applicants can verify the current posting.</p></article>
      <aside class="seo-related"><h2>Explore more opportunities</h2><a href="${baseUrl}/apprenticeships/">Data center apprenticeships</a><a href="${baseUrl}/internships/">Data center internships</a><a href="${baseUrl}/entry-level/">Entry-level data center jobs</a><a href="${baseUrl}/jobs/">All data center jobs</a></aside>
    </main>${footer()}</body></html>`;
    await writeHtml(`jobs/${jobSlug(job)}/index.html`,html);
    urls.push(canonical);
  }
  return urls;
}

await rm('jobs',{recursive:true,force:true});
await rm('apprenticeships',{recursive:true,force:true});
await rm('internships',{recursive:true,force:true});
await rm('entry-level',{recursive:true,force:true});
await rm('no-experience',{recursive:true,force:true});
await rm('career-events',{recursive:true,force:true});

const urls = [baseUrl + '/'];
urls.push(...await generateListing({
  root:'jobs',
  title:'Data Center Jobs, Internships & Apprenticeships | Data Center Careers',
  h1:'Data center jobs',
  description:'Browse current employer-direct data center jobs, internships, apprenticeships and trainee opportunities across the United States.',
  intro:'Browse current openings from employer career sites. We prioritize apprenticeships, internships, trainee programs and true early-career roles.',
  filter:()=>true
}));
urls.push(...await generateListing({
  root:'apprenticeships',
  title:'Data Center Apprenticeships | Paid Training & Apprentice Jobs',
  h1:'Data center apprenticeships',
  description:'Find current data center apprenticeships, paid training programs and apprentice-level infrastructure jobs from employer career sites.',
  intro:'Paid apprenticeships and structured training routes into electrical, critical-facilities, operations, cabling and data-center infrastructure work.',
  filter:job=>job.type==='apprenticeship' || job.type==='trainee'
}));
urls.push(...await generateListing({
  root:'internships',
  title:'Data Center Internships | Current Infrastructure Intern Roles',
  h1:'Data center internships',
  description:'Find current data center internships in operations, infrastructure, engineering, facilities and related roles from employer career sites.',
  intro:'Current internships that can help students and early-career applicants enter the data-center industry through real employer programs.',
  filter:job=>job.type==='internship'
}));
urls.push(...await generateListing({
  root:'entry-level',
  title:'Entry-Level Data Center Jobs | No Experience & 0–2 Years',
  h1:'Entry-level data center jobs',
  description:'Browse entry-level data center jobs for no-experience and 0–2 year candidates, including technicians, operators and critical-facilities roles.',
  intro:'Beginner-friendly openings for first-time applicants and workers with up to two years of relevant experience.',
  filter:job=>job.experience==='no-experience' || job.experience==='0-2-years'
}));
urls.push(...await generateListing({
  root:'no-experience',
  title:'Data Center Jobs With No Experience Required | Beginner Roles',
  h1:'No-experience data center jobs',
  description:'Find beginner data center jobs and training-friendly roles that are classified as requiring no prior industry experience.',
  intro:'The most beginner-friendly roles in the current inventory, including trainee, apprentice and no-experience opportunities.',
  filter:job=>job.experience==='no-experience'
}));
urls.push(...await generateJobPages());

const eventsCanonical = `${baseUrl}/career-events/`;
const eventSchema = {'@context':'https://schema.org','@type':'ItemList','itemListElement':events.map((event,index)=>({'@type':'ListItem','position':index+1,'item':{'@type':'Event','name':event.name,'startDate':event.date,'eventAttendanceMode':event.location==='Online'?'https://schema.org/OnlineEventAttendanceMode':'https://schema.org/OfflineEventAttendanceMode','location':event.location==='Online'?{'@type':'VirtualLocation','url':event.url}:{'@type':'Place','name':event.location},'organizer':{'@type':'Organization','name':event.organizer},'url':event.url}}))};
const eventsHtml = `${head({title:'Data Center Career Events | Hiring, Training & Industry Events',description:'Upcoming verified career-focused data center events, hiring events and industry programs for people entering the field.',canonical:eventsCanonical,schema:json(eventSchema)})}<body>${siteHeader()}<main class="seo-shell"><nav class="breadcrumbs"><a href="${baseUrl}/">Home</a> / <span>Career events</span></nav><header class="seo-page-head"><span class="seo-kicker">VERIFIED CAREER EVENTS</span><h1>Data center career events</h1><p>Upcoming career-focused events verified from organizer pages.</p></header><section class="seo-list">${events.map(e=>`<article class="seo-event"><time datetime="${e.date}">${e.date}</time><div><h2>${esc(e.name)}</h2><p>${esc(e.location)} · ${esc(e.organizer)}</p></div><a href="${esc(e.url)}" target="_blank" rel="noopener">Event details →</a></article>`).join('') || '<p>No verified upcoming events are currently listed. Check back soon.</p>'}</section></main>${footer()}</body></html>`;
await writeHtml('career-events/index.html',eventsHtml);
urls.push(eventsCanonical);

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[...new Set(urls)].map(url=>`  <url><loc>${esc(url)}</loc><lastmod>${lastmod}</lastmod></url>`).join('\n')}\n</urlset>\n`;
await writeFile('sitemap.xml',sitemap);
await writeFile('robots.txt',`User-agent: *\nAllow: /\nSitemap: ${baseUrl}/sitemap.xml\n`);
console.log(`Generated ${orderedJobs.length} job pages plus paginated category pages for ${baseUrl}.`);