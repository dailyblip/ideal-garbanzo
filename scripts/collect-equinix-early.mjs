import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const listingUrls = [
  'https://careers.equinix.com/global-internship',
  'https://careers.equinix.com/internships',
  'https://careers.equinix.com/students-recent-grads',
  'https://careers.equinix.com/hiring-operations-us-equinix',
  ...[1,2,3,4].map(page => `https://careers.equinix.com/jobs/search?country_codes%5B%5D=US&page=${page}&query=data+center`),
  ...[1,2,3].map(page => `https://careers.equinix.com/jobs/search?country_codes%5B%5D=US&page=${page}&query=skillbridge`)
];

const roleSignal = /data\s*center|datacenter|critical facilit|customer operations/i;
const earlySignal = /skillbridge|intern|apprentice|trainee|fellowship|work.?based learning|co-?op/i;
const excluded = /\b(?:senior|sr\.?|lead|principal|manager|director|vice president|vp|head of|staff|supervisor|accountant|security|iam|sales)\b/i;
const states = ['alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa','kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan','minnesota','mississippi','missouri','montana','nebraska','nevada','new-hampshire','new-jersey','new-mexico','new-york','north-carolina','north-dakota','ohio','oklahoma','oregon','pennsylvania','rhode-island','south-carolina','south-dakota','tennessee','texas','utah','vermont','virginia','washington','west-virginia','wisconsin','wyoming','district-of-columbia'];
const experienceNumberWords = new Map([
  ['zero','0'],['one','1'],['two','2'],['three','3'],['four','4'],['five','5'],
  ['six','6'],['seven','7'],['eight','8'],['nine','9'],['ten','10']
]);

// Equinix's current careers pages expose job titles/URLs reliably to GitHub
// runners but sometimes omit the rendered qualification body. These five live
// US SkillBridge roles were verified against the official detail pages on
// 2026-09-05. They are re-fetched on every run and only supply an experience
// bucket when the live page still contains the expected title; a 404 or title
// change removes the fallback automatically.
const verifiedCandidates = [
  {
    requisition:'JR-161457',
    title:"SkillBridge - Data Center Technician - Hiring our Heroes Cohort Q3' 2026",
    url:'https://careers.equinix.com/jobs/skillbridge-data-center-technician-hiring-our-heroes-cohort-q3-2026-dallas-texas-united-states-ashburn-virginia-boca-raton-florida-chicago-illinois-englewood-colorado-san-jose-california',
    location:'San Jose, CA; Englewood, CO; Boca Raton, FL; Chicago, IL; Dallas, TX; Ashburn, VA',
    experience:'2-5-years'
  },
  {
    requisition:'JR-161458',
    title:"SkillBridge Critical Facilities Engineer, Data Center - Hiring our Heroes Cohort Q3' 2026",
    url:'https://careers.equinix.com/jobs/skillbridge-critical-facilities-engineer-data-center-hiring-our-heroes-cohort-q3-2026-dallas-texas-united-states-ashburn-virginia-chicago-illinois-denver-colorado-miami-florida-san-jose-calif',
    location:'San Jose, CA; Denver, CO; Miami, FL; Chicago, IL; Dallas, TX; Ashburn, VA',
    experience:'2-5-years'
  },
  {
    requisition:'JR-163300',
    title:"SkillBridge - Data Center Technician - Trainee - Cohort Q1' 2027",
    url:'https://careers.equinix.com/jobs/skillbridge-data-center-technician-trainee-cohort-q1-2027-dallas-texas-united-states-ashburn-virginia-atlanta-georgia-chicago-illinois-san-jose-california',
    location:'San Jose, CA; Atlanta, GA; Chicago, IL; Dallas, TX; Ashburn, VA',
    experience:'2-5-years'
  },
  {
    requisition:'JR-158170',
    title:'SkillBridge Critical Facilities Engineer - Trainee',
    url:'https://careers.equinix.com/jobs/skillbridge-critical-facilities-engineer-trainee-dallas-texas-united-states',
    location:'Dallas, TX',
    experience:'2-5-years'
  },
  {
    requisition:'JR-811161',
    title:'SkillBridge, Data Center Critical Facilities Engineer - Trainee',
    url:'https://careers.equinix.com/jobs/skillbridge-data-center-critical-facilities-engineer-trainee-san-jose-california-united-states',
    location:'San Jose, CA',
    experience:'2-5-years'
  }
];
const verifiedByUrl = new Map(verifiedCandidates.map(item => [item.url, item]));

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

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      headers:{accept:'text/html,application/xhtml+xml','accept-language':'en-US,en;q=0.9','user-agent':'DataCenterCareersBot/2.2 (+https://datacentercareers.us/)'},
      redirect:'follow', signal:controller.signal
    });
    if (!response.ok) throw new Error(`${response.status} ${url}`);
    return response.text();
  } finally { clearTimeout(timer); }
}

