import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const PAGE_PATH = 'apprenticeships/index.html';
const SCRIPT_PATH = '/assets/apprenticeship-listing.js';
const CSS_PATH = 'assets/styles.css';
const CSS_MARKER = '/* apprenticeship front-page layout */';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const PAGE_CSS = String.raw`/* apprenticeship front-page layout */
.apprenticeship-page{background:#fff}
.apprenticeship-page .nav a[aria-current="page"]{color:var(--red)}
.path-page-main{min-width:0}
.path-hero{padding:0 28px;background:#fff}
.path-hero-inner{width:min(100%,var(--page));min-height:410px;margin:0 auto;padding:52px 0;display:grid;grid-template-columns:minmax(0,1.22fr) minmax(320px,.78fr);gap:54px;align-items:center;border-bottom:1px solid var(--line)}
.path-hero-copy{min-width:0;max-width:800px}
.path-breadcrumbs{display:flex;align-items:center;gap:8px;margin:0 0 28px;color:#7a858f;font-size:11px}
.path-breadcrumbs a{color:var(--navy);font-weight:750}
.path-hero h1{max-width:760px;margin:10px 0 16px;color:var(--navy);font-size:clamp(48px,5vw,68px);line-height:.98;letter-spacing:-.05em;font-weight:900}
.path-hero-copy>p:not(.path-live-count){max-width:760px;margin:0;color:#596674;font-size:18px;line-height:1.5}
.path-live-count{margin:18px 0 0;color:var(--muted);font-size:12px}
.path-live-count strong{color:var(--red)}
.path-hero-actions{display:flex;align-items:center;gap:18px;flex-wrap:wrap;margin-top:26px}
.path-hero-actions .btn{min-height:46px}
.path-text-link,.path-section-link{color:var(--navy);font-size:12px;font-weight:850}
.path-text-link:hover,.path-section-link:hover{color:var(--red)}
.path-proof-card{min-width:0;padding:24px;border:1px solid var(--line);border-top:4px solid var(--red);border-radius:10px;background:#fff;box-shadow:0 8px 24px rgba(23,50,77,.08)}
.path-proof-card h2{margin:5px 0 18px;color:var(--navy);font-size:22px;line-height:1.15;letter-spacing:-.025em}
.path-proof-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.path-proof-grid>div{min-width:0;padding:14px;border:1px solid var(--line);border-radius:8px;background:var(--soft)}
.path-proof-grid strong{display:block;color:var(--navy);font-size:27px;line-height:1;font-weight:900}
.path-proof-grid span{display:block;margin-top:6px;color:var(--muted);font-size:10px;font-weight:750;line-height:1.3}
.path-proof-note{display:flex;align-items:center;gap:7px;margin:16px 0 0;color:#5d6973;font-size:11px;font-weight:750}
.path-proof-note>span{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 0 3px rgba(47,123,78,.12)}
.path-section,.path-board{width:min(calc(100% - 56px),var(--content));margin-left:auto;margin-right:auto}
.path-section{padding:30px 0;border-bottom:1px solid var(--line)}
.path-section-heading{display:flex;justify-content:space-between;align-items:end;gap:24px;margin-bottom:14px}
.path-section-heading h2,.path-board-heading h2,.path-faq-section>h2{margin:5px 0 0;color:var(--navy);font-size:27px;line-height:1.12;letter-spacing:-.025em}
.path-section-heading p,.path-board-heading p{margin:5px 0 0;color:var(--muted);font-size:12px}
.path-fresh-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.path-fresh-card{height:100%;padding:16px}
.path-fresh-card .job-card-top{grid-template-columns:1fr}
.path-fresh-card .posted{text-align:left;margin-top:8px}
.path-fresh-card .job-card-actions{justify-content:flex-start}
.path-fresh-card .apply-link{flex:1;text-align:center;min-height:40px}
.path-board{display:grid;grid-template-columns:minmax(0,1fr) 250px;gap:22px;padding:30px 0 52px;align-items:start}
.path-board-main{min-width:0}
.path-board-heading{padding-bottom:13px;border-bottom:1px solid var(--line);margin-bottom:12px}
.path-filter-card{margin-bottom:12px;padding:16px 18px;border:1px solid var(--line);border-radius:8px;background:var(--soft)}
.path-filter-heading{display:flex;align-items:center;justify-content:space-between;gap:18px}
.path-filter-heading h3{margin:0;color:var(--navy);font-size:16px}
.path-filter-heading button{min-height:40px;padding:8px 10px;border:1px solid #cfd6dc;border-radius:6px;background:#fff;color:var(--navy);font-size:11px;font-weight:850;cursor:pointer}
.path-filter-heading button:hover{border-color:var(--navy)}
.path-filter-grid{display:grid;grid-template-columns:minmax(150px,.85fr) minmax(170px,1fr) minmax(260px,1.35fr);gap:10px;margin-top:13px;align-items:stretch}
.path-filter-grid>label{display:flex;min-width:0;flex-direction:column;gap:5px;color:#52606b;font-size:10px;font-weight:850}
.path-filter-grid select{width:100%;min-width:0;min-height:44px;padding:9px 34px 9px 11px;border:1px solid #cfd6dc;border-radius:6px;background:#fff;color:var(--ink);font-size:16px}
.path-filter-check{min-height:44px;padding:8px 11px;border:1px solid #cfd6dc;border-radius:6px;background:#fff;flex-direction:row!important;align-items:center;cursor:pointer}
.path-filter-check input{width:20px;height:20px;margin:0;flex:0 0 auto;accent-color:var(--navy)}
.path-filter-check span{font-size:11px;line-height:1.3}
.path-results-summary{margin:12px 0 0;color:var(--muted);font-size:11px}
.apprenticeship-job-list{gap:10px}
.apprenticeship-job-card{min-width:0}
.apprenticeship-job-card .job-meta{overflow-wrap:anywhere}
.apprenticeship-job-card .posted small{font-size:9px}
.apprenticeship-job-card[hidden]{display:none}
.apprenticeship-apply{border-color:var(--navy);background:var(--navy);color:#fff}
.apprenticeship-apply:hover{background:var(--navy2)}
.apprenticeship-empty{margin-top:12px}
.path-rail{display:flex;flex-direction:column;gap:12px;position:sticky;top:94px}
.path-rail .rail-card:first-child{border-top:4px solid var(--navy)}
.path-rail .rail-card:nth-child(2){border-top:4px solid var(--gold)}
.path-rail .link-button{min-height:32px;display:flex;align-items:center}
.path-faq-section{padding-top:8px;padding-bottom:54px;border-bottom:0}
.path-section-intro{max-width:850px;margin:10px 0 0;color:#596674;font-size:14px;line-height:1.55}
.path-faq-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:20px}
.path-faq-grid article{padding:20px;border:1px solid var(--line);border-radius:8px;background:#fff}
.path-faq-grid article:nth-child(1),.path-faq-grid article:nth-child(4){border-top:4px solid var(--navy)}
.path-faq-grid article:nth-child(2),.path-faq-grid article:nth-child(3){border-top:4px solid var(--gold)}
.path-faq-grid h3{margin:0 0 7px;color:var(--navy);font-size:17px}
.path-faq-grid p{margin:0;color:var(--muted);font-size:12px;line-height:1.5}
@media(max-width:1040px){
  .path-hero-inner{gap:34px;grid-template-columns:minmax(0,1fr) minmax(300px,.72fr)}
  .path-fresh-grid{grid-template-columns:1fr 1fr}
  .path-board{grid-template-columns:minmax(0,1fr) 230px}
  .path-filter-grid{grid-template-columns:1fr 1fr}.path-filter-check{grid-column:1/-1}
}
@media(max-width:860px){
  .path-hero-inner{grid-template-columns:1fr;min-height:0;padding:42px 0;gap:28px}
  .path-proof-card{max-width:680px}
  .path-board{grid-template-columns:1fr}
  .path-rail{position:static;display:grid;grid-template-columns:1fr 1fr}
}
@media(max-width:760px){
  .path-hero{padding:0 18px}.path-hero-inner{padding:30px 0 26px;gap:22px}
  .path-breadcrumbs{margin-bottom:20px}
  .path-hero h1{font-size:40px;line-height:1.02;letter-spacing:-.04em;margin:8px 0 14px}
  .path-hero-copy>p:not(.path-live-count){font-size:16px}
  .path-hero-actions{display:grid;grid-template-columns:1fr;gap:12px;margin-top:22px}
  .path-hero-actions .btn{width:100%;min-height:48px}
  .path-text-link{min-height:44px;display:flex;align-items:center}
  .path-proof-card{padding:18px}.path-proof-card h2{font-size:20px}
  .path-proof-grid{grid-template-columns:1fr 1fr}.path-proof-grid>div{padding:12px}.path-proof-grid strong{font-size:24px}
  .path-section,.path-board{width:auto;margin-left:18px;margin-right:18px}
  .path-section{padding:24px 0}
  .path-section-heading{align-items:flex-start;flex-direction:column;gap:10px}
  .path-section-heading h2,.path-board-heading h2,.path-faq-section>h2{font-size:24px}
  .path-section-link{min-height:44px;display:flex;align-items:center}
  .path-fresh-grid,.path-faq-grid,.path-rail{grid-template-columns:1fr}
  .path-board{padding:24px 0 38px}
  .path-filter-card{padding:14px}.path-filter-heading{align-items:flex-start}
  .path-filter-heading button{min-height:44px}
  .path-filter-grid{grid-template-columns:1fr}.path-filter-check{grid-column:auto}
  .path-filter-grid select{font-size:16px}
  .apprenticeship-job-card .job-card-actions{display:grid;grid-template-columns:1fr;gap:8px}
  .apprenticeship-job-card .apply-link{width:100%;min-height:44px;display:flex;align-items:center;justify-content:center}
  .path-faq-section{padding-bottom:40px}
}
@media(max-width:420px){
  .path-filter-heading{flex-direction:column}.path-filter-heading button{width:100%}
}
@media(max-width:330px){.path-proof-grid{grid-template-columns:1fr}}`;

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}[ch]));
const slugify = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'job';
const jobSlug = job => `${slugify(job.title)}-${slugify(job.company).slice(0, 32)}-${String(job.id || '').replace(/[^a-zA-Z0-9]/g, '').slice(-10)}`;
const json = value => JSON.stringify(value).replace(/</g, '\\u003c');

