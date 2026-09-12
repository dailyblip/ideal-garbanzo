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
const css = await readFile('assets/seo.css', 'utf8');
const browserJs = await readFile('assets/apprenticeship-listing.js', 'utf8');
const sitemap = await readFile('sitemap.xml', 'utf8');

requireOk(domain === 'datacentercareers.us', `Unexpected canonical domain: ${domain}`);
requireOk(html.includes('<title>Data Center Apprenticeships | Verified Employer Openings</title>'), 'Apprenticeship title is missing its verified-employer click signal.');
requireOk(html.includes('apply through verified employer listings'), 'Apprenticeship meta description is missing its verified application benefit.');
requireOk(html.includes('data-apprenticeship-proof'), 'Apprenticeship page is missing its live proof bar.');
requireOk(html.includes(`<strong>${apprenticeships.length}</strong><span>current apprenticeships</span>`), 'Live apprenticeship count does not match the feed.');
requireOk(html.includes(`<strong>${employers.size}</strong><span>employers represented</span>`), 'Live employer count does not match the feed.');
requireOk(html.includes(`<strong>${states.size}</strong><span>states represented</span>`), 'Live state count does not match the feed.');
requireOk(html.includes(`<strong>${noExperience.length}</strong><span>no-experience openings</span>`), 'Live no-experience count does not match the feed.');
requireOk(html.includes('<strong>Daily</strong><span>verified source refresh</span>'), 'Apprenticeship proof bar is missing its source-refresh signal.');
requireOk(html.includes('href="#apprenticeships-list"'), 'Apprenticeship page is missing its jump-to-openings CTA.');

requireOk(html.includes('data-apprenticeship-browser'), 'Apprenticeship page is missing lightweight filters.');
for (const marker of ['id="apprenticeship-state"', 'id="apprenticeship-focus"', 'id="apprenticeship-no-experience"', 'id="apprenticeship-reset"', 'id="apprenticeship-results-summary"']) {
  requireOk(html.includes(marker), `Apprenticeship filters are missing ${marker}.`);
}
requireOk(html.includes('/assets/apprenticeship-listing.js'), 'Apprenticeship filter script is not loaded.');
requireOk(/min-height:44px/.test(css), 'Apprenticeship controls do not preserve 44px touch targets.');
requireOk(css.includes('/* apprenticeship landing conversion UI */'), 'Apprenticeship responsive styles were not applied.');
requireOk(browserJs.includes("apprenticeship_filter"), 'Apprenticeship filter interaction is not measurable.');
requireOk(browserJs.includes("card.hidden = !show"), 'Apprenticeship browser does not hide nonmatching cards.');

const cardCount = (html.match(/data-apprenticeship-card(?:\s|>)/g) || []).length;
const trustCount = (html.match(/>Verified employer listing<\/p>/g) || []).length;
const ctaCount = (html.match(/>See requirements &amp; apply →<\/a>/g) || []).length;
requireOk(cardCount === apprenticeships.length, `Rendered ${cardCount} apprenticeship cards for ${apprenticeships.length} feed roles.`);
requireOk(trustCount === apprenticeships.length, `Only ${trustCount}/${apprenticeships.length} cards show verified-employer trust text.`);
requireOk(ctaCount >= apprenticeships.length, `Only ${ctaCount}/${apprenticeships.length} cards expose the requirements/apply CTA.`);
for (const job of apprenticeships) {
  requireOk(html.includes(`${baseUrl}/jobs/${jobSlug(job)}/`), `Apprenticeship page is missing ${job.id}.`);
}

const expectedRecentShown = Math.min(5, recent.length);
const recentMatch = html.match(/data-new-this-week-count="(\d+)"/);
if (expectedRecentShown) {
  requireOk(Number(recentMatch?.[1]) === expectedRecentShown, `New-this-week section shows ${recentMatch?.[1] ?? 0}; expected ${expectedRecentShown}.`);
  requireOk(html.includes('New apprenticeships this week'), 'Recent apprenticeship section is missing its clear heading.');
} else {
  requireOk(!recentMatch, 'New-this-week section must not claim fresh inventory when none was discovered in the past seven days.');
}

for (const text of [
  'Can I get a data center apprenticeship without experience?',
  'Are data center apprenticeships paid?',
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
requireOk(!/\/apprenticeships\/page\/\d+\//.test(sitemap), 'Sitemap must not retain paginated apprenticeship URLs when all filterable openings are on one page.');
let pageDirExists = true;
try { await access('apprenticeships/page'); } catch { pageDirExists = false; }
requireOk(!pageDirExists, 'Generated apprenticeship pagination directory should be removed so filters cover the complete inventory.');

if (errors.length) {
  console.error('Apprenticeship landing validation failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Apprenticeship landing validation passed: ${apprenticeships.length} verified roles, ${employers.size} employers, ${states.size} states, ${noExperience.length} no-experience openings, ${expectedRecentShown} fresh roles featured, filters/cards/breadcrumbs responsive and aligned.`);
