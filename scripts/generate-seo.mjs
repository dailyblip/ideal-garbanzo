import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';

const FALLBACK_BASE = 'https://dailyblip.github.io/ideal-garbanzo';
const PAGE_SIZE = 25;

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const clean = value => String(value ?? '').replace(/\s+/g,' ').trim();
const slugify = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,70) || 'job';
const jobSlug = job => `${slugify(job.title)}-${slugify(job.company).slice(0,32)}-${String(job.id).replace(/[^a-zA-Z0-9]/g,'').slice(-10)}`;
const json = value => JSON.stringify(value).replace(/</g,'\\u003c');
const displayPay = value => {
  const pay = clean(value);
  return !pay || /^pay not listed$/i.test(pay) ? '' : pay;
};

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
  const pay = displayPay(job.pay);
  return `<article class="seo-job-card">
    <div class="seo-job-main">
      <span class="seo-kicker">${esc(typeLabel(job.type))}</span>
      <h2><a href="${internal}">${esc(job.title)}</a></h2>
      <p class="seo-meta"><strong>${esc(job.company)}</strong> · ${esc(job.location)}</p>
      <div class="seo-tags"><span>${esc(experienceLabel(job.experience))}</span>${(job.tags || []).map(tag => `<span>${esc(tag)}</span>`).join('')}</div>
      ${pay ? `<p class="seo-pay">${esc(pay)}</p>` : ''}
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

function topEmployerNames(list, limit = 6) {
  const counts = new Map();
  for (const job of list) {
    const company = clean(job.company);
    if (!company) continue;
    counts.set(company, (counts.get(company) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name]) => name);
}

function readableNames(names) {
  if (!names.length) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0,-1).join(', ')}, and ${names.at(-1)}`;
}

function relatedLinksHtml(links) {
  if (!links?.length) return '';
  return `<aside class="seo-related"><h2>Keep exploring</h2>${links.map(([label,url]) => `<a href="${url}">${esc(label)}</a>`).join('')}</aside>`;
}

function apprenticeshipProofHtml(list) {
  const employerCount = new Set(list.map(job => clean(job.company)).filter(Boolean)).size;
  const noExperienceCount = list.filter(job => job.experience === 'no-experience').length;
  return `<section class="guide-section" aria-labelledby="apprenticeship-proof-heading"><span class="seo-kicker">CURRENT VERIFIED INVENTORY</span><h2 id="apprenticeship-proof-heading">Current apprenticeships from employer career sites</h2><p>See the size and shape of the verified apprenticeship inventory before you browse. Experience labels come from published minimum qualifications, and each job page links back to the employer source.</p><div class="guide-stats"><div><strong>${list.length}</strong><span>current apprenticeships</span></div><div><strong>${employerCount}</strong><span>employers represented</span></div><div><strong>${noExperienceCount}</strong><span>no-experience openings</span></div><div><strong>Direct</strong><span>employer career sources</span></div></div><div class="guide-actions"><a class="seo-apply" href="#apprenticeships-list">View current apprenticeships ↓</a></div></section>`;
}

const stateNames = {
  AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',DC:'District of Columbia'
};
const stateCodes = Object.keys(stateNames);
const stateNameToCode = new Map(Object.entries(stateNames).map(([code,name]) => [name.toLowerCase(),code]));

function statesForListing(job) {
  const location = clean(job?.location);
  const found = new Set();
  for (const match of location.matchAll(new RegExp(`\\b(${stateCodes.join('|')})\\b`,'g'))) found.add(match[1]);
  const lower = location.toLowerCase();
  for (const [name,code] of stateNameToCode) {
    if (new RegExp(`\\b${name.replace(/ /g,'\\s+')}\\b`,'i').test(lower)) found.add(code);
  }
  return [...found];
}

function internshipProofHtml(list) {
  const employerCount = new Set(list.map(job => clean(job.company)).filter(Boolean)).size;
  const stateCount = new Set(list.flatMap(statesForListing)).size;
  return `<section class="guide-section" aria-labelledby="internship-proof-heading"><span class="seo-kicker">CURRENT VERIFIED INVENTORY</span><h2 id="internship-proof-heading">Current internships from employer career sites</h2><p>See the verified internship inventory before you browse. We publish infrastructure, facilities, electrical, mechanical and operations internships that link back to the employer source.</p><div class="guide-stats"><div><strong>${list.length}</strong><span>current internships</span></div><div><strong>${employerCount}</strong><span>employers represented</span></div><div><strong>${stateCount}</strong><span>states represented</span></div><div><strong>Direct</strong><span>employer career sources</span></div></div><div class="guide-actions"><a class="seo-apply" href="#internships-list">View current internships ↓</a></div></section>`;
}