const stateNames = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia'
};
const stateCodes = Object.keys(stateNames);
const stateNameToCode = new Map(Object.entries(stateNames).map(([code, name]) => [name.toLowerCase(), code]));
const focusLabels = {
  electrical: 'Electrical / power',
  mechanical: 'Mechanical / cooling',
  facilities: 'Critical facilities',
  operations: 'Operations / technician'
};

const baseDomain = clean(await readFile('CNAME', 'utf8')).replace(/^https?:\/\//, '').replace(/\/$/, '');
if (!baseDomain) throw new Error('CNAME is required to generate the apprenticeship page.');
const baseUrl = `https://${baseDomain}`;
const allJobs = JSON.parse(await readFile('data/jobs.json', 'utf8'));
if (!Array.isArray(allJobs)) throw new Error('data/jobs.json must contain an array.');

const apprenticeships = allJobs
  .filter(job => job?.type === 'apprenticeship')
  .sort((a, b) => (Number(a.postedHours) || 999999) - (Number(b.postedHours) || 999999));

function validDate(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function discoveryDate(job) {
  return validDate(job?.firstSeenAt) ?? validDate(job?.postedAt);
}

function displayPay(value) {
  const pay = clean(value);
  return !pay || /^pay not listed$/i.test(pay) ? '' : pay;
}

function postedLabel(hours) {
  const value = Number(hours);
  if (!Number.isFinite(value) || value >= 9999) return 'Recently verified';
  if (value < 24) return `${Math.max(1, Math.round(value))}h ago`;
  return `${Math.max(1, Math.round(value / 24))}d ago`;
}

function statesFor(job) {
  const location = clean(job?.location);
  const found = new Set();
  for (const match of location.matchAll(new RegExp(`\\b(${stateCodes.join('|')})\\b`, 'g'))) found.add(match[1]);
  const lower = location.toLowerCase();
  for (const [name, code] of stateNameToCode) {
    if (new RegExp(`\\b${name.replace(/ /g, '\\s+')}\\b`, 'i').test(lower)) found.add(code);
  }
  return [...found].sort();
}

function focusFor(job) {
  const text = `${clean(job?.title)} ${(job?.tags || []).map(clean).join(' ')}`.toLowerCase();
  const focus = [];
  if (/electrical|electrician|power|generator|ups|switchgear|voltage/.test(text)) focus.push('electrical');
  if (/mechanical|hvac|cooling|chiller|plumbing/.test(text)) focus.push('mechanical');
  if (/critical facilit|facilities|facility/.test(text)) focus.push('facilities');
  if (/operations|operator|technician|data center|infrastructure/.test(text)) focus.push('operations');
  return [...new Set(focus)];
}

function experienceText(job) {
  if (job.experience === 'no-experience') return 'No prior data center experience required';
  if (job.experience === '0-2-years') return '0–2 years';
  if (job.experience === '2-5-years') return '2–5 years';
  return clean(job.experience) || 'See employer requirements';
}

function safeSourceUrl(value) {
  const url = clean(value);
  return /^https:\/\//i.test(url) ? url : '';
}

function usefulTags(job) {
  const ignored = /^(?:apprenticeship|apprentice|no experience needed|no experience required|0–2 years|0-2 years|2–5 years|2-5 years|training \/ mentorship)$/i;
  const tags = [...new Set((job.tags || []).map(clean).filter(Boolean))]
    .filter(tag => !ignored.test(tag));
  const focus = focusFor(job).map(value => focusLabels[value]);
  return [...new Set([...focus, ...tags])].slice(0, 3);
}

function jobCard(job, { compact = false } = {}) {
  const internal = `${baseUrl}/jobs/${jobSlug(job)}/`;
  const source = safeSourceUrl(job.sourceUrl);
  const pay = displayPay(job.pay);
  const states = statesFor(job);
  const focus = focusFor(job);
  const tags = usefulTags(job);
  const filterAttributes = compact ? ' data-apprenticeship-feature' : ` data-apprenticeship-card data-states="${esc(states.join(' '))}" data-focus="${esc(focus.join(' '))}" data-experience="${esc(job.experience)}"`;
  return `<article class="job-card apprenticeship-job-card${compact ? ' apprenticeship-job-card--compact' : ''}"${filterAttributes}>
    <div class="job-card-top">
      <div>
        <h3><a href="${internal}">${esc(job.title)}</a> <span class="badge">APPRENTICE</span></h3>
        <div class="job-meta">${esc(job.company)} <span>•</span> ${esc(job.location)}</div>
        <div class="job-tags"><span>${esc(experienceText(job))}</span>${tags.map(tag => `<span>${esc(tag)}</span>`).join('')}</div>
        ${pay ? `<div class="job-pay">${esc(pay)}</div>` : ''}
      </div>
      <div class="posted">${esc(postedLabel(job.postedHours))}<br><small>Verified employer site</small></div>
    </div>
    <div class="job-card-actions">
      <a class="apply-link" href="${internal}">${compact ? 'See requirements →' : 'Job details →'}</a>
      ${!compact && source ? `<a class="apply-link apprenticeship-apply" href="${esc(source)}" target="_blank" rel="noopener noreferrer">View &amp; Apply →</a>` : ''}
    </div>
  </article>`;
}

function headerHtml() {
  return `<header class="site-header">
  <div class="header-inner">
    <a class="brand" href="${baseUrl}/" aria-label="Launch Your Data Center Career home">
      <span class="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill="none" stroke="#17324d" stroke-width="3.2"/><g transform="rotate(45 32 32)"><path d="M32 10C25.5 16.2 23 23.5 23 34v8h18v-8c0-10.5-2.5-17.8-9-24Z" fill="#17324d"/><path d="M23 31 15 38v9l8-4Z" fill="#17324d"/><path d="M41 31 49 38v9l-8-4Z" fill="#17324d"/><circle cx="32" cy="25" r="5.5" fill="#fff"/><circle cx="32" cy="25" r="3" fill="#17324d"/><path d="M27 42c-2 4-2 8 0 12 2-1 4-3 5-6 1 3 3 5 5 6 2-4 2-8 0-12Z" fill="#a94f45"/><path d="M30 43c-1 3-1 5 2 8 3-3 3-5 2-8Z" fill="#c9942f"/></g></svg>
      </span>
      <span class="brand-copy"><small>LAUNCH YOUR</small><strong>DATA CENTER CAREER</strong></span>
    </a>
    <nav class="nav" aria-label="Primary"><a href="${baseUrl}/jobs/">Jobs</a><a href="${baseUrl}/apprenticeships/" aria-current="page">Apprenticeships</a><a href="${baseUrl}/internships/">Internships</a><a href="${baseUrl}/how-to-get-a-data-center-job/">Career Guide</a><a href="${baseUrl}/career-events/">Career Events</a><a href="${baseUrl}/employers/">Employers</a></nav>
    <a class="header-cta" href="${baseUrl}/jobs/">Browse jobs</a>
    <button class="menu-button" type="button" aria-label="Toggle navigation" aria-expanded="false">☰</button>
  </div>
</header>`;
}

function footerHtml() {
  return `<footer><span>Launch Your Data Center Career</span><span><a href="${baseUrl}/jobs/">Jobs</a> · <a href="${baseUrl}/internships/">Internships</a> · <a href="${baseUrl}/apprenticeships/">Apprenticeships</a> · <a href="${baseUrl}/how-to-get-a-data-center-job/">Career Guide</a> · <a href="${baseUrl}/career-events/">Career Events</a></span></footer>`;
}

const employers = new Set(apprenticeships.map(job => clean(job.company)).filter(Boolean));
const states = new Set(apprenticeships.flatMap(statesFor));
const noExperience = apprenticeships.filter(job => job.experience === 'no-experience');
const recent = apprenticeships
  .filter(job => {
    const seen = discoveryDate(job);
    return seen !== null && seen >= Date.now() - WEEK_MS;
  })
  .slice(0, 3);

const stateOptions = [...states]
  .sort((a, b) => stateNames[a].localeCompare(stateNames[b]))
  .map(code => `<option value="${code}">${esc(stateNames[code])} (${code})</option>`)
  .join('');
const focusCounts = new Map();
for (const job of apprenticeships) {
  for (const focus of focusFor(job)) focusCounts.set(focus, (focusCounts.get(focus) || 0) + 1);
}
const focusOptions = Object.keys(focusLabels)
  .filter(value => focusCounts.get(value))
  .map(value => `<option value="${value}">${esc(focusLabels[value])} (${focusCounts.get(value)})</option>`)
  .join('');

const itemList = {
  '@context': 'https://schema.org',
  '@type': 'ItemList',
  name: 'Data center apprenticeships',
  numberOfItems: apprenticeships.length,
  itemListElement: apprenticeships.map((job, index) => ({
    '@type': 'ListItem',
    position: index + 1,
    url: `${baseUrl}/jobs/${jobSlug(job)}/`,
    name: job.title
  }))
};
const breadcrumb = {
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'Home', item: `${baseUrl}/` },
    { '@type': 'ListItem', position: 2, name: 'Data center apprenticeships', item: `${baseUrl}/apprenticeships/` }
  ]
};

