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
const canonical = `${baseUrl}/how-to-get-a-data-center-job/`;
const heroImage = `${baseUrl}/assets/guides/data-center-career-guide-mentor.webp`;
const trainingImage = `${baseUrl}/assets/guides/data-center-internship-training.webp`;

const typeRank = {apprenticeship:0,internship:1,trainee:2,'entry-level':3};
const expRank = {'no-experience':0,'0-2-years':1,'2-5-years':2};
const beginnerJobs = jobs
  .filter(job => job?.active !== false && (['apprenticeship','internship','trainee'].includes(job.type) || ['no-experience','0-2-years'].includes(job.experience)))
  .sort((a,b) => (typeRank[a.type] ?? 9) - (typeRank[b.type] ?? 9) || (expRank[a.experience] ?? 9) - (expRank[b.experience] ?? 9) || (a.postedHours ?? 9999) - (b.postedHours ?? 9999));

const internshipCount = jobs.filter(job => job?.active !== false && job.type === 'internship').length;
const trainingCount = jobs.filter(job => job?.active !== false && ['apprenticeship','trainee'].includes(job.type)).length;
const noExperienceCount = jobs.filter(job => job?.active !== false && job.experience === 'no-experience').length;
const sampleJobs = beginnerJobs.slice(0,6);

const regionNames = {
  'mid-atlantic':'Northern Virginia / Mid-Atlantic',
  texas:'Texas',
  southwest:'Southwest',
  midwest:'Midwest',
  southeast:'Southeast',
  northeast:'Northeast',
  west:'West'
};
const regionCounts = new Map();
for (const job of beginnerJobs) {
  if (!job.region) continue;
  regionCounts.set(job.region,(regionCounts.get(job.region) || 0) + 1);
}
const topRegions = [...regionCounts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,4);

const faq = [
  ['Can I get a data center job with no experience?','Yes. Apprenticeships, trainee programs, internships and some technician jobs are open to people with little or no direct data center experience. Read the minimum qualifications closely and focus on roles that match the skills you already have.'],
  ['Do data center jobs require a college degree?','Not always. Many technician, facilities, electrical, mechanical, cabling and operations jobs accept a high school diploma, trade training, military experience, certifications or equivalent hands-on experience. Some engineering and specialist jobs do require a degree.'],
  ['What is a good first data center job?','Common starting points include data center technician, inventory or asset technician, cabling technician, apprentice, trainee and internship roles. Electrical, HVAC and building-maintenance experience can also lead into critical-facilities work.'],
  ['How do I get a data center internship?','Start with employer career sites, your school career office and programs such as Microsoft Datacenter Academy where available. Search infrastructure, technician, facilities, operations and engineering internships, not just titles that include the words data center.'],
  ['What certifications help with data center jobs?','It depends on the role. Basic IT and networking knowledge can help with technician jobs, while electrical, HVAC and safety credentials matter more for facilities work. Check the jobs you want before spending money on a certification.'],
  ['Where are the most data center jobs?','Large U.S. markets include Northern Virginia, Texas, Arizona, parts of the Midwest and several Southeast markets. Hiring shifts quickly, so current employer listings are more useful than a fixed ranking.']
];

const schema = {
  '@context':'https://schema.org',
  '@graph':[
    {
      '@type':'Article',
      headline:'How to Get a Job at a Data Center: Beginner Roadmap',
      description:'How to get a data center job with little or no direct experience, including internships, apprenticeships, training resources and current employer-direct openings.',
      mainEntityOfPage:canonical,
      image:[heroImage,trainingImage],
      dateModified:modified,
      author:{'@type':'Organization','name':'Data Center Careers','url':baseUrl+'/'},
      publisher:{'@type':'Organization','name':'Data Center Careers','url':baseUrl+'/'}
    },
    {
      '@type':'BreadcrumbList',
      itemListElement:[
        {'@type':'ListItem','position':1,'name':'Home','item':baseUrl+'/'},
        {'@type':'ListItem','position':2,'name':'How to get a data center job','item':canonical}
      ]
    },
    {
      '@type':'FAQPage',
      mainEntity:faq.map(([question,answer])=>({'@type':'Question','name':question,'acceptedAnswer':{'@type':'Answer','text':answer}}))
    }
  ]
};

