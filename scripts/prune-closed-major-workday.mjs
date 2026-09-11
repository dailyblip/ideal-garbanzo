import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const MAJOR_PATH = 'data/major-jobs.json';
const STATUS_PATH = 'data/collector-status.json';

// Targeted recovery can find roles that the broad Workday listing temporarily
// misses. Re-check the official Workday detail endpoint every six hours so
// recovered records cannot linger after an employer definitively closes them.
const boards = new Map([
  ['Vantage Data Centers', { origin: 'https://vantagedc.wd1.myworkdayjobs.com', tenant: 'vantagedc', site: 'Vantage', locale: 'en-US' }],
  ['QTS Data Centers', { origin: 'https://qtsdatacenters.wd5.myworkdayjobs.com', tenant: 'qtsdatacenters', site: 'QTS', locale: 'en-US' }],
  ['CyrusOne', { origin: 'https://cyrusone.wd1.myworkdayjobs.com', tenant: 'cyrusone', site: 'CyrusOneCareerPortal', locale: 'en-US' }],
  ['STACK Infrastructure', { origin: 'https://stackinfra.wd108.myworkdayjobs.com', tenant: 'stackinfra', site: 'STACK_AMER', locale: 'en-US' }],
  ['NTT Global Data Centers', { origin: 'https://nttglobaldatacenters.wd501.myworkdayjobs.com', tenant: 'nttglobaldatacenters', site: 'External', locale: 'en-US' }],
  ['Aligned Data Centers', { origin: 'https://aligneddc.wd12.myworkdayjobs.com', tenant: 'aligneddc', site: 'aligneddc', locale: 'en-US' }]
]);

const clean = value => String(value ?? '').trim();

async function readArray(path) {
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(value)) throw new Error(`${path} must contain an array`);
  return value;
}

async function readObject(path) {
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must contain an object`);
  return value;
}

function summarize(records, field) {
  return records.reduce((acc, job) => {
    const value = clean(job?.[field]) || 'unknown';
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function detailEndpoint(job) {
  const board = boards.get(clean(job?.company));
  if (!board) return null;

  let source;
  try { source = new URL(clean(job?.sourceUrl)); }
  catch { return null; }

  const origin = new URL(board.origin);
  if (source.protocol !== 'https:' || source.hostname.toLowerCase() !== origin.hostname.toLowerCase()) return null;

  const prefix = `/${board.locale}/${board.site}`;
  if (!source.pathname.startsWith(prefix)) return null;
  const externalPath = source.pathname.slice(prefix.length);
  if (!externalPath.startsWith('/')) return null;

  return {
    sourceUrl: source.href,
    detailUrl: `${board.origin}/wday/cxs/${board.tenant}/${board.site}${externalPath}`
  };
}

async function liveState(job) {
  const endpoint = detailEndpoint(job);
  if (!endpoint) return { state: 'unmanaged' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(endpoint.detailUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        accept: 'application/json',
        referer: endpoint.sourceUrl,
        'user-agent': 'DataCenterCareersBot/1.5 (+https://datacentercareers.us/)'
      }
    });
    if (response.ok) return { state: 'live', status: response.status };
    if (response.status === 404 || response.status === 410) return { state: 'closed', status: response.status };
    return { state: 'transient', status: response.status };
  } catch (error) {
    return { state: 'transient', error: error?.name === 'AbortError' ? 'timeout' : clean(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

function key(job) {
  return clean(job?.sourceUrl);
}

const jobs = await readArray(JOBS_PATH);
const major = await readArray(MAJOR_PATH);
const candidates = new Map();
for (const job of [...jobs, ...major]) {
  const url = key(job);
  if (!url || candidates.has(url) || !detailEndpoint(job)) continue;
  candidates.set(url, job);
}

const closedUrls = new Set();
const closedByCompany = {};
const transient = [];
let checked = 0;

const rows = [...candidates.entries()];
for (let index = 0; index < rows.length; index += 8) {
  const batch = rows.slice(index, index + 8);
  const states = await Promise.all(batch.map(async ([url, job]) => [url, job, await liveState(job)]));
  for (const [url, job, result] of states) {
    checked += 1;
    if (result.state === 'closed') {
      closedUrls.add(url);
      const company = clean(job.company) || 'Unknown';
      closedByCompany[company] = (closedByCompany[company] || 0) + 1;
      console.log(`Closed Workday role: ${job.company} — ${job.title} (${result.status})`);
    } else if (result.state === 'transient') {
      transient.push({ company: job.company, title: job.title, status: result.status || null, error: result.error || null });
    }
  }
}

if (!closedUrls.size) {
  console.log(`Priority Workday liveness passed: ${checked} official role URL(s) checked; 0 definitively closed.${transient.length ? ` ${transient.length} transient check(s) were kept.` : ''}`);
  process.exit(0);
}

const nextJobs = jobs.filter(job => !closedUrls.has(key(job)));
const nextMajor = major.filter(job => !closedUrls.has(key(job)));
const status = await readObject(STATUS_PATH);
const nowIso = new Date().toISOString();

status.updatedAt = nowIso;
status.jobs = nextJobs.length;
status.countsByType = summarize(nextJobs, 'type');
status.countsByExperience = summarize(nextJobs, 'experience');
status.majorSources = status.majorSources && typeof status.majorSources === 'object' && !Array.isArray(status.majorSources)
  ? status.majorSources
  : {};
status.majorSources.jobs = nextMajor.length;
status.majorSources.reconciliation = {
  ...(status.majorSources.reconciliation || {}),
  checkedAt: nowIso,
  rawJobs: nextMajor.length,
  publishedUsJobs: nextMajor.length,
  closedRolePruneAt: nowIso,
  closedRolesRemoved: closedUrls.size
};
status.majorSources.closedRolePrune = {
  checkedAt: nowIso,
  officialRoleUrlsChecked: checked,
  removed: closedUrls.size,
  removedByCompany: closedByCompany,
  transientKept: transient.length,
  policy: 'Remove only priority Workday roles whose official detail endpoint returns HTTP 404 or 410; retain transient failures.'
};

await writeFile(JOBS_PATH, JSON.stringify(nextJobs, null, 2) + '\n');
await writeFile(MAJOR_PATH, JSON.stringify(nextMajor, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');

console.log(`Pruned ${closedUrls.size} definitively closed priority Workday role URL(s): public feed ${jobs.length}→${nextJobs.length}, major snapshot ${major.length}→${nextMajor.length}.`);
if (transient.length) console.log(`Kept ${transient.length} role(s) whose liveness checks were transient or blocked.`);
