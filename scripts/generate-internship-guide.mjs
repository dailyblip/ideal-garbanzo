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
const canonical = `${baseUrl}/how-to-get-a-data-center-internship/`;
const careerGuide = `${baseUrl}/how-to-get-a-data-center-job/`;
const trainingImage = `${baseUrl}/assets/guides/data-center-internship-training.webp`;
const mentorImage = `${baseUrl}/assets/guides/data-center-career-guide-mentor.webp`;

const internships = jobs
  .filter(job => job?.active !== false && job.type === 'internship')
  .sort((a,b) => (a.postedHours ?? 9999) - (b.postedHours ?? 9999));
const apprenticeships = jobs.filter(job => job?.active !== false && ['apprenticeship','trainee'].includes(job.type));
const entryJobs = jobs.filter(job => job?.active !== false && ['no-experience','0-2-years'].includes(job.experience));

const internshipCards = internships.slice(0,8).map(job => {
  const url = `${baseUrl}/jobs/${jobSlug(job)}/`;
  const pay = job.pay && job.pay !== 'Pay not listed' ? ` · ${esc(job.pay)}` : '';
  return `<article class="guide-job"><span>Internship</span><h3><a href="${url}">${esc(job.title)}</a></h3><p><strong>${esc(job.company)}</strong> · ${esc(job.location)}</p><small>Employer-direct listing${pay}</small></article>`;
}).join('');

const faq = [
  ['How do I get a data center internship?','Start with employer career sites and search beyond the exact phrase data center intern. Relevant internships may be listed under infrastructure, operations, facilities, critical environment, electrical, mechanical, DCIM, inventory or technician teams. Apply to jobs that match your real coursework, projects and hands-on experience.'],
  ['Do I need a computer science degree for a data center internship?','No. Data centers hire across IT hardware, electrical, mechanical, HVAC, controls, logistics, inventory and operations. The right major or training depends on the internship. Use the employer’s minimum qualifications as your guide.'],
  ['What should I put on my resume for a data center internship?','Show that you can troubleshoot, follow procedures, work safely and learn technical systems. Useful examples include PC building, networking labs, electrical or HVAC coursework, robotics, maintenance, cabling, inventory work, military technical experience and school projects.'],
  ['When should I apply for data center internships?','Recruiting schedules vary by employer, and some internship windows are short. Start early, check employer career sites regularly and keep job alerts active. Also watch apprenticeships, trainee programs and true entry-level technician jobs.'],
  ['Can a data center internship lead to a full-time job?','Yes, it can. Some employers use internships as a way to identify future full-time candidates, but a permanent job is never guaranteed. Treat the internship as a chance to build experience and industry contacts.']
];

