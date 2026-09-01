import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const listingUrls = [
  'https://careers.equinix.com/internships',
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
      headers:{accept:'text/html,application/xhtml+xml','user-agent':'DataCenterCareersBot/1.9 (+https://dailyblip.github.io/ideal-garbanzo/)'},
      redirect:'follow', signal:controller.signal
    });
    if (!response.ok) throw new Error(`${response.status} ${url}`);
    return response.text();
  } finally { clearTimeout(timer); }
}

function discover(html, baseUrl) {
  const out = new Map();
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = clean(match[1]);
    const label = clean(match[2]);
    if (!href || !earlySignal.test(`${label} ${href}`) || !roleSignal.test(`${label} ${href}`) || excluded.test(label)) continue;
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
    if (value && earlySignal.test(value) && roleSignal.test(value) && !excluded.test(value)) candidates.push(value);
  }
  const exact = candidates.sort((a,b) => a.length - b.length)[0];
  return exact || clean(fallback);
}

function locationFromUrl(url) {
  const slug = new URL(url).pathname.toLowerCase();
  for (const state of states.sort((a,b)=>b.length-a.length)) {
    if (slug.includes(`-${state}-united-states`)) return state.split('-').map(word => word[0].toUpperCase()+word.slice(1)).join(' ');
  }
  return 'United States';
}

function canonicalTitle(job) {
  return normalize(job.title.replace(/\s+[-–—]\s+(?:[A-Z][A-Za-z .'-]+,?\s*)+$/,'').trim());
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

const found = [];
for (const [url,label] of candidates) {
  try {
    const html = await fetchText(url);
    const title = roleHeading(html,label);
    if (!title || !earlySignal.test(title) || !roleSignal.test(title) || excluded.test(title)) continue;
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
  } catch (error) { errors.push(`job ${url}: ${error.message}`); }
}

let merged = dedupe([...found,...current]);
const rank = job => ({apprenticeship:0,internship:1,trainee:2,'entry-level':3}[job.type]??4)*10 + ({'no-experience':0,'0-2-years':1,'2-5-years':3}[job.experience]??2);
merged.sort((a,b)=>rank(a)-rank(b)||(a.postedHours??9999)-(b.postedHours??9999));
const countsByType = merged.reduce((a,j)=>(a[j.type]=(a[j.type]||0)+1,a),{});
const countsByExperience = merged.reduce((a,j)=>(a[j.experience]=(a[j.experience]||0)+1,a),{});

await writeFile('data/jobs.json',JSON.stringify(merged,null,2)+'\n');
await writeFile('data/collector-status.json',JSON.stringify({
  ...status, updatedAt:new Date().toISOString(), jobs:merged.length, countsByType, countsByExperience,
  priorityEmployerExpansion:{...(status.priorityEmployerExpansion||{}),EquinixEarlyCareer:{officialSource:'https://careers.equinix.com/',listingPagesAttempted:listingUrls.length,listingPagesSucceeded,candidateLinks:candidates.size,qualifyingRoles:found.length,errors}}
},null,2)+'\n');
console.log(`Equinix early-career fallback found ${found.length} qualifying US roles from ${candidates.size} candidates.`);
if(errors.length) console.warn(`Equinix early-career warnings: ${errors.join(' | ')}`);