const jobCards = sampleJobs.map(job => {
  const url = `${baseUrl}/jobs/${jobSlug(job)}/`;
  const label = job.type === 'internship' ? 'Internship' : job.type === 'apprenticeship' ? 'Apprenticeship' : job.type === 'trainee' ? 'Trainee program' : 'Early-career job';
  const exp = job.experience === 'no-experience' ? 'No experience' : job.experience === '0-2-years' ? '0–2 years' : 'Up to 5 years';
  return `<article class="guide-job"><span>${esc(label)}</span><h3><a href="${url}">${esc(job.title)}</a></h3><p><strong>${esc(job.company)}</strong> · ${esc(job.location)}</p><small>${esc(exp)}${job.pay && job.pay !== 'Pay not listed' ? ` · ${esc(job.pay)}` : ''}</small></article>`;
}).join('');

const regionLinks = topRegions.length
  ? topRegions.map(([region,count])=>`<li><strong>${esc(regionNames[region] || region)}</strong><span>${count} current starting-point opportunities</span></li>`).join('')
  : '<li><strong>Search nationwide</strong><span>Browse current employer listings and filter by region.</span></li>';

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>How to Get a Job at a Data Center | Beginner Roadmap ${year}</title>
<meta name="description" content="Learn how to get a data center job with little or no experience. Find internships, apprenticeships, training programs, resume tips and current employer-direct openings.">
<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1">
<link rel="canonical" href="${canonical}">
<meta name="author" content="Data Center Careers">
<meta property="og:type" content="article">
<meta property="og:title" content="How to Get a Job at a Data Center: Beginner Roadmap">
<meta property="og:description" content="A straightforward guide to data center jobs, internships and apprenticeships, with current employer-direct openings and training resources.">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${heroImage}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="How to Get a Job at a Data Center: Beginner Roadmap">
<meta name="twitter:description" content="How to break into data center work through jobs, internships, apprenticeships and training programs.">
<meta name="twitter:image" content="${heroImage}">
<link rel="stylesheet" href="${baseUrl}/assets/seo.css">
<script type="application/ld+json">${json(schema)}</script>
</head>
<body>
<header class="seo-header"><div class="seo-header-inner"><a class="seo-brand" href="${baseUrl}/"><small>LAUNCH YOUR</small><strong>DATA CENTER CAREER</strong></a><nav class="seo-nav" aria-label="Primary"><a href="${baseUrl}/">Home</a><a href="${baseUrl}/jobs/">All jobs</a><a href="${baseUrl}/apprenticeships/">Apprenticeships</a><a href="${baseUrl}/internships/">Internships</a><a href="${baseUrl}/entry-level/">Entry-level</a><a href="${canonical}" aria-current="page">Career guide</a></nav></div></header>
<main class="seo-shell guide-shell">
<nav class="breadcrumbs"><a href="${baseUrl}/">Home</a> / <span>How to get a data center job</span></nav>

<article>
<header class="guide-hero">
  <div class="guide-hero-copy"><span class="seo-kicker">BEGINNER CAREER ROADMAP</span><h1>How to get a job at a data center.</h1><p>You do not need data center experience to start. Begin with what you already know - school, trades, military work, IT, facilities, maintenance or other hands-on technical experience.</p><div class="guide-actions"><a class="seo-apply" href="${baseUrl}/entry-level/">See entry-level jobs</a><a class="guide-secondary" href="#roadmap">See the roadmap ↓</a></div></div>
  <figure><img src="${heroImage}" width="1440" height="810" alt="Early-career data center technician learning from an experienced mentor beside server racks" fetchpriority="high"></figure>
</header>

<section class="guide-stats" aria-label="Current opportunities"><div><strong>${internshipCount}</strong><span>internships</span></div><div><strong>${trainingCount}</strong><span>apprenticeships & trainee roles</span></div><div><strong>${noExperienceCount}</strong><span>no-experience roles</span></div><div><strong>${beginnerJobs.length}</strong><span>good starting points</span></div></section>

