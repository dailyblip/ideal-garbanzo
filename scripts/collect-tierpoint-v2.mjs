import { readFile, writeFile } from 'node:fs/promises';

const COMPANY = 'TierPoint';
const ORIGIN = 'https://careers-tierpoint.icims.com';
const SEARCH_URL = `${ORIGIN}/jobs/search?hashed=-626007049&ss=1`;
const SNAPSHOT_PATH = 'data/tierpoint-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';

const stateCodes = new Map(Object.entries({
  Alabama:'AL',Alaska:'AK',Arizona:'AZ',Arkansas:'AR',California:'CA',Colorado:'CO',Connecticut:'CT',Delaware:'DE',Florida:'FL',Georgia:'GA',Hawaii:'HI',Idaho:'ID',Illinois:'IL',Indiana:'IN',Iowa:'IA',Kansas:'KS',Kentucky:'KY',Louisiana:'LA',Maine:'ME',Maryland:'MD',Massachusetts:'MA',Michigan:'MI',Minnesota:'MN',Mississippi:'MS',Missouri:'MO',Montana:'MT',Nebraska:'NE',Nevada:'NV','New Hampshire':'NH','New Jersey':'NJ','New Mexico':'NM','New York':'NY','North Carolina':'NC','North Dakota':'ND',Ohio:'OH',Oklahoma:'OK',Oregon:'OR',Pennsylvania:'PA','Rhode Island':'RI','South Carolina':'SC','South Dakota':'SD',Tennessee:'TN',Texas:'TX',Utah:'UT',Vermont:'VT',Virginia:'VA',Washington:'WA','West Virginia':'WV',Wisconsin:'WI',Wyoming:'WY'
}));
const excludedTitle = /\b(?:senior|sr\.?|lead|principal|manager|director|vice president|vp|head of|supervisor|architect|sales|account executive|cloud engineer|support analyst|operations specialist)\b/i;

const decode = value => String(value ?? '')
  .replace(/&nbsp;|&#160;/gi,' ')
  .replace(/&amp;/gi,'&')
  .replace(/&#39;|&apos;/gi,"'")
  .replace(/&quot;/gi,'"')
  .replace(/&#x2F;/gi,'/');
const textify = html => decode(String(html ?? ''))
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ')
  .replace(/<\/(?:p|div|li|h1|h2|h3|section|article)>/gi,'\n')
  .replace(/<br\s*\/?>/gi,'\n')
  .replace(/<[^>]*>/g,' ')
  .replace(/\r/g,'')
  .replace(/[ \t]+/g,' ')
  .replace(/\n\s*\n+/g,'\n')
  .trim();
const clean = value => decode(String(value ?? '')).replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
const normalize = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path,'utf8')); } catch { return fallback; }
}
async function fetchHtml(url) {
  const response = await fetch(url,{headers:{accept:'text/html,application/xhtml+xml','user-agent':'Mozilla/5.0 (compatible; DataCenterCareersBot/1.5; +https://datacentercareers.us/)'} ,redirect:'follow'});
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.text();
}

