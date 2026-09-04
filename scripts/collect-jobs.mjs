import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const leverCompanies = [
  ['serverfarm','Serverfarm'],
  ['lightedge','LightEdge Solutions'],
  ['cologix','Cologix'],
  ['ecldc','ECL'],
  ['hive','Hive'],
  ['cagents','CAI'],
  ['t5datacenters','T5 Data Centers']
];
const greenhouseBoards = [
  ['xai','xAI'],
  ['elementcritical','Element Critical'],
  ['coreweave','CoreWeave'],
  ['flexentialcorp','Flexential']
];
const ashbyBoards = [
  ['lambda','Lambda'],
  ['crusoe','Crusoe'],
  ['fluidstack','Fluidstack'],
  ['gimlet','Gimlet Labs'],
  ['tensorwave','TensorWave']
];

// Keep the feed centered on hands-on data-center work. Strong title phrases can
// qualify on their own; generic trade titles must also have data-center context
// in the job description so that office IT and unrelated technician roles stay out.
const strongTitleTerms = [
  'data center','data centre','critical facilities','critical facility','electrical apprentice',
  'low voltage','fiber technician','fiber splicer','data cabling','structured cabling'
];
const contextualTitleTerms = [
  'electrician','technician','apprentice','trainee','intern','operator','commissioning',
  'facilities','facility','controls','mechanical','electrical'
];
const dataCenterContextTerms = [
  'data center','data centre','critical facilities','colocation','colo facility','server rack','server racks',
  'white space','ups system','uninterruptible power','switchgear','pdu','power distribution unit',
  'generator','crac','crah','chiller','cooling plant','raised floor','fiber infrastructure'
];
const earlyTerms = [
  'intern','internship','apprentice','apprenticeship','trainee','entry level','entry-level','tier 1','technician i',
  'level 1','junior','associate','no experience','0-2 years','0–2 years','1-2 years','1–2 years','training provided'
];
const midTerms = [
  '2+ years','2 years','3 years','4 years','5 years','2-3 years','2–3 years','3-5 years','3–5 years',
  'technician ii','technician iii','level 2','level 3','tier 2','tier 3','journeyman'
];
const excludedTitleTerms = [
  'senior','sr.','sr ','lead ','principal','manager','director','vice president','vp ','head of','staff engineer',
  'supervisor','superintendent','foreman','counsel','attorney','designer','architect','recruiter','sales','account executive',
  'software engineer','software developer','machine learning engineer','ml engineer',
  'future opportunity','future opportunities','talent pool','talent community','general application','express your interest'
];
const excludedDescriptionTerms = [
  'this is an evergreen requisition','evergreen requisition','talent pool application','general interest application',
  'join our talent community','considered for future','may not currently have an open'
];

const clean = s => String(s ?? '').replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/\s+/g,' ').trim();
const lower = s => clean(s).toLowerCase();
const hash = value => crypto.createHash('sha1').update(value).digest('hex').slice(0,14);
const hasAny = (text, terms) => terms.some(term => text.includes(term));
const normalizeIdentity = value => lower(value).replace(/[^a-z0-9]+/g,' ').trim();

function relevant(title, description='') {
  const t = lower(title);
  const d = lower(description);
  if (!t || hasAny(t, excludedTitleTerms) || hasAny(d, excludedDescriptionTerms)) return false;
  if (hasAny(t, strongTitleTerms)) return true;
  return hasAny(t, contextualTitleTerms) && hasAny(d, dataCenterContextTerms);
}

function statedExperienceYears(text='') {
  const values = [];
  const patterns = [
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\+?\s*(?:-|–|to)\s*(\d{1,2})\s+years?(?:\s+of)?\s+(?:relevant\s+|related\s+)?experience/gi,
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\+?\s+years?(?:\s+of)?\s+(?:relevant\s+|related\s+)?experience/gi,
    /experience(?:\s+of)?\s+(?:at least\s+|minimum(?: of)?\s+)?(\d{1,2})\+?\s+years?/gi
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      values.push(Number(match[1]));
      if (match[2]) values.push(Number(match[2]));
    }
  }
  return values.filter(Number.isFinite);
}

