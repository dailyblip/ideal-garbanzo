import { readFile, writeFile, mkdir } from 'node:fs/promises';

const FALLBACK_BASE = 'https://dailyblip.github.io/ideal-garbanzo';
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
const now = new Date();
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
  ['Can I get a data center job with no experience?','Yes. Some employers publish apprenticeships, trainee programs, internships and technician roles that accept candidates with little or no direct data center experience. Requirements vary by employer, so read the minimum qualifications carefully and focus on roles labeled beginner-friendly or 0–2 years.'],
  ['Do data center jobs require a college degree?','Not always. Many technician, facilities, electrical, mechanical, cabling and operations roles accept a high school diploma, trade training, military experience, certifications or equivalent hands-on experience. Engineering and some specialist roles may require a degree.'],
  ['What is the easiest data center job to start with?','There is no single easiest role, but common entry paths include data center technician, inventory or asset technician, cabling technician, apprentice, trainee and internship roles. Facilities candidates may also enter through electrical, HVAC or building-maintenance experience.'],
  ['How do I get a data center internship?','Start with employer-direct internship listings, school career offices and programs such as Microsoft Datacenter Academy where available. Apply to infrastructure, technician, facilities, operations and engineering internships, not only roles with “data center” in the title.'],
  ['What certifications help with data center jobs?','Certifications are not required for every entry-level role. Depending on the path, employers may value basic IT support and networking knowledge, electrical or HVAC credentials, safety training, or vendor-specific technical training. The job posting should determine what is worth pursuing.'],
  ['Where are the most data center jobs?','Large U.S. data center markets include Northern Virginia, Texas, Arizona, parts of the Midwest and several Southeast markets. Hiring changes constantly, so use current employer-direct listings rather than relying on a fixed market list.']
];

