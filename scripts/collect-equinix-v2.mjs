import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const COMPANY = 'Equinix';
const listings = [
  'https://careers.equinix.com/internships',
  ...[1,2,3,4].map(page => `https://careers.equinix.com/jobs/search?country_codes%5B%5D=US&page=${page}&query=data+center`),
  'https://careers.equinix.com/jobs/search?country_codes%5B%5D=US&page=1&query=skillbridge'
];
const titleAllow = /data\s*center|datacenter|critical facilit|customer operations|logistics technician|skillbridge|apprentice|intern|trainee/i;
const titleExclude = /\b(?:senior|sr\.?|lead|principal|manager|director|vice president|vp|head of|staff|supervisor|superintendent|foreman|architect|sales|account executive)\b|\b(?:IV|V|VI)\b/i;
const earlyTitle = /intern|apprentice|trainee|skillbridge|fellowship|work.?based learning|co-?op/i;
const dataCenterSignals = ['data center','datacenter','data centre','critical facilities','critical facility','critical environment','ibx','rack and stack','structured cabling','fiber','cross-connect','cross connect','switchgear','ups','generator','bms','epms','hvac','chiller','colocation','mission critical','customer installations'];
const noExperienceSignals = ['no experience','entry level','entry-level','high school diploma','high school or equivalent','high school diploma or equivalent','training program','training will be','learning program'];

const clean = value => String(value ?? '')
  .replace(/<script\b[\s\S]*?<\/script>/gi,' ')
  .replace(/<style\b[\s\S]*?<\/style>/gi,' ')
  .replace(/<[^>]*>/g,' ')
  .replace(/&nbsp;|&#160;/gi,' ')
  .replace(/&amp;/gi,'&')
  .replace(/&quot;/gi,'"')
  .replace(/&#39;|&apos;/gi,"'")
  .replace(/&ndash;|&#8211;/gi,'–')
  .replace(/&mdash;|&#8212;/gi,'—')
  .replace(/\s+/g,' ')
  .trim();
const lower = value => clean(value).toLowerCase();
const normalize = value => lower(value).replace(/[^a-z0-9]+/g,' ').trim();
const hash = value => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0,14);
const hasAny = (text, terms) => terms.some(term => text.includes(term));

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      headers:{accept:'text/html,application/xhtml+xml','user-agent':'DataCenterCareersBot/1.7 (+https://dailyblip.github.io/ideal-garbanzo/)'},
      redirect:'follow',
      signal:controller.signal
    });
    if (!response.ok) throw new Error(`${response.status} ${url}`);
    return response.text();
  } finally { clearTimeout(timer); }
}

function discoverLinks(html, baseUrl) {
  const out = [];
  const seen = new Set();
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = clean(match[1]);
    const label = clean(match[2]);
    if (!href || !titleAllow.test(`${label} ${href}`) || titleExclude.test(label)) continue;
    let url;
    try { url = new URL(href, baseUrl).href; } catch { continue; }
    if (!/^https:\/\/careers\.equinix\.com\/(?:[a-z]{2}\/)?jobs\//i.test(url)) continue;
    if (/\/jobs\/search(?:[/?]|$)/i.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function findJobPosting(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    for (const item of value) { const found = findJobPosting(item); if (found) return found; }
    return null;
  }
  if (typeof value !== 'object') return null;
  const type = value['@type'];
  if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) return value;
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') { const found = findJobPosting(child); if (found) return found; }
  }
  return null;
}

function extractPosting(html) {
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { const found = findJobPosting(JSON.parse(match[1].trim())); if (found) return found; } catch {}
  }
  return null;
}

function extractPageTitle(html) {
  return clean(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s*\|\s*Equinix.*$/i,'').trim();
}

function parsePageTitle(raw) {
  const segments = clean(raw).split(/\s+-\s+/).map(clean).filter(Boolean);
  const firstLoc = segments.findIndex(segment => /,\s*[^,]+,\s*United States$/i.test(segment));
  if (firstLoc < 0) return { title:clean(raw), locations:[] };
  return {
    title:segments.slice(0, firstLoc).join(' - '),
    locations:[...new Set(segments.slice(firstLoc).filter(segment => /,\s*[^,]+,\s*United States$/i.test(segment)).map(segment => segment.replace(/,\s*United States$/i,'').trim()))]
  };
}

function postingLocation(posting) {
  const entries = Array.isArray(posting?.jobLocation) ? posting.jobLocation : [posting?.jobLocation].filter(Boolean);
  const locations = [];
  let us = false;
  for (const entry of entries) {
    const address = entry?.address || entry || {};
    const country = clean(typeof address.addressCountry === 'object' ? address.addressCountry?.name : address.addressCountry);
    if (/united states|\busa?\b/i.test(country)) us = true;
    const label = [address.addressLocality,address.addressRegion].map(clean).filter(Boolean).join(', ');
    if (label) locations.push(label);
  }
  return { locations:[...new Set(locations)], us };
}