function usable(title, url='') {
  const text = `${clean(title)} ${url}`;
  return earlySignal.test(text) && roleSignal.test(text) && !excluded.test(clean(title));
}

function discover(html, baseUrl) {
  const out = new Map();
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = clean(match[1]);
    const label = clean(match[2]);
    if (!href || !usable(label, href)) continue;
    let url;
    try { url = new URL(href, baseUrl).href; } catch { continue; }
    if (!/^https:\/\/careers\.equinix\.com\/(?:[a-z]{2}\/)?jobs\//i.test(url) || !/united-states/i.test(url)) continue;
    out.set(url, label);
  }
  return out;
}

function findJobPosting(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findJobPosting(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  const type = value['@type'];
  if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) return value;
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      const found = findJobPosting(child);
      if (found) return found;
    }
  }
  return null;
}

function extractPosting(html) {
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const found = findJobPosting(JSON.parse(match[1].trim()));
      if (found) return found;
    } catch {}
  }
  return null;
}

function roleHeading(html, fallback) {
  const candidates = [];
  for (const match of html.matchAll(/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/gi)) {
    const value = clean(match[1]);
    if (value && usable(value)) candidates.push(value);
  }
  return candidates.sort((a,b) => a.length - b.length)[0] || clean(fallback);
}

function locationFromUrl(url) {
  const slug = new URL(url).pathname.toLowerCase();
  for (const state of [...states].sort((a,b)=>b.length-a.length)) {
    if (slug.includes(`-${state}-united-states`)) return state.split('-').map(word => word[0].toUpperCase()+word.slice(1)).join(' ');
  }
  return 'United States';
}

function locationFromPosting(posting, url) {
  const entries = Array.isArray(posting?.jobLocation) ? posting.jobLocation : [posting?.jobLocation].filter(Boolean);
  const locations = [];
  for (const entry of entries) {
    const address = entry?.address || entry || {};
    const country = clean(typeof address.addressCountry === 'object' ? address.addressCountry?.name : address.addressCountry);
    if (country && !/united states|\busa?\b/i.test(country)) continue;
    const label = [address.addressLocality, address.addressRegion].map(clean).filter(Boolean).join(', ');
    if (label) locations.push(label);
  }
  return [...new Set(locations)].join('; ') || locationFromUrl(url);
}

function requiredExperienceText(description='') {
  const text = clean(description);
  const preferred = text.search(/\b(?:preferred qualifications?|preferred experience|preferred skills?|nice to have|bonus qualifications?)\b/i);
  return preferred >= 0 ? text.slice(0, preferred) : text;
}

function normalizeExperienceNumbers(text='') {
  return lower(text).replace(/\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/g, word => experienceNumberWords.get(word) || word);
}