<section class="guide-section guide-intro"><span class="seo-kicker">START HERE</span><h2>There is more than one way into a data center.</h2><p>Data centers need people to keep servers, power, cooling, cabling and facilities running. That creates jobs for IT-minded candidates, electricians, HVAC technicians, maintenance workers, students and people coming from other technical fields.</p><div class="guide-path-grid"><div><h3>IT & hardware</h3><p>Data center technician, deployment, break/fix, inventory and asset roles.</p></div><div><h3>Electrical & facilities</h3><p>Critical environment, electrical, UPS, generators, controls and building systems.</p></div><div><h3>Mechanical & HVAC</h3><p>Cooling systems, chillers, pumps, air handling and facilities maintenance.</p></div><div><h3>Construction & cabling</h3><p>Low-voltage cabling, fiber, installation, commissioning and site buildout.</p></div></div></section>

<section class="guide-section" id="roadmap"><span class="seo-kicker">THE ROADMAP</span><h2>Seven steps to your first data center job</h2><ol class="guide-steps"><li><div><strong>1</strong></div><article><h3>Start with what you already know.</h3><p>If you build PCs or work help desk, look at technician roles. If you have electrical, HVAC, maintenance, construction or military technical experience, look at facilities and critical-environment jobs. Students should check internships and school-based programs.</p></article></li><li><div><strong>2</strong></div><article><h3>Check requirements before paying for training.</h3><p>Many entry-level jobs accept equivalent experience instead of a four-year degree. Read several job postings first. Then you will know whether a certification, trade credential or short course is actually worth the money.</p></article></li><li><div><strong>3</strong></div><article><h3>Give employers something concrete.</h3><p>For IT roles, that might be hardware, networking or troubleshooting work. For facilities roles, it could be electrical safety, HVAC, controls, preventive maintenance or industrial systems. School labs, trade programs, military work and maintenance experience all count when they match the job.</p></article></li><li><div><strong>4</strong></div><article><h3>Make your resume specific.</h3><p>Use the language of the job posting when it is true of your experience: troubleshooting, ticketing, preventive maintenance, rack-and-stack, inventory, cabling, electrical systems, HVAC, safety procedures, shift work or incident response.</p></article></li><li><div><strong>5</strong></div><article><h3>Apply on the employer's site.</h3><p>Use official career pages whenever possible. Every job on this site links back to the employer so you can confirm it is still open and apply directly.</p></article></li><li><div><strong>6</strong></div><article><h3>Use training programs and events when they help.</h3><p>Microsoft Datacenter Academy, registered apprenticeships and local career events can give you training, contacts and work experience. They are useful tools, but they are not requirements for every job.</p></article></li><li><div><strong>7</strong></div><article><h3>Keep the search focused.</h3><p>Look for technician, facilities, electrical, mechanical, critical environment, operations, cabling, internship, apprenticeship and trainee roles. Skip jobs that clearly require senior-level experience.</p></article></li></ol></section>

<section class="guide-section guide-split"><div><span class="seo-kicker">INTERNSHIP ROADMAP</span><h2>How to get a data center internship</h2><p>Do not search only for <strong>data center intern</strong>. Employers also use titles tied to infrastructure, operations, facilities, critical environment, electrical or mechanical engineering, inventory and DCIM.</p><ul class="guide-check"><li>Start with <a href="${baseUrl}/internships/">current data center internships</a> from employer career sites.</li><li>Check your school career office and technical faculty for local employer partnerships.</li><li>Put relevant labs, projects and hands-on coursework on your resume.</li><li>Apply to infrastructure internships even when data center is not in the title.</li><li>Watch permanent entry-level jobs too. An internship is one route, not the only route.</li></ul><a class="seo-apply" href="${baseUrl}/internships/">Browse ${internshipCount} current internships →</a></div><figure><img src="${trainingImage}" width="1440" height="810" loading="lazy" alt="Student or intern reviewing technical work with a mentor in a data center training environment"></figure></section>