async function generateListing({root,title,h1,description,intro,filter,listId='',beforeListHtml=null,contextHtml=null,relatedLinks=[]}) {
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
    const beforeList = page === 1 && typeof beforeListHtml === 'function' ? beforeListHtml(list) : '';
    const intentContext = page === 1 && typeof contextHtml === 'function' ? contextHtml(list) : '';
    const related = page === 1 ? relatedLinksHtml(relatedLinks) : '';
    const idAttribute = page === 1 && listId ? ` id="${esc(listId)}"` : '';
    const html = `${head({title:pageTitle,description,canonical,schema:json(itemList),prev,next})}<body>${siteHeader()}<main class="seo-shell">
      <nav class="breadcrumbs"><a href="${baseUrl}/">Home</a> / <span>${esc(h1)}</span></nav>
      <header class="seo-page-head"><span class="seo-kicker">EMPLOYER-DIRECT OPPORTUNITIES</span><h1>${esc(h1)}</h1><p>${esc(intro)}</p><strong>${list.length} current opportunities</strong></header>
      ${beforeList}<section${idAttribute} class="seo-list" aria-label="${esc(h1)}">${subset.map(card).join('')}</section>${pagination}${intentContext}${related}
    </main>${footer()}</body></html>`;
    const out = page === 1 ? `${root}/index.html` : `${root}/page/${page}/index.html`;
    await writeHtml(out,html);
    urls.push(canonical);
  }
  return urls;
}

