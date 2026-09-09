import { readFile, writeFile, mkdir } from 'node:fs/promises';

const FALLBACK_BASE = 'https://dailyblip.github.io/ideal-garbanzo';
const displayText = value => String(value ?? '').replace(/\u2014/g,' - ');
const esc = value => displayText(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
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
const now = new Date();
const year = now.getUTCFullYear();
const modified = now.toISOString().slice(0,10);
const canonical = `${baseUrl}/how-to-get-a-data-center-apprenticeship/`;
const apprenticeshipListing = `${baseUrl}/apprenticeships/`;
const careerGuide = `${baseUrl}/how-to-get-a-data-center-job/`;

const apprenticeRoles = jobs
  .filter(job => job?.active !== false && ['apprenticeship','trainee'].includes(job.type))
  .sort((a,b) => (a.postedHours ?? 9999) - (b.postedHours ?? 9999));
const noExperienceJobs = jobs.filter(job => job?.active !== false && job.experience === 'no-experience');
const entryJobs = jobs.filter(job => job?.active !== false && ['no-experience','0-2-years'].includes(job.experience));

const roleCards = apprenticeRoles.slice(0,10).map(job => {
  const url = `${baseUrl}/jobs/${jobSlug(job)}/`;
  const type = job.type === 'apprenticeship' ? 'Apprenticeship' : 'Trainee program';
  const pay = job.pay && job.pay !== 'Pay not listed' ? ` · ${esc(job.pay)}` : '';
  return `<article class="guide-job"><span>${type}</span><h3><a href="${url}">${esc(job.title)}</a></h3><p><strong>${esc(job.company)}</strong> · ${esc(job.location)}</p><small>Employer-direct listing${pay}</small></article>`;
}).join('');

const faq = [
  ['What is a data center apprenticeship?','It is a structured route into data center or critical-infrastructure work that combines job training with progressively more responsibility. Employers may use apprenticeship, trainee or technician-development titles, so read the posting rather than relying on one keyword.'],
  ['Are data center apprenticeships paid?','Many apprenticeship and trainee jobs are paid employment, but pay and program structure vary by employer. Check the official employer posting for compensation, schedule and program terms before applying.'],
  ['Do I need data center experience to get an apprenticeship?','Not always. Some programs are designed for beginners, while others expect related electrical, mechanical, IT, military or trade experience. Use the minimum qualifications in the employer posting as the deciding standard.'],
  ['Do I need a college degree for a data center apprenticeship?','There is no universal degree requirement. Some roles value trade school, community college, technical coursework, military training or hands-on experience instead. Requirements vary by employer and job family.'],
  ['What should I search for besides data center apprenticeship?','Try critical facilities apprentice, operations trainee, data center trainee, technician I, infrastructure technician, electrical apprentice, mechanical apprentice and early-career facilities roles. Employers often use different titles for similar entry routes.'],
  ['What if there are no apprenticeships near me?','Look at trainee programs, no-experience jobs and true 0-2 year technician roles. Those can provide the same first step into the industry even when the employer does not call the position an apprenticeship.']
];

const schema = {
  '@context':'https://schema.org',
  '@graph':[
    {
      '@type':'Article',
      headline:`How to Get a Data Center Apprenticeship: Beginner Guide ${year}`,
      description:'How to find and apply for data center apprenticeships and trainee roles, including current employer-direct openings, search terms, resume tips and beginner pathways.',
      mainEntityOfPage:canonical,
      dateModified:modified,
      author:{'@type':'Organization','name':'Data Center Careers','url':baseUrl+'/'},
      publisher:{'@type':'Organization','name':'Data Center Careers','url':baseUrl+'/'}
    },
    {
      '@type':'BreadcrumbList',
      itemListElement:[
        {'@type':'ListItem','position':1,'name':'Home','item':baseUrl+'/'},
        {'@type':'ListItem','position':2,'name':'Apprenticeships','item':apprenticeshipListing},
        {'@type':'ListItem','position':3,'name':'Data center apprenticeship guide','item':canonical}
      ]
    },
    {
      '@type':'FAQPage',
      mainEntity:faq.map(([question,answer])=>({'@type':'Question','name':question,'acceptedAnswer':{'@type':'Answer','text':answer}}))
    }
  ]
};

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>How to Get a Data Center Apprenticeship | Beginner Guide ${year}</title>
<meta name="description" content="Learn how to get a data center apprenticeship. Find current employer-direct apprenticeships and trainee roles, search terms, resume tips and beginner pathways.">
<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1">
<link rel="canonical" href="${canonical}">
<meta name="author" content="Data Center Careers">
<meta property="og:type" content="article">
<meta property="og:title" content="How to Get a Data Center Apprenticeship: Beginner Guide">
<meta property="og:description" content="Find data center apprenticeships and trainee routes, understand common requirements and apply to current employer-direct openings.">
<meta property="og:url" content="${canonical}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="How to Get a Data Center Apprenticeship: Beginner Guide">
<meta name="twitter:description" content="A plain-language route into data center apprenticeships, trainee programs and beginner-friendly infrastructure work.">
<link rel="stylesheet" href="${baseUrl}/assets/seo.css">
<script type="application/ld+json">${json(schema)}</script>
</head>
<body>
<header class="seo-header"><div class="seo-header-inner"><a class="seo-brand" href="${baseUrl}/"><small>LAUNCH YOUR</small><strong>DATA CENTER CAREER</strong></a><nav class="seo-nav" aria-label="Primary"><a href="${baseUrl}/">Home</a><a href="${baseUrl}/jobs/">All jobs</a><a href="${apprenticeshipListing}" aria-current="page">Apprenticeships</a><a href="${baseUrl}/internships/">Internships</a><a href="${baseUrl}/entry-level/">Entry-level</a><a href="${careerGuide}">Career guide</a></nav></div></header>
<main class="seo-shell guide-shell">
<nav class="breadcrumbs"><a href="${baseUrl}/">Home</a> / <a href="${apprenticeshipListing}">Apprenticeships</a> / <span>Beginner guide</span></nav>
<article>
<header class="guide-hero">
  <div class="guide-hero-copy"><span class="seo-kicker">APPRENTICESHIP & TRAINEE ROADMAP</span><h1>How to get a data center apprenticeship.</h1><p>Apprenticeships are one route into data center work, but employers do not always use the word apprentice. Trainee programs and beginner-friendly technician roles can lead into the same electrical, facilities, operations and infrastructure career paths.</p><div class="guide-actions"><a class="seo-apply" href="${apprenticeshipListing}">See current apprenticeships</a><a class="guide-secondary" href="#roadmap">See the roadmap ↓</a></div></div>
</header>

<section class="guide-stats" aria-label="Current beginner opportunities"><div><strong>${apprenticeRoles.length}</strong><span>apprentice & trainee roles</span></div><div><strong>${noExperienceJobs.length}</strong><span>no-experience jobs</span></div><div><strong>${entryJobs.length}</strong><span>0-2 year jobs</span></div><div><strong>100%</strong><span>employer-direct applications</span></div></section>

<section class="guide-section guide-intro"><span class="seo-kicker">START WITH THE RIGHT SEARCH</span><h2>Do not search only for “apprentice.”</h2><p>Data center employers use different names for early-career training roles. Search several related titles and then confirm the real experience requirement in the official posting.</p><div class="guide-path-grid"><div><h3>Critical facilities</h3><p>Critical facilities apprentice, facilities trainee, critical environment technician and technician I.</p></div><div><h3>Electrical</h3><p>Electrical apprentice, electrical technician, power systems trainee and facilities electrical roles.</p></div><div><h3>Mechanical & cooling</h3><p>Mechanical apprentice, HVAC trainee, cooling technician and facilities maintenance roles.</p></div><div><h3>IT & infrastructure</h3><p>Data center trainee, infrastructure technician, hardware technician and operations technician.</p></div></div></section>

<section class="guide-section" id="roadmap"><span class="seo-kicker">THE ROADMAP</span><h2>Six steps to a stronger apprenticeship application</h2><ol class="guide-steps"><li><div><strong>1</strong></div><article><h3>Pick the path that matches your background.</h3><p>Electrical, mechanical, HVAC, hardware, networking, maintenance and military technical experience can all connect to data center work. Start with the area where you can show real skills.</p></article></li><li><div><strong>2</strong></div><article><h3>Read minimum qualifications before preferred qualifications.</h3><p>Minimum qualifications tell you whether the employer expects prior experience, a credential or specific training. Preferred qualifications are useful signals, but they are not always required.</p></article></li><li><div><strong>3</strong></div><article><h3>Show hands-on evidence on your resume.</h3><p>List relevant labs, tools, maintenance, cabling, PC building, electrical work, HVAC coursework, troubleshooting, safety training or technical military experience when it is true of your background.</p></article></li><li><div><strong>4</strong></div><article><h3>Use several job-title searches.</h3><p>Check apprentice, trainee, technician I, critical facilities, operations and infrastructure roles. The right beginner opening may not contain the word apprenticeship.</p></article></li><li><div><strong>5</strong></div><article><h3>Apply on the employer's career site.</h3><p>Use the original posting to verify the job is still open, confirm requirements and submit the application. This site links applicants directly to employer career sources.</p></article></li><li><div><strong>6</strong></div><article><h3>Keep parallel entry routes open.</h3><p>If apprenticeship openings are limited, apply to trainee, no-experience and true 0-2 year roles too. The goal is a credible first step into data center operations or infrastructure.</p></article></li></ol></section>

<section class="guide-section"><span class="seo-kicker">BUILD USEFUL BASELINE SKILLS</span><h2>What helps when you are new to data centers</h2><div class="guide-path-grid"><div><h3>Safety & procedure</h3><p>Show that you can follow written steps, use tools safely, document work and stop when something is outside your training.</p></div><div><h3>Troubleshooting</h3><p>Be ready to explain how you diagnosed a real hardware, network, electrical or mechanical problem.</p></div><div><h3>Hands-on technical work</h3><p>Trade school, community college labs, home projects, maintenance work, military training and technical jobs can all be relevant.</p></div><div><h3>Reliability</h3><p>Data centers operate continuously. Attendance, teamwork, shift flexibility and careful documentation can matter alongside technical ability.</p></div></div></section>

<section class="guide-section"><span class="seo-kicker">CURRENT OPENINGS</span><h2>Data center apprenticeships and trainee roles hiring now</h2><p>These openings come from employer career sites and update with the main job feed.</p><div class="guide-jobs">${roleCards || '<p>No verified apprenticeship or trainee roles are currently in the feed. Check no-experience and entry-level jobs while new programs open.</p>'}</div><div class="guide-actions"><a class="seo-apply" href="${apprenticeshipListing}">Browse all apprenticeships →</a><a class="guide-secondary" href="${baseUrl}/no-experience/">See no-experience jobs →</a></div></section>

<section class="guide-section"><span class="seo-kicker">FAQ</span><h2>Common questions about data center apprenticeships</h2><div class="guide-faq">${faq.map(([q,a])=>`<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</div></section>

<section class="guide-section guide-cta"><span class="seo-kicker">NEXT STEP</span><h2>Start with the openings that fit your actual experience.</h2><p>Check apprenticeships and trainee programs first. If there are few near you, widen the search to no-experience and 0-2 year technician roles.</p><div class="guide-actions"><a class="seo-apply" href="${apprenticeshipListing}">Browse apprenticeships</a><a class="guide-secondary" href="${careerGuide}">Read the full career guide →</a></div></section>
</article>
</main>
<footer class="seo-footer"><div><strong>Launch Your Data Center Career</strong><span>Employer-direct data center jobs, internships and apprenticeships.</span></div><a href="${baseUrl}/">Back to home</a></footer>
</body>
</html>`;

await mkdir('how-to-get-a-data-center-apprenticeship',{recursive:true});
await writeFile('how-to-get-a-data-center-apprenticeship/index.html',html);

const sitemapPath = 'sitemap.xml';
let sitemap = await readFile(sitemapPath,'utf8');
if (!sitemap.includes(`<loc>${canonical}</loc>`)) {
  sitemap = sitemap.replace('</urlset>',`  <url><loc>${canonical}</loc><lastmod>${modified}</lastmod></url>\n</urlset>`);
  await writeFile(sitemapPath,sitemap);
}

const listingPath = 'apprenticeships/index.html';
let listing = await readFile(listingPath,'utf8');
if (!listing.includes(canonical)) {
  const marker = '<section class="seo-list" aria-label="Data center apprenticeships">';
  const guideLink = `<div class="guide-actions"><a class="guide-secondary" href="${canonical}">New to the field? Read the data center apprenticeship guide →</a></div>`;
  if (!listing.includes(marker)) throw new Error('Could not find apprenticeship listing insertion point.');
  listing = listing.replace(marker,`${guideLink}${marker}`);
  await writeFile(listingPath,listing);
}

console.log(`Generated apprenticeship guide with ${apprenticeRoles.length} current apprenticeship and trainee roles.`);
