import { readFile, writeFile } from 'node:fs/promises';

const SNAPSHOT_PATH = 'data/oracle-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const COMPANY = 'Oracle';
const OFFICIAL_HOST = 'eeho.fa.us2.oraclecloud.com';
const DETAIL_BATCH_SIZE = 6;

// Oracle's broad career taxonomy can surface corporate/engineering internships
// whose descriptions mention cloud infrastructure even though the jobs are not
// hands-on data-center, facilities, electrical, critical-environment, or
// operations roles. Keep this narrow and title-based so valid technician,
// facilities, electrical, mechanical, controls, and deployment roles survive.
const CLEARLY_NON_OPERATIONAL_TITLE = /\b(?:business analyst|business operations|cost management|cost estimator|cost analyst|cost controls|procurement|purchasing|finance|financial|accounting|accountant|security operations|cybersecurity|information security|software engineer|software developer|application developer|applications developer|frontend|backend|full[ -]?stack|database engineer|database administrator|product manager|product management|ux|ui|machine learning|data scientist|legal|counsel|paralegal|recruiter|recruiting|talent sourcer|talent sourcing|talent acquisition|marketing|sales|account executive)\b/i;

const EXPERIENCE_NUMBER_WORDS = new Map([
  ['zero', '0'], ['one', '1'], ['two', '2'], ['three', '3'], ['four', '4'], ['five', '5'],
  ['six', '6'], ['seven', '7'], ['eight', '8'], ['nine', '9'], ['ten', '10']
]);

const regressionCases = [
  ['Data Center Business Operations Business Analyst', true],
  ['Data Center Development Cost Management', true],
  ['OCI Software Engineer Intern - OVIP', true],
  ['Corporate Accounting Intern', true],
  ['Talent Sourcer (Contract) – Data Center Recruiting (North America)', true],
  ['Data Center Technician 2', false],
  ['Critical Facilities Engineer', false],
  ['Mechanical Engineer 2', false],
  ['Electrical Engineer 2', false],
  ['Data Center Facilities Technician', false],
  ['Data Center Low Voltage Engineer III', false]
];
for (const [title, rejected] of regressionCases) {
  const actual = CLEARLY_NON_OPERATIONAL_TITLE.test(title);
  if (actual !== rejected) {
    throw new Error(`Oracle mission-fit scrub regression for "${title}": expected rejected=${rejected}, got ${actual}`);
  }
}

const clean = value => String(value ?? '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;|&#160;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/\s+/g, ' ')
  .trim();
const lower = value => clean(value).toLowerCase();

function normalizeExperienceNumbers(text = '') {
  return lower(text)
    .replace(/\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/g, word => EXPERIENCE_NUMBER_WORDS.get(word) || word)
    .replace(/\b(\d{1,2})\s*\(\s*(\d{1,2})\s*\)/g, (full, first, second) => first === second ? first : full);
}

function requiredExperienceYears(text = '') {
  const values = [];
  const normalized = normalizeExperienceNumbers(text);
  const patterns = [
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\+?\s*(?:-|–|to)\s*(\d{1,2})\s+years?(?:\s+of)?\s+(?:relevant\s+|related\s+)?experience/gi,
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\+?\s+years?(?:\s+of)?\s+(?:relevant\s+|related\s+)?experience/gi,
    /(\d{1,2})\+?\s+years?(?:\s+of)?\s+experience\b/gi,
    /(\d{1,2})\+?\s+years?\s+(?:of\s+)?(?:technical|professional|data center|datacenter|hardware|network|electrical|mechanical|operations|facilities|facility)\s+experience/gi,
    /experience(?:\s+of)?\s+(?:at least\s+|minimum(?: of)?\s+)?(\d{1,2})\+?\s+years?/gi
  ];
  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      values.push(Number(match[1]));
      if (match[2]) values.push(Number(match[2]));
    }
  }
  return values.filter(Number.isFinite);
}