function classify(title, description='', employmentType='') {
  const text = lower(`${title} ${description}`);
  const t = lower(title);
  if (!relevant(title, description)) return null;

  const years = statedExperienceYears(text);
  if (years.some(year => year >= 6)) return null;

  let type = 'entry-level';
  const employment = lower(employmentType);
  if (t.includes('intern') || employment === 'intern') type = 'internship';
  else if (t.includes('apprentice')) type = 'apprenticeship';
  else if (t.includes('trainee')) type = 'trainee';

  let experience = '0-2-years';
  if (hasAny(text, ['no experience','entry level','entry-level']) || /\b0\s*(?:-|–|to)\s*\d{1,2}\s+years?(?:\s+of)?\s+experience\b/i.test(text)) experience = 'no-experience';
  else if (t.includes('journeyman') || /\b(iii|3)\b/.test(t) || years.some(year => year >= 3) || hasAny(text, midTerms)) experience = '2-5-years';
  else if (hasAny(text, earlyTerms) || years.some(year => year <= 2)) experience = '0-2-years';

  return { type, experience };
}

function payObject(label='Pay not listed', min=null, max=null, interval='') {
  const isHourly = /hour|hourly|hr/i.test(interval);
  const salarySortMax = Number.isFinite(max) ? (isHourly ? Math.round(max * 2080) : max) : null;
  return { pay: label, salaryMin:min, salaryMax:max, salarySortMax };
}

function extractPay(text='') {
  const s = clean(text);
  const range = s.match(/\$([\d,.]+)\s*(?:-|–|to)\s*\$?([\d,.]+)\s*(?:\/|per\s+)?(hour|hourly|hr|year|yearly|yr|annum|annual|annually)?/i);
  if (!range) return payObject();
  const min = Number(range[1].replace(/,/g,''));
  const max = Number(range[2].replace(/,/g,''));
  const explicit = lower(range[3] || '');
  const annual = /year|yr|annum|annual/.test(explicit) || (!explicit && max >= 1000);
  return payObject(`$${range[1]}–$${range[2]} / ${annual ? 'year' : 'hr'}`, min, max, annual ? 'year' : 'hour');
}

function extractAshbyPay(compensation, description='') {
  const parts = compensation?.summaryComponents || [];
  const salary = parts.find(part => part?.compensationType === 'Salary' && Number.isFinite(part?.maxValue));
  if (!salary) return extractPay(description);
  const min = Number.isFinite(salary.minValue) ? salary.minValue : null;
  const max = Number.isFinite(salary.maxValue) ? salary.maxValue : null;
  const hourly = /HOUR/i.test(String(salary.interval || ''));
  const fmt = value => value == null ? '' : Number(value).toLocaleString('en-US',{maximumFractionDigits:2});
  const label = min != null && max != null ? `$${fmt(min)}–$${fmt(max)} / ${hourly ? 'hr' : 'year'}` : (compensation?.scrapeableCompensationSalarySummary || 'Pay listed on employer site');
  return payObject(label, min, max, hourly ? 'hour' : 'year');
}

