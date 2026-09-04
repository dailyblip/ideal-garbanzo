import { readFile, writeFile } from 'node:fs/promises';

const APPLY = 'https://apply.careers.microsoft.com';
const SEARCH = `${APPLY}/api/pcsx/search`;
const DETAIL = `${APPLY}/api/pcsx/position_details`;
const DOMAIN = 'microsoft.com';
const COMPANY = 'Microsoft';
const QUERIES = ['data center technician','datacenter technician','critical environment','critical facilities','inventory and asset','data center'];
const LEGACY = [
  'https://careers.microsoft.com/v2/global/en/datacentertechnicians.html',
  'https://careers.microsoft.com/v2/global/en/datacenters.html'
];
const senior = /\b(?:senior|sr\.?|lead|principal|manager|director|vice president|vp|head of|staff engineer|supervisor|superintendent|foreman|architect|program manager)\b/i;
const candidate = /\b(?:data\s*center|datacenter|critical environment|critical facilities|field service engineer|inventory and asset|technician|operations technician)\b/i;
const strong = /\b(?:data\s*center|datacenter|critical environment|critical facilities)\b/i;
const context = /\b(?:data\s*center|datacenter|critical environment|critical facilities|mission[- ]critical|server|rack|ups|switchgear|generator|chiller|cooling|electrical|mechanical|facility operations)\b/i;
const states = {Alabama:'AL',Alaska:'AK',Arizona:'AZ',Arkansas:'AR',California:'CA',Colorado:'CO',Connecticut:'CT',Delaware:'DE',Florida:'FL',Georgia:'GA',Hawaii:'HI',Idaho:'ID',Illinois:'IL',Indiana:'IN',Iowa:'IA',Kansas:'KS',Kentucky:'KY',Louisiana:'LA',Maine:'ME',Maryland:'MD',Massachusetts:'MA',Michigan:'MI',Minnesota:'MN',Mississippi:'MS',Missouri:'MO',Montana:'MT',Nebraska:'NE',Nevada:'NV','New Hampshire':'NH','New Jersey':'NJ','New Mexico':'NM','New York':'NY','North Carolina':'NC','North Dakota':'ND',Ohio:'OH',Oklahoma:'OK',Oregon:'OR',Pennsylvania:'PA','Rhode Island':'RI','South Carolina':'SC','South Dakota':'SD',Tennessee:'TN',Texas:'TX',Utah:'UT',Vermont:'VT',Virginia:'VA',Washington:'WA','West Virginia':'WV',Wisconsin:'WI',Wyoming:'WY','District of Columbia':'DC'};
const stateMap = new Map(Object.entries(states).flatMap(([name, code]) => [[name.toLowerCase(),code],[code.toLowerCase(),code]]));
const numberWords = {zero:'0',one:'1',two:'2',three:'3',four:'4',five:'5',six:'6',seven:'7',eight:'8',nine:'9',ten:'10'};
const clean = v => String(v ?? '').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&ndash;|&#8211;/gi,'–').replace(/&mdash;|&#8212;/gi,'—').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
const identity = v => clean(v).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();