function experienceRange(text) {
  const mins = [], maxes = [];
  for (const match of text.matchAll(/(?:requires?|minimum(?: of)?|at least|typically requires)?\s*(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s+years?(?:\s+of)?\s+(?:equivalent\s+|relevant\s+|related\s+)?(?:work\s+)?experience/gi)) {
    mins.push(Number(match[1])); maxes.push(Number(match[2]));
  }
  for (const match of text.matchAll(/(?:requires?|minimum(?: of)?|at least|typically requires)\s+(\d{1,2})\+?\s+years?(?:\s+of)?\s+(?:equivalent\s+|relevant\s+|related\s+)?(?:work\s+)?experience/gi)) {
    mins.push(Number(match[1])); maxes.push(Number(match[1]));
  }
  return { min:mins.length ? Math.min(...mins) : null, max:maxes.length ? Math.max(...maxes) : null };
}

function classify(title, description) {
  const t = lower(title), text = lower(`${title} ${description}`);
  if (!titleAllow.test(title) || titleExclude.test(title)) return { drop:'title' };
  if (!hasAny(text,dataCenterSignals)) return { drop:'context' };
  const years = experienceRange(text);
  if (years.min != null && years.min > 5) return { drop:'experience' };

  let type = 'entry-level';
  if (/apprentice/.test(t)) type = 'apprenticeship';
  else if (/intern|co-?op/.test(t)) type = 'internship';
  else if (/trainee|skillbridge|fellowship|work.?based learning/.test(t)) type = 'trainee';

  let experience;
  if (years.min != null) experience = years.min <= 2 ? '0-2-years' : '2-5-years';
  else if (earlyTitle.test(title)) experience = hasAny(text,noExperienceSignals) ? 'no-experience' : '0-2-years';
  else if (hasAny(text,noExperienceSignals)) experience = 'no-experience';
  else return { drop:'unknown-experience' };
  return { type, experience, years };
}

function pay(posting, description) {
  const salary = posting?.baseSalary?.value || posting?.baseSalary;
  const lo = Number(salary?.minValue ?? salary?.value?.minValue), hi = Number(salary?.maxValue ?? salary?.value?.maxValue);
  const unit = clean(salary?.unitText || salary?.value?.unitText || posting?.baseSalary?.unitText);
  if (Number.isFinite(lo) && Number.isFinite(hi)) {
    const hourly = /hour/i.test(unit);
    return {pay:`$${lo.toLocaleString('en-US')}–$${hi.toLocaleString('en-US')} / ${hourly?'hr':'year'}`,salaryMin:lo,salaryMax:hi,salarySortMax:hourly?Math.round(hi*2080):hi};
  }
  const m = clean(description).match(/(?:\$\s*)?([\d]{2,3},[\d]{3})\s*(?:-|–|to)\s*(?:\$\s*)?([\d]{2,3},[\d]{3})\s*(?:USD)?\s*\/\s*(Annual|Year|Hourly|Hour)/i);
  if (!m) return {pay:'Pay not listed',salaryMin:null,salaryMax:null,salarySortMax:null};
  const min = Number(m[1].replace(/,/g,'')), max = Number(m[2].replace(/,/g,'')), hourly = /hour/i.test(m[3]);
  return {pay:`$${min.toLocaleString('en-US')}–$${max.toLocaleString('en-US')} / ${hourly?'hr':'year'}`,salaryMin:min,salaryMax:max,salarySortMax:hourly?Math.round(max*2080):max};
}

function tags(title, description, cls) {
  const text = lower(`${title} ${description}`), out = [];
  if (cls.type === 'internship') out.push('Internship');
  if (cls.type === 'apprenticeship') out.push('Apprenticeship');
  if (cls.type === 'trainee') out.push('Trainee');
  out.push(cls.experience === 'no-experience' ? 'No Experience Needed' : cls.experience === '2-5-years' ? '2–5 Years' : '0–2 Years');
  if (/skillbridge/.test(text)) out.push('SkillBridge');
  if (/training|learning|mentorship/.test(text)) out.push('Training / Mentorship');
  if (/electrical|switchgear|ups|epms/.test(text)) out.push('Electrical');
  if (/fiber|cabling|network|cross-connect|cross connect/.test(text)) out.push('Network / Cabling');
  if (/critical facilit|generator|hvac|chiller|mechanical|bms/.test(text)) out.push('Critical Facilities');
  return [...new Set(out)].slice(0,5);
}

async function hydrate(url) {
  const html = await fetchText(url);
  const posting = extractPosting(html);
  const meta = parsePageTitle(extractPageTitle(html));
  const title = clean(posting?.title || posting?.name || meta.title);
  const description = clean(posting?.description || posting?.responsibilities || html);
  const cls = classify(title,description);
  if (cls.drop) return { drop:cls.drop };
  const structured = postingLocation(posting);
  const locations = structured.locations.length ? structured.locations : meta.locations;
  if (!(structured.us || meta.locations.length || /United States/i.test(extractPageTitle(html)))) return { drop:'non-us' };
  let postedAt = null;
  if (posting?.datePosted) { const d = new Date(posting.datePosted); if (!Number.isNaN(d.getTime())) postedAt = d.toISOString(); }
  return { job:{id:`equinix-${hash(url)}`,title,company:COMPANY,location:[...new Set(locations)].join('; ')||'United States',type:cls.type,experience:cls.experience,tags:tags(title,description,cls),...pay(posting,description),postedAt,source:'Equinix official careers',sourceUrl:url,active:true,demo:false} };
}

function canonicalTitle(job) {
  let title = clean(job.title);
  const locTokens = new Set(normalize(job.location).split(' ').filter(token=>token.length>1));
  title = title.replace(/\s+[-–—]\s+([^|]+)$/u,(full,tail)=>{const tokens=normalize(tail).split(' ').filter(token=>token.length>1);return tokens.length&&tokens.every(token=>locTokens.has(token))?'':full;});
  return normalize(title);
}

function dedupe(jobs) {
  const urls = new Set(), ids = new Set(), out=[];
  for (const job of jobs) {
    if (titleExclude.test(clean(job.title))) continue;
    const url=clean(job.sourceUrl), id=[normalize(job.company),canonicalTitle(job),normalize(job.location)].join('|');
    if ((url&&urls.has(url))||ids.has(id)) continue;
    if(url)urls.add(url); ids.add(id); out.push(job);
  }
  return out;
}
const priority = job => ({apprenticeship:0,internship:1,trainee:2,'entry-level':3}[job.type]??4)*10 + ({'no-experience':0,'0-2-years':1,'2-5-years':3}[job.experience]??2);

const current = JSON.parse(await readFile('data/jobs.json','utf8'));
let status={}; try{status=JSON.parse(await readFile('data/collector-status.json','utf8'));}catch{}
const links=new Set(), errors=[], drops={}; let listingPagesSucceeded=0;
for(const listing of listings){try{const html=await fetchText(listing);for(const link of discoverLinks(html,listing))links.add(link);listingPagesSucceeded++;}catch(error){errors.push(`listing ${listing}: ${error.message}`);}}
const discovered=[];
for(const link of [...links].slice(0,90)){try{const result=await hydrate(link);if(result.job)discovered.push(result.job);else if(result.drop)drops[result.drop]=(drops[result.drop]||0)+1;}catch(error){errors.push(`job ${link}: ${error.message}`);}}
let merged=dedupe([...discovered,...current]);
const now=Date.now();for(const job of merged)job.postedHours=job.postedAt?Math.max(0,Math.round((now-new Date(job.postedAt).getTime())/36e5)):(job.postedHours??9999);
const early=merged.filter(job=>job.experience!=='2-5-years'), mid=merged.filter(job=>job.experience==='2-5-years'), maxMid=Math.max(12,Math.floor(Math.max(early.length,1)*0.30));
merged=[...early,...mid.sort((a,b)=>(a.postedHours??9999)-(b.postedHours??9999)).slice(0,maxMid)].sort((a,b)=>priority(a)-priority(b)||(a.postedHours??9999)-(b.postedHours??9999));
const countsByType=merged.reduce((a,j)=>(a[j.type]=(a[j.type]||0)+1,a),{}),countsByExperience=merged.reduce((a,j)=>(a[j.experience]=(a[j.experience]||0)+1,a),{});
await writeFile('data/jobs.json',JSON.stringify(merged,null,2)+'\n');
await writeFile('data/collector-status.json',JSON.stringify({...status,updatedAt:new Date().toISOString(),jobs:merged.length,countsByType,countsByExperience,priorityEmployerExpansion:{...(status.priorityEmployerExpansion||{}),Equinix:{officialSource:'https://careers.equinix.com/',listingPagesAttempted:listings.length,listingPagesSucceeded,candidateLinks:links.size,qualifyingRoles:discovered.length,drops,errors}}},null,2)+'\n');
console.log(`Equinix official-source pass found ${links.size} candidates and ${discovered.length} qualifying US roles. Drops: ${JSON.stringify(drops)}`);
if(errors.length)console.warn(`Equinix warnings: ${errors.join(' | ')}`);
