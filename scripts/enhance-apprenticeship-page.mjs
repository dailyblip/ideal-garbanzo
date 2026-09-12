import { readFile, writeFile, rm } from 'node:fs/promises';

const PAGE_PATH = 'apprenticeships/index.html';
const CSS_PATH = 'assets/seo.css';
const SCRIPT_PATH = '/assets/apprenticeship-listing.js';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const CSS_MARKER = '/* apprenticeship landing conversion UI */';

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
if (!baseDomain) throw new Error('CNAME is required to enhance the apprenticeship page.');
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

function apprenticeshipCard(job) {
  const url = `${baseUrl}/jobs/${jobSlug(job)}/`;
  const pay = displayPay(job.pay);
  const states = statesFor(job);
  const focus = focusFor(job);
  const tags = [...new Set((job.tags || []).map(clean).filter(Boolean))]
    .filter(tag => !/^(?:apprenticeship|no experience needed|0–2 years|2–5 years)$/i.test(tag));
  return `<article class="seo-job-card apprenticeship-job-card" data-apprenticeship-card data-states="${esc(states.join(' '))}" data-focus="${esc(focus.join(' '))}" data-experience="${esc(job.experience)}">
    <div class="seo-job-main">
      <span class="seo-kicker">VERIFIED APPRENTICESHIP</span>
      <h2><a href="${url}">${esc(job.title)}</a></h2>
      <p class="seo-meta"><strong>${esc(job.company)}</strong> · ${esc(job.location)}</p>
      <p class="apprenticeship-trust">Verified employer listing</p>
      <div class="seo-tags"><span>${esc(experienceText(job))}</span>${tags.map(tag => `<span>${esc(tag)}</span>`).join('')}</div>
      ${pay ? `<p class="seo-pay">${esc(pay)}</p>` : ''}
    </div>
    <div class="seo-job-side"><span>${esc(postedLabel(job.postedHours))}</span><a class="apprenticeship-card-cta" href="${url}">See requirements &amp; apply →</a></div>
  </article>`;
}

function featureCard(job) {
  const url = `${baseUrl}/jobs/${jobSlug(job)}/`;
  const pay = displayPay(job.pay);
  return `<article class="apprenticeship-feature-card">
    <span class="seo-kicker">NEW TO THE VERIFIED FEED</span>
    <h3><a href="${url}">${esc(job.title)}</a></h3>
    <p><strong>${esc(job.company)}</strong> · ${esc(job.location)}</p>
    <div class="seo-tags"><span>${esc(experienceText(job))}</span></div>
    ${pay ? `<p class="seo-pay">${esc(pay)}</p>` : ''}
    <a class="apprenticeship-feature-link" href="${url}">See requirements &amp; apply →</a>
  </article>`;
}

function proofHtml() {
  const employers = new Set(apprenticeships.map(job => clean(job.company)).filter(Boolean));
  const states = new Set(apprenticeships.flatMap(statesFor));
  const noExperienceCount = apprenticeships.filter(job => job.experience === 'no-experience').length;
  return `<section class="apprenticeship-proof" aria-labelledby="apprenticeship-proof-heading" data-apprenticeship-proof>
    <span class="seo-kicker">CURRENT VERIFIED INVENTORY</span>
    <h2 id="apprenticeship-proof-heading">Current apprenticeships from employer career sites</h2>
    <p>See real apprenticeship openings, the qualifications employers publish and a clear route to the original application.</p>
    <div class="guide-stats apprenticeship-proof-stats">
      <div><strong>${apprenticeships.length}</strong><span>current apprenticeships</span></div>
      <div><strong>${employers.size}</strong><span>employers represented</span></div>
      <div><strong>${states.size}</strong><span>states represented</span></div>
      <div><strong>${noExperienceCount}</strong><span>no-experience openings</span></div>
      <div><strong>Daily</strong><span>verified source refresh</span></div>
    </div>
    <div class="guide-actions"><a class="seo-apply" href="#apprenticeships-list">View current apprenticeships ↓</a></div>
  </section>`;
}

function newThisWeekHtml() {
  const cutoff = Date.now() - WEEK_MS;
  const recent = apprenticeships
    .filter(job => {
      const seen = discoveryDate(job);
      return seen !== null && seen >= cutoff;
    })
    .slice(0, 5);
  if (!recent.length) return '';
  return `<section class="apprenticeship-new" aria-labelledby="apprenticeship-new-heading" data-new-this-week-count="${recent.length}">
    <div class="apprenticeship-section-heading"><div><span class="seo-kicker">FRESH OPPORTUNITIES</span><h2 id="apprenticeship-new-heading">New apprenticeships this week</h2><p>Added to our verified feed during the past seven days.</p></div><a href="#apprenticeships-list">See every current opening ↓</a></div>
    <div class="apprenticeship-new-grid">${recent.map(featureCard).join('')}</div>
  </section>`;
}