const description = 'Browse current data center apprenticeships in electrical, mechanical and operations. See experience requirements and apply through verified employer listings on employer sites.';
const recentHtml = recent.length ? `<section class="path-section path-fresh" aria-labelledby="apprenticeship-new-heading" data-new-this-week-count="${recent.length}">
  <div class="path-section-heading">
    <div><span class="section-kicker">NEW THIS WEEK</span><h2 id="apprenticeship-new-heading">Recently added apprenticeships</h2><p>Newly discovered employer listings from the past seven days.</p></div>
    <a class="path-section-link" href="#apprenticeships-list">See all current openings ↓</a>
  </div>
  <div class="path-fresh-grid">${recent.map(job => jobCard(job, { compact: true })).join('')}</div>
</section>` : '';

const pageHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>Data Center Apprenticeships | Verified Employer Openings</title>
  <meta name="description" content="${esc(description)}">
  <meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1">
  <link rel="canonical" href="${baseUrl}/apprenticeships/">
  <meta property="og:type" content="website">
  <meta property="og:title" content="Data Center Apprenticeships | Verified Employer Openings">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${baseUrl}/apprenticeships/">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="Data Center Apprenticeships | Verified Employer Openings">
  <meta name="twitter:description" content="${esc(description)}">
  <meta name="theme-color" content="#17324d">
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2064%2064%22%3E%3Ccircle%20cx%3D%2232%22%20cy%3D%2232%22%20r%3D%2228%22%20fill%3D%22white%22%20stroke%3D%22%2317324d%22%20stroke-width%3D%224%22%2F%3E%3Cg%20transform%3D%22rotate%2845%2032%2032%29%22%3E%3Cpath%20d%3D%22M32%2010C25.5%2016.2%2023%2023.5%2023%2034v8h18v-8c0-10.5-2.5-17.8-9-24Z%22%20fill%3D%22%2317324d%22%2F%3E%3Cpath%20d%3D%22M23%2031%2015%2038v9l8-4Z%22%20fill%3D%22%2317324d%22%2F%3E%3Cpath%20d%3D%22M41%2031%2049%2038v9l-8-4Z%22%20fill%3D%22%2317324d%22%2F%3E%3Ccircle%20cx%3D%2232%22%20cy%3D%2225%22%20r%3D%225.5%22%20fill%3D%22white%22%2F%3E%3Ccircle%20cx%3D%2232%22%20cy%3D%2225%22%20r%3D%223%22%20fill%3D%22%2317324d%22%2F%3E%3Cpath%20d%3D%22M27%2042c-2%204-2%208%200%2012%202-1%204-3%205-6%201%203%203%205%205%206%202-4%202-8%200-12Z%22%20fill%3D%22%23a94f45%22%2F%3E%3Cpath%20d%3D%22M30%2043c-1%203-1%205%202%208%203-3%203-5%202-8Z%22%20fill%3D%22%23c9942f%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E">
  <link rel="stylesheet" href="${baseUrl}/assets/styles.css">
  <script type="application/ld+json">${json(itemList)}</script>
  <script type="application/ld+json">${json(breadcrumb)}</script>
