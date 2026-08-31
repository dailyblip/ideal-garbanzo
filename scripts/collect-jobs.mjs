import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const leverCompanies = [
  ['serverfarm','Serverfarm'],
  ['lightedge','LightEdge Solutions'],
  ['cologix','Cologix'],
  ['ecldc','ECL'],
  ['hive','Hive']
];
const greenhouseBoards = [
  ['xai','xAI'],
  ['elementcritical','Element Critical']
];

const includeTerms = [
  'data center','data centre','critical facilities','critical facility','electrical apprentice','electrician','facilities technician','operations technician','infrastructure technician','commissioning technician','low voltage','fiber technician','network technician','field technician'
];
const earlyTerms = ['intern','internship','apprentice','apprenticeship','trainee','entry level','entry-level','tier 1','technician i','level 1','junior','associate','no experience','0-2 years','0–2 years','1-2 years','1–2 years','training provided'];
const midTerms = ['2+ years','2 years','3 years','2-3 years','2–3 years','3-5 years','3–5 years','technician ii','level 2','tier 2','journeyman'];
const seniorTerms = ['senior','sr.','sr ','lead ','principal','manager','director','vice president','vp ','head of','staff engineer','7+ years','8+ years','10+ years'];

const clean = s => String(s ?? '').replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
const lower = s => clean(s).toLowerCase();
const hash = value => crypto.createHash('sha1').update(value).digest('hex').slice(0,14);
const hasAny = (text, terms) => terms.some(term => text.includes(term));

function classify(title, description='') {
  const text = lower(`${title} ${description}`);
  const t = lower(title);
  if (hasAny(t, seniorTerms) || hasAny(text, ['7+ years','8+ years','10+ years'])) return null;
  let type = 'entry-level';
  if (t.includes('intern')) type = 'internship';
  else if (t.includes('apprentice')) type = 'apprenticeship';
  else if (t.includes('trainee')) type = 'trainee';
  const early = hasAny(text, earlyTerms);
  const mid = hasAny(text, midTerms);
  const experience = early ? (hasAny(text,['no experience','entry level','entry-level']) ? 'no-experience' : '0-2-years') : (mid ? '2-5-years' : '0-2-years');
  return { type, experience };
}

function relevant(title, description='') {
  const text = lower(`${title} ${description}`);
  if (!hasAny(text, includeTerms)) return false;
  if (hasAny(lower(title), seniorTerms)) return false;
  return true;
}

function extractPay(text='') {
  const s = clean(text);
  const range = s.match(/\$([\d,.]+)\s*(?:-|–|to)\s*\$?([\d,.]+)\s*(?:\/|per\s+)?(hour|hr|year|yr|annum)?/i);
  if (range) {
    const unit = /year|yr|annum/i.test(range[3]||'') ? 'year' : 'hour';
    return { pay: `$${range[1]}–$${range[2]} / ${unit === 'year' ? 'year' : 'hr'}`, salaryMin:Number(range[1].replace(/,/g,'')), salaryMax:Number(range[2].replace(/,/g,'')) };
  }
  return { pay: 'Pay not listed', salaryMin:null, salaryMax:null };
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
  if (hasAny(text,['critical facilities','hvac','generator','mechanical'])) tags.push('Critical Facilities');
  return [...new Set(tags)].slice(0,5);
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { 'user-agent':'DataCenterCareersBot/1.0 (+https://dailyblip.github.io/ideal-garbanzo/)' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function collectLever(slug, company) {
  const rows = await fetchJson(`https://api.lever.co/v0/postings/${slug}?mode=json`);
  return rows.filter(r => relevant(r.text, r.descriptionPlain || r.description || '')).map(r => {
    const description = clean(r.descriptionPlain || r.description || '');
    const cls = classify(r.text, description); if (!cls) return null;
    const pay = extractPay(`${r.salaryRange?.min || ''} ${r.salaryRange?.max || ''} ${description}`);
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
  return (payload.jobs || []).filter(r => relevant(r.title, r.content || '')).map(r => {
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

const byUrl = new Map();
for (const job of all) {
  const key = job.sourceUrl || `${job.company}|${job.title}|${job.location}`;
  if (!byUrl.has(key)) byUrl.set(key, job);
}
let jobs = [...byUrl.values()];
const now = Date.now();
for (const job of jobs) {
  job.postedHours = job.postedAt ? Math.max(0, Math.round((now - new Date(job.postedAt).getTime()) / 36e5)) : 9999;
}
jobs = jobs.filter(j => !j.postedAt || j.postedHours <= 45 * 24).sort((a,b)=>(a.postedHours??9999)-(b.postedHours??9999));

if (jobs.length < 3 && previous.filter(j=>!j.demo).length >= 3) {
  throw new Error(`Collector returned only ${jobs.length} real jobs; preserving prior snapshot. Errors: ${errors.join(' | ')}`);
}
await writeFile('data/jobs.json', JSON.stringify(jobs, null, 2) + '\n');
await writeFile('data/collector-status.json', JSON.stringify({updatedAt:new Date().toISOString(),jobs:jobs.length,sourcesAttempted:leverCompanies.length+greenhouseBoards.length,errors}, null, 2) + '\n');
console.log(`Collected ${jobs.length} qualifying jobs from employer-direct sources.`);
if (errors.length) console.warn(`Source warnings: ${errors.join(' | ')}`);
