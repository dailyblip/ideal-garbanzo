import { readFile } from 'node:fs/promises';

const SNAPSHOT_PATH = 'data/major-jobs.json';
const SAMPLE_SIZE = 3;
const REQUEST_TIMEOUT_MS = 10000;
const RETRIES = 2;

const boards = [
  { company: 'Vantage Data Centers', origin: 'https://vantagedc.wd1.myworkdayjobs.com', tenant: 'vantagedc', site: 'Vantage', locale: 'en-US' },
  { company: 'QTS Data Centers', origin: 'https://qtsdatacenters.wd5.myworkdayjobs.com', tenant: 'qtsdatacenters', site: 'QTS', locale: 'en-US' },
  { company: 'CyrusOne', origin: 'https://cyrusone.wd1.myworkdayjobs.com', tenant: 'cyrusone', site: 'CyrusOneCareerPortal', locale: 'en-US' },
  { company: 'STACK Infrastructure', origin: 'https://stackinfra.wd108.myworkdayjobs.com', tenant: 'stackinfra', site: 'STACK_AMER', locale: 'en-US' },
  { company: 'NTT Global Data Centers', origin: 'https://nttglobaldatacenters.wd501.myworkdayjobs.com', tenant: 'nttglobaldatacenters', site: 'External', locale: 'en-US' },
  { company: 'Aligned Data Centers', origin: 'https://aligneddc.wd12.myworkdayjobs.com', tenant: 'aligneddc', site: 'aligneddc', locale: 'en-US' }
];

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function detailPathFromSourceUrl(board, sourceUrl) {
  let parsed;
  try {
    parsed = new URL(clean(sourceUrl));
  } catch {
    return '';
  }
  if (parsed.protocol !== 'https:' || parsed.origin !== board.origin) return '';
  const prefix = `/${board.locale}/${board.site}`;
  if (!parsed.pathname.startsWith(`${prefix}/`)) return '';
  const externalPath = parsed.pathname.slice(prefix.length);
  return externalPath.startsWith('/job/') ? externalPath : '';
}

function detailEndpoint(board, externalPath) {
  return `${board.origin}/wday/cxs/${board.tenant}/${board.site}${externalPath}`;
}

function hasUsableDetail(payload) {
  const info = payload?.jobPostingInfo || payload?.jobInfo;
  if (!info || typeof info !== 'object') return false;
  return Boolean(clean(info.title || info.jobTitle || info.jobDescription || info.description));
}

async function fetchJson(url, options = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'user-agent': 'DataCenterCareersBot/1.6 (+https://datacentercareers.us/)',
          ...(options.headers || {})
        }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      clearTimeout(timeout);
      return payload;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (attempt < RETRIES) await sleep(350 * attempt);
    }
  }
  throw lastError || new Error('request failed');
}

async function discoverySamplePath(board) {
  const endpoint = `${board.origin}/wday/cxs/${board.tenant}/${board.site}/jobs`;
  const payload = await fetchJson(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      referer: `${board.origin}/${board.locale}/${board.site}`
    },
    body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: '' })
  });
  const rows = Array.isArray(payload?.jobPostings) ? payload.jobPostings : [];
  return clean(rows.find(row => clean(row?.externalPath).startsWith('/job/'))?.externalPath);
}

async function samplePathsForBoard(board, snapshot) {
  const paths = [];
  const seen = new Set();
  for (const job of snapshot) {
    if (clean(job?.company) !== board.company) continue;
    const path = detailPathFromSourceUrl(board, job?.sourceUrl);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
    if (paths.length >= SAMPLE_SIZE) return paths;
  }

  // A priority employer can legitimately have zero mission-fit roles. In that
  // case, still probe one current role from the official board so detail health
  // is not inferred solely from the listing endpoint.
  if (!paths.length) {
    const discovered = await discoverySamplePath(board);
    if (discovered) paths.push(discovered);
  }
  return paths;
}