const schema = {
  '@context':'https://schema.org',
  '@graph':[
    {
      '@type':'Article',
      headline:'How to Get a Job at a Data Center: Beginner Roadmap',
      description:'A practical beginner roadmap for getting a data center job, internship or apprenticeship, including current employer-direct openings and training resources.',
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
  ? topRegions.map(([region,count])=>`<li><strong>${esc(regionNames[region] || region)}</strong><span>${count} current beginner-friendly opportunities in the feed</span></li>`).join('')
  : '<li><strong>Search nationwide</strong><span>Use current employer-direct openings and filter by region.</span></li>';

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>How to Get a Job at a Data Center | Beginner Roadmap 2026</title>
<meta name="description" content="Learn how to get a data center job with little or no experience. Follow a practical roadmap for internships, apprenticeships, technician roles, training and employer-direct applications.">
<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1">
<link rel="canonical" href="${canonical}">
<meta name="author" content="Data Center Careers">
<meta property="og:type" content="article">
<meta property="og:title" content="How to Get a Job at a Data Center: Beginner Roadmap">
<meta property="og:description" content="A practical path into data center jobs, internships and apprenticeships with current employer-direct openings and verified training resources.">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${heroImage}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="How to Get a Job at a Data Center: Beginner Roadmap">
<meta name="twitter:description" content="A practical path into data center jobs, internships and apprenticeships.">
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
  <div class="guide-hero-copy"><span class="seo-kicker">BEGINNER CAREER ROADMAP</span><h1>How to get a job at a data center.</h1><p>You do not need to already work in a data center to start. The best route depends on what you have now: school, trade skills, military experience, IT experience, facilities experience—or simply the willingness to learn.</p><div class="guide-actions"><a class="seo-apply" href="${baseUrl}/entry-level/">See beginner jobs</a><a class="guide-secondary" href="#roadmap">Follow the roadmap ↓</a></div></div>
  <figure><img src="${heroImage}" width="1440" height="810" alt="Early-career data center technician learning from an experienced mentor beside server racks" fetchpriority="high"></figure>
</header>

<section class="guide-stats" aria-label="Current opportunities"><div><strong>${internshipCount}</strong><span>internships</span></div><div><strong>${trainingCount}</strong><span>apprenticeships & trainee roles</span></div><div><strong>${noExperienceCount}</strong><span>no-experience roles</span></div><div><strong>${beginnerJobs.length}</strong><span>beginner-friendly openings</span></div></section>

<section class="guide-section guide-intro"><span class="seo-kicker">START HERE</span><h2>What kind of work happens inside a data center?</h2><p>Data centers need more than software engineers. The facilities have servers, power systems, cooling equipment, controls, cabling, security, inventory and around-the-clock operations. That creates multiple entry points for people with different backgrounds.</p><div class="guide-path-grid"><div><h3>IT & hardware</h3><p>Data center technician, deployment, break/fix, inventory and asset roles.</p></div><div><h3>Electrical & facilities</h3><p>Critical environment, electrical, UPS, generators, controls and building systems.</p></div><div><h3>Mechanical & HVAC</h3><p>Cooling systems, chillers, pumps, air handling and facilities maintenance.</p></div><div><h3>Construction & cabling</h3><p>Low-voltage cabling, fiber, installation, commissioning and site buildout.</p></div></div></section>

<section class="guide-section" id="roadmap"><span class="seo-kicker">THE ROADMAP</span><h2>A practical 7-step path into a data center job</h2><ol class="guide-steps"><li><div><strong>1</strong></div><article><h3>Pick the lane closest to what you already know.</h3><p>If you build PCs or work help desk, start with technician roles. If you have electrical, HVAC, maintenance, construction or military technical experience, search facilities and critical-environment roles. Students should search internships and Datacenter Academy partners.</p></article></li><li><div><strong>2</strong></div><article><h3>Read minimum qualifications before chasing certifications.</h3><p>Many entry roles accept equivalent experience instead of a four-year degree. Use the actual job description to decide whether a certification, trade credential or short course would close a real gap.</p></article></li><li><div><strong>3</strong></div><article><h3>Build one piece of hands-on proof.</h3><p>For IT paths, practice hardware, networking and troubleshooting. For facilities paths, emphasize electrical safety, HVAC, controls, preventive maintenance or industrial systems. School labs, trade programs, military work and maintenance experience all count as evidence when they match the role.</p></article></li><li><div><strong>4</strong></div><article><h3>Translate your resume into data center language.</h3><p>Do not claim experience you do not have. Instead, connect real work to the posting: troubleshooting, ticketing, preventive maintenance, rack-and-stack, inventory, cabling, electrical systems, HVAC, safety procedures, shift work or incident response.</p></article></li><li><div><strong>5</strong></div><article><h3>Apply directly to the employer.</h3><p>Prioritize official career pages and verified openings. This site links each listing back to the employer so you can confirm the role is still open and apply at the source.</p></article></li><li><div><strong>6</strong></div><article><h3>Use training programs and career events to get closer to the industry.</h3><p>Programs such as Microsoft Datacenter Academy, registered apprenticeships and local career events can provide structured learning, mentoring or work experience.</p></article></li><li><div><strong>7</strong></div><article><h3>Keep your search narrow enough to stay relevant.</h3><p>Focus on technician, facilities, electrical, mechanical, critical environment, operations, cabling, internships, apprenticeships and trainee roles. Skip senior leadership noise when you are trying to get your first foothold.</p></article></li></ol></section>

<section class="guide-section guide-split"><div><span class="seo-kicker">INTERNSHIP ROADMAP</span><h2>How to get a data center internship</h2><p>Internship titles are not always identical. Search for <strong>data center technician intern</strong>, infrastructure, operations, facilities, critical environment, electrical/mechanical engineering, inventory and DCIM roles.</p><ul class="guide-check"><li>Start with <a href="${baseUrl}/internships/">current data center internships</a> from employer career sites.</li><li>Use your school career office and technical faculty, especially if your college partners with a local data center employer.</li><li>Show projects or coursework that prove you can troubleshoot, document work and learn safely around infrastructure.</li><li>Apply to related infrastructure internships even when “data center” is not the first phrase in the title.</li><li>Keep applying to permanent entry-level roles too; an internship is one path, not the only path.</li></ul><a class="seo-apply" href="${baseUrl}/internships/">Browse ${internshipCount} current internships →</a></div><figure><img src="${trainingImage}" width="1440" height="810" loading="lazy" alt="Student or intern reviewing technical work with a mentor in a data center training environment"></figure></section>

<section class="guide-section"><span class="seo-kicker">PROGRAMS & TRAINING</span><h2>Useful places to start learning and applying</h2><div class="guide-resource-grid"><article><h3>Microsoft Datacenter Academy</h3><p>Microsoft partners with vocational schools and community colleges to support curriculum, hands-on labs, mentorship, scholarships and work experience in datacenter communities.</p><a href="https://careers.microsoft.com/v2/global/en/datacenteracademy.html" target="_blank" rel="noopener">Official Datacenter Academy →</a></article><article><h3>Introduction to Datacenters</h3><p>Microsoft provides a vendor-agnostic introductory course covering data center design, operations, sustainability and career pathways.</p><a href="https://learn.microsoft.com/en-us/training/educator-center/instructor-materials/datacenter-academy/introduction-to-datacenter" target="_blank" rel="noopener">Microsoft Learn course →</a></article><article><h3>Registered Apprenticeships</h3><p>The U.S. Department of Labor's Apprenticeship Job Finder lets career seekers search active apprenticeship opportunities by keyword and location.</p><a href="https://www.apprenticeship.gov/finder/listings" target="_blank" rel="noopener">Apprenticeship Job Finder →</a></article><article><h3>Verified career events</h3><p>Hiring events, training events and industry meetups can create a direct path to employers and training providers in your region.</p><a href="${baseUrl}/career-events/">Current career events →</a></article></div></section>

<section class="guide-section"><span class="seo-kicker">WHERE TO LOOK</span><h2>Current beginner-friendly hiring regions</h2><p>These are based on the jobs currently in our employer-direct feed, not a permanent ranking of data center markets.</p><ul class="guide-region-list">${regionLinks}</ul><a class="guide-secondary inline" href="${baseUrl}/jobs/">Browse all current locations →</a></section>

<section class="guide-section"><span class="seo-kicker">APPLY NOW</span><h2>Beginner-friendly openings in the current feed</h2><p>These examples are generated from the live job inventory and point to our detail pages, which then link to the employer application.</p><div class="guide-jobs">${jobCards || '<p>No beginner-friendly roles are currently available. Check the full jobs page for the latest inventory.</p>'}</div><a class="seo-apply" href="${baseUrl}/entry-level/">Browse all beginner-friendly jobs →</a></section>

<section class="guide-section"><span class="seo-kicker">RESUME CHECK</span><h2>What to put on your resume when you are new to data centers</h2><div class="guide-do-dont"><article><h3>Use this</h3><ul><li>Hardware troubleshooting and repair</li><li>Networking, cabling or fiber work</li><li>Electrical, HVAC or facilities maintenance</li><li>Industrial or manufacturing systems</li><li>Safety procedures and regulated environments</li><li>Ticketing, documentation and incident response</li><li>Military technical specialties</li><li>Shift, on-call or 24/7 operations experience</li></ul></article><article><h3>Avoid this</h3><ul><li>Claiming data center experience you do not have</li><li>Listing unrelated certifications without showing why they matter</li><li>Using only generic phrases such as “hard worker”</li><li>Applying to senior roles simply because the title contains “data center”</li><li>Hiding trade, maintenance or military experience because it is not “tech”</li></ul></article></div></section>

<section class="guide-section guide-faq"><span class="seo-kicker">COMMON QUESTIONS</span><h2>Data center career FAQ</h2>${faq.map(([q,a])=>`<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</section>

<section class="guide-cta"><h2>Ready to start looking?</h2><p>Use the beginner-friendly job pages first. Every published role is filtered toward real data center infrastructure work and links back to the employer source.</p><div class="guide-actions"><a class="seo-apply" href="${baseUrl}/entry-level/">Entry-level jobs</a><a class="guide-secondary" href="${baseUrl}/apprenticeships/">Apprenticeships</a><a class="guide-secondary" href="${baseUrl}/internships/">Internships</a></div></section>
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

console.log(`Generated beginner career guide with ${beginnerJobs.length} current beginner-friendly jobs.`);