function exceedsFiveYearCeiling(text = '') {
  const normalized = normalizeExperienceNumbers(text);
  const strictMinimumPatterns = [
    /\b(?:more than|over|greater than|in excess of)\s+(\d{1,2})\s+years?\b/g,
    />\s*(\d{1,2})\s+years?\b/g
  ];
  for (const pattern of strictMinimumPatterns) {
    for (const match of normalized.matchAll(pattern)) {
      if (Number(match[1]) >= 5) return true;
    }
  }
  return requiredExperienceYears(normalized).some(year => year > 5);
}

function runExperienceParserTests() {
  const cases = [
    ['exactly five years remains eligible', '5 years of experience in data center operations.', false],
    ['five plus years remains eligible by policy', '5+ years of experience in critical facilities.', false],
    ['more than five years is rejected', 'More than five years of experience in data center operations.', true],
    ['over five years is rejected', 'Over 5 years of experience in critical facilities.', true],
    ['greater than five years is rejected', 'Greater than five years of experience in facility operations.', true],
    ['in excess of five years is rejected', 'In excess of 5 years of experience in a critical environment.', true],
    ['greater-than symbol five years is rejected', '> 5 years of experience in data center operations.', true],
    ['spelled-out six years is rejected', 'Six years of experience in data center operations.', true],
    ['spelled and parenthetical six years is rejected', 'Six (6) years of facilities experience.', true],
    ['five or more remains eligible by five-plus policy', 'Five or more years of data center experience.', false]
  ];
  for (const [name, requirement, expectedRejected] of cases) {
    const rejected = exceedsFiveYearCeiling(requirement);
    if (rejected !== expectedRejected) {
      throw new Error(`Oracle experience parser regression failed: ${name}; expected rejected=${expectedRejected}, got ${rejected}.`);
    }
  }
}

runExperienceParserTests();
if (process.argv.includes('--test-experience-parser')) {
  console.log('Oracle experience parser regression tests passed.');
  process.exit(0);
}

async function readArray(path) {
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(value)) throw new Error(`${path} must contain a JSON array`);
  return value;
}

function isOracle(job = {}) {
  return String(job?.company || '').trim() === COMPANY;
}