function collapseDetected(attempted, succeeded) {
  return attempted > 0 && succeeded === 0;
}

function runSelfTest() {
  const board = boards[0];
  const good = detailPathFromSourceUrl(
    board,
    'https://vantagedc.wd1.myworkdayjobs.com/en-US/Vantage/job/Ashburn-Virginia/Critical-Facilities-Engineer_R12345'
  );
  if (good !== '/job/Ashburn-Virginia/Critical-Facilities-Engineer_R12345') {
    throw new Error(`detail-path parsing regression: ${good || '(empty)'}`);
  }
  if (detailPathFromSourceUrl(board, 'https://example.com/en-US/Vantage/job/Test_R1')) {
    throw new Error('detail-path parser accepted a non-official host');
  }
  if (detailPathFromSourceUrl(board, 'https://vantagedc.wd1.myworkdayjobs.com/en-US/Other/job/Test_R1')) {
    throw new Error('detail-path parser accepted the wrong Workday site');
  }
  if (!collapseDetected(3, 0) || collapseDetected(3, 1) || collapseDetected(0, 0)) {
    throw new Error('detail-collapse decision regression');
  }
  if (!hasUsableDetail({ jobPostingInfo: { jobDescription: '<p>Role description</p>' } })) {
    throw new Error('usable Workday detail payload was rejected');
  }
  if (hasUsableDetail({ jobPostingInfo: {} }) || hasUsableDetail({})) {
    throw new Error('empty Workday detail payload was accepted');
  }
  console.log('Major Workday detail-health regression tests passed.');
}

if (process.argv.includes('--test')) {
  runSelfTest();
  process.exit(0);
}

const snapshot = await readJson(SNAPSHOT_PATH, []);
if (!Array.isArray(snapshot)) throw new Error(`${SNAPSHOT_PATH} must contain an array.`);

const failures = [];
const summaries = [];

for (const board of boards) {
  let samplePaths = [];
  try {
    samplePaths = await samplePathsForBoard(board, snapshot);
  } catch (error) {
    failures.push(`${board.company}: could not obtain an official detail sample (${clean(error?.message || error)})`);
    summaries.push({ company: board.company, attempted: 0, succeeded: 0, failed: 0 });
    continue;
  }

  if (!samplePaths.length) {
    failures.push(`${board.company}: official Workday board returned no detail sample to verify`);
    summaries.push({ company: board.company, attempted: 0, succeeded: 0, failed: 0 });
    continue;
  }

  let succeeded = 0;
  const errors = [];
  for (const externalPath of samplePaths) {
    const sourceUrl = `${board.origin}/${board.locale}/${board.site}${externalPath}`;
    try {
      const payload = await fetchJson(detailEndpoint(board, externalPath), { headers: { referer: sourceUrl } });
      if (!hasUsableDetail(payload)) throw new Error('detail response lacked job posting content');
      succeeded += 1;
    } catch (error) {
      errors.push(`${externalPath}: ${clean(error?.message || error)}`);
    }
  }

  const attempted = samplePaths.length;
  const failed = attempted - succeeded;
  summaries.push({ company: board.company, attempted, succeeded, failed });
  if (collapseDetected(attempted, succeeded)) {
    failures.push(`${board.company}: all ${attempted} sampled employer-direct job-detail requests failed (${errors.join('; ')})`);
  } else if (failed > 0) {
    console.warn(`${board.company}: ${failed}/${attempted} sampled detail request(s) failed, but ${succeeded} current detail request(s) succeeded.`);
  }
}

for (const summary of summaries) {
  console.log(`${summary.company}: detail health ${summary.succeeded}/${summary.attempted} succeeded.`);
}

if (failures.length) {
  for (const failure of failures) console.error(`Major Workday detail-health violation: ${failure}`);
  throw new Error(`Detected ${failures.length} priority Workday detail-health failure(s).`);
}

console.log(`Major Workday detail-health guard passed for ${boards.length} priority employer boards.`);