function statedExperienceYears(text='') {
  const normalized = normalizeExperienceNumbers(text);
  const values = [];
  const patterns = [
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s+years?['’]?(?:\s+(?:of|prior))?\s+(?:direct\s+|equivalent\s+|relevant\s+|related\s+|professional\s+|technical\s+|work\s+)*experience/gi,
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:\+|or more)?\s+years?['’]?(?:\s+(?:of|prior))?\s+(?:direct\s+|equivalent\s+|relevant\s+|related\s+|professional\s+|technical\s+|work\s+)*experience/gi,
    /experience.{0,45}?(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s+years?/gi,
    /experience.{0,45}?(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:\+|or more)?\s+years?/gi,
    /(?:relevant|related|equivalent|technical|professional)\s+experience\s+(?:with|w\/)\s*(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s+years?/gi
  ];
  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      values.push(Number(match[1]));
      if (match[2]) values.push(Number(match[2]));
    }
  }
  const monthPatterns = [
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,3})\s*(?:\+|or more)?\s+months?(?:\s+(?:of|prior))?\s+(?:direct\s+|relevant\s+|related\s+|professional\s+|technical\s+|work\s+)*experience/gi,
    /experience.{0,35}?(\d{1,3})\s*(?:\+|or more)?\s+months?/gi
  ];
  for (const pattern of monthPatterns) {
    for (const match of normalized.matchAll(pattern)) {
      const months = Number(match[1]);
      if (Number.isFinite(months)) values.push(months / 12);
    }
  }
  return values.filter(value => Number.isFinite(value) && value >= 0 && value <= 50);
}

function classifyExperience(title, description='') {
  const t = lower(title);
  const requiredText = lower(`${title} ${requiredExperienceText(description)}`);
  const years = statedExperienceYears(requiredText);
  if (years.some(year => year > 5)) return { drop:'experience' };
  if (years.length) {
    const highest = Math.max(...years);
    return { experience: highest <= 2 ? '0-2-years' : '2-5-years' };
  }
  const explicitNoExperience = /(?:no|zero) (?:prior )?experience(?: is)? (?:required|needed)|experience (?:is )?not required|\b0\+?\s+months?\s+(?:of\s+)?experience\b/i.test(requiredText);
  if (explicitNoExperience) return { experience:'no-experience' };
  if (/intern|co-?op|apprentice/i.test(t)) return { experience:'0-2-years' };
  return { drop:'unknown-experience' };
}

function validateClassifier() {
  const cases = [
    {name:'SkillBridge 2–4 years is mid-level eligible',title:"SkillBridge - Data Center Technician - Cohort Q3' 2026",description:'Qualifications: 2–4 years of experience in technical support, IT, telecom, or data center operations.',expected:'2-5-years'},
    {name:'SkillBridge 4–6 years exceeds site mission',title:'SkillBridge Data Center Customer Operations Technician - Trainee',description:'Qualifications: 4–6 years of experience in a data center environment.',expected:null},
    {name:'one-to-four relevant experience is mid-level eligible',title:'SkillBridge Critical Facilities Engineer, Data Center - Cohort Q3',description:"Qualifications: Working on bachelor's degree or relevant experience w/1-4 years in Mechanical Engineering or related field.",expected:'2-5-years'},
    {name:'preferred seniority does not override required two years',title:'Data Center Operations Trainee',description:'Minimum of two years of relevant experience. Preferred qualifications: seven years of experience.',expected:'0-2-years'},
    {name:'explicit no-experience language is truthful',title:'Data Center Operations Trainee',description:'No prior experience required. Training is provided.',expected:'no-experience'},
    {name:'bare SkillBridge title fails closed',title:'SkillBridge Data Center Technician - Trainee',description:'Hands-on data center operations training program.',expected:null},
    {name:'internship without stated years stays early-career',title:'Data Center Customer Operations Intern',description:'Support the data center operations team.',expected:'0-2-years'}
  ];
  const failures = [];
  for (const testCase of cases) {
    const actual = classifyExperience(testCase.title, testCase.description);
    const value = actual.drop ? null : actual.experience;
    if (value !== testCase.expected) failures.push(`${testCase.name}: expected ${testCase.expected}, got ${value}`);
  }
  if (failures.length) throw new Error(`Equinix early-career classifier regression: ${failures.join(' | ')}`);
}
validateClassifier();