function linksFrom(html) {
  const urls = new Set();
  for (const match of html.matchAll(/href=["']([^"']*\/jobs\/\d+\/[^"']+?\/job(?:\?[^"']*)?)["']/gi)) {
    try {
      const url = new URL(match[1],ORIGIN);
      if (url.hostname === 'careers-tierpoint.icims.com') {
        url.search=''; url.hash=''; urls.add(url.toString());
      }
    } catch {}
  }
  return [...urls];
}

async function listJobs() {
  const urls = new Set();
  let pages = 1;
  let attempted = 0;
  let succeeded = 0;
  for (let page=0; page<Math.min(pages,10); page+=1) {
    attempted += 1;
    const url = page === 0 ? SEARCH_URL : `${ORIGIN}/jobs/search?o=&pr=${page}&schemaId=`;
    const html = await fetchHtml(url);
    succeeded += 1;
    const text = textify(html);
    const pageInfo = text.match(/Search Results Page\s+(\d+)\s+of\s+(\d+)/i);
    if (pageInfo) pages = Math.max(pages, Math.min(10,Number(pageInfo[2])));
    for (const link of linksFrom(html)) urls.add(link);
  }
  if (!urls.size) throw new Error('official TierPoint iCIMS listing exposed zero job links');
  return { urls:[...urls], attempted, succeeded, pages };
}

function titleFrom(html,url) {
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1 && clean(h1[1])) return clean(h1[1]);
  const tag = clean(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  const fromTag = tag.match(/^(.+?)\s+in\s+.+?\s*\|\s*Careers at/i)?.[1];
  if (fromTag) return clean(fromTag);
  const slug = new URL(url).pathname.match(/\/jobs\/\d+\/([^/]+)\/job/i)?.[1] || '';
  return slug.split('-').map(word => /^(?:i|ii|iii|iv)$/i.test(word) ? word.toUpperCase() : word.charAt(0).toUpperCase()+word.slice(1)).join(' ');
}

function locationFrom(html,text) {
  const direct = text.match(/\bJob Locations?\s+US-([A-Z]{2})-([^\n]+)/i);
  if (direct) {
    const city = clean(direct[2]).replace(/\s+ID\s+\d{4}-\d+.*$/i,'').replace(/\s+Category\s+.*$/i,'').trim();
    if (city) return `${city}, ${direct[1].toUpperCase()}`;
  }
  const tag = clean(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  const loc = tag.match(/\s+in\s+([^,|]+),\s*([^|]+?)\s*\|\s*Careers at/i);
  if (loc) {
    const code = stateCodes.get(clean(loc[2]));
    if (code) return `${clean(loc[1])}, ${code}`;
  }
  return '';
}

function requiredYears(text) {
  const required = String(text).split(/\bPreferred (?:Experience|Qualifications?)\b/i)[0];
  const years=[];
  for (const pattern of [/(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s+years?\b/gi,/(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:\+|or more)?\s+years?\b/gi]) {
    for (const m of required.matchAll(pattern)) { years.push(Number(m[1])); if (m[2]) years.push(Number(m[2])); }
  }
  return years.filter(Number.isFinite);
}

function classify(title,text) {
  if (!title || excludedTitle.test(title) || !/\btechnician\b/i.test(title)) return null;
  const lower = text.toLowerCase();
  if (!/data center|datacenter/i.test(lower)) return null;
  const years = requiredYears(text);
  if (years.some(year=>year>5)) return null;
  const levelOne = /\btechnician\s+(?:i|1)\b/i.test(title);
  const levelTwoThree = /\btechnician\s+(?:ii|iii|2|3)\b/i.test(title);
  if (!levelOne && !levelTwoThree && !years.length) return null;
  if (levelOne && /\b(?:novice|entry[- ]level|no experience)\b/i.test(text)) return {type:'entry-level',experience:'no-experience'};
  if (levelTwoThree || years.some(year=>year>=3)) return {type:'entry-level',experience:'2-5-years'};
  return {type:'entry-level',experience:'0-2-years'};
}

function payFrom(text) {
  const m=text.match(/Pay Range\s*\$([\d,.]+)\s*(?:-|–|to)\s*\$?([\d,.]+)/i);
  if (!m) return {pay:'Pay not listed',salaryMin:null,salaryMax:null,salarySortMax:null};
  const min=Number(m[1].replace(/,/g,'')), max=Number(m[2].replace(/,/g,''));
  const hourly=max<500;
  return {pay:`$${m[1]}–$${m[2]} / ${hourly?'hr':'year'}`,salaryMin:min,salaryMax:max,salarySortMax:hourly?Math.round(max*2080):max};
}
function tags(title,text,experience) {
  const v=`${title} ${text}`.toLowerCase();
  const out=[experience==='no-experience'?'No Experience Needed':experience==='2-5-years'?'2–5 Years':'0–2 Years'];
  if (/electrical|switchgear|ups|generator/.test(v)) out.push('Electrical');
  if (/fiber|cabling|network|rack|server/.test(v)) out.push('Network / Cabling');
  if (/critical facilit|hvac|chiller|crah|crac|mechanical/.test(v)) out.push('Critical Facilities');
  if (/entry[- ]level|novice|training/.test(v)) out.push('Training / Mentorship');
  return [...new Set(out)].slice(0,5);
}

function dedupe(jobs) {
  const urls=new Set(), identities=new Set(), out=[];
  for (const job of jobs) {
    const id=[job.company,job.title,job.location].map(normalize).join('|');
    if (urls.has(job.sourceUrl)||identities.has(id)) continue;
    urls.add(job.sourceUrl); identities.add(id); out.push(job);
  }
  return out;
}

const base=await readJson(JOBS_PATH,[]);
const previous=await readJson(SNAPSHOT_PATH,[]);
const priorStatus=await readJson(STATUS_PATH,{});
let sourceHealthy=true, error='', snapshot=[], listing=null;
const drops={parse:0,titleOrExperience:0};
const samples=[];

try {
  listing=await listJobs();
  for (let i=0;i<listing.urls.length;i+=6) {
    const batch=listing.urls.slice(i,i+6);
    const results=await Promise.all(batch.map(async url=>{
      try {
        const html=await fetchHtml(url), text=textify(html);
        const title=titleFrom(html,url), location=locationFrom(html,text);
        if (!title||!location) { drops.parse+=1; if(samples.length<6)samples.push({url,title,location,textPrefix:text.slice(0,180)}); return null; }
        const cls=classify(title,text);
        if (!cls) { drops.titleOrExperience+=1; if(samples.length<6)samples.push({url,title,location,reason:'classification'}); return null; }
        const numeric=new URL(url).pathname.match(/\/jobs\/(\d+)\//)?.[1]||normalize(url);
        return {id:`icims-tierpoint-${numeric}`,title,company:COMPANY,location,type:cls.type,experience:cls.experience,tags:tags(title,text,cls.experience),...payFrom(text),postedAt:null,postedHours:9999,source:'Employer career site',sourceUrl:url,active:true,demo:false};
      } catch (e) { drops.parse+=1; if(samples.length<6)samples.push({url,error:e.message}); return null; }
    }));
    snapshot.push(...results.filter(Boolean));
  }
  snapshot=dedupe(snapshot);
  if (!snapshot.length) throw new Error(`parsed ${listing.urls.length} official job links but found zero qualifying roles; drops=${JSON.stringify(drops)} samples=${JSON.stringify(samples)}`);
} catch (e) {
  sourceHealthy=false; error=e.message;
  if (Array.isArray(previous)&&previous.length) snapshot=previous;
  else throw e;
}

const merged=dedupe([...base.filter(job=>String(job?.company||'').trim()!==COMPANY),...snapshot]);
merged.sort((a,b)=>(a.postedHours??9999)-(b.postedHours??9999));
const status={...priorStatus,updatedAt:new Date().toISOString(),jobs:merged.length,sourcesAttempted:Number(priorStatus.sourcesAttempted||0)+1,providers:{...(priorStatus.providers||{}),icims:1},tierPoint:{officialSource:'https://www.tierpoint.com/about-us/careers/',boardUrl:SEARCH_URL,sourceHealthy,qualifyingRoles:snapshot.length,usedPreviousSnapshot:!sourceHealthy,listing:{pagesAttempted:listing?.attempted||0,pagesSucceeded:listing?.succeeded||0,reportedPages:listing?.pages||null,candidateLinks:listing?.urls?.length||0},drops,samples,...(error?{error}:{})},errors:error?[...(priorStatus.errors||[]),`TierPoint: ${error} (kept previous verified snapshot)`]:(priorStatus.errors||[])};
await writeFile(SNAPSHOT_PATH,JSON.stringify(snapshot,null,2)+'\n');
await writeFile(JOBS_PATH,JSON.stringify(merged,null,2)+'\n');
await writeFile(STATUS_PATH,JSON.stringify(status,null,2)+'\n');
console.log(`TierPoint ${sourceHealthy?'verified':'preserved'} ${snapshot.length} qualifying employer-direct role(s); ${merged.length} total jobs.`);
