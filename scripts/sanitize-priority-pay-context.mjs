import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const FETCH_TIMEOUT_MS = 10000;

const jobs = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
if (!Array.isArray(jobs)) throw new Error(`${JOBS_PATH} must contain an array.`);

const targets = jobs.filter(job =>
  String(job?.company || '').trim() === 'Equinix' &&
  /skillbridge/i.test(String(job?.title || '')) &&
  String(job?.pay || '').trim()
);

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': 'Mozilla/5.0 (compatible; DataCenterCareers/1.0; +https://datacentercareers.us/)'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.text();
}

function findJobPosting(node) {
  if (!node) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findJobPosting(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== 'object') return null;
  const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
  if (types.some(type => /jobposting/i.test(String(type || '')))) return node;
  for (const child of Object.values(node)) {
    if (child && typeof child === 'object') {
      const found = findJobPosting(child);
      if (found) return found;
    }
  }
  return null;
}

function hasStructuredBaseSalary(html) {
  for (const match of String(html || '').matchAll(/<script\b[^>]*type=["']application\/ld\+json[^"']*["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const posting = findJobPosting(JSON.parse(match[1] || ''));
      if (!posting) continue;
      const salary = posting.baseSalary;
      if (salary && typeof salary === 'object') return true;
    } catch {}
  }
  return false;
}

let cleared = 0;
let structuredKept = 0;
let fetchErrors = 0;

for (const job of targets) {
  let keep = false;
  try {
    const parsed = new URL(String(job.sourceUrl || ''));
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'careers.equinix.com') throw new Error('non-official Equinix URL');
    const html = await fetchText(parsed.href);
    keep = hasStructuredBaseSalary(html);
  } catch {
    fetchErrors += 1;
  }

  if (keep) {
    structuredKept += 1;
    continue;
  }

  job.pay = '';
  job.salaryMin = null;
  job.salaryMax = null;
  job.salarySortMax = null;
  cleared += 1;
}

if (cleared) await writeFile(JOBS_PATH, `${JSON.stringify(jobs, null, 2)}\n`);
console.log(`Priority compensation context guard checked ${targets.length} Equinix SkillBridge role(s), kept ${structuredKept} structured base-salary record(s), cleared ${cleared} ambiguous/conversion-only range(s), and saw ${fetchErrors} fetch error(s).`);
