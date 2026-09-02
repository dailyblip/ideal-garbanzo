import { readFile, writeFile } from 'node:fs/promises';

const SOURCE_URL = 'https://careers.microsoft.com/v2/global/en/datacenters.html';
const APPLY_ORIGIN = 'https://apply.careers.microsoft.com';
const COMPANY = 'Microsoft';

const seniorTitlePattern = /\b(?:senior|sr\.?|lead|principal|manager|director|vice president|vp|head of|staff engineer|supervisor|superintendent|foreman|architect|program manager)\b/i;
const relevantTitlePattern = /\b(?:data\s*center|datacenter|critical environment|critical facilities|field service engineer|inventory and asset|technician|operations technician)\b/i;

const stateCodes = {
  Alabama:'AL', Alaska:'AK', Arizona:'AZ', Arkansas:'AR', California:'CA', Colorado:'CO', Connecticut:'CT', Delaware:'DE', Florida:'FL', Georgia:'GA', Hawaii:'HI', Idaho:'ID', Illinois:'IL', Indiana:'IN', Iowa:'IA', Kansas:'KS', Kentucky:'KY', Louisiana:'LA', Maine:'ME', Maryland:'MD', Massachusetts:'MA', Michigan:'MI', Minnesota:'MN', Mississippi:'MS', Missouri:'MO', Montana:'MT', Nebraska:'NE', Nevada:'NV', 'New Hampshire':'NH', 'New Jersey':'NJ', 'New Mexico':'NM', 'New York':'NY', 'North Carolina':'NC', 'North Dakota':'ND', Ohio:'OH', Oklahoma:'OK', Oregon:'OR', Pennsylvania:'PA', 'Rhode Island':'RI', 'South Carolina':'SC', 'South Dakota':'SD', Tennessee:'TN', Texas:'TX', Utah:'UT', Vermont:'VT', Virginia:'VA', Washington:'WA', 'West Virginia':'WV', Wisconsin:'WI', Wyoming:'WY', 'District of Columbia':'DC'
};

