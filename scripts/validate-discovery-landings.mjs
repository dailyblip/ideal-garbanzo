import { access, readFile } from 'node:fs/promises';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const slugify = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'company';
const domain = clean(await readFile('CNAME', 'utf8')).replace(/^https?:\/\//, '').replace(/\/$/, '');
const baseUrl = `https://${domain}`;
const jobs = JSON.parse(await readFile('data/jobs.json', 'utf8'));
const sitemap = await readFile('sitemap.xml', 'utf8');
const failures = [];

const regions = [
  'northern-virginia-mid-atlantic',
  'texas',
  'southwest',
  'midwest',
  'southeast',
  'northeast',
  'west'
];
const priorityCompanies = [
  'Meta', 'Google', 'Microsoft', 'Amazon Web Services', 'Oracle', 'Equinix', 'Digital Realty',
  'QTS Data Centers', 'Vantage Data Centers', 'CyrusOne', 'STACK Infrastructure',
  'Aligned Data Centers', 'NTT Global Data Centers'
];

async function requirePage(path, canonical, label) {
  try {
    await access(path);
  } catch {
    failures.push(`${label}: missing ${path}`);
    return;
  }
  const html = await readFile(path, 'utf8');
  if (!/<h1\b/i.test(html)) failures.push(`${label}: missing h1`);
  if (/name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(html)) failures.push(`${label}: contains noindex`);
  if (!html.includes(`<link rel="canonical" href="${canonical}">`)) failures.push(`${label}: canonical must be ${canonical}`);
  if (!sitemap.includes(`<loc>${canonical}</loc>`)) failures.push(`${label}: canonical is missing from sitemap.xml`);
}

await requirePage('locations/index.html', `${baseUrl}/locations/`, 'Locations hub');
await requirePage('companies/index.html', `${baseUrl}/companies/`, 'Companies hub');

for (const slug of regions) {
  await requirePage(`locations/${slug}/index.html`, `${baseUrl}/locations/${slug}/`, `Region ${slug}`);
}

const activeCompanies = new Set(jobs.map(job => clean(job?.company)).filter(Boolean));
let checkedPriorityCompanies = 0;
for (const company of priorityCompanies) {
  if (!activeCompanies.has(company)) continue;
  checkedPriorityCompanies += 1;
  const slug = slugify(company);
  await requirePage(`companies/${slug}/index.html`, `${baseUrl}/companies/${slug}/`, `Priority company ${company}`);
}

const jobsIndex = await readFile('jobs/index.html', 'utf8');
if (!jobsIndex.includes('id="browse-regions"')) failures.push('Jobs hub is missing its browse-by-region entry point.');
if (!jobsIndex.includes('id="browse-companies"')) failures.push('Jobs hub is missing its browse-by-company entry point.');
if (!sitemap.includes(`<loc>${baseUrl}/locations/</loc>`)) failures.push('Sitemap is missing the locations hub.');
if (!sitemap.includes(`<loc>${baseUrl}/companies/</loc>`)) failures.push('Sitemap is missing the companies hub.');

if (failures.length) {
  console.error('Discovery landing validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Discovery landing validation passed: ${regions.length} regions and ${checkedPriorityCompanies} active priority-employer pages are crawlable and linked from the jobs hub.`);
