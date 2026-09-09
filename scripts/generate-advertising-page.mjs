import { readFile, writeFile, mkdir } from 'node:fs/promises';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

async function getBaseUrl() {
  try {
    const cname = clean(await readFile('CNAME', 'utf8'));
    if (cname) return `https://${cname.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
  } catch {}
  return 'https://dailyblip.github.io/ideal-garbanzo';
}

const baseUrl = await getBaseUrl();
const jobs = JSON.parse(await readFile('data/jobs.json', 'utf8'));
const campaigns = JSON.parse(await readFile('data/sponsorships.json', 'utf8'));
const modified = new Date().toISOString().slice(0, 10);
const canonical = `${baseUrl}/advertise/`;
const employers = new Set(jobs.map(job => clean(job.company)).filter(Boolean));
const earlyCareer = jobs.filter(job => ['internship', 'apprenticeship', 'trainee'].includes(job.type) || ['no-experience', '0-2-years'].includes(job.experience));
const activeCampaigns = campaigns.filter(campaign => campaign?.status === 'active').length;

const schema = {
  '@context': 'https://schema.org',
  '@type': 'WebPage',
  name: 'Advertise on Data Center Careers',
  description: 'Direct sponsorship opportunities reaching people actively researching data center jobs, apprenticeships, internships and early-career infrastructure work.',
  url: canonical,
  dateModified: modified,
  isPartOf: { '@type': 'WebSite', name: 'Data Center Careers', url: `${baseUrl}/` }
};

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Advertise on Data Center Careers | Sponsorships & Industry Campaigns</title>
<meta name="description" content="Reach people actively exploring data center careers, apprenticeships, internships and infrastructure work through clearly labeled direct sponsorships.">
<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="website">
<meta property="og:title" content="Advertise on Data Center Careers">
<meta property="og:description" content="Direct, clearly labeled sponsorships for campaigns relevant to data center careers and workforce development.">
<meta property="og:url" content="${canonical}">
<meta name="twitter:card" content="summary">
<link rel="stylesheet" href="${baseUrl}/assets/seo.css">
<script type="application/ld+json">${JSON.stringify(schema).replace(/</g, '\\u003c')}</script>
</head>
<body>
<header class="seo-header"><div class="seo-header-inner"><a class="seo-brand" href="${baseUrl}/"><small>LAUNCH YOUR</small><strong>DATA CENTER CAREER</strong></a><nav class="seo-nav" aria-label="Primary"><a href="${baseUrl}/jobs/">Jobs</a><a href="${baseUrl}/apprenticeships/">Apprenticeships</a><a href="${baseUrl}/internships/">Internships</a><a href="${baseUrl}/career-events/">Career events</a><a href="${baseUrl}/employers/">Employers</a></nav></div></header>
<main class="seo-shell guide-shell">
<nav class="breadcrumbs"><a href="${baseUrl}/">Home</a> / <span>Advertise</span></nav>
<header class="seo-page-head">
  <span class="seo-kicker">DIRECT SPONSORSHIPS</span>
  <h1>Reach people building careers in data centers.</h1>
  <p>Data Center Careers connects job seekers with employer-direct openings, apprenticeships, internships, training routes and early-career infrastructure work. Sponsorships are sold directly and displayed separately from editorial and job-ranking decisions.</p>
  <strong>Professional, contextual and clearly disclosed.</strong>
</header>

<section class="guide-stats" aria-label="Current audience inventory"><div><strong>${jobs.length}</strong><span>current jobs</span></div><div><strong>${earlyCareer.length}</strong><span>early-career opportunities</span></div><div><strong>${employers.size}</strong><span>employers represented</span></div><div><strong>100%</strong><span>employer-direct job links</span></div></section>

<section class="guide-section">
  <span class="seo-kicker">AVAILABLE INVENTORY</span>
  <h2>Simple placements, not ad clutter.</h2>
  <div class="guide-path-grid">
    <div><h3>Homepage sponsorship</h3><p>A clearly labeled text sponsorship below the primary job-alert area. The approved homepage hero stays untouched.</p></div>
    <div><h3>Career-path sponsorship</h3><p>Contextual placement on jobs, apprenticeships, internships or career-event pages.</p></div>
    <div><h3>Regional sponsorship</h3><p>Campaigns can be limited to Northern Virginia / Mid-Atlantic, Texas, Southwest, Midwest, Southeast, Northeast or West pages.</p></div>
    <div><h3>Job-detail sponsorship</h3><p>Sitewide or campaign-specific messaging adjacent to job-detail content without changing employer listings or rankings.</p></div>
  </div>
</section>

<section class="guide-section guide-split">
  <div><span class="seo-kicker">WHO IT FITS</span><h2>Relevant industry and workforce campaigns.</h2><p>Good fits include data center operators, workforce programs, training providers, industry associations, community outreach campaigns and public-policy organizations whose message is relevant to data center employment, training or infrastructure.</p></div>
  <div><span class="seo-kicker">HOW TARGETING WORKS</span><h2>Contextual, not personal.</h2><p>Campaigns can target a site section or broad U.S. region. We do not sell user lists, individual browsing histories or sensitive personal targeting. Sponsorship performance is measured with aggregate impressions and clicks.</p></div>
</section>

<section class="guide-section">
  <span class="seo-kicker">SPONSORSHIP STANDARDS</span>
  <h2>Clear disclosure is part of the product.</h2>
  <ul class="guide-check">
    <li>Every paid placement is visibly labeled <strong>Sponsored</strong>.</li>
    <li>The sponsor or payor is named in the placement.</li>
    <li>Political and issue-advocacy campaigns must provide the disclosure language required for their communication before activation.</li>
    <li>Sponsored messages do not control editorial coverage, job inclusion, employer ranking or career-event verification.</li>
    <li>Campaigns must use a real HTTPS destination and may be rejected if the message is deceptive, unrelated to the site's audience or incompatible with the site's career mission.</li>
    <li>Pricing is set as a normal commercial advertising rate based on placement, geography, campaign length and current verified audience data.</li>
  </ul>
  <p>Advertisers remain responsible for their own federal, state and local campaign-finance, disclaimer, authorization and reporting obligations. Data Center Careers may require additional documentation or disclosure text before a political or issue-advocacy campaign is activated.</p>
</section>

<section class="guide-section guide-cta">
  <span class="seo-kicker">REQUEST SPONSORSHIP DETAILS</span>
  <h2>Get current traffic, placement availability and commercial rates.</h2>
  <p>Leave an email address and we will use it for sponsorship follow-up. This does not enroll the address in weekly job alerts.</p>
  <form action="https://buttondown.com/api/emails/embed-subscribe/datacentercareers" method="post" class="guide-actions">
    <input class="guide-secondary" type="email" name="email" autocomplete="email" required aria-label="Email address" placeholder="you@organization.org">
    <input type="hidden" name="embed" value="1">
    <input type="hidden" name="tag" value="advertising-inquiries">
    <input type="hidden" name="metadata__interest" value="sponsorship">
    <input type="hidden" name="utm_source" value="datacentercareers.us">
    <input type="hidden" name="utm_medium" value="website">
    <input type="hidden" name="utm_campaign" value="advertising-inquiry">
    <button class="seo-apply" type="submit">Request sponsorship details</button>
  </form>
  <small>${activeCampaigns ? `${activeCampaigns} sponsorship campaign${activeCampaigns === 1 ? '' : 's'} currently active.` : 'No paid sponsorship campaign is currently active.'}</small>
</section>
</main>
<footer class="seo-footer"><div><strong>Launch Your Data Center Career</strong><span>Employer-direct data center jobs, internships and apprenticeships.</span></div><a href="${baseUrl}/">Back to home</a></footer>
</body>
</html>`;

await mkdir('advertise', { recursive: true });
await writeFile('advertise/index.html', html);

let sitemap = await readFile('sitemap.xml', 'utf8');
if (!sitemap.includes(`<loc>${canonical}</loc>`)) {
  sitemap = sitemap.replace('</urlset>', `  <url><loc>${canonical}</loc><lastmod>${modified}</lastmod></url>\n</urlset>`);
  await writeFile('sitemap.xml', sitemap);
}

console.log(`Generated advertising media-kit page for ${jobs.length} current jobs and ${employers.size} represented employers.`);
