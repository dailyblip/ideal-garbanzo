import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const OFFICIAL_SOURCE = 'https://sabey.com/about/careers';
const RECRUITER_BOARD = 'https://careers2-anothersource.icims.com/jobs/search?hashed=-625979185&ss=1';
const RECRUITER_ORIGIN = new URL(RECRUITER_BOARD).origin;
const COMPANY = 'Sabey Data Centers';

const clean = value => String(value ?? '')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;|&#160;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&quot;/gi, '"')
  .replace(/&#8211;|&ndash;/gi, '–')
  .replace(/&#8212;|&mdash;/gi, '—')
  .replace(/\s+/g, ' ')
  .trim();
const lower = value => clean(value).toLowerCase();
const hash = value => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 14);

const missionTitlePattern = /\bdata center\b.*\b(?:operations?|facilit(?:y|ies)|mechanical|electrical|critical|technician|engineer)\b/i;
const excludedTitlePattern = /\b(?:senior|sr\.?|lead|principal|chief|manager|director|vice president|vp|head of|staff|supervisor|superintendent|foreman)\b/i;
const experienceNumberWords = new Map([
  ['zero', '0'], ['one', '1'], ['two', '2'], ['three', '3'], ['four', '4'], ['five', '5'],
  ['six', '6'], ['seven', '7'], ['eight', '8'], ['nine', '9'], ['ten', '10']
]);

function normalizeExperienceNumbers(text = '') {
  return lower(text).replace(/\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/g, word => experienceNumberWords.get(word) || word);
}

function statedExperienceYears(text = '') {
  const normalized = normalizeExperienceNumbers(text);
  const values = [];
  const patterns = [
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\+?\s*(?:-|–|to)\s*(\d{1,2})\s+years?(?:\s+(?:of|prior))?\s+(?:[a-z0-9/&+(),.'’\-]+\s+){0,12}experience\b/gi,
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:\+|or more)?\s+years?(?:\s+(?:of|prior))?\s+(?:[a-z0-9/&+(),.'’\-]+\s+){0,12}experience\b/gi,
    /experience(?:\s+(?:of|in))?\s+(?:at least\s+|minimum(?: of)?\s+)?(\d{1,2})\s*(?:\+|or more)?\s+years?\b/gi
  ];
  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      const prefix = normalized.slice(Math.max(0, (match.index || 0) - 100), match.index || 0);
      if (/\bpreferred(?: qualifications?| experience| skills?)?\b/.test(prefix)) continue;
      values.push(Number(match[1]));
      if (match[2]) values.push(Number(match[2]));
    }
  }
  return values.filter(value => Number.isFinite(value) && value >= 0 && value <= 50);
}

function classify(title, text) {
  if (!missionTitlePattern.test(title) || excludedTitlePattern.test(title)) return null;
  const normalized = lower(`${title} ${text}`);
  const years = statedExperienceYears(normalized);
  if (years.some(year => year > 5)) return null;

  if (years.some(year => year >= 3)) return { type: 'entry-level', experience: '2-5-years' };
  if (years.some(year => year <= 2)) return { type: 'entry-level', experience: '0-2-years' };

  // High-school requirements and level numerals do not prove a 0–5 year
  // experience ceiling. Fail closed until the recruiter page states one.
  return null;
}

function decodeHref(value = '') {
  return String(value).replace(/&amp;/gi, '&').trim();
}

function normalizeRecruiterUrl(value = '') {
  try {
    const url = new URL(decodeHref(value), RECRUITER_BOARD);
    if (url.origin !== RECRUITER_ORIGIN) return '';
    if (!/^\/jobs\/\d+\/.+\/job\/?$/i.test(url.pathname)) return '';
    return url.href;
  } catch {
    return '';
  }
}

function extractJobLinks(html) {
  const links = [];
  const pattern = /href=["']([^"']*(?:careers2-anothersource\.icims\.com)?\/jobs\/\d+\/[^"']*\/job[^"']*)["']/gi;
  for (const match of html.matchAll(pattern)) {
    const url = normalizeRecruiterUrl(match[1]);
    if (url && !links.includes(url)) links.push(url);
  }
  return links;
}

function extractRecruiterSabeyLinks(html) {
  const links = [];
  const pattern = /<a\b[^>]*href=["']([^"']*\/jobs\/\d+\/[^"']*\/job[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    const label = clean(match[2]);
    if (!/\bSabey Data Center(?:s| Properties(?:,\s*LLC)?)\b/i.test(label)) continue;
    const url = normalizeRecruiterUrl(match[1]);
    if (url && !links.includes(url)) links.push(url);
  }
  return links;
}

function isSabeyDataCenterDetail(html) {
  const text = clean(html);
  return /\bCompany\s+Sabey Data Center(?:s| Properties(?:,\s*LLC)?)\b/i.test(text)
    || /Another Source(?:'s)? client,\s*Sabey Data Center(?:s| Properties(?:,\s*LLC)?)\b/i.test(text);
}

if (process.argv.includes('--test-experience-parser')) {
  const cases = [
    {
      name: 'project engineer with domain-specific three-year requirement',
      title: 'Data Center Electrical Project Engineer',
      text: 'Experience You Will Bring: Bachelor degree. 3+ years of electrical design or project engineering experience within commercial, industrial, mission-critical, or data center facilities.',
      expected: '2-5-years'
    },
    {
      name: 'worded requirement is parsed while higher preferred experience is ignored',
      title: 'Data Center Operations Engineer',
      text: 'Minimum qualifications: Three years of mission critical facilities experience. Preferred qualifications: Seven years of data center operations experience.',
      expected: '2-5-years'
    },
    {
      name: 'required experience over five years is rejected',
      title: 'Data Center Operations Engineer',
      text: 'Experience You Will Bring: 6+ years of critical facilities operations experience.',
      expected: null
    },
    {
      name: 'high school diploma alone does not imply early career',
      title: 'Data Center Operations Technician',
      text: 'High school diploma or GED required. General maintenance skills and technical curiosity required.',
      expected: null
    },
    {
      name: 'level two title alone does not imply five years or less',
      title: 'Data Center Operations Engineer 2',
      text: 'Experience maintaining mission-critical electrical infrastructure required.',
      expected: null
    },
    {
      name: 'one-year requirement remains early career',
      title: 'Data Center Facilities Technician',
      text: 'Minimum of 1 year of relevant facilities experience in a critical environment.',
      expected: '0-2-years'
    }
  ];
  const failures = [];
  for (const testCase of cases) {
    const actual = classify(testCase.title, testCase.text)?.experience ?? null;
    if (actual !== testCase.expected) failures.push(`${testCase.name}: expected ${testCase.expected}, got ${actual}`);
  }

  const recruiterFixture = `
    <a href="/jobs/102554/data-center-electrical-project-engineer---sabey-data-center-properties%2C-llc/job">Data Center Electrical Project Engineer - Sabey Data Center Properties, LLC</a>
    <a href="/jobs/999999/facilities-technician---other-client/job">Facilities Technician - Other Client</a>
    <a href="https://example.com/jobs/102555/data-center-mechanical-project-engineer---sabey-data-centers/job">Data Center Mechanical Project Engineer - Sabey Data Centers</a>
  `;
  const recruiterLinks = extractRecruiterSabeyLinks(recruiterFixture);
  if (recruiterLinks.length !== 1 || !recruiterLinks[0].includes('/jobs/102554/')) {
    failures.push(`recruiter fallback isolation: expected only Sabey iCIMS job 102554, got ${recruiterLinks.join(', ') || 'none'}`);
  }
  if (!isSabeyDataCenterDetail('<div>Company Sabey Data Centers Category Engineering</div>')) {
    failures.push('Sabey detail identity: expected Sabey Data Centers company marker to pass');
  }
  if (isSabeyDataCenterDetail('<div>Company Another Client Category Engineering</div>')) {
    failures.push('Sabey detail identity: non-Sabey recruiter client was accepted');
  }

  if (failures.length) {
    for (const failure of failures) console.error(`Sabey collector regression: ${failure}`);
    process.exit(1);
  }
  console.log(`Sabey collector passed ${cases.length} experience cases plus recruiter-board isolation checks.`);
  process.exit(0);
}

function extractPay(text) {
  const match = clean(text).match(/(?:salary(?: range)?\s*:?\s*)?\$([\d,.]+)\s*(?:-|–|to)\s*\$?([\d,.]+)/i);
  if (!match) return { pay: 'Pay not listed', salaryMin: null, salaryMax: null, salarySortMax: null };
  const min = Number(match[1].replace(/,/g, ''));
  const max = Number(match[2].replace(/,/g, ''));
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { pay: 'Pay not listed', salaryMin: null, salaryMax: null, salarySortMax: null };
  return {
    pay: `$${min.toLocaleString('en-US', { maximumFractionDigits: 2 })}–$${max.toLocaleString('en-US', { maximumFractionDigits: 2 })} / year`,
    salaryMin: min,
    salaryMax: max,
    salarySortMax: max
  };
}

function tagsFor(title, text, experience) {
  const value = lower(`${title} ${text}`);
  const tags = [experience === '2-5-years' ? '2–5 Years' : '0–2 Years'];
  if (/\belectrical\b|\bswitchgear\b|\bups\b/.test(value)) tags.push('Electrical');
  if (/\bmechanical\b|\bhvac\b|\bchiller\b|\bcrah\b|\bcrac\b/.test(value)) tags.push('Critical Facilities');
  if (/\btraining\b|\bdevelop(?:ing|ment)?\b|\blearn\b/.test(value)) tags.push('Training / Mentorship');
  return [...new Set(tags)].slice(0, 5);
}

function extractTitle(html) {
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  let title = clean(h1?.[1] || '');
  title = title.replace(/\s+-\s+Sabey Data Center(?:s| Properties(?:, LLC)?)\s*$/i, '').trim();
  return title;
}

function extractLocation(html) {
  const titleTag = clean(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  const titleLocation = titleTag.match(/\|\s*Careers at\s+(.+?)(?:\s+\d{5}(?:-\d{4})?)?$/i)?.[1]?.trim();
  if (titleLocation && /,\s*[A-Z]{2}\b/.test(titleLocation)) return titleLocation;

  const text = clean(html);
  const atsLocation = text.match(/Job Locations?\s+US-([A-Z]{2})-([A-Za-z][A-Za-z .'-]{1,60}?)(?=\s+(?:At a glance|Description|Overview|Company|Category|ID)\b)/i);
  if (!atsLocation) return '';
  const city = atsLocation[2].replace(/-/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, char => char.toUpperCase());
  return city ? `${city}, ${atsLocation[1].toUpperCase()}` : '';
}

function applicationDeadlinePassed(text) {
  const match = clean(text).match(/Application Deadline\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  if (!match) return false;
  const endOfDayUtc = Date.UTC(Number(match[3]), Number(match[1]) - 1, Number(match[2]) + 1) - 1;
  return Date.now() > endOfDayUtc;
}

async function fetchText(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': 'DataCenterCareersBot/1.2 (+https://datacentercareers.us/)'
    },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return { html: await response.text(), finalUrl: response.url || url };
}

let jobs = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
if (!Array.isArray(jobs)) throw new Error('jobs.json must contain an array');
let status = {};
try { status = JSON.parse(await readFile(STATUS_PATH, 'utf8')); } catch {}

const previousSabey = jobs.filter(job => job?.company === COMPANY || /^Official Sabey careers$/i.test(String(job?.source || '')));
const errors = [];
const drops = { stale: 0, titleOrExperience: 0, location: 0, nonSabey: 0, fetch: 0 };
let listingFetched = false;
let listingMethod = 'none';
let recruiterBoardComplete = false;
let candidateLinks = 0;
let detailSucceeded = 0;
const qualifying = [];
let links = [];

try {
  const listing = await fetchText(OFFICIAL_SOURCE);
  const officialLinks = extractJobLinks(listing.html);
  if (!officialLinks.length) throw new Error('official careers page exposed no iCIMS job links');
  listingFetched = true;
  listingMethod = 'official-careers-page';
  links = officialLinks;
} catch (error) {
  errors.push(`official listing: ${error.message}`);
  try {
    const recruiter = await fetchText(RECRUITER_BOARD);
    recruiterBoardComplete = /\bIndustry Jobs\b/i.test(clean(recruiter.html))
      && /\bSearch Results\b/i.test(clean(recruiter.html));
    if (!recruiterBoardComplete) throw new Error('recruiter board did not expose expected search-result markers');
    listingFetched = true;
    listingMethod = 'official-recruiter-board';
    links = extractRecruiterSabeyLinks(recruiter.html);
  } catch (fallbackError) {
    errors.push(`recruiter board: ${fallbackError.message}`);
  }
}

candidateLinks = links.length;

for (const url of links) {
  try {
    const detail = await fetchText(url);
    detailSucceeded += 1;
    if (!isSabeyDataCenterDetail(detail.html)) {
      drops.nonSabey += 1;
      continue;
    }

    const text = clean(detail.html);
    if (applicationDeadlinePassed(text)) {
      drops.stale += 1;
      continue;
    }

    const title = extractTitle(detail.html);
    const location = extractLocation(detail.html);
    const cls = classify(title, text);
    if (!cls) {
      drops.titleOrExperience += 1;
      continue;
    }
    if (!location) {
      drops.location += 1;
      continue;
    }

    const idMatch = detail.finalUrl.match(/\/jobs\/(\d+)\//i) || url.match(/\/jobs\/(\d+)\//i);
    const id = `sabey-${idMatch?.[1] || hash(detail.finalUrl || `${title}|${location}`)}`;
    qualifying.push({
      id,
      title,
      company: COMPANY,
      location,
      type: cls.type,
      experience: cls.experience,
      tags: tagsFor(title, text, cls.experience),
      ...extractPay(text),
      postedAt: null,
      source: 'Official Sabey careers',
      sourceUrl: detail.finalUrl || url,
      active: true,
      demo: false,
      postedHours: 9999
    });
  } catch (error) {
    drops.fetch += 1;
    errors.push(`detail: ${error.message}`);
  }
}

const sourceHealthy = listingFetched && (
  listingMethod === 'official-recruiter-board'
    ? recruiterBoardComplete && (candidateLinks === 0 || detailSucceeded > 0)
    : candidateLinks > 0 && detailSucceeded > 0
);
if (sourceHealthy) {
  jobs = jobs.filter(job => !(job?.company === COMPANY || /^Official Sabey careers$/i.test(String(job?.source || ''))));
  const existingUrls = new Set(jobs.map(job => String(job?.sourceUrl || '')).filter(Boolean));
  const existingIdentities = new Set(jobs.map(job => [job?.company, job?.title, job?.location].map(lower).join('|')));
  for (const job of qualifying) {
    const identity = [job.company, job.title, job.location].map(lower).join('|');
    if ((job.sourceUrl && existingUrls.has(job.sourceUrl)) || existingIdentities.has(identity)) continue;
    jobs.push(job);
    if (job.sourceUrl) existingUrls.add(job.sourceUrl);
    existingIdentities.add(identity);
  }
}

status.sabeyCareers = {
  officialSource: OFFICIAL_SOURCE,
  recruiterBoard: RECRUITER_BOARD,
  sourceHealthy,
  listingMethod,
  usedRecruiterBoardFallback: listingMethod === 'official-recruiter-board',
  recruiterBoardComplete,
  candidateLinks,
  detailSucceeded,
  qualifyingRoles: qualifying.length,
  preservedPrevious: sourceHealthy ? 0 : previousSabey.length,
  drops,
  errors: errors.slice(0, 12)
};
status.jobs = jobs.length;

await writeFile(JOBS_PATH, JSON.stringify(jobs, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');

console.log(`Sabey careers (${listingMethod}): ${candidateLinks} candidate links, ${detailSucceeded} live detail pages, ${qualifying.length} qualifying 0–5 year roles.`);
if (listingMethod === 'official-recruiter-board') console.warn('Sabey official page was unavailable; recovered discovery through its official Another Source iCIMS recruiter board.');
if (!sourceHealthy && previousSabey.length) console.warn(`Sabey source incomplete; preserved ${previousSabey.length} previously published role(s).`);
if (errors.length) console.warn(`Sabey source warnings: ${errors.slice(0, 6).join(' | ')}`);