const schema = {
  '@context':'https://schema.org',
  '@graph':[
    {
      '@type':'Article',
      headline:`How to Get a Data Center Internship: Student Roadmap ${year}`,
      description:'How to find and apply for data center internships, including current employer-direct openings, resume tips, training programs and related entry-level jobs.',
      mainEntityOfPage:canonical,
      image:[trainingImage,mentorImage],
      dateModified:modified,
      author:{'@type':'Organization','name':'Data Center Careers','url':baseUrl+'/'},
      publisher:{'@type':'Organization','name':'Data Center Careers','url':baseUrl+'/'}
    },
    {
      '@type':'BreadcrumbList',
      itemListElement:[
        {'@type':'ListItem','position':1,'name':'Home','item':baseUrl+'/'},
        {'@type':'ListItem','position':2,'name':'Career guide','item':careerGuide},
        {'@type':'ListItem','position':3,'name':'Data center internship guide','item':canonical}
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
<title>How to Get a Data Center Internship | Student Roadmap ${year}</title>
<meta name="description" content="Learn how to get a data center internship. Find current employer-direct internships, resume tips, training programs and related entry-level data center jobs.">
<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1">
<link rel="canonical" href="${canonical}">
<meta name="author" content="Data Center Careers">
<meta property="og:type" content="article">
<meta property="og:title" content="How to Get a Data Center Internship: Student Roadmap">
<meta property="og:description" content="How to find data center internships, prepare your resume and apply to current employer-direct openings.">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${trainingImage}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="How to Get a Data Center Internship: Student Roadmap">
<meta name="twitter:description" content="Find data center internships, training programs and other ways to get started in the field.">
<meta name="twitter:image" content="${trainingImage}">
<link rel="stylesheet" href="${baseUrl}/assets/seo.css">
<script type="application/ld+json">${json(schema)}</script>
</head>
<body>
<header class="seo-header"><div class="seo-header-inner"><a class="seo-brand" href="${baseUrl}/"><small>LAUNCH YOUR</small><strong>DATA CENTER CAREER</strong></a><nav class="seo-nav" aria-label="Primary"><a href="${baseUrl}/">Home</a><a href="${baseUrl}/jobs/">All jobs</a><a href="${baseUrl}/apprenticeships/">Apprenticeships</a><a href="${baseUrl}/internships/" aria-current="page">Internships</a><a href="${baseUrl}/entry-level/">Entry-level</a><a href="${careerGuide}">Career guide</a></nav></div></header>
<main class="seo-shell guide-shell">
<nav class="breadcrumbs"><a href="${baseUrl}/">Home</a> / <a href="${careerGuide}">Career guide</a> / <span>Data center internship guide</span></nav>
<article>
<header class="guide-hero">
  <div class="guide-hero-copy"><span class="seo-kicker">STUDENT & EARLY-CAREER ROADMAP</span><h1>How to get a data center internship.</h1><p>You do not need to be a computer science major. Data centers also need interns interested in hardware, electrical systems, mechanical systems, facilities, controls, inventory and operations.</p><div class="guide-actions"><a class="seo-apply" href="${baseUrl}/internships/">See current internships</a><a class="guide-secondary" href="#roadmap">See the roadmap ↓</a></div></div>
  <figure><img src="${trainingImage}" width="1440" height="810" alt="Student reviewing technical work with a mentor in a data center training environment" fetchpriority="high"></figure>
</header>

<section class="guide-stats" aria-label="Current entry opportunities"><div><strong>${internships.length}</strong><span>current internships</span></div><div><strong>${apprenticeships.length}</strong><span>apprentice & trainee roles</span></div><div><strong>${entryJobs.length}</strong><span>entry-level jobs</span></div><div><strong>100%</strong><span>employer-direct applications</span></div></section>

<section class="guide-section guide-intro"><span class="seo-kicker">KNOW WHAT TO SEARCH</span><h2>Search more than “data center intern.”</h2><p>Good matches often sit under infrastructure, facilities or operations teams. Use several search terms so you do not miss internships just because the title is different.</p><div class="guide-path-grid"><div><h3>Hardware & IT</h3><p>Data center technician, infrastructure technician, deployment, break/fix and hardware operations.</p></div><div><h3>Electrical & facilities</h3><p>Critical environment, electrical engineering, power systems, controls and facilities operations.</p></div><div><h3>Mechanical & cooling</h3><p>Mechanical engineering, HVAC, cooling systems, facilities maintenance and reliability.</p></div><div><h3>Operations & inventory</h3><p>DCIM, asset management, inventory, logistics, project coordination and site operations.</p></div></div></section>

<section class="guide-section" id="roadmap"><span class="seo-kicker">THE ROADMAP</span><h2>Six steps to a stronger internship application</h2><ol class="guide-steps"><li><div><strong>1</strong></div><article><h3>Pick the technical area that fits you.</h3><p>If your strengths are electrical, mechanical, construction or hands-on hardware, do not force yourself into a software path. Data centers hire across all of those areas.</p></article></li><li><div><strong>2</strong></div><article><h3>Have one project you can explain clearly.</h3><p>A networking lab, PC build, robotics project, electrical lab, HVAC class, maintenance project or cabling exercise gives an interviewer something real to ask about.</p></article></li><li><div><strong>3</strong></div><article><h3>Match your resume to the posting.</h3><p>Use skills from the minimum qualifications when they are true of your experience: troubleshooting, documentation, safety, preventive maintenance, inventory, hardware, networking, electrical systems or mechanical systems.</p></article></li><li><div><strong>4</strong></div><article><h3>Apply early and apply directly.</h3><p>Internship windows can be short. Use official employer career pages and apply when a relevant job opens instead of waiting for one perfect title.</p></article></li><li><div><strong>5</strong></div><article><h3>Ask your school about employer partnerships.</h3><p>Community colleges, vocational programs and universities sometimes work directly with data center employers. Ask your career center and technical faculty about local programs.</p></article></li><li><div><strong>6</strong></div><article><h3>Keep another route open.</h3><p>If internships are scarce, apply to apprenticeships, trainee programs and true 0–2 year technician jobs too. Your first data center job does not have to start with an internship.</p></article></li></ol></section>

<section class="guide-section guide-split"><div><span class="seo-kicker">PROGRAM EXAMPLE</span><h2>Microsoft Datacenter Academy</h2><p>Microsoft's Datacenter Academy works with vocational schools and community colleges in some data center communities. Programs can include curriculum support, hands-on labs, mentorship and work-experience opportunities. Availability varies by school and location.</p><ul class="guide-check"><li><a href="https://careers.microsoft.com/v2/global/en/datacenteracademy.html" target="_blank" rel="noopener">Microsoft Datacenter Academy</a></li><li><a href="https://learn.microsoft.com/en-us/training/educator-center/instructor-materials/datacenter-academy/introduction-to-datacenter" target="_blank" rel="noopener">Microsoft Introduction to Datacenters course</a></li><li><a href="https://careers.microsoft.com/students/us/en/interns" target="_blank" rel="noopener">Microsoft student opportunities</a></li></ul></div><figure><img src="${mentorImage}" width="1440" height="810" loading="lazy" alt="Early-career technician receiving guidance from an experienced data center mentor"></figure></section>

<section class="guide-section"><span class="seo-kicker">CURRENT OPENINGS</span><h2>Data center internships hiring now</h2><p>These internships come from employer career sites and update with the rest of the job feed.</p><div class="guide-jobs">${internshipCards || '<p>No verified internships are currently in the feed. Check apprenticeships and entry-level jobs while internship recruiting cycles reopen.</p>'}</div><div class="guide-actions"><a class="seo-apply" href="${baseUrl}/internships/">Browse all internships →</a><a class="guide-secondary" href="${baseUrl}/apprenticeships/">See apprenticeships →</a></div></section>

<section class="guide-section"><span class="seo-kicker">RESUME CHECKLIST</span><h2>What to show when you are new to the field</h2><div class="guide-path-grid"><div><h3>Troubleshooting</h3><p>Give a real example of diagnosing a hardware, network, electrical or mechanical problem.</p></div><div><h3>Safety & procedure</h3><p>Show that you can follow documented steps, work carefully and ask for help when needed.</p></div><div><h3>Hands-on work</h3><p>Projects, labs, maintenance, tools, cabling, hardware assembly and trade coursework all count when they are relevant.</p></div><div><h3>Reliability</h3><p>Data centers run around the clock. Attendance, documentation, teamwork and comfort with shift work can matter.</p></div></div></section>

<section class="guide-section"><span class="seo-kicker">FAQ</span><h2>Common questions about data center internships</h2><div class="guide-faq">${faq.map(([q,a])=>`<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</div></section>

<section class="guide-section guide-cta"><span class="seo-kicker">NEXT STEP</span><h2>Start with the openings that match your background.</h2><p>Check current internships first. If there are not many in your area, look at apprenticeships, trainee programs and entry-level technician jobs too.</p><div class="guide-actions"><a class="seo-apply" href="${baseUrl}/internships/">Browse internships</a><a class="guide-secondary" href="${careerGuide}">Read the full career guide →</a></div></section>
</article>
</main>
<footer class="seo-footer"><div><strong>Launch Your Data Center Career</strong><span>Employer-direct data center jobs, internships and apprenticeships.</span></div><a href="${baseUrl}/">Back to home</a></footer>
</body>
</html>`;

await mkdir('how-to-get-a-data-center-internship',{recursive:true});
await writeFile('how-to-get-a-data-center-internship/index.html',html);

const sitemapPath = 'sitemap.xml';
let sitemap = await readFile(sitemapPath,'utf8');
if (!sitemap.includes(`<loc>${canonical}</loc>`)) {
  sitemap = sitemap.replace('</urlset>',`  <url><loc>${canonical}</loc><lastmod>${modified}</lastmod></url>\n</urlset>`);
  await writeFile(sitemapPath,sitemap);
}

async function injectGuideLink(path, marker, block) {
  try {
    let page = await readFile(path,'utf8');
    if (!page.includes(canonical) && page.includes(marker)) {
      page = page.replace(marker,`${block}${marker}`);
      await writeFile(path,page);
    }
  } catch {}
}

await injectGuideLink(
  'internships/index.html',
  '<section class="seo-list"',
  `<aside class="seo-related"><h2>New to data center internships?</h2><a href="${canonical}">Read the data center internship guide →</a></aside>`
);

await injectGuideLink(
  'how-to-get-a-data-center-job/index.html',
  '<section class="guide-cta">',
  `<section class="guide-section"><span class="seo-kicker">STUDENT GUIDE</span><h2>Looking for an internship?</h2><p>The internship guide covers search terms, resume tips, training programs and current employer-direct openings.</p><a class="seo-apply" href="${canonical}">Read the internship guide →</a></section>`
);

console.log(`Generated internship guide with ${internships.length} current internships for ${canonical}.`);