function filterHtml() {
  const states = [...new Set(apprenticeships.flatMap(statesFor))].sort((a, b) => stateNames[a].localeCompare(stateNames[b]));
  const focusCounts = new Map();
  for (const job of apprenticeships) {
    for (const focus of focusFor(job)) focusCounts.set(focus, (focusCounts.get(focus) || 0) + 1);
  }
  const focusOptions = Object.keys(focusLabels)
    .filter(value => focusCounts.get(value))
    .map(value => `<option value="${value}">${esc(focusLabels[value])} (${focusCounts.get(value)})</option>`)
    .join('');
  const stateOptions = states
    .map(code => `<option value="${code}">${esc(stateNames[code])} (${code})</option>`)
    .join('');
  return `<section class="apprenticeship-browser" data-apprenticeship-browser aria-labelledby="apprenticeship-filter-heading">
    <div class="apprenticeship-browser-head"><div><span class="seo-kicker">NARROW THE LIST</span><h2 id="apprenticeship-filter-heading">Filter current apprenticeships</h2></div><button type="button" id="apprenticeship-reset">Reset filters</button></div>
    <div class="apprenticeship-filter-grid">
      <label for="apprenticeship-state"><span>Location</span><select id="apprenticeship-state"><option value="">All locations</option>${stateOptions}</select></label>
      <label for="apprenticeship-focus"><span>Work area</span><select id="apprenticeship-focus"><option value="">All work areas</option>${focusOptions}</select></label>
      <label class="apprenticeship-checkbox" for="apprenticeship-no-experience"><input id="apprenticeship-no-experience" type="checkbox"><span>Only show openings that do not require prior data center experience</span></label>
    </div>
    <p id="apprenticeship-results-summary" class="apprenticeship-results-summary" aria-live="polite">Showing all ${apprenticeships.length} current apprenticeships.</p>
  </section>`;
}

function eligibilityHtml() {
  return `<section class="guide-section apprenticeship-eligibility" aria-labelledby="apprenticeship-eligibility-heading">
    <span class="seo-kicker">BEFORE YOU APPLY</span>
    <h2 id="apprenticeship-eligibility-heading">Can I get a data center apprenticeship without experience?</h2>
    <p>Some apprenticeship openings accept first-time data center applicants. Employers may still require a diploma, a driver's license, shift availability, basic trade knowledge, military technical experience or another qualification stated in the posting. We use the employer's published requirements and only use “no experience required” when the source supports it.</p>
    <div class="apprenticeship-faq-grid">
      <article><h3>Are data center apprenticeships paid?</h3><p>Compensation varies by employer and program. We display pay only when the employer publishes it, so check the original listing for wages, benefits and schedule details.</p></article>
      <article><h3>What work do apprentices perform?</h3><p>Current programs can involve electrical systems, mechanical and cooling equipment, critical-facilities maintenance, operations, cabling and other hands-on infrastructure work.</p></article>
      <article><h3>What counts as an apprenticeship here?</h3><p>This page is reserved for roles employers explicitly call apprenticeships or apprentice positions. Trainee and development programs remain on the separate trainee-jobs page.</p></article>
      <article><h3>How often are listings checked?</h3><p>The main feed refreshes daily, priority sources are often checked more frequently, and expired or unverifiable jobs are removed. Confirm final details on the employer site before applying.</p></article>
    </div>
    <div class="guide-actions"><a class="guide-secondary" href="${baseUrl}/how-to-get-a-data-center-apprenticeship/">How to get a data center apprenticeship →</a><a class="guide-secondary" href="${baseUrl}/trainee-jobs/">Compare trainee jobs →</a></div>
  </section>`;
}

let html = await readFile(PAGE_PATH, 'utf8');
html = html.replace(/<title>[\s\S]*?<\/title>/i, '<title>Data Center Apprenticeships | Verified Employer Openings</title>');
html = html.replace(/<meta name="description" content="[^"]*">/i, '<meta name="description" content="Browse current data center apprenticeships in electrical, mechanical, critical facilities and operations. See requirements and apply through verified employer listings.">');
html = html.replace(/<meta property="og:title" content="[^"]*">/i, '<meta property="og:title" content="Data Center Apprenticeships | Verified Employer Openings">');
html = html.replace(/<meta property="og:description" content="[^"]*">/i, '<meta property="og:description" content="Browse current data center apprenticeships, compare experience requirements and apply through verified employer listings.">');
html = html.replace(/<meta name="twitter:title" content="[^"]*">/i, '<meta name="twitter:title" content="Data Center Apprenticeships | Verified Employer Openings">');
html = html.replace(/<meta name="twitter:description" content="[^"]*">/i, '<meta name="twitter:description" content="Browse current data center apprenticeships, compare experience requirements and apply through verified employer listings.">');

const schemaMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
if (!schemaMatch) throw new Error('Apprenticeship page is missing ItemList JSON-LD.');
let itemList;
try { itemList = JSON.parse(schemaMatch[1]); }
catch { throw new Error('Apprenticeship page ItemList JSON-LD is invalid.'); }
if (itemList?.['@type'] !== 'ItemList') throw new Error('Apprenticeship page first JSON-LD block must be ItemList.');
itemList.numberOfItems = apprenticeships.length;
itemList.itemListElement = apprenticeships.map((job, index) => ({
  '@type': 'ListItem',
  position: index + 1,
  url: `${baseUrl}/jobs/${jobSlug(job)}/`,
  name: job.title
}));
html = html.replace(schemaMatch[0], `<script type="application/ld+json">${json(itemList)}</script>`);

if (!html.includes('"@type":"BreadcrumbList"')) {
  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${baseUrl}/` },
      { '@type': 'ListItem', position: 2, name: 'Data center apprenticeships', item: `${baseUrl}/apprenticeships/` }
    ]
  };
  html = html.replace(/(<script type="application\/ld\+json">[\s\S]*?<\/script>)/i, `$1\n<script type="application/ld+json">${json(breadcrumb)}</script>`);
}

const proofPattern = /<section class="(?:guide-section|apprenticeship-proof)" aria-labelledby="apprenticeship-proof-heading"[\s\S]*?<\/section>/i;
if (!proofPattern.test(html)) throw new Error('Apprenticeship page is missing the proof section marker.');
html = html.replace(proofPattern, proofHtml());

const listPattern = /<section id="apprenticeships-list" class="seo-list"[^>]*>[\s\S]*?<\/section>/i;
if (!listPattern.test(html)) throw new Error('Apprenticeship page is missing its opening list.');
const allOpenings = `<section id="apprenticeships-list" class="seo-list" aria-label="Data center apprenticeships" data-apprenticeship-results>${apprenticeships.map(apprenticeshipCard).join('') || '<p>No verified apprenticeship openings are currently listed. Check trainee jobs and no-experience openings while new programs open.</p>'}</section><p class="apprenticeship-empty" id="apprenticeship-empty" hidden>No apprenticeships match those filters. Reset a filter or browse every current opening.</p>`;
html = html.replace(listPattern, `${newThisWeekHtml()}${filterHtml()}${allOpenings}`);
html = html.replace(/<nav class="seo-pagination"[\s\S]*?<\/nav>/i, '');

const contextPattern = /<section class="guide-section" aria-labelledby="apprenticeship-search-heading">[\s\S]*?<\/section>/i;
if (!contextPattern.test(html)) throw new Error('Apprenticeship page is missing its eligibility context section.');
html = html.replace(contextPattern, eligibilityHtml());

if (!html.includes(SCRIPT_PATH)) html = html.replace('</body>', `<script defer src="${SCRIPT_PATH}"></script></body>`);
await writeFile(PAGE_PATH, html);
await rm('apprenticeships/page', { recursive: true, force: true });

let sitemap = await readFile('sitemap.xml', 'utf8');
sitemap = sitemap.replace(/\s*<url><loc>https:\/\/[^<]+\/apprenticeships\/page\/\d+\/<\/loc>(?:<lastmod>[^<]+<\/lastmod>)?<\/url>/g, '');
await writeFile('sitemap.xml', sitemap);

const css = `
${CSS_MARKER}
.apprenticeship-proof{padding:26px;border:1px solid var(--line);border-radius:12px;background:var(--soft);margin:0 0 22px}.apprenticeship-proof h2,.apprenticeship-new h2,.apprenticeship-browser h2{margin:6px 0 8px;color:var(--navy);font-size:clamp(25px,3.6vw,36px);line-height:1.05;letter-spacing:-.025em}.apprenticeship-proof>p,.apprenticeship-new p{margin:0;color:#56636e;max-width:820px}.apprenticeship-proof-stats{grid-template-columns:repeat(5,minmax(0,1fr))}.apprenticeship-new{padding:28px 0;border-bottom:1px solid var(--line);margin-bottom:24px}.apprenticeship-section-heading{display:flex;justify-content:space-between;gap:24px;align-items:flex-end;margin-bottom:16px}.apprenticeship-section-heading>a{color:var(--navy);font-weight:850;font-size:13px}.apprenticeship-new-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.apprenticeship-feature-card{padding:20px;border:1px solid var(--line);border-radius:10px;background:#fff}.apprenticeship-feature-card h3{margin:5px 0;color:var(--navy);font-size:19px;line-height:1.25}.apprenticeship-feature-card h3 a:hover{color:var(--red)}.apprenticeship-feature-card>p:not(.seo-pay){margin:0;color:var(--muted);font-size:13px}.apprenticeship-feature-link{display:inline-flex;margin-top:14px;color:var(--navy);font-weight:850;font-size:13px}.apprenticeship-browser{padding:22px;border:1px solid var(--line);border-radius:12px;background:#fff;margin-bottom:16px}.apprenticeship-browser-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}.apprenticeship-browser-head button{min-height:44px;border:1px solid #bdc7cf;border-radius:7px;background:#fff;color:var(--navy);font:inherit;font-weight:800;padding:9px 13px;cursor:pointer}.apprenticeship-filter-grid{display:grid;grid-template-columns:1fr 1fr 1.35fr;gap:12px;margin-top:16px;align-items:end}.apprenticeship-filter-grid label{display:flex;flex-direction:column;gap:6px;color:#52606b;font-size:12px;font-weight:800}.apprenticeship-filter-grid select{width:100%;min-height:44px;border:1px solid #bdc7cf;border-radius:7px;background:#fff;color:var(--ink);font:inherit;font-size:16px;padding:9px 36px 9px 11px}.apprenticeship-checkbox{min-height:44px;flex-direction:row!important;align-items:center;padding:8px 11px;border:1px solid #bdc7cf;border-radius:7px;background:var(--soft);cursor:pointer}.apprenticeship-checkbox input{width:20px;height:20px;flex:0 0 auto}.apprenticeship-results-summary{margin:14px 0 0;color:var(--muted);font-size:13px}.apprenticeship-empty{padding:24px;border:1px dashed #bdc7cf;border-radius:10px;color:var(--muted);text-align:center}.apprenticeship-trust{margin:9px 0 0;color:var(--green);font-size:12px;font-weight:850}.apprenticeship-card-cta{max-width:190px;text-align:right}.apprenticeship-job-card[hidden]{display:none}.apprenticeship-faq-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:20px}.apprenticeship-faq-grid article{padding:20px;border:1px solid var(--line);border-radius:10px;background:var(--soft)}.apprenticeship-faq-grid h3{margin:0 0 8px;color:var(--navy);font-size:18px}.apprenticeship-faq-grid p{margin:0;color:#596671;font-size:14px}
@media(max-width:900px){.apprenticeship-proof-stats{grid-template-columns:repeat(3,minmax(0,1fr))}.apprenticeship-filter-grid{grid-template-columns:1fr 1fr}.apprenticeship-checkbox{grid-column:1/-1}.apprenticeship-new-grid{grid-template-columns:1fr}}
@media(max-width:600px){.apprenticeship-proof{padding:20px}.apprenticeship-proof-stats,.apprenticeship-filter-grid,.apprenticeship-faq-grid{grid-template-columns:1fr}.apprenticeship-checkbox{grid-column:auto}.apprenticeship-section-heading,.apprenticeship-browser-head{align-items:stretch;flex-direction:column}.apprenticeship-browser-head button,.apprenticeship-proof .seo-apply{width:100%;justify-content:center}.apprenticeship-card-cta{text-align:left;max-width:none}.apprenticeship-feature-link{min-height:44px;align-items:center}}
`;
let seoCss = await readFile(CSS_PATH, 'utf8');
if (!seoCss.includes(CSS_MARKER)) {
  seoCss = `${seoCss.trimEnd()}\n${css}`;
  await writeFile(CSS_PATH, seoCss);
}

const recentCount = apprenticeships.filter(job => {
  const seen = discoveryDate(job);
  return seen !== null && seen >= Date.now() - WEEK_MS;
}).length;
console.log(`Apprenticeship landing enhanced: ${apprenticeships.length} verified openings, ${new Set(apprenticeships.map(job => job.company)).size} employers, ${new Set(apprenticeships.flatMap(statesFor)).size} states, ${recentCount} added in the past week.`);