<section class="guide-section"><span class="seo-kicker">PROGRAMS & TRAINING</span><h2>Places to learn and find opportunities</h2><div class="guide-resource-grid"><article><h3>Microsoft Datacenter Academy</h3><p>Microsoft works with vocational schools and community colleges in some data center communities on curriculum, labs, mentorship, scholarships and work experience.</p><a href="https://careers.microsoft.com/v2/global/en/datacenteracademy.html" target="_blank" rel="noopener">Microsoft Datacenter Academy →</a></article><article><h3>Introduction to Datacenters</h3><p>Microsoft offers a vendor-neutral introductory course on data center design, operations, sustainability and careers.</p><a href="https://learn.microsoft.com/en-us/training/educator-center/instructor-materials/datacenter-academy/introduction-to-datacenter" target="_blank" rel="noopener">Microsoft Learn course →</a></article><article><h3>Registered Apprenticeships</h3><p>The U.S. Department of Labor's Apprenticeship Job Finder lets you search active apprenticeship openings by keyword and location.</p><a href="https://www.apprenticeship.gov/finder/listings" target="_blank" rel="noopener">Apprenticeship Job Finder →</a></article><article><h3>Career events</h3><p>Hiring events and industry meetups can be a good way to meet employers and training providers in your area.</p><a href="${baseUrl}/career-events/">Current career events →</a></article></div></section>

<section class="guide-section"><span class="seo-kicker">WHERE TO LOOK</span><h2>Where starting-point jobs are showing up now</h2><p>These regions are based on the current employer-direct job feed. The list changes as employers open and close jobs.</p><ul class="guide-region-list">${regionLinks}</ul><a class="guide-secondary inline" href="${baseUrl}/jobs/">Browse all locations →</a></section>

<section class="guide-section"><span class="seo-kicker">OPEN NOW</span><h2>Jobs worth a look</h2><p>These openings come from the current job feed. Open a job to see the details, then follow the link to the employer's site to apply.</p><div class="guide-jobs">${jobCards || '<p>No entry-level openings are currently available. Check the full jobs page for the latest listings.</p>'}</div><a class="seo-apply" href="${baseUrl}/entry-level/">Browse all entry-level jobs →</a></section>

<section class="guide-section"><span class="seo-kicker">RESUME CHECK</span><h2>What to put on your resume</h2><div class="guide-do-dont"><article><h3>Include</h3><ul><li>Hardware troubleshooting and repair</li><li>Networking, cabling or fiber work</li><li>Electrical, HVAC or facilities maintenance</li><li>Industrial or manufacturing systems</li><li>Safety procedures and regulated environments</li><li>Ticketing, documentation and incident response</li><li>Military technical specialties</li><li>Shift, on-call or 24/7 operations experience</li></ul></article><article><h3>Leave out</h3><ul><li>Data center experience you do not actually have</li><li>Unrelated certifications with no connection to the job</li><li>Generic filler such as “hard worker” without an example</li><li>Senior jobs that do not match your experience level</li><li>The assumption that trade, maintenance or military experience is not relevant to tech</li></ul></article></div></section>

<section class="guide-section guide-faq"><span class="seo-kicker">COMMON QUESTIONS</span><h2>Data center job FAQ</h2>${faq.map(([q,a])=>`<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</section>

<section class="guide-cta"><h2>Start with jobs you can realistically qualify for.</h2><p>Entry-level roles, internships and apprenticeships are the best places to begin. Check the requirements, apply directly and keep watching for new openings.</p><div class="guide-actions"><a class="seo-apply" href="${baseUrl}/entry-level/">Entry-level jobs</a><a class="guide-secondary" href="${baseUrl}/apprenticeships/">Apprenticeships</a><a class="guide-secondary" href="${baseUrl}/internships/">Internships</a></div></section>
</article>
</main>
<footer class="seo-footer"><div><strong>Launch Your Data Center Career</strong><span>Employer-direct data center jobs, internships and apprenticeships.</span></div><span><a href="${baseUrl}/jobs/">Jobs</a> · <a href="${baseUrl}/career-events/">Events</a> · <a href="${canonical}">Career guide</a></span></footer>
</body>
</html>`;

await mkdir('how-to-get-a-data-center-job',{recursive:true});
await writeFile('how-to-get-a-data-center-job/index.html',html);

const sitemapPath = 'sitemap.xml';
let sitemap = await readFile(sitemapPath,'utf8');
if (!sitemap.includes(`<loc>${canonical}</loc>`)) {
  const entry = `  <url><loc>${canonical}</loc><lastmod>${modified}</lastmod></url>\n`;
  sitemap = sitemap.replace('</urlset>',`${entry}</urlset>`);
  await writeFile(sitemapPath,sitemap);
}

console.log(`Generated career guide with ${beginnerJobs.length} current starting-point jobs.`);