async function readJson(path, fallback) { try { return JSON.parse(await readFile(path,'utf8')); } catch { return fallback; } }
async function get(url, accept='application/json') {
  const r = await fetch(url,{headers:{accept,'user-agent':'DataCenterCareersBot/1.8 (+https://datacentercareers.us/)'},redirect:accept.includes('json')?'error':'follow'});
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return accept.includes('json') ? r.json() : r.text();
}
function required(text) {
  const value=clean(text), lower=value.toLowerCase();
  const starts=['required qualifications','basic qualifications','minimum qualifications'];
  let start=-1; for (const x of starts) { const i=lower.indexOf(x); if(i>=0&&(start<0||i<start)) start=i; }
  if(start<0) return value;
  const tail=value.slice(start), tl=tail.toLowerCase(); let end=tail.length;
  for(const x of ['preferred qualifications','preferred experience','other requirements','background check requirements','additional or preferred qualifications']) { const i=tl.indexOf(x); if(i>0&&i<end) end=i; }
  return tail.slice(0,end);
}
function years(text) {
  const t=clean(text).toLowerCase().replace(/\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/g,w=>numberWords[w]||w), out=[];
  for(const re of [/(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s+years?(?:\(s\))?[^.;]{0,100}experience/gi,/(\d{1,2})\s*(?:\+|or more)?\s+years?(?:\(s\))?[^.;]{0,100}experience/gi,/experience[^.;]{0,70}?(\d{1,2})\s*(?:\+|or more)?\s+years?(?:\(s\))?/gi,/(?:minimum(?: of)?\s+|at least\s+)(\d{1,2})\s*(?:\+|or more)?\s+years?(?:\(s\))?\b/gi]) {
    for(const m of t.matchAll(re)){ out.push(Number(m[1])); if(m[2]) out.push(Number(m[2])); }
  }
  return out.filter(n=>Number.isFinite(n)&&n>=0&&n<=50);
}
function relevant(title,text='') { return Boolean(title)&&!senior.test(title)&&candidate.test(title)&&(strong.test(title)||context.test(`${title} ${text}`)); }
function classify(title,text='') {
  if(!relevant(title,text)) return null;
  const req=required(text), ys=years(req); if(ys.some(y=>y>5)) return null;
  let type='entry-level'; if(/intern/i.test(title)) type='internship'; else if(/apprentice/i.test(title)) type='apprenticeship'; else if(/trainee|skillbridge/i.test(title)) type='trainee';
  const noexp=/\b(?:no experience(?: required| needed)?|0\+?\s*(?:months?|years?)|entry[- ]level)\b/i.test(req);
  const baseline=/high school diploma|high school qualification|secondary school|equivalent experience/i.test(req);
  if(!ys.length&&!noexp&&!baseline&&type==='entry-level') return null;
  return {type,experience:noexp?'no-experience':ys.some(y=>y>=3)?'2-5-years':'0-2-years'};
}

if(process.argv.includes('--test-experience-parser')) {
  const tests=[
    ['Critical Environment Field Service Engineer','Required Qualifications Two years of experience maintaining critical environment systems. Preferred Qualifications Seven years of experience.','entry-level/0-2-years'],
    ['Critical Environment Technician','Required Qualifications 3+ years of experience in data center critical facilities.','entry-level/2-5-years'],
    ['Data Center Technician','Required Qualifications At least 6 years of experience in data center operations.',null],
    ['Data Center Technician','Required Qualifications High School Diploma or equivalent experience. Training is provided.','entry-level/0-2-years'],
    ['Senior Data Center Technician','Required Qualifications 2 years of experience in data center operations.',null]
  ];
  const bad=[]; for(const [title,text,want] of tests){ const r=classify(title,text), got=r?`${r.type}/${r.experience}`:null; if(got!==want) bad.push(`${title}: expected ${want}, got ${got}`); }
  if(bad.length){ bad.forEach(x=>console.error(`Microsoft parser regression: ${x}`)); process.exit(1); }
  console.log(`Microsoft experience parser passed ${tests.length} regression cases.`); process.exit(0);
}

function idOf(p={}) { for(const v of [p.id,p.positionId,p.position_id,p.atsJobId,p.displayJobId]) { const v2=clean(v); if(v2) return v2; } return ''; }
function titleOf(p={}) { return clean(p.name||p.title||p.postingName||p.posting_name||p.hiringTitle||''); }
function usLocation(p={}) {
  const values=Array.isArray(p.standardizedLocations)&&p.standardizedLocations.length?p.standardizedLocations:Array.isArray(p.locations)&&p.locations.length?p.locations:[p.location];
  for(const raw of values.map(clean).filter(Boolean)) {
    const parts=raw.split(/\s*[|·]\s*|\s*,\s*/).map(clean).filter(Boolean), low=parts.map(x=>x.toLowerCase().replace(/\.$/,''));
    const si=low.findIndex(x=>stateMap.has(x)), ui=low.findIndex(x=>/^(?:united states(?: of america)?|usa|u\.s\.?a?\.?)$/i.test(x)); if(si<0) continue;
    let city=si>0&&si-1!==ui?parts[si-1]:si+1<parts.length&&si+1!==ui?parts[si+1]:''; city=clean(city).replace(/\bUnited States(?: of America)?\b/gi,'').replace(/^[-,\s]+|[-,\s]+$/g,'');
    if(city) return `${city}, ${stateMap.get(low[si])}`;
  }
  return null;
}
function dateOf(p={}) { for(const v of [p.postedTs,p.creationTs,p.postedAt,p.posted_at]) { if(v==null||v==='') continue; const n=Number(v); const d=Number.isFinite(n)&&n>0?new Date(n<1e12?n*1000:n):new Date(v); if(!Number.isNaN(d.getTime())) return d.toISOString(); } return null; }
function sourceUrl(p,id) { for(const v of [p.publicUrl,p.positionUrl]) { try { const u=new URL(clean(v),APPLY); if(u.protocol==='https:'&&u.hostname==='apply.careers.microsoft.com') return u.href; } catch {} } return `${APPLY}/careers/job/${encodeURIComponent(id)}?hl=en`; }
function pay(text) { const m=clean(text).match(/(?:USD\s*)?\$([\d,.]+)\s*(?:-|–|to)\s*\$?([\d,.]+)\s*(?:USD\s*)?(?:per|\/)?\s*(hour|hourly|hr|year|yearly|yr|annual|annually)/i); if(!m) return {pay:'Pay not listed',salaryMin:null,salaryMax:null,salarySortMax:null}; const min=Number(m[1].replace(/,/g,'')),max=Number(m[2].replace(/,/g,'')),hour=/hour|hr/i.test(m[3]); return {pay:`$${m[1]}–$${m[2]} / ${hour?'hr':'year'}`,salaryMin:min,salaryMax:max,salarySortMax:hour?Math.round(max*2080):max}; }
function tags(title,text,exp,type) { const h=`${title} ${text}`.toLowerCase(), out=[]; if(type==='internship')out.push('Internship'); if(type==='apprenticeship')out.push('Apprenticeship'); if(type==='trainee')out.push('Trainee'); out.push(exp==='no-experience'?'No Experience Needed':exp==='2-5-years'?'2–5 Years':'0–2 Years'); if(/critical environment|critical facilit|ups|generator|chiller|mechanical|hvac/.test(h))out.push('Critical Facilities'); if(/electrical|switchgear|power distribution/.test(h))out.push('Electrical'); if(/network|cabling|fiber|server|inventory and asset/.test(h))out.push('IT / Hardware'); return [...new Set(out)].slice(0,5); }
function dedupe(jobs){ const ids=new Set(),urls=new Set(),keys=new Set(),out=[]; for(const j of jobs){ const key=[j.company,j.title,j.location].map(identity).join('|'); if((j.id&&ids.has(j.id))||(j.sourceUrl&&urls.has(j.sourceUrl))||keys.has(key))continue; if(j.id)ids.add(j.id); if(j.sourceUrl)urls.add(j.sourceUrl); keys.add(key); out.push(j); } return out; }
function previousFor(p,previous){ const id=idOf(p), display=clean(p.displayJobId||p.atsJobId); return previous.find(j=>{ const sid=String(j.sourceUrl||'').match(/\/careers\/job\/([^/?#]+)/)?.[1]||''; return j.id===`microsoft-${id}`||sid===id||(display&&(j.id===`microsoft-${display}`||sid===display)); })||null; }

async function pcsx(previous) {
  const all=new Map(),queryStats=[],errors=[]; let healthy=true;
  for(const query of QUERIES){ try { let total=null,complete=false,pages=0,rows=0; for(let page=0;page<50;page++){ const start=page*10,qs=new URLSearchParams({domain:DOMAIN,query,location:'United States',start:String(start),sort_by:'relevance',filter_include_remote:'0'}); const data=(await get(`${SEARCH}?${qs}`))?.data; if(!data||!Array.isArray(data.positions))throw new Error('unexpected search payload'); const count=Number(data.count); if(page===0){if(!Number.isFinite(count)||count<0)throw new Error('invalid search count'); total=count;} pages++; rows+=data.positions.length; for(const p of data.positions){const id=idOf(p);if(id&&!all.has(id))all.set(id,p);} if(data.positions.length<10||start+10>=total){complete=true;break;} } if(!complete)throw new Error(`pagination cap before ${total} rows`); queryStats.push({query,healthy:true,pages,reportedRows:total,rows}); } catch(e){healthy=false;errors.push(`${query}: ${e.message}`);queryStats.push({query,healthy:false,error:e.message});} }
  if(healthy&&!all.size){healthy=false;errors.push('PCS-X returned zero unique positions across all data-center queries');}
  const plausible=[...all.values()].filter(p=>{const t=titleOf(p);return t&&!senior.test(t)&&candidate.test(t);}), jobs=[], drops={nonUs:0,irrelevant:0,experience:0,detailFailure:0}; let detailAttempts=0,detailVerified=0;
  if(healthy){ for(let i=0;i<plausible.length;i+=5){ const results=await Promise.all(plausible.slice(i,i+5).map(async p=>{const id=idOf(p);detailAttempts++;try{const qs=new URLSearchParams({position_id:id,domain:DOMAIN,hl:'en'}),data=(await get(`${DETAIL}?${qs}`))?.data,d=data?.position&&typeof data.position==='object'?data.position:data;if(!d||typeof d!=='object')throw new Error('unexpected detail payload');detailVerified++;const title=titleOf(d)||titleOf(p),text=clean(d.jobDescription||d.job_description||d.description||''),location=usLocation(d)||usLocation(p);if(!location)return{drop:'nonUs'};if(!relevant(title,text))return{drop:'irrelevant'};const cls=classify(title,text);if(!cls)return{drop:'experience'};const merged={...p,...d};return{job:{id:`microsoft-${id}`,title,company:COMPANY,location,type:cls.type,experience:cls.experience,tags:tags(title,text,cls.experience,cls.type),...pay(text),postedAt:dateOf(merged),source:'Official Microsoft Careers',sourceUrl:sourceUrl(merged,id),active:true,demo:false}};}catch(e){const old=previousFor(p,previous);return{job:old,drop:'detailFailure',warning:`${titleOf(p)||id}: ${e.message}${old?' (kept previous verified role still present in search)':''}`};}})); for(const r of results){if(r.job)jobs.push(r.job);if(r.drop)drops[r.drop]++;if(r.warning)errors.push(r.warning);} } }
  const out=dedupe(jobs); if(healthy&&previous.length&&plausible.length&&!out.length){healthy=false;errors.push(`Refused to erase ${previous.length} previous role(s) after ${plausible.length} plausible current results produced zero verified roles.`);}
  return {healthy,jobs:out,candidateRows:all.size,plausibleRows:plausible.length,detailAttempts,detailVerified,queryStats,drops,errors};
}

function legacyLinks(html){const out=[],seen=new Set(),re=/href=["']([^"']*apply\.careers\.microsoft\.com\/careers\/job\/\d+[^"']*|\/careers\/job\/\d+[^"']*)["']/gi;for(const m of html.matchAll(re)){let href;try{href=new URL(clean(m[1]),APPLY).href;}catch{continue;}const id=href.match(/\/careers\/job\/(\d+)/)?.[1];if(id&&!seen.has(id)){seen.add(id);out.push({id,href,index:m.index});}}return out;}
function legacyHeading(html,index){const m=[...html.slice(Math.max(0,index-60000),index).matchAll(/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/gi)];return clean(m.at(-1)?.[1]||'');}
function legacySegment(html,index){const start=Math.max(0,index-50000),prefix=html.slice(start,index),m=[...prefix.matchAll(/<h3\b[^>]*>[\s\S]*?<\/h3>/gi)].at(-1);return html.slice(m?start+m.index:Math.max(0,index-18000),index+1000);}
function legacyLocation(text){const m=text.match(/United States\s*,\s*([A-Za-z .'-]+?)\s*,\s*([A-Za-z .'-]+?)(?=\s+(?:Fully|[0-9]+\s+days?|Overview|Work site|Hybrid|Remote|\+\d+\s+more|$))/i)||text.match(/United States\s*,\s*([A-Za-z .'-]+?)\s*,\s*([A-Za-z .'-]+)/i);if(!m)return null;const state=clean(m[1]),city=clean(m[2]).replace(/\s+\+\d+\s+more.*$/i,'');return `${city}, ${states[state]||stateMap.get(state.toLowerCase())||state}`;}
async function legacy(){const pages=[],map=new Map(),errors=[];let healthy=true;for(const url of LEGACY){try{const html=await get(url,'text/html'),links=legacyLinks(html);pages.push({url,healthy:true,candidateLinks:links.length});for(const l of links)if(!map.has(l.id))map.set(l.id,{...l,html});}catch(e){healthy=false;errors.push(`${url}: ${e.message}`);pages.push({url,healthy:false,error:e.message});}}if(healthy&&!map.size){healthy=false;errors.push('legacy pages returned zero links');}const jobs=[];if(healthy)for(const l of map.values()){const text=clean(legacySegment(l.html,l.index)),title=legacyHeading(l.html,l.index),location=legacyLocation(text),cls=location?classify(title,text):null;if(!location||!cls)continue;const d=text.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1]||null;jobs.push({id:`microsoft-${l.id}`,title,company:COMPANY,location,type:cls.type,experience:cls.experience,tags:tags(title,text,cls.experience,cls.type),...pay(text),postedAt:d?new Date(`${d}T12:00:00Z`).toISOString():null,source:'Official Microsoft Careers',sourceUrl:l.href,active:true,demo:false});}return{healthy,jobs:dedupe(jobs),pages,errors};}

const current=await readJson('data/jobs.json',null);if(!Array.isArray(current))throw new Error('data/jobs.json must contain an array.');const status=await readJson('data/collector-status.json',{}),previous=dedupe(current.filter(j=>clean(j.company)===COMPANY||/^https:\/\/apply\.careers\.microsoft\.com\//i.test(String(j.sourceUrl||''))));
const direct=await pcsx(previous);let snapshot=direct.jobs,sourceMode='eightfold-pcsx',sourceHealthy=direct.healthy,legacyStatus=null,errors=[...direct.errors];
if(!sourceHealthy){legacyStatus=await legacy();errors.push(...legacyStatus.errors.map(e=>`legacy fallback: ${e}`));if(legacyStatus.healthy&&legacyStatus.jobs.length){snapshot=legacyStatus.jobs;sourceMode='legacy-curated';sourceHealthy=true;}else if(previous.length){snapshot=previous;sourceMode='retained-previous';errors.push(`Retained ${snapshot.length} previously verified Microsoft role(s) because direct sources could not refresh safely.`);}else throw new Error(`Microsoft collector failed with no prior verified roles: ${errors.join(' | ')}`);}
snapshot=dedupe(snapshot);const merged=dedupe([...current.filter(j=>clean(j.company)!==COMPANY&&!/^https:\/\/apply\.careers\.microsoft\.com\//i.test(String(j.sourceUrl||''))),...snapshot]),now=Date.now();for(const j of merged)j.postedHours=j.postedAt?Math.max(0,Math.round((now-new Date(j.postedAt).getTime())/36e5)):(j.postedHours??9999);
const countsByType=merged.reduce((a,j)=>(a[j.type]=(a[j.type]||0)+1,a),{}),countsByExperience=merged.reduce((a,j)=>(a[j.experience]=(a[j.experience]||0)+1,a),{}),cleanErrors=(status.errors||[]).filter(e=>!String(e).startsWith('Microsoft Datacenter:'));
await writeFile('data/jobs.json',JSON.stringify(merged,null,2)+'\n');await writeFile('data/collector-status.json',JSON.stringify({...status,updatedAt:new Date().toISOString(),jobs:merged.length,countsByType,countsByExperience,microsoftDatacenter:{officialSource:`${APPLY}/careers`,apiSource:SEARCH,sourceMode,sourceHealthy,queryStats:direct.queryStats,candidateRows:direct.candidateRows,plausibleRows:direct.plausibleRows,detailAttempts:direct.detailAttempts,detailVerified:direct.detailVerified,currentQualifyingRoles:direct.jobs.length,qualifyingRoles:snapshot.length,retainedPrevious:sourceMode==='retained-previous',drops:direct.drops,legacyFallback:legacyStatus?{healthy:legacyStatus.healthy,pages:legacyStatus.pages,qualifyingRoles:legacyStatus.jobs.length}:null,errors},errors:[...cleanErrors,...errors.map(e=>`Microsoft Datacenter: ${e}`)]},null,2)+'\n');
console.log(sourceMode==='eightfold-pcsx'?`Microsoft PCS-X refreshed: ${direct.candidateRows} unique results, ${snapshot.length} verified U.S. 0–5 year roles.`:sourceMode==='legacy-curated'?`Microsoft PCS-X unavailable; refreshed ${snapshot.length} verified legacy roles.`:`Microsoft direct sources unavailable; retained ${snapshot.length} previous role(s).`);if(errors.length)console.warn(`Microsoft datacenter warnings: ${errors.join(' | ')}`);