function tagsFor(title, description, experience, type) {
  const text = lower(`${title} ${description}`);
  const tags = [];
  if (type === 'internship') tags.push('Internship');
  if (type === 'apprenticeship') tags.push('Apprenticeship');
  if (type === 'trainee') tags.push('Trainee');
  if (experience === 'no-experience') tags.push('No Experience Needed');
  else if (experience === '0-2-years') tags.push('0–2 Years');
  else tags.push('2–5 Years');
  if (hasAny(text,['training provided','on-the-job training','on the job training','mentorship'])) tags.push('Training / Mentorship');
  if (hasAny(text,['electrical','electrician','ups','switchgear'])) tags.push('Electrical');
  if (hasAny(text,['fiber','cabling','network'])) tags.push('Network / Cabling');
  if (hasAny(text,['critical facilities','hvac','generator','mechanical','chiller','crah','crac'])) tags.push('Critical Facilities');
  return [...new Set(tags)].slice(0,5);
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { 'user-agent':'DataCenterCareersBot/1.1 (+https://datacentercareers.us/)' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function collectLever(slug, company) {
  const rows = await fetchJson(`https://api.lever.co/v0/postings/${slug}?mode=json`);
  return rows.map(r => {
    const description = clean(r.descriptionPlain || r.description || '');
    const cls = classify(r.text, description); if (!cls) return null;
    const pay = extractPay(description);
    const location = clean(r.categories?.location || r.categories?.allLocations?.join(', ') || 'Location not listed');
    return {
      id: `lever-${slug}-${r.id || hash(r.hostedUrl || r.text)}`,
      title: clean(r.text), company, location,
      type: cls.type, experience: cls.experience,
      tags: tagsFor(r.text, description, cls.experience, cls.type),
      ...pay,
      postedAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
      source: 'Employer career site', sourceUrl: r.hostedUrl || r.applyUrl,
      active: true, demo: false
    };
  }).filter(Boolean);
}

async function collectGreenhouse(slug, company) {
  const payload = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
  return (payload.jobs || []).map(r => {
    const description = clean(r.content || '');
    const cls = classify(r.title, description); if (!cls) return null;
    const pay = extractPay(description);
    const location = clean(r.location?.name || 'Location not listed');
    return {
      id: `gh-${slug}-${r.id}`,
      title: clean(r.title), company, location,
      type: cls.type, experience: cls.experience,
      tags: tagsFor(r.title, description, cls.experience, cls.type),
      ...pay,
      postedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
      source: 'Employer career site', sourceUrl: r.absolute_url,
      active: true, demo: false
    };
  }).filter(Boolean);
}

async function collectAshby(slug, company) {
  const payload = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`);
  return (payload.jobs || []).filter(r => r.isListed !== false).map(r => {
    const description = clean(r.descriptionPlain || r.descriptionHtml || '');
    const cls = classify(r.title, description, r.employmentType); if (!cls) return null;
    const pay = extractAshbyPay(r.compensation, description);
    const secondary = (r.secondaryLocations || []).map(loc => clean(loc.location)).filter(Boolean);
    const location = [...new Set([clean(r.location), ...secondary].filter(Boolean))].join('; ') || 'Location not listed';
    return {
      id: `ashby-${slug}-${hash(r.jobUrl || `${r.title}|${location}`)}`,
      title: clean(r.title), company, location,
      type: cls.type, experience: cls.experience,
      tags: tagsFor(r.title, description, cls.experience, cls.type),
      ...pay,
      postedAt: r.publishedAt ? new Date(r.publishedAt).toISOString() : null,
      source: 'Employer career site', sourceUrl: r.jobUrl || r.applyUrl,
      active: true, demo: false
    };
  }).filter(Boolean);
}

let previous = [];
try { previous = JSON.parse(await readFile('data/jobs.json','utf8')); } catch {}
const all = [];
const errors = [];
for (const [slug, company] of leverCompanies) {
  try { all.push(...await collectLever(slug, company)); }
  catch (e) { errors.push(`${company}: ${e.message}`); }
}
for (const [slug, company] of greenhouseBoards) {
  try { all.push(...await collectGreenhouse(slug, company)); }
  catch (e) { errors.push(`${company}: ${e.message}`); }
}
for (const [slug, company] of ashbyBoards) {
  try { all.push(...await collectAshby(slug, company)); }
  catch (e) { errors.push(`${company}: ${e.message}`); }
}

const byUrl = new Map();
const identities = new Set();
for (const job of all) {
  const urlKey = job.sourceUrl || '';
  const identity = [job.company,job.title,job.location].map(normalizeIdentity).join('|');
  if ((urlKey && byUrl.has(urlKey)) || identities.has(identity)) continue;
  if (urlKey) byUrl.set(urlKey, job);
  else byUrl.set(identity, job);
  identities.add(identity);
}
let jobs = [...byUrl.values()];
const now = Date.now();
for (const job of jobs) {
  job.postedHours = job.postedAt ? Math.max(0, Math.round((now - new Date(job.postedAt).getTime()) / 36e5)) : 9999;
}
// ATS feeds above contain currently published roles. Age is an additional freshness guard,
// not the primary active/inactive signal; retain legitimate slow-to-fill roles up to 75 days.
jobs = jobs.filter(j => !j.postedAt || j.postedHours <= 75 * 24).sort((a,b)=>(a.postedHours??9999)-(b.postedHours??9999));

if (jobs.length < 3 && previous.filter(j=>!j.demo).length >= 3) {
  throw new Error(`Collector returned only ${jobs.length} real jobs; preserving prior snapshot. Errors: ${errors.join(' | ')}`);
}
const countsByType = jobs.reduce((acc, job) => { acc[job.type] = (acc[job.type] || 0) + 1; return acc; }, {});
const countsByExperience = jobs.reduce((acc, job) => { acc[job.experience] = (acc[job.experience] || 0) + 1; return acc; }, {});
await writeFile('data/jobs.json', JSON.stringify(jobs, null, 2) + '\n');
await writeFile('data/collector-status.json', JSON.stringify({
  updatedAt:new Date().toISOString(),
  jobs:jobs.length,
  sourcesAttempted:leverCompanies.length+greenhouseBoards.length+ashbyBoards.length,
  providers:{lever:leverCompanies.length,greenhouse:greenhouseBoards.length,ashby:ashbyBoards.length},
  countsByType,
  countsByExperience,
  errors
}, null, 2) + '\n');
console.log(`Collected ${jobs.length} qualifying jobs from employer-direct sources.`);
if (errors.length) console.warn(`Source warnings: ${errors.join(' | ')}`);