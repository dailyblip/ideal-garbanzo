import { access, readFile } from 'node:fs/promises';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const slugify = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'job';
const jobSlug = job => `${slugify(job.title)}-${slugify(job.company).slice(0, 32)}-${String(job.id || '').replace(/[^a-zA-Z0-9]/g, '').slice(-10)}`;
const errors = [];
const requireOk = (condition, message) => { if (!condition) errors.push(message); };
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const stateNames = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia'
};
const stateCodes = Object.keys(stateNames);
const stateNameToCode = new Map(Object.entries(stateNames).map(([code, name]) => [name.toLowerCase(), code]));

function statesFor(job) {
  const location = clean(job?.location);
  const found = new Set();
  for (const match of location.matchAll(new RegExp(`\\b(${stateCodes.join('|')})\\b`, 'g'))) found.add(match[1]);
  const lower = location.toLowerCase();
  for (const [name, code] of stateNameToCode) {
    if (new RegExp(`\\b${name.replace(/ /g, '\\s+')}\\b`, 'i').test(lower)) found.add(code);
  }
  return [...found];
}

function validDate(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

const domain = clean(await readFile('CNAME', 'utf8')).replace(/^https?:\/\//, '').replace(/\/$/, '');
const baseUrl = `https://${domain}`;
const jobs = JSON.parse(await readFile('data/jobs.json', 'utf8'));
const apprenticeships = jobs.filter(job => job.type === 'apprenticeship');
const employers = new Set(apprenticeships.map(job => clean(job.company)).filter(Boolean));
const states = new Set(apprenticeships.flatMap(statesFor));
const noExperience = apprenticeships.filter(job => job.experience === 'no-experience');
const recent = apprenticeships.filter(job => {
  const seen = validDate(job.firstSeenAt) ?? validDate(job.postedAt);
  return seen !== null && seen >= Date.now() - WEEK_MS;
});

const html = await readFile('apprenticeships/index.html', 'utf8');
const css = await readFile('assets/styles.css', 'utf8');
const browserJs = await readFile('assets/apprenticeship-listing.js', 'utf8');
const sitemap = await readFile('sitemap.xml', 'utf8');

requireOk(domain === 'datacentercareers.us', `Unexpected canonical domain: ${domain}`);
requireOk(html.includes('<title>Data Center Apprenticeships | Verified Employer Openings</title>'), 'Apprenticeship title is missing its verified-employer click signal.');
requireOk(html.includes('experience requirements') && html.includes('employer sites'), 'Apprenticeship meta description is missing qualification and employer-site language.');
requireOk(html.includes(`<link rel="stylesheet" href="${baseUrl}/assets/styles.css">`), 'Apprenticeship page must use the shared homepage stylesheet.');
requireOk(!html.includes('/assets/seo.css'), 'Apprenticeship page must not fall back to the detached SEO-page stylesheet.');
requireOk(!/\sstyle="/i.test(html), 'Apprenticeship page must not use inline style patches.');
requireOk((html.match(/<h1\b/gi) || []).length === 1, 'Apprenticeship page must contain exactly one h1.');
requireOk(html.includes('<body class="apprenticeship-page">'), 'Apprenticeship page is missing its shared-design body class.');

for (const marker of [
  'class="site-header"',
  'class="header-inner"',
  'class="brand"',
  'class="brand-mark"',
  'class="brand-copy"',
  'class="nav"',
  'class="header-cta"',
  'class="menu-button"',
  'class="path-hero-inner"',
  'class="path-board"'
]) requireOk(html.includes(marker), `Apprenticeship page is missing homepage-aligned structure: ${marker}.`);
for (const href of ['/jobs/', '/apprenticeships/', '/internships/', '/how-to-get-a-data-center-job/', '/career-events/', '/employers/']) {
  requireOk(html.includes(`href="${baseUrl}${href}"`), `Shared apprenticeship header is missing ${href}.`);
}

requireOk(html.includes('data-apprenticeship-proof'), 'Apprenticeship page is missing its live proof card.');
requireOk(html.includes(`<strong>${apprenticeships.length}</strong><span>current apprenticeships</span>`), 'Live apprenticeship count does not match the feed.');
requireOk(html.includes(`<strong>${employers.size}</strong><span>employers represented</span>`), 'Live employer count does not match the feed.');
requireOk(html.includes(`<strong>${states.size}</strong><span>states represented</span>`), 'Live state count does not match the feed.');
requireOk(html.includes(`<strong>${noExperience.length}</strong><span>no-experience openings</span>`), 'Live no-experience count does not match the feed.');
requireOk(html.includes('Daily verified source refresh'), 'Apprenticeship proof card is missing its refresh signal.');
requireOk(html.includes(`<strong>${apprenticeships.length} current opportunities</strong>`), 'Hero inventory count does not match the feed.');
requireOk(html.includes('href="#apprenticeships-list"'), 'Apprenticeship page is missing its jump-to-openings CTA.');

requireOk(html.includes('data-apprenticeship-browser'), 'Apprenticeship page is missing lightweight filters.');
for (const marker of ['id="apprenticeship-state"', 'id="apprenticeship-focus"', 'id="apprenticeship-no-experience"', 'id="apprenticeship-reset"', 'id="apprenticeship-results-summary"']) {
  requireOk(html.includes(marker), `Apprenticeship filters are missing ${marker}.`);
}
requireOk(html.includes('/assets/apprenticeship-listing.js'), 'Apprenticeship filter script is not loaded.');
requireOk(browserJs.includes("apprenticeship_filter"), 'Apprenticeship filter interaction is not measurable.');
requireOk(browserJs.includes('card.hidden = !show'), 'Apprenticeship browser does not hide nonmatching cards.');
requireOk(browserJs.includes("header?.classList.toggle('menu-open')"), 'Shared mobile navigation is not interactive on the apprenticeship page.');
requireOk(browserJs.includes("document.querySelectorAll('.nav a')"), 'Mobile navigation does not close after choosing a destination.');

requireOk(css.includes('/* apprenticeship front-page layout */'), 'Shared stylesheet is missing the apprenticeship component block.');
requireOk(css.includes('.path-section,.path-board{width:min(calc(100% - 56px),var(--content))'), 'Apprenticeship content does not share the homepage centered width contract.');
requireOk(css.includes('.path-hero h1{') && css.includes('font-size:clamp(48px,5vw,68px)'), 'Desktop apprenticeship heading scale is not aligned to the homepage.');
requireOk(css.includes('.path-hero h1{font-size:40px'), 'Mobile apprenticeship heading is not locked near 40px.');
requireOk(css.includes('.path-filter-grid select{font-size:16px'), 'Mobile select text must remain 16px to prevent iPhone zoom.');
requireOk(css.includes('min-height:44px'), 'Apprenticeship controls do not preserve 44px touch targets.');
requireOk(css.includes('overflow-wrap:anywhere'), 'Long apprenticeship locations are not protected against horizontal overflow.');
requireOk(css.includes('@media(max-width:760px)'), 'Apprenticeship layout is missing its independent mobile composition.');

const cardCount = (html.match(/data-apprenticeship-card(?:\s|>)/g) || []).length;
const featureCount = (html.match(/data-apprenticeship-feature(?:\s|>)/g) || []).length;
const applyCount = (html.match(/class="apply-link apprenticeship-apply"/g) || []).length;
requireOk(cardCount === apprenticeships.length, `Rendered ${cardCount} filterable apprenticeship cards for ${apprenticeships.length} feed roles.`);
requireOk(featureCount === Math.min(3, recent.length), `Rendered ${featureCount} fresh cards; expected ${Math.min(3, recent.length)}.`);
requireOk(applyCount === apprenticeships.filter(job => /^https:\/\//i.test(clean(job.sourceUrl))).length, 'Direct employer apply links do not match valid apprenticeship sources.');
for (const job of apprenticeships) {
  requireOk(html.includes(`${baseUrl}/jobs/${jobSlug(job)}/`), `Apprenticeship page is missing ${job.id}.`);
}

const recentMatch = html.match(/data-new-this-week-count="(\d+)"/);
if (recent.length) {
  requireOk(Number(recentMatch?.[1]) === Math.min(3, recent.length), `Recently added section shows ${recentMatch?.[1] ?? 0}; expected ${Math.min(3, recent.length)}.`);
  requireOk(html.includes('Recently added apprenticeships'), 'Recent apprenticeship section is missing its clear heading.');
} else {
  requireOk(!recentMatch, 'Recent apprenticeship section must not claim fresh inventory when none was discovered in the past seven days.');
}

for (const text of [
  'Can I get a data center apprenticeship without experience?',
  'Are apprenticeships paid?',
  'What work do apprentices perform?',
  'What counts as an apprenticeship here?',
  'How often are listings checked?'
]) requireOk(html.includes(text), `Apprenticeship eligibility content is missing: ${text}`);

const schemas = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)].map(match => {
  try { return JSON.parse(match[1]); } catch { return null; }
});
const itemList = schemas.find(schema => schema?.['@type'] === 'ItemList');
const breadcrumb = schemas.find(schema => schema?.['@type'] === 'BreadcrumbList');
requireOk(itemList?.numberOfItems === apprenticeships.length, 'Apprenticeship ItemList does not cover every current apprenticeship.');
requireOk(itemList?.itemListElement?.length === apprenticeships.length, 'Apprenticeship ItemList entries do not match visible inventory.');
requireOk(breadcrumb?.itemListElement?.length === 2, 'Apprenticeship page is missing two-level BreadcrumbList structured data.');
requireOk(breadcrumb?.itemListElement?.[1]?.item === `${baseUrl}/apprenticeships/`, 'BreadcrumbList does not point to the canonical apprenticeship page.');
requireOk(!/\/apprenticeships\/page\/\d+\//.test(sitemap), 'Sitemap must not retain paginated apprenticeship URLs when all openings are on one page.');
let pageDirExists = true;
try { await access('apprenticeships/page'); } catch { pageDirExists = false; }
requireOk(!pageDirExists, 'Generated apprenticeship pagination directory should be removed.');

if (errors.length) {
  console.error('Apprenticeship landing validation failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Apprenticeship visual and functional QA passed: shared header/styles, ${apprenticeships.length} roles, ${employers.size} employers, ${states.size} states, ${noExperience.length} no-experience openings, ${Math.min(3, recent.length)} recent cards, responsive controls and no pagination.`);
