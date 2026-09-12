import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';

const html = await readFile('index.html', 'utf8');
const css = await readFile('assets/styles.css', 'utf8');
const heroAsset = await readFile('hero.jpg');
const mailingListJs = await readFile('assets/mailing-list.js', 'utf8');
const employerHtml = await readFile('employers/index.html', 'utf8');
const employerProducts = JSON.parse(await readFile('data/employer-products.json', 'utf8'));
const errors = [];

const requireMatch = (condition, message) => {
  if (!condition) errors.push(message);
};

const textContent = html
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&middot;|·/g, '·')
  .replace(/\s+/g, ' ')
  .trim();

const approvedCopy = [
  'SKILLED WORK · MODERN INFRASTRUCTURE · REAL OPPORTUNITY',
  'Build your future in data centers.',
  'Real openings for interns, apprentices, first-time applicants and workers ready for their next step.'
];
for (const copy of approvedCopy) requireMatch(textContent.includes(copy), `Approved hero copy changed: ${copy}`);

const stylesheetLinks = [...html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi)];
requireMatch(stylesheetLinks.length === 1, `Homepage must load exactly one stylesheet; found ${stylesheetLinks.length}.`);
requireMatch(stylesheetLinks.length === 1 && /href=["']assets\/styles\.css["']/i.test(stylesheetLinks[0][0]), 'Homepage stylesheet must be assets/styles.css.');
requireMatch(!/<style\b/i.test(html), 'Inline <style> blocks are not allowed on the homepage.');
requireMatch(!/\sstyle\s*=/i.test(html), 'Inline style attributes are not allowed on the homepage.');
requireMatch(!/hero-overrides\.css|home-tools\.css/i.test(html), 'Legacy homepage override stylesheets must not be referenced.');

const heroFigure = html.match(/<figure class=["']hero-media["'][\s\S]*?<\/figure>/i)?.[0] || '';
const heroImage = heroFigure.match(/<img\b[^>]*>/i)?.[0] || '';
requireMatch(Boolean(heroImage), 'hero.jpg must remain integrated inside .hero-media.');
requireMatch(/src=["']\/hero\.jpg\?v=[0-9a-f]{12}["']/i.test(heroImage), 'Homepage hero must use the root-absolute, cache-busted hero.jpg URL.');
requireMatch(/width=["']1536["']/i.test(heroImage) && /height=["']1024["']/i.test(heroImage), 'Homepage hero image dimensions must remain explicit to prevent layout shift.');
requireMatch(/loading=["']eager["']/i.test(heroImage), 'Homepage hero image must load eagerly.');
requireMatch(/fetchpriority=["']high["']/i.test(heroImage), 'Homepage hero image must retain high fetch priority.');
requireMatch(/decoding=["']async["']/i.test(heroImage), 'Homepage hero image must retain asynchronous decoding.');
requireMatch(heroAsset.length >= 100000, `hero.jpg is unexpectedly small (${heroAsset.length} bytes).`);
requireMatch(heroAsset[0] === 0xff && heroAsset[1] === 0xd8 && heroAsset[heroAsset.length - 2] === 0xff && heroAsset[heroAsset.length - 1] === 0xd9, 'hero.jpg does not have intact JPEG start/end markers.');

requireMatch(/body\{[^}]*background:#fff[^}]*overflow-x:hidden[^}]*\}/i.test(css), 'Homepage must keep a white background and prevent horizontal overflow.');
requireMatch(/--navy:#17324d/i.test(css), 'Approved navy token is missing.');
requireMatch(/--red:#a94f45/i.test(css), 'Approved muted brick red token is missing.');
requireMatch(/--gold:#c9942f/i.test(css), 'Approved restrained workwear gold token is missing.');
requireMatch(/\.hero-grid\{[^}]*max-width:var\(--page\)[^}]*margin:0 auto[^}]*position:relative[^}]*overflow:hidden/i.test(css), 'Desktop hero must remain centered and integrated in one container.');
requireMatch(/\.hero-media\{[^}]*position:absolute[^}]*inset:0/i.test(css), 'Desktop hero image must remain integrated in the hero container.');
const desktopHeroImageRule = css.match(/\.hero-media img\{([^}]*)\}/i)?.[1] || '';
requireMatch(/object-fit:contain/i.test(desktopHeroImageRule), 'Desktop hero image must remain fully contained.');
requireMatch(/object-position:right top/i.test(desktopHeroImageRule), 'Desktop hero image must remain aligned to the right side of the composition.');
requireMatch(/\.hero-media:before\{[^}]*linear-gradient\(90deg/i.test(css), 'Desktop hero left-edge fade is missing.');
requireMatch(/\.hero-copy\{[^}]*width:min\(760px,56%\)/i.test(css), 'Desktop hero copy/image balance changed.');

const mobileStart = css.indexOf('@media(max-width:760px)');
requireMatch(mobileStart >= 0, 'Mobile breakpoint at 760px is missing.');
const mobileCss = mobileStart >= 0 ? css.slice(mobileStart) : '';
requireMatch(/\.hero-grid\{[^}]*display:flex[^}]*flex-direction:column/i.test(mobileCss), 'Mobile hero must stack independently.');
requireMatch(/\.hero h1\{[^}]*font-size:40px/i.test(mobileCss), 'Mobile hero headline must remain approximately 40px.');
requireMatch(/\.hero-search\{[^}]*grid-template-columns:1fr/i.test(mobileCss), 'Mobile search fields must stack.');
requireMatch(/\.hero-search input,\.hero-search select\{[^}]*font-size:16px/i.test(mobileCss), 'Mobile hero form controls must use 16px text.');
requireMatch(/\.hero-search \.btn\{[^}]*width:100%[^}]*min-height:48px/i.test(mobileCss), 'Mobile search button must remain full-width with a large touch target.');
requireMatch(/\.hero-media\{[^}]*position:relative[^}]*order:2/i.test(mobileCss), 'Mobile hero image must remain a clean block below search.');
requireMatch(/\.apply-link\{[^}]*min-height:44px/i.test(mobileCss), 'Mobile job actions must keep 44px+ touch targets.');
requireMatch(/\.employer-cta\{[^}]*min-height:44px/i.test(mobileCss), 'Mobile employer CTA must keep a 44px+ touch target.');
requireMatch(/\.alert-strip input,\.alert-strip select\{[^}]*font-size:16px[^}]*min-height:46px/i.test(mobileCss), 'Mobile alert controls must remain readable and touch-friendly.');

// Keep the public job stream focused on the audience mission. Senior-only
// "career ceiling" cards must not be injected into the early-career feed.
requireMatch(!/career-motivators|career ceiling|career-ceiling/i.test(mailingListJs), 'Mailing-list code must not inject senior career-ceiling content into the job feed.');

// Employer promotion examples must follow the same compensation rule as the
// candidate feed: show verified pay when present and otherwise leave it blank.
requireMatch(!/Pay not listed/i.test(employerHtml), 'Employer promotion examples must leave unavailable compensation blank.');
requireMatch(!/See what employers are buying\.?/i.test(employerHtml), 'Employer promotion page must not imply purchases before checkout is active.');
const checkoutEnabled = employerProducts?.checkout?.enabled === true || employerProducts?.featuredJob?.checkoutEnabled === true;
if (!checkoutEnabled) {
  requireMatch(/Online payment is not active yet/i.test(employerHtml), 'Disabled employer checkout must be disclosed clearly on the employer page.');
  const externalPlanLinks = [...employerHtml.matchAll(/<a\b[^>]*class=["'][^"']*plan-button[^"']*["'][^>]*href=["']https?:\/\//gi)];
  requireMatch(externalPlanLinks.length === 0, 'Employer purchase buttons must not point to external checkout while checkout is disabled.');
}

for (const forbidden of [
  'assets/hero-overrides.css',
  'assets/home-tools.css',
  'assets/career-motivators.js',
  'data/career-motivator-candidates.json',
  'data/career-motivators.json',
  'scripts/refresh-career-motivators.mjs',
  'scripts/validate-career-motivators.mjs',
  '.github/workflows/career-motivators.yml'
]) {
  try {
    await access(forbidden, constants.F_OK);
    errors.push(`Forbidden homepage drift artifact must not exist: ${forbidden}`);
  } catch {}
}

if (errors.length) {
  console.error('Homepage contract validation failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Homepage visual, hero-image integrity, mobile, accessibility, feed-focus and employer-promotion contract passed (${heroAsset.length} byte hero.jpg).`);
