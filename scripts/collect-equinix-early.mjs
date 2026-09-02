import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const listingUrls = [
  'https://careers.equinix.com/internships',
  'https://careers.equinix.com/hiring-operations-us-equinix',
  ...[1,2,3,4].map(page => `https://careers.equinix.com/jobs/search?country_codes%5B%5D=US&page=${page}&query=data+center`),
  'https://careers.equinix.com/jobs/search?country_codes%5B%5D=US&page=1&query=skillbridge',
  'https://careers.equinix.com/jobs/search?country_codes%5B%5D=US&page=2&query=skillbridge'
];

const roleSignal = /data\s*center|datacenter|critical facilit|customer operations/i;
const earlySignal = /skillbridge|intern|apprentice|trainee|fellowship|work.?based learning|co-?op/i;
const excluded = /\b(?:senior|sr\.?|lead|principal|manager|director|vice president|vp|head of|staff|supervisor|accountant|security|iam|sales)\b/i;
const states = ['alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa','kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan','minnesota','mississippi','missouri','montana','nebraska','nevada','new-hampshire','new-jersey','new-mexico','new-york','north-carolina','north-dakota','ohio','oklahoma','oregon','pennsylvania','rhode-island','south-carolina','south-dakota','tennessee','texas','utah','vermont','virginia','washington','west-virginia','wisconsin','wyoming','district-of-columbia'];

const clean = value => String(value ?? '')
  .replace(/<script\b[\s\S]*?<\/script>/gi,' ')
  .replace(/<style\b[\s\S]*?<\/style>/gi,' ')
  .replace(/<[^>]*>/g,' ')
  .replace(/&nbsp;|&#160;/gi,' ')
  .replace(/&amp;/gi,'&')
  .replace(/&quot;/gi,'"')
  .replace(/&#39;|&apos;/gi,"'")
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
      headers:{accept:'text/html,application/xhtml+xml','user-agent':'DataCenterCareersBot/2.0 (+https://dailyblip.github.io/ideal-garbanzo/)'},
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

function canonicalTitle(job) {
  return normalize(job.title.replace(/\s+[-–—]\s+(?:[A-Z][A-Za-z .'-]+,?\s*)+$/,'').trim());
}

function isManagedEarly(job) {
  return job?.company === 'Equinix' && (
    /^equinix-early-/i.test(String(job?.id || '')) ||
    job?.source === 'Equinix official early-career program'
  );
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

// Keep the broader Equinix collector's verified US samples as a fallback for
// employer pages that omit usable links or structured location data. Every
// recovered role is still re-fetched below before publication.
const priorSamples = status?.priorityEmployerExpansion?.Equinix?.dropSamples || [];
let recoveredCandidates = 0;
for (const sample of priorSamples) {
  const url = clean(sample?.url);
  const title = clean(sample?.title || sample?.listingLabel);
  if (!/^https:\/\/careers\.equinix\.com\//i.test(url) || !/united-states/i.test(url) || !usable(title,url)) continue;
  if (!candidates.has(url)) recoveredCandidates += 1;
  candidates.set(url,title);
}

const found = [];
const preservedOnFailure = [];
let detailAttempted = 0;
let detailSucceeded = 0;
let detailFailed = 0;
for (const [url,label] of candidates) {
  detailAttempted += 1;
  try {
    const html = await fetchText(url);
    detailSucceeded += 1;
    const title = roleHeading(html,label);
    if (!title || !usable(title,url)) continue;
    let type = 'trainee';
    if (/apprentice/i.test(title)) type = 'apprenticeship';
    else if (/intern|co-?op/i.test(title)) type = 'internship';
    const experience = /skillbridge|apprentice|trainee|work.?based learning/i.test(title) ? 'no-experience' : '0-2-years';
    const tags = [type === 'internship' ? 'Internship' : type === 'apprenticeship' ? 'Apprenticeship' : 'Trainee', experience === 'no-experience' ? 'No Experience Needed' : '0–2 Years'];
    if (/skillbridge/i.test(title)) tags.push('SkillBridge');
    if (/critical facilit/i.test(title)) tags.push('Critical Facilities');
    if (/customer operations|technician/i.test(title)) tags.push('Data Center Operations');
    found.push({
      id:`equinix-early-${hash(url)}`, title, company:'Equinix', location:locationFromUrl(url), type, experience,
      tags:[...new Set(tags)].slice(0,5), pay:'Pay not listed', salaryMin:null, salaryMax:null, salarySortMax:null,
      postedAt:null, postedHours:9999, source:'Equinix official early-career program', sourceUrl:url, active:true, demo:false
    });
  } catch (error) {
    detailFailed += 1;
    errors.push(`job ${url}: ${error.message}`);
    const prior = previousEarlyByUrl.get(url);
    if (prior) preservedOnFailure.push({ ...prior, active:true, demo:false });
  }
}

// A complete official listing pass is authoritative: managed Equinix early-career
// records that no longer appear are allowed to disappear. If even one listing
// page fails, retain unmatched prior records so a partial scan cannot wipe them.
// A failed detail fetch likewise retains only that still-listed prior role.
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
    detailAttempted,
    detailSucceeded,
    detailFailed,
    preservedOnFailure:preservedOnFailure.length,
    fallbackRetained:fallbackRetained.length,
    staleRemoved,
    qualifyingRoles:managedNext.length,
    errors
  }}
},null,2)+'\n');
console.log(`Equinix early-career pass found ${managedNext.length} qualifying US roles from ${candidates.size} candidates (${recoveredCandidates} recovered from verified US URLs; ${staleRemoved} stale removed).`);
if(errors.length) console.warn(`Equinix early-career warnings: ${errors.join(' | ')}`);