</head>
<body class="apprenticeship-page">
${headerHtml()}
<main id="top" class="path-page-main">
  <section class="path-hero" aria-labelledby="apprenticeship-heading">
    <div class="path-hero-inner">
      <div class="path-hero-copy">
        <nav class="path-breadcrumbs" aria-label="Breadcrumb"><a href="${baseUrl}/">Home</a><span aria-hidden="true">/</span><span>Apprenticeships</span></nav>
        <span class="section-kicker">EMPLOYER-DIRECT APPRENTICESHIPS</span>
        <h1 id="apprenticeship-heading">Data center apprenticeships</h1>
        <p>Verified openings for people building hands-on experience in electrical, mechanical, critical-facilities and data center operations work.</p>
        <p class="path-live-count"><strong>${apprenticeships.length} current opportunities</strong> · refreshed from employer career sites</p>
        <div class="path-hero-actions">
          <a class="btn btn-primary" href="#apprenticeships-list">View current apprenticeships</a>
          <a class="path-text-link" href="${baseUrl}/how-to-get-a-data-center-apprenticeship/">How apprenticeships work →</a>
        </div>
      </div>
      <aside class="path-proof-card" aria-labelledby="apprenticeship-proof-heading" data-apprenticeship-proof>
        <span class="utility-kicker">LIVE INVENTORY</span>
        <h2 id="apprenticeship-proof-heading">Current verified openings</h2>
        <div class="path-proof-grid">
          <div><strong>${apprenticeships.length}</strong><span>current apprenticeships</span></div>
          <div><strong>${employers.size}</strong><span>employers represented</span></div>
          <div><strong>${states.size}</strong><span>states represented</span></div>
          <div><strong>${noExperience.length}</strong><span>no-experience openings</span></div>
        </div>
        <p class="path-proof-note"><span aria-hidden="true"></span>Daily verified source refresh</p>
      </aside>
    </div>
  </section>

  ${recentHtml}

  <section class="path-board" id="current-openings" aria-labelledby="current-openings-heading">
    <div class="path-board-main">
      <div class="path-board-heading">
        <div><span class="section-kicker">CURRENT OPENINGS</span><h2 id="current-openings-heading">Browse verified apprenticeships</h2><p>Use the filters to narrow this employer-direct list.</p></div>
      </div>
      <section class="path-filter-card" data-apprenticeship-browser aria-labelledby="apprenticeship-filter-heading">
        <div class="path-filter-heading"><h3 id="apprenticeship-filter-heading">Filter openings</h3><button type="button" id="apprenticeship-reset">Reset filters</button></div>
        <div class="path-filter-grid">
          <label for="apprenticeship-state"><span>Location</span><select id="apprenticeship-state"><option value="">All locations</option>${stateOptions}</select></label>
          <label for="apprenticeship-focus"><span>Work area</span><select id="apprenticeship-focus"><option value="">All work areas</option>${focusOptions}</select></label>
          <label class="path-filter-check" for="apprenticeship-no-experience"><input id="apprenticeship-no-experience" type="checkbox"><span>Only show openings that do not require prior data center experience</span></label>
        </div>
        <p id="apprenticeship-results-summary" class="path-results-summary" aria-live="polite">Showing all ${apprenticeships.length} current apprenticeships.</p>
      </section>
      <section id="apprenticeships-list" class="job-list apprenticeship-job-list" aria-label="Data center apprenticeships" data-apprenticeship-results>
        ${apprenticeships.length ? apprenticeships.map(job => jobCard(job)).join('') : '<div class="empty-state">No verified apprenticeship openings are currently listed. Check trainee jobs and no-experience openings while new programs open.</div>'}
      </section>
      <p class="empty-state apprenticeship-empty" id="apprenticeship-empty" hidden>No apprenticeships match those filters. Reset a filter or browse every current opening.</p>
    </div>
    <aside class="path-rail" aria-label="Apprenticeship help">
      <section class="rail-card"><span class="utility-kicker">WHAT TO EXPECT</span><h3>Hands-on, paid learning.</h3><p>Programs can combine supervised work with electrical, mechanical, cooling, controls, cabling or operations training. Pay and requirements vary by employer.</p><a class="link-button" href="${baseUrl}/how-to-get-a-data-center-apprenticeship/">Read the apprenticeship guide →</a></section>
      <section class="rail-card"><span class="utility-kicker">OTHER STARTING POINTS</span><h3>Broaden your search.</h3><p>Some employers use trainee, technician I or work-based learning titles instead of apprentice.</p><a class="link-button" href="${baseUrl}/trainee-jobs/">Trainee jobs →</a><a class="link-button" href="${baseUrl}/no-experience/">No-experience jobs →</a><a class="link-button" href="${baseUrl}/entry-level/">Entry-level jobs →</a></section>
    </aside>
  </section>

  <section class="path-section path-faq-section" aria-labelledby="apprenticeship-eligibility-heading">
    <span class="section-kicker">BEFORE YOU APPLY</span>
    <h2 id="apprenticeship-eligibility-heading">Can I get a data center apprenticeship without experience?</h2>
    <p class="path-section-intro">Some openings accept first-time data center applicants. Employers may still require a diploma, driver's license, shift availability, basic trade knowledge, military technical experience or another qualification stated in the posting.</p>
    <div class="path-faq-grid">
      <article><h3>Are apprenticeships paid?</h3><p>Compensation varies by employer and program. We show pay only when the employer publishes it.</p></article>
      <article><h3>What work do apprentices perform?</h3><p>Programs may cover electrical systems, mechanical and cooling equipment, critical-facilities maintenance, operations or cabling.</p></article>
      <article><h3>What counts as an apprenticeship here?</h3><p>This page is reserved for roles employers explicitly call apprenticeships or apprentice positions.</p></article>
      <article><h3>How often are listings checked?</h3><p>The feed refreshes daily, and expired or unverifiable roles are removed. Confirm final details on the employer site.</p></article>
    </div>
  </section>
</main>
${footerHtml()}
<script defer src="${SCRIPT_PATH}"></script>
</body>
</html>`;

await mkdir('apprenticeships', { recursive: true });
await writeFile(PAGE_PATH, pageHtml);
await rm('apprenticeships/page', { recursive: true, force: true });

let sitemap = await readFile('sitemap.xml', 'utf8');
sitemap = sitemap.replace(/\s*<url><loc>https:\/\/[^<]+\/apprenticeships\/page\/\d+\/<\/loc>(?:<lastmod>[^<]+<\/lastmod>)?<\/url>/g, '');
await writeFile('sitemap.xml', sitemap);

let sharedStyles = await readFile(CSS_PATH, 'utf8');
if (!sharedStyles.includes(CSS_MARKER)) {
  sharedStyles = `${sharedStyles.trimEnd()}\n\n${PAGE_CSS}\n`;
  await writeFile(CSS_PATH, sharedStyles);
}

console.log(`Apprenticeship page aligned to the homepage system: ${apprenticeships.length} verified openings, ${employers.size} employers, ${states.size} states, ${recent.length} fresh roles featured.`);