const decode = value => String(value ?? '')
  .replace(/&nbsp;|&#160;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&ndash;|&#8211;/gi, '–')
  .replace(/&mdash;|&#8212;/gi, '—')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>');
const clean = value => decode(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const normalizeIdentity = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'user-agent': 'DataCenterCareersBot/1.7 (+https://datacentercareers.us/)'
    },
    redirect: 'follow'
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.text();
}

function extractApplyLinks(html) {
  const links = [];
  const seen = new Set();
  const re = /href=["']([^"']*apply\.careers\.microsoft\.com\/careers\/job\/\d+[^"']*|\/careers\/job\/\d+[^"']*)["']/gi;
  for (const match of html.matchAll(re)) {
    let href = decode(match[1]);
    try {
      href = new URL(href, APPLY_ORIGIN).href;
    } catch { continue; }
    const id = href.match(/\/careers\/job\/(\d+)/)?.[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    links.push({ id, href, index: match.index });
  }
  return links;
}

function lastHeadingBefore(html, index) {
  const prefix = html.slice(Math.max(0, index - 60000), index);
  const matches = [...prefix.matchAll(/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/gi)];
  return clean(matches.at(-1)?.[1] || '');
}

function roleSegment(html, index) {
  const prefixStart = Math.max(0, index - 50000);
  const prefix = html.slice(prefixStart, index);
  const h3Matches = [...prefix.matchAll(/<h3\b[^>]*>[\s\S]*?<\/h3>/gi)];
  const last = h3Matches.at(-1);
  const start = last ? prefixStart + last.index : Math.max(0, index - 18000);
  return html.slice(start, index + 1000);
}

function parseLocation(text) {
  const match = text.match(/United States\s*,\s*([A-Za-z .'-]+?)\s*,\s*([A-Za-z .'-]+?)(?=\s+(?:Fully|[0-9]+\s+days?|Overview|Work site|Hybrid|Remote|\+\d+\s+more|$))/i)
    || text.match(/United States\s*,\s*([A-Za-z .'-]+?)\s*,\s*([A-Za-z .'-]+)/i);
  if (!match) return null;
  const state = clean(match[1]);
  const city = clean(match[2]).replace(/\s+\+\d+\s+more.*$/i, '');
  const code = stateCodes[state] || (state.length === 2 ? state.toUpperCase() : state);
  return `${city}, ${code}`;
}

function requiredSection(text) {
  const lower = text.toLowerCase();
  const starts = ['required qualifications', 'basic qualifications'];
  let start = -1;
  for (const label of starts) {
    const i = lower.indexOf(label);
    if (i !== -1 && (start === -1 || i < start)) start = i;
  }
  if (start === -1) return text;
  const tail = text.slice(start);
  const lowerTail = tail.toLowerCase();
  const ends = ['preferred qualifications', 'other requirements', 'background check requirements'];
  let end = tail.length;
  for (const label of ends) {
    const i = lowerTail.indexOf(label);
    if (i > 0 && i < end) end = i;
  }
  return tail.slice(0, end);
}

function experienceYears(text) {
  const out = [];
  const patterns = [
    /(?:and|with|minimum(?: of)?|at least)?\s*(\d{1,2})\+?\s*(?:-|–|to)\s*(\d{1,2})\s+years?[^.;]{0,90}experience/gi,
    /(?:and|with|minimum(?: of)?|at least)?\s*(\d{1,2})\+?\s+years?[^.;]{0,90}experience/gi,
    /experience[^.;]{0,50}?(\d{1,2})\+?\s+years?/gi
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      out.push(Number(match[1]));
      if (match[2]) out.push(Number(match[2]));
    }
  }
  return out.filter(Number.isFinite);
}

function classify(title, text) {
  if (!title || seniorTitlePattern.test(title) || !relevantTitlePattern.test(title)) return null;
  const req = requiredSection(text);
  const years = experienceYears(req);
  if (years.some(year => year >= 6)) return null;

  let experience = '0-2-years';
  const reqLower = req.toLowerCase();
  if (/\b(?:no experience|0\+\s*(?:months?|years?)|entry[- ]level)\b/.test(reqLower)) experience = 'no-experience';
  else if (years.some(year => year >= 3)) experience = '2-5-years';
  else if (!years.length && !/high school diploma|high school qualification|equivalent experience/i.test(req)) return null;

  let type = 'entry-level';
  if (/intern/i.test(title)) type = 'internship';
  else if (/apprentice/i.test(title)) type = 'apprenticeship';
  else if (/trainee|skillbridge/i.test(title)) type = 'trainee';
  return { type, experience };
}

function extractPay(text) {
  const range = text.match(/USD\s*\$([\d,.]+)\s*(?:-|–|to)\s*\$?([\d,.]+)\s+per\s+(hour|year)/i);
  if (!range) return { pay:'Pay not listed', salaryMin:null, salaryMax:null, salarySortMax:null };
  const min = Number(range[1].replace(/,/g, ''));
  const max = Number(range[2].replace(/,/g, ''));
  const hourly = /hour/i.test(range[3]);
  return {
    pay:`$${range[1]}–$${range[2]} / ${hourly ? 'hr' : 'year'}`,
    salaryMin:min,
    salaryMax:max,
    salarySortMax: hourly ? Math.round(max * 2080) : max
  };
}

function tagsFor(title, text, experience) {
  const hay = `${title} ${text}`.toLowerCase();
  const tags = [experience === 'no-experience' ? 'No Experience Needed' : experience === '2-5-years' ? '2–5 Years' : '0–2 Years'];
  if (/critical environment|critical facilit|ups|generator|chiller|mechanical|hvac/.test(hay)) tags.push('Critical Facilities');
  if (/electrical|switchgear|power distribution/.test(hay)) tags.push('Electrical');
  if (/network|cabling|fiber|server/.test(hay)) tags.push('IT / Hardware');
  return [...new Set(tags)].slice(0, 5);
}

function dedupe(jobs) {
  const urls = new Set();
  const ids = new Set();
  const identities = new Set();
  const out = [];
  for (const job of jobs) {
    const identity = [job.company, job.title, job.location].map(normalizeIdentity).join('|');
    if (ids.has(job.id) || urls.has(job.sourceUrl) || identities.has(identity)) continue;
    ids.add(job.id); urls.add(job.sourceUrl); identities.add(identity); out.push(job);
  }
  return out;
}

const current = JSON.parse(await readFile('data/jobs.json','utf8'));
if (!Array.isArray(current)) throw new Error('data/jobs.json must contain an array.');
let status = {};
try { status = JSON.parse(await readFile('data/collector-status.json','utf8')); } catch {}

const previousMicrosoft = current.filter(job =>
  clean(job?.company) === COMPANY || /^https:\/\/apply\.careers\.microsoft\.com\//i.test(String(job?.sourceUrl || ''))
);
const drops = { nonUs:0, seniorOrIrrelevant:0, experience:0 };
const discovered = [];
const errors = [];
let links = [];
let sourceHealthy = true;

try {
  const html = await fetchText(SOURCE_URL);
  links = extractApplyLinks(html);
  if (!links.length) throw new Error('Microsoft datacenter page returned no job detail links');

  for (const link of links) {
    const segmentHtml = roleSegment(html, link.index);
    const text = clean(segmentHtml);
    const title = lastHeadingBefore(html, link.index);
    const location = parseLocation(text);
    if (!location) { drops.nonUs += 1; continue; }
    if (!title || seniorTitlePattern.test(title) || !relevantTitlePattern.test(title)) { drops.seniorOrIrrelevant += 1; continue; }
    const cls = classify(title, text);
    if (!cls) { drops.experience += 1; continue; }
    const postedDate = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1] || null;
    discovered.push({
      id:`microsoft-${link.id}`,
      title,
      company:COMPANY,
      location,
      type:cls.type,
      experience:cls.experience,
      tags:tagsFor(title, text, cls.experience),
      ...extractPay(text),
      postedAt:postedDate ? new Date(`${postedDate}T12:00:00Z`).toISOString() : null,
      source:'Microsoft Datacenter Careers',
      sourceUrl:link.href,
      active:true,
      demo:false
    });
  }
} catch (error) {
  sourceHealthy = false;
  errors.push(error.message);
}

let snapshot;
if (sourceHealthy) {
  // A healthy Microsoft datacenter page is authoritative, including a legitimate zero-result day.
  // This prevents closed Microsoft roles from lingering in the combined feed after they disappear.
  snapshot = dedupe(discovered);
} else if (previousMicrosoft.length) {
  // A transient source failure should not erase previously verified Microsoft opportunities.
  snapshot = dedupe(previousMicrosoft);
  errors.push(`Retained ${snapshot.length} previously verified Microsoft role(s) because the source could not be refreshed.`);
} else {
  throw new Error(`Microsoft datacenter collector failed and no prior verified roles exist: ${errors.join(' | ')}`);
}

const withoutMicrosoft = current.filter(job =>
  clean(job?.company) !== COMPANY && !/^https:\/\/apply\.careers\.microsoft\.com\//i.test(String(job?.sourceUrl || ''))
);
const merged = dedupe([...withoutMicrosoft, ...snapshot]);
const now = Date.now();
for (const job of merged) {
  job.postedHours = job.postedAt ? Math.max(0, Math.round((now - new Date(job.postedAt).getTime()) / 36e5)) : (job.postedHours ?? 9999);
}

const countsByType = merged.reduce((acc, job) => { acc[job.type] = (acc[job.type] || 0) + 1; return acc; }, {});
const countsByExperience = merged.reduce((acc, job) => { acc[job.experience] = (acc[job.experience] || 0) + 1; return acc; }, {});
const cleanGlobalErrors = (status.errors || []).filter(error => !String(error).startsWith('Microsoft Datacenter:'));

await writeFile('data/jobs.json', JSON.stringify(merged, null, 2) + '\n');
await writeFile('data/collector-status.json', JSON.stringify({
  ...status,
  updatedAt:new Date().toISOString(),
  jobs:merged.length,
  countsByType,
  countsByExperience,
  microsoftDatacenter:{
    officialSource:SOURCE_URL,
    sourceHealthy,
    candidateLinks:links.length,
    qualifyingRoles:snapshot.length,
    currentQualifyingRoles:discovered.length,
    retainedPrevious:!sourceHealthy && previousMicrosoft.length > 0,
    drops,
    errors
  },
  errors:[...cleanGlobalErrors, ...errors.map(error => `Microsoft Datacenter: ${error}`)]
}, null, 2) + '\n');

console.log(sourceHealthy
  ? `Microsoft datacenter source refreshed authoritatively: ${links.length} official role links, ${snapshot.length} qualifying U.S. 0–5 year roles.`
  : `Microsoft datacenter source unavailable; retained ${snapshot.length} previously verified role(s).`);
if (errors.length) console.warn(`Microsoft datacenter warnings: ${errors.join(' | ')}`);
