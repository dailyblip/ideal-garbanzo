import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const MAX_ALLOWED_YEARS = 5;
const USER_AGENT = 'DataCenterCareersBot/1.1 (+https://datacentercareers.us/)';
const BOARDS = [
  ['lambda', 'Lambda'],
  ['crusoe', 'Crusoe'],
  ['fluidstack', 'Fluidstack'],
  ['gimlet', 'Gimlet Labs'],
  ['tensorwave', 'TensorWave']
];

const clean = value => String(value ?? '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&#39;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ')
  .trim();

const numberWords = new Map([
  ['zero', '0'], ['one', '1'], ['two', '2'], ['three', '3'], ['four', '4'], ['five', '5'],
  ['six', '6'], ['seven', '7'], ['eight', '8'], ['nine', '9'], ['ten', '10'],
  ['eleven', '11'], ['twelve', '12'], ['thirteen', '13'], ['fourteen', '14'], ['fifteen', '15']
]);

function requiredExperienceText(description = '') {
  const text = clean(description);
  const preferred = text.search(/\b(?:preferred qualifications?|preferred experience|preferred skills?|nice to have|bonus qualifications?|bonus points?)\b/i);
  return preferred >= 0 ? text.slice(0, preferred) : text;
}

function normalizeExperienceNumbers(text = '') {
  return clean(text).toLowerCase().replace(
    /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen)\b/g,
    word => numberWords.get(word) || word
  );
}

function statedExperienceYears(description = '') {
  const normalized = normalizeExperienceNumbers(requiredExperienceText(description));
  const values = [];
  const patterns = [
    /\b(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s+years?\b(?=[^.!?]{0,140}\bexperience\b)/gi,
    /\b(\d{1,2})\s*(?:\+|or more)?\s+years?\b(?=[^.!?]{0,140}\bexperience\b)/gi,
    /\bexperience(?:\s+(?:of|in))?\s+(?:at least\s+|minimum(?: of)?\s+)?(\d{1,2})\s*(?:\+|or more)?\s+years?\b/gi,
    /\b(?:minimum(?: of)?|at least)\s+(\d{1,2})\s*(?:\+|or more)?\s+years?\b/gi
  ];

  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      values.push(Number(match[1]));
      if (match[2]) values.push(Number(match[2]));
    }
  }

  return [...new Set(values.filter(value => Number.isFinite(value) && value >= 0 && value <= 50))];
}

function normalizeUrl(value = '') {
  try {
    const url = new URL(clean(value));
    url.hash = '';
    url.search = '';
    return `${url.protocol}//${url.hostname.toLowerCase()}${url.pathname.toLowerCase().replace(/\/$/, '')}`;
  } catch {
    return '';
  }
}

function runTests() {
  const cases = [
    {
      name: 'domain-qualified ten-year requirement is detected',
      description: 'What You Will Bring: 10+ years of electrical engineering design experience, with a heavy emphasis on data centers.',
      expected: [10]
    },
    {
      name: 'five-year direct experience remains within mission',
      description: 'Minimum qualifications: Five or more years of direct experience in a critical environment.',
      expected: [5]
    },
    {
      name: 'preferred seniority does not disqualify a five-year required role',
      description: 'Minimum qualifications: Five years of relevant experience. Preferred qualifications: Seven years of relevant experience.',
      expected: [5]
    },
    {
      name: 'experience-first wording is detected',
      description: 'Relevant professional experience of at least 8 years in mission-critical facilities is required.',
      expected: [8]
    },
    {
      name: 'non-experience year references are ignored',
      description: 'Support a 10-year capital plan for data center systems. Two years of relevant experience required.',
      expected: [2]
    }
  ];

  const failures = [];
  for (const testCase of cases) {
    const actual = statedExperienceYears(testCase.description).sort((a, b) => a - b);
    const expected = [...testCase.expected].sort((a, b) => a - b);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      failures.push(`${testCase.name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }

  if (failures.length) {
    for (const failure of failures) console.error(`Ashby experience reconciliation regression: ${failure}`);
    process.exit(1);
  }
  console.log(`Ashby experience reconciliation parser passed ${cases.length} regression cases.`);
}

if (process.argv.includes('--test')) {
  runTests();
  process.exit(0);
}

async function fetchBoard(slug) {
  const response = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`, {
    headers: { 'user-agent': USER_AGENT }
  });
  if (!response.ok) throw new Error(`${response.status} Ashby board ${slug}`);
  return response.json();
}

const jobs = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
if (!Array.isArray(jobs)) throw new Error(`${JOBS_PATH} must contain an array.`);

const officialByCompany = new Map();
const failures = [];
for (const [slug, company] of BOARDS) {
  try {
    const payload = await fetchBoard(slug);
    const listed = new Map();
    for (const posting of payload.jobs || []) {
      if (posting?.isListed === false) continue;
      const url = normalizeUrl(posting?.jobUrl || posting?.applyUrl);
      if (!url) continue;
      listed.set(url, posting);
    }
    officialByCompany.set(company, listed);
  } catch (error) {
    failures.push(`${company}: ${error.message}`);
  }
}

const removed = [];
const reconciled = jobs.filter(job => {
  const company = clean(job?.company);
  const board = officialByCompany.get(company);
  if (!board) return true;
  const posting = board.get(normalizeUrl(job?.sourceUrl));
  if (!posting) return true;

  const description = clean(posting?.descriptionPlain || posting?.descriptionHtml || '');
  const years = statedExperienceYears(description);
  const requiredMax = years.length ? Math.max(...years) : null;
  if (requiredMax !== null && requiredMax > MAX_ALLOWED_YEARS) {
    removed.push({
      id: clean(job?.id),
      company,
      title: clean(job?.title),
      requiredMax
    });
    return false;
  }
  return true;
});

if (removed.length) {
  await writeFile(JOBS_PATH, JSON.stringify(reconciled, null, 2) + '\n');
}

try {
  const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
  const diagnostics = status?.genericDirectSources?.sourceDiagnostics;
  if (Array.isArray(diagnostics)) {
    const counts = new Map();
    for (const job of reconciled) {
      const company = clean(job?.company);
      if (!officialByCompany.has(company)) continue;
      counts.set(company, (counts.get(company) || 0) + 1);
    }
    for (const diagnostic of diagnostics) {
      const company = clean(diagnostic?.company);
      if (!officialByCompany.has(company)) continue;
      diagnostic.qualifyingRoles = counts.get(company) || 0;
    }
    status.genericDirectSources.ashbyExperienceReconciledAt = new Date().toISOString();
    status.genericDirectSources.ashbyExperienceRemoved = removed.length;
    await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
  }
} catch (error) {
  console.warn(`Ashby reconciliation status update skipped: ${error.message}`);
}

console.log(`Ashby experience reconciliation checked ${officialByCompany.size}/${BOARDS.length} boards; removed ${removed.length} role(s) requiring more than ${MAX_ALLOWED_YEARS} years.`);
for (const role of removed) {
  console.log(`Removed ${role.company}: ${role.title} (${role.requiredMax}+ years detected; ${role.id || 'missing id'}).`);
}
if (failures.length) console.warn(`Ashby reconciliation source warnings: ${failures.join(' | ')}`);