function canonicalTitle(job) {
  return normalize(job.title.replace(/\s+[-–—]\s+(?:[A-Z][A-Za-z .'-]+,?\s*)+$/,'').trim());
}
function isManagedEarly(job) {
  return job?.company === 'Equinix' && (/^equinix-early-/i.test(String(job?.id || '')) || job?.source === 'Equinix official early-career program');
}
function dedupe(jobs) {
  const urls = new Set();
  const identities = new Set();
  const out = [];
  for (const job of jobs) {
    const url = clean(job.sourceUrl);
    const identity = [normalize(job.company), canonicalTitle(job), normalize(job.location)].join('|');
    if ((url && urls.has(url)) || identities.has(identity)) continue;
    if (url) urls.add(url);
    identities.add(identity);
    out.push(job);
  }
  return out;
}

const current = JSON.parse(await readFile('data/jobs.json','utf8'));
let status = {};
try { status = JSON.parse(await readFile('data/collector-status.json','utf8')); } catch {}
const previousEarly = current.filter(isManagedEarly);
const previousEarlyByUrl = new Map(previousEarly.map(job => [clean(job.sourceUrl), job]));

const candidates = new Map();
const errors = [];
let listingPagesSucceeded = 0;
for (const listing of listingUrls) {
  try {
    const html = await fetchText(listing);
    for (const [url,label] of discover(html,listing)) candidates.set(url,label);
    listingPagesSucceeded += 1;
  } catch (error) { errors.push(`listing ${listing}: ${error.message}`); }
}

const priorSamples = status?.priorityEmployerExpansion?.Equinix?.dropSamples || [];
let recoveredCandidates = 0;
for (const sample of priorSamples) {
  const url = clean(sample?.url);
  const title = clean(sample?.title || sample?.listingLabel);
  if (!/^https:\/\/careers\.equinix\.com\//i.test(url) || !/united-states/i.test(url) || !usable(title,url)) continue;
  if (!candidates.has(url)) recoveredCandidates += 1;
  candidates.set(url,title);
}
let verifiedSeeded = 0;
for (const item of verifiedCandidates) {
  if (!candidates.has(item.url)) verifiedSeeded += 1;
  candidates.set(item.url,item.title);
}

const found = [];
const preservedOnFailure = [];
let detailAttempted = 0;
let detailSucceeded = 0;
let detailFailed = 0;
let verifiedFallbackUsed = 0;
const drops = { experience:0, unknownExperience:0, unusable:0, verifiedMismatch:0 };
for (const [url,label] of candidates) {
  detailAttempted += 1;
  try {
    const html = await fetchText(url);
    detailSucceeded += 1;
    const posting = extractPosting(html);
    const title = clean(posting?.title || posting?.name) || roleHeading(html,label);
    if (!title || !usable(title,url)) { drops.unusable += 1; continue; }
    const description = clean(posting?.description || html);
    let classification = classifyExperience(title, description);
    const verified = verifiedByUrl.get(url);
    if (classification.drop === 'unknown-experience' && verified) {
      const pageText = normalize(clean(html));
      const expectedTitle = normalize(verified.title);
      if (pageText.includes(expectedTitle)) {
        classification = { experience:verified.experience };
        verifiedFallbackUsed += 1;
      } else {
        drops.verifiedMismatch += 1;
      }
    }
    if (classification.drop) {
      if (classification.drop === 'experience') drops.experience += 1;
      else drops.unknownExperience += 1;
      continue;
    }

    let type = 'trainee';
    if (/apprentice/i.test(title)) type = 'apprenticeship';
    else if (/intern|co-?op/i.test(title)) type = 'internship';
    const experience = classification.experience;
    const tags = [type === 'internship' ? 'Internship' : type === 'apprenticeship' ? 'Apprenticeship' : 'Trainee',experience === 'no-experience' ? 'No Experience Needed' : experience === '2-5-years' ? '2–5 Years' : '0–2 Years'];
    if (/skillbridge/i.test(title)) tags.push('SkillBridge');
    if (/critical facilit/i.test(title)) tags.push('Critical Facilities');
    if (/customer operations|technician/i.test(title)) tags.push('Data Center Operations');
    const datePosted = clean(posting?.datePosted);
    const postedAt = /^\d{4}-\d{2}-\d{2}/.test(datePosted) ? new Date(datePosted).toISOString() : null;
    const postedHours = postedAt ? Math.max(0, Math.round((Date.now() - new Date(postedAt).getTime()) / 36e5)) : 9999;

    found.push({
      id:`equinix-early-${hash(url)}`, title, company:'Equinix', location:verified?.location || locationFromPosting(posting,url), type, experience,
      tags:[...new Set(tags)].slice(0,5), pay:'Pay not listed', salaryMin:null, salaryMax:null, salarySortMax:null,
      postedAt, postedHours, source:'Equinix official early-career program', sourceUrl:url, active:true, demo:false
    });
  } catch (error) {
    detailFailed += 1;
    errors.push(`job ${url}: ${error.message}`);
    const prior = previousEarlyByUrl.get(url);
    if (prior) preservedOnFailure.push({ ...prior, active:true, demo:false });
  }
}

const listingComplete = listingPagesSucceeded === listingUrls.length;
const candidateUrls = new Set(candidates.keys());
const alreadyRetainedUrls = new Set([...found, ...preservedOnFailure].map(job => clean(job.sourceUrl)));
const fallbackRetained = listingComplete ? [] : previousEarly.filter(job => {
  const url = clean(job.sourceUrl);
  return !candidateUrls.has(url) && !alreadyRetainedUrls.has(url);
}).map(job => ({ ...job, active:true, demo:false }));
const managedNext = dedupe([...found, ...preservedOnFailure, ...fallbackRetained]);
const managedNextUrls = new Set(managedNext.map(job => clean(job.sourceUrl)));
const staleRemoved = listingComplete ? previousEarly.filter(job => !managedNextUrls.has(clean(job.sourceUrl))).length : 0;
const currentWithoutManagedEarly = current.filter(job => !isManagedEarly(job));

let merged = dedupe([...managedNext,...currentWithoutManagedEarly]);
const rank = job => ({apprenticeship:0,internship:1,trainee:2,'entry-level':3}[job.type]??4)*10 + ({'no-experience':0,'0-2-years':1,'2-5-years':3}[job.experience]??2);
merged.sort((a,b)=>rank(a)-rank(b)||(a.postedHours??9999)-(b.postedHours??9999));
const countsByType = merged.reduce((a,j)=>(a[j.type]=(a[j.type]||0)+1,a),{});
const countsByExperience = merged.reduce((a,j)=>(a[j.experience]=(a[j.experience]||0)+1,a),{});

await writeFile('data/jobs.json',JSON.stringify(merged,null,2)+'\n');
await writeFile('data/collector-status.json',JSON.stringify({
  ...status, updatedAt:new Date().toISOString(), jobs:merged.length, countsByType, countsByExperience,
  priorityEmployerExpansion:{...(status.priorityEmployerExpansion||{}),EquinixEarlyCareer:{
    officialSource:'https://careers.equinix.com/',
    sourceHealthy:listingPagesSucceeded>0,
    listingComplete,
    listingPagesAttempted:listingUrls.length,
    listingPagesSucceeded,
    candidateLinks:candidates.size,
    recoveredCandidates,
    verifiedSeeded,
    verifiedFallbackUsed,
    verifiedAt:'2026-09-05',
    detailAttempted,
    detailSucceeded,
    detailFailed,
    preservedOnFailure:preservedOnFailure.length,
    fallbackRetained:fallbackRetained.length,
    staleRemoved,
    qualifyingRoles:managedNext.length,
    drops,
    errors
  }}
},null,2)+'\n');
console.log(`Equinix early-career pass found ${managedNext.length} qualifying US roles from ${candidates.size} candidates (${verifiedFallbackUsed} source-verified requirement fallbacks; ${staleRemoved} stale removed; ${drops.experience} over-experience and ${drops.unknownExperience} unknown-experience dropped).`);
if(errors.length) console.warn(`Equinix early-career warnings: ${errors.join(' | ')}`);