function employerContext(list) {
  const employers = topEmployerNames(list);
  return employers.length ? ` Current openings represented on this page include ${esc(readableNames(employers))}.` : '';
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
    const pay = displayPay(job.pay);
    const html = `${head({title:`${job.title} – ${job.company} | Data Center Careers`,description,canonical,schema:json(schema)})}<body>${siteHeader()}<main class="seo-shell seo-detail">
      <nav class="breadcrumbs"><a href="${baseUrl}/">Home</a> / <a href="${baseUrl}/jobs/">Jobs</a> / <span>${esc(job.title)}</span></nav>
      <article class="seo-detail-card"><span class="seo-kicker">${esc(typeLabel(job.type))}</span><h1>${esc(job.title)}</h1><p class="seo-meta"><strong>${esc(job.company)}</strong> · ${esc(job.location)}</p>
      <div class="seo-tags"><span>${esc(experienceLabel(job.experience))}</span>${(job.tags || []).map(tag=>`<span>${esc(tag)}</span>`).join('')}</div>
      ${pay ? `<p class="seo-pay">${esc(pay)}</p>` : ''}
      <p>${esc(description)}</p>
      <a class="seo-apply" href="${esc(job.sourceUrl)}" rel="nofollow noopener" target="_blank">View & apply on employer site →</a>
      <p class="seo-source">Listing source: employer career site. We link directly to the employer so applicants can verify the current posting.</p></article>
      <aside class="seo-related"><h2>Explore more opportunities</h2><a href="${baseUrl}/no-experience/">Data center jobs with no experience</a><a href="${baseUrl}/trainee-jobs/">Data center trainee jobs</a><a href="${baseUrl}/apprenticeships/">Data center apprenticeships</a><a href="${baseUrl}/internships/">Data center internships</a><a href="${baseUrl}/entry-level/">Entry-level data center jobs</a><a href="${baseUrl}/career-events/">Data center hiring events</a><a href="${baseUrl}/jobs/">All data center jobs</a></aside>
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
await rm('trainee-jobs',{recursive:true,force:true});
await rm('career-events',{recursive:true,force:true});

const urls = [baseUrl + '/'];
urls.push(...await generateListing({
  root:'jobs',
  title:'Data Center Jobs | Current Employer-Direct Openings',
  h1:'Data center jobs',
  description:'Browse current employer-direct data center jobs, including technician, operations, critical-facilities, internships, apprenticeships and trainee roles.',
  intro:'Browse current openings from employer career sites. We prioritize hands-on data center work, apprenticeships, internships, trainee programs and appropriate early- to mid-career roles.',
  filter:()=>true,
  relatedLinks:[
    ['Data center jobs with no experience', `${baseUrl}/no-experience/`],
    ['Data center trainee jobs', `${baseUrl}/trainee-jobs/`],
    ['Data center apprenticeships', `${baseUrl}/apprenticeships/`],
    ['Data center hiring events', `${baseUrl}/career-events/`]
  ]
}));
urls.push(...await generateListing({
  root:'apprenticeships',
  title:'Data Center Apprenticeships | Verified Employer Openings',
  h1:'Data center apprenticeships',
  description:'Browse current data center apprenticeships in electrical, mechanical, critical facilities and operations. See experience requirements and apply on employer sites.',
  intro:'Current apprenticeship openings for people building hands-on experience in electrical, mechanical, critical-facilities, operations and data center infrastructure work.',
  filter:job=>job.type==='apprenticeship',
  listId:'apprenticeships-list',
  beforeListHtml:list=>apprenticeshipProofHtml(list),
  contextHtml:list=>`<section class="guide-section" aria-labelledby="apprenticeship-search-heading"><span class="seo-kicker">APPRENTICESHIP PATHS</span><h2 id="apprenticeship-search-heading">What counts as a data center apprenticeship here?</h2><p>This page is reserved for roles employers explicitly label as apprenticeships or apprentice positions. Trainee programs and other paid training routes live on the separate trainee-jobs page, so you can compare true apprenticeships without mixing different program types.${employerContext(list)}</p><div class="guide-actions"><a class="guide-secondary" href="${baseUrl}/how-to-get-a-data-center-apprenticeship/">How to get a data center apprenticeship →</a><a class="guide-secondary" href="${baseUrl}/trainee-jobs/">See trainee jobs →</a></div></section>`,
  relatedLinks:[
    ['How to get a data center apprenticeship', `${baseUrl}/how-to-get-a-data-center-apprenticeship/`],
    ['Data center trainee jobs', `${baseUrl}/trainee-jobs/`],
    ['Jobs with no experience required', `${baseUrl}/no-experience/`],
    ['Entry-level data center jobs', `${baseUrl}/entry-level/`]
  ]
}));
urls.push(...await generateListing({
  root:'internships',
  title:'Data Center Internships | Verified Employer Openings',
  h1:'Data center internships',
  description:'Browse current data center internships in infrastructure, facilities, electrical, mechanical and operations. See locations and apply through verified employer listings.',
  intro:'Verified internships for students and early-career applicants building experience in data center infrastructure, facilities, engineering and operations.',
  filter:job=>job.type==='internship',
  listId:'internships-list',
  beforeListHtml:list=>internshipProofHtml(list),
  contextHtml:list=>`<section class="guide-section" aria-labelledby="internship-search-heading"><span class="seo-kicker">INTERNSHIP PATHS</span><h2 id="internship-search-heading">What counts as a data center internship here?</h2><p>This page is limited to employer-listed internships tied to data center infrastructure, facilities, electrical, mechanical, critical-environment or operations work. General software, sales and unrelated corporate internships are excluded.${employerContext(list)}</p><div class="guide-actions"><a class="guide-secondary" href="${baseUrl}/how-to-get-a-data-center-internship/">How to get a data center internship →</a><a class="guide-secondary" href="${baseUrl}/apprenticeships/">See apprenticeships →</a></div></section>`,
  relatedLinks:[
    ['How to get a data center internship', `${baseUrl}/how-to-get-a-data-center-internship/`],
    ['Data center apprenticeships', `${baseUrl}/apprenticeships/`],
    ['Entry-level data center jobs', `${baseUrl}/entry-level/`],
    ['Data center hiring events', `${baseUrl}/career-events/`]
  ]
}));
urls.push(...await generateListing({
  root:'entry-level',
  title:'Entry-Level Data Center Jobs | No Experience & 0–2 Years',
  h1:'Entry-level data center jobs',
  description:'Browse entry-level data center jobs for no-experience and 0–2 year candidates, including technicians, operators and critical-facilities roles.',
  intro:'Beginner-friendly openings for first-time applicants and workers with up to two years of relevant experience.',
  filter:job=>job.experience==='no-experience' || job.experience==='0-2-years',
  relatedLinks:[
    ['Jobs with no experience required', `${baseUrl}/no-experience/`],
    ['Data center trainee jobs', `${baseUrl}/trainee-jobs/`],
    ['Data center apprenticeships', `${baseUrl}/apprenticeships/`]
  ]
}));
urls.push(...await generateListing({
  root:'no-experience',
  title:'Data Center Jobs With No Experience | Current Beginner Openings',
  h1:'Data center jobs with no experience required',
  description:'Browse current employer-direct data center jobs with no experience required, including trainee, apprentice and beginner technician openings.',
  intro:'Current beginner-friendly openings whose published minimum qualifications do not require prior data center industry experience.',
  filter:job=>job.experience==='no-experience',
  contextHtml:list=>`<section class="guide-section" aria-labelledby="no-experience-heading"><span class="seo-kicker">HOW WE FILTER</span><h2 id="no-experience-heading">What “no experience required” means here</h2><p>We use the employer's published minimum qualifications to identify openings that do not require prior data center experience. A role may still require a high school diploma, shift availability, basic technical ability, a driver's license, safety training or another clearly stated qualification.${employerContext(list)}</p><p>Always read the official employer posting before applying. “No experience required” does not mean every applicant automatically qualifies.</p></section>`,
  relatedLinks:[
    ['Data center trainee jobs', `${baseUrl}/trainee-jobs/`],
    ['Data center apprenticeships', `${baseUrl}/apprenticeships/`],
    ['Entry-level jobs with 0–2 years', `${baseUrl}/entry-level/`],
    ['How to get a job at a data center', `${baseUrl}/how-to-get-a-data-center-job/`]
  ]
}));
urls.push(...await generateListing({
  root:'trainee-jobs',
  title:'Data Center Trainee Jobs | Current Paid Training Openings',
  h1:'Data center trainee jobs',
  description:'Find current employer-direct data center trainee jobs and structured training programs in facilities, operations, electrical and infrastructure work.',
  intro:'Current trainee and structured development roles designed to build hands-on data center, critical-facilities and infrastructure experience.',
  filter:job=>job.type==='trainee',
  contextHtml:list=>`<section class="guide-section" aria-labelledby="trainee-search-heading"><span class="seo-kicker">PAID TRAINING PATHS</span><h2 id="trainee-search-heading">Trainee roles can be an alternative to apprenticeships.</h2><p>Some employers use “trainee,” “development program” or technician-level titles instead of “apprentice.” These openings can provide supervised, paid experience in operations, facilities, electrical, mechanical or infrastructure work.${employerContext(list)}</p><p>If there are few trainee openings near you, also check apprenticeships and jobs whose minimum qualifications require no prior data center experience.</p></section>`,
  relatedLinks:[
    ['Data center apprenticeships', `${baseUrl}/apprenticeships/`],
    ['Jobs with no experience required', `${baseUrl}/no-experience/`],
    ['Entry-level data center jobs', `${baseUrl}/entry-level/`],
    ['How to get a data center apprenticeship', `${baseUrl}/how-to-get-a-data-center-apprenticeship/`]
  ]
}));
urls.push(...await generateJobPages());

const eventsCanonical = `${baseUrl}/career-events/`;
const eventSchema = {'@context':'https://schema.org','@type':'ItemList','itemListElement':events.map((event,index)=>({'@type':'ListItem','position':index+1,'item':{'@type':'Event','name':event.name,'startDate':event.date,'eventAttendanceMode':event.location==='Online'?'https://schema.org/OnlineEventAttendanceMode':'https://schema.org/OfflineEventAttendanceMode','location':event.location==='Online'?{'@type':'VirtualLocation','url':event.url}:{'@type':'Place','name':event.location},'organizer':{'@type':'Organization','name':event.organizer},'url':event.url}}))};
const eventsHtml = `${head({title:'Data Center Hiring Events | Upcoming Career & Training Events',description:'Find upcoming verified data center hiring events, career fairs, training events and industry programs for people entering or advancing in the field.',canonical:eventsCanonical,schema:json(eventSchema)})}<body>${siteHeader()}<main class="seo-shell"><nav class="breadcrumbs"><a href="${baseUrl}/">Home</a> / <span>Hiring events</span></nav><header class="seo-page-head"><span class="seo-kicker">VERIFIED CAREER EVENTS</span><h1>Data center hiring events</h1><p>Upcoming hiring, career and training events verified from organizer pages. We keep only events with a confirmed event name and date.</p><strong>${events.length} upcoming verified events</strong></header><section class="seo-list">${events.map(e=>`<article class="seo-event"><time datetime="${e.date}">${e.date}</time><div><h2>${esc(e.name)}</h2><p>${esc(e.location)} · ${esc(e.organizer)}</p></div><a href="${esc(e.url)}" target="_blank" rel="noopener">Event details →</a></article>`).join('') || '<p>No verified upcoming events are currently listed. Check back soon.</p>'}</section><section class="guide-section" aria-labelledby="event-filter-heading"><span class="seo-kicker">WHAT WE INCLUDE</span><h2 id="event-filter-heading">Real data center hiring and career events, not generic event listings.</h2><p>We prioritize employer hiring events, workforce programs, training opportunities and industry events with a clear career connection. Every event is tied to an organizer page so you can confirm the details before attending.</p></section>${relatedLinksHtml([['Data center jobs with no experience', `${baseUrl}/no-experience/`],['Data center trainee jobs', `${baseUrl}/trainee-jobs/`],['Data center apprenticeships', `${baseUrl}/apprenticeships/`],['All data center jobs', `${baseUrl}/jobs/`]])}</main>${footer()}</body></html>`;
await writeHtml('career-events/index.html',eventsHtml);
urls.push(eventsCanonical);

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[...new Set(urls)].map(url=>`  <url><loc>${esc(url)}</loc><lastmod>${lastmod}</lastmod></url>`).join('\n')}\n</urlset>\n`;
await writeFile('sitemap.xml',sitemap);
await writeFile('robots.txt',`User-agent: *\nAllow: /\nSitemap: ${baseUrl}/sitemap.xml\n`);
console.log(`Generated ${orderedJobs.length} job pages plus search-focused category pages for ${baseUrl}.`);