function oracleDetailRef(job = {}) {
  const parsed = new URL(String(job?.sourceUrl || ''));
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== OFFICIAL_HOST) {
    throw new Error(`${job?.id || '(missing id)'} is not an official Oracle role URL`);
  }
  const match = parsed.pathname.match(/\/hcmUI\/CandidateExperience\/en\/sites\/([^/]+)\/job\/([^/?#]+)/i);
  if (!match) throw new Error(`${job?.id || '(missing id)'} does not expose an Oracle site/job identity`);
  return { site: decodeURIComponent(match[1]), id: decodeURIComponent(match[2]) };
}

function detailUrl(job = {}) {
  const { site, id } = oracleDetailRef(job);
  const finder = `ById;Id=${id},siteNumber=${site}`;
  return `https://${OFFICIAL_HOST}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?onlyData=true&expand=all&finder=${encodeURIComponent(finder)}`;
}

function collectStrings(value, out = []) {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

async function checkExperiencePolicy(job = {}) {
  const response = await fetch(detailUrl(job), {
    headers: {
      accept: 'application/json',
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': 'Mozilla/5.0 (compatible; DataCenterCareersBot/2.0; +https://dailyblip.github.io/ideal-garbanzo/)'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`${response.status} ${job?.id || job?.sourceUrl || 'Oracle role'}`);
  const payload = await response.json();
  const detail = Array.isArray(payload?.items) ? payload.items[0] : null;
  if (!detail) throw new Error(`No detail payload for ${job?.id || job?.sourceUrl || 'Oracle role'}`);
  const text = collectStrings(detail).join(' ');
  return exceedsFiveYearCeiling(text);
}

async function evaluateExperience(snapshot = []) {
  const candidates = snapshot.filter(job => isOracle(job) && !CLEARLY_NON_OPERATIONAL_TITLE.test(String(job?.title || '')));
  const rejectedUrls = new Set();
  const failures = [];
  let checked = 0;

  for (let index = 0; index < candidates.length; index += DETAIL_BATCH_SIZE) {
    const batch = candidates.slice(index, index + DETAIL_BATCH_SIZE);
    const results = await Promise.all(batch.map(async job => {
      try {
        return { job, rejected: await checkExperiencePolicy(job), error: null };
      } catch (error) {
        return { job, rejected: false, error: error?.message || String(error) };
      }
    }));
    for (const result of results) {
      if (result.error) {
        failures.push(`${result.job?.id || '(missing id)'}: ${result.error}`);
        continue;
      }
      checked += 1;
      if (result.rejected) rejectedUrls.add(String(result.job?.sourceUrl || ''));
    }
  }
  return { rejectedUrls, failures, checked, candidates: candidates.length };
}

function removalReason(job = {}, rejectedUrls = new Set()) {
  if (!isOracle(job)) return '';
  const title = String(job?.title || '').trim();
  if (CLEARLY_NON_OPERATIONAL_TITLE.test(title)) return 'non-operational role family';
  if (rejectedUrls.has(String(job?.sourceUrl || ''))) return 'experience requirement above 5 years';
  return '';
}

function partition(records = [], rejectedUrls = new Set()) {
  const kept = [];
  const removed = [];
  for (const job of records) {
    const reason = removalReason(job, rejectedUrls);
    if (!reason) {
      kept.push(job);
      continue;
    }
    removed.push({
      id: String(job?.id || ''),
      title: String(job?.title || '').trim(),
      location: String(job?.location || '').trim(),
      reason
    });
  }
  return { kept, removed };
}

function countsBy(records, field) {
  return records.reduce((acc, job) => {
    const key = String(job?.[field] || 'unknown').trim() || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

const snapshot = await readArray(SNAPSHOT_PATH);
const jobs = await readArray(JOBS_PATH);
const experienceResult = await evaluateExperience(snapshot);
const snapshotResult = partition(snapshot, experienceResult.rejectedUrls);
const jobsResult = partition(jobs, experienceResult.rejectedUrls);

// The source-specific snapshot is authoritative for Oracle. Every role removed
// here must also be absent from the public feed; removing from both files keeps
// the subsequent global publication filter and Oracle parity guard deterministic.
if (snapshotResult.removed.length) {
  await writeFile(SNAPSHOT_PATH, JSON.stringify(snapshotResult.kept, null, 2) + '\n');
}
if (jobsResult.removed.length) {
  await writeFile(JOBS_PATH, JSON.stringify(jobsResult.kept, null, 2) + '\n');
}

if (snapshotResult.removed.length || jobsResult.removed.length) {
  const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
  status.jobs = jobsResult.kept.length;
  status.countsByType = countsBy(jobsResult.kept, 'type');
  status.countsByExperience = countsBy(jobsResult.kept, 'experience');
  status.oracleCareers = {
    ...(status.oracleCareers || {}),
    qualifyingRoles: snapshotResult.kept.length,
    missionFitScrub: {
      checkedAt: new Date().toISOString(),
      removedFromSnapshot: snapshotResult.removed.length,
      removedFromPublicFeed: jobsResult.removed.length,
      experienceCandidates: experienceResult.candidates,
      experienceChecked: experienceResult.checked,
      experienceFetchFailures: experienceResult.failures.length,
      removed: snapshotResult.removed
    }
  };
  await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
}

const leftovers = snapshotResult.kept.filter(job => CLEARLY_NON_OPERATIONAL_TITLE.test(String(job?.title || '')));
if (leftovers.length) {
  throw new Error(`Oracle mission-fit scrub left ${leftovers.length} clearly non-operational role(s) in the snapshot.`);
}

console.log(`Oracle mission-fit scrub: removed ${snapshotResult.removed.length} snapshot role(s) and ${jobsResult.removed.length} public-feed role(s); ${snapshotResult.kept.length} Oracle role(s) remain. Experience policy checked ${experienceResult.checked}/${experienceResult.candidates} candidate role(s), with ${experienceResult.failures.length} detail fetch failure(s).`);
if (snapshotResult.removed.length) {
  console.log(`Removed Oracle roles: ${snapshotResult.removed.map(item => `${item.title} (${item.reason})`).join(' | ')}`);
}
if (experienceResult.failures.length) {
  console.warn(`Oracle experience-policy detail checks preserved ${experienceResult.failures.length} role(s) after official-detail fetch failure: ${experienceResult.failures.join(' | ')}`);
}
