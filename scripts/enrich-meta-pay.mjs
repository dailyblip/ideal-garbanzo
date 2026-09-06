import { readFile, writeFile } from 'node:fs/promises';

const COMPANY = 'Meta';
const JOBS_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/meta-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const MAX_ROLES = 60;

const clean = value => String(value ?? '')
  .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;|&#160;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&ndash;|&#8211;/gi, '–')
  .replace(/&mdash;|&#8212;/gi, '—')
  .replace(/\s+/g, ' ')
  .trim();

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': 'facebookexternalhit/1.1 (+https://datacentercareers.us/)'
    },
    redirect: 'follow'
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.text();
}

function canonicalUrl(value) {
  try {
    const parsed = new URL(String(value || ''), 'https://www.metacareers.com/');
    if (!/(^|\.)metacareers\.com$/i.test(parsed.hostname)) return '';
    const match = parsed.pathname.match(/\/(?:profile\/job_details|jobs)\/(\d+)/i);
    return match ? `https://www.metacareers.com/profile/job_details/${match[1]}/` : '';
  } catch { return ''; }
}

function findJobPostingObjects(node, out = [], seen = new Set(), depth = 0) {
  if (!node || typeof node !== 'object' || seen.has(node) || depth > 16) return out;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) findJobPostingObjects(item, out, seen, depth + 1);
    return out;
  }
  const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
  if (types.some(type => /JobPosting/i.test(String(type || '')))) out.push(node);
  for (const value of Object.values(node)) findJobPostingObjects(value, out, seen, depth + 1);
  return out;
}

function jobPostings(html) {
  const postings = [];
  for (const match of String(html || '').matchAll(/<script\b[^>]*type=["']application\/ld\+json[^"']*["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = match[1] || '';
    if (!raw.trim()) continue;
    try { findJobPostingObjects(JSON.parse(raw), postings); } catch {}
  }
  return postings;
}

function numberValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const number = Number(value.replace(/[$,\s]/g, ''));
  return Number.isFinite(number) ? number : null;
}

function salaryUnit(value) {
  const text = String(value || '').trim();
  if (/hour|hr/i.test(text)) return 'HOUR';
  if (/year|yr|annual/i.test(text)) return 'YEAR';
  return '';
}

function plausible(value, unit) {
  if (!Number.isFinite(value) || value <= 0) return false;
  if (unit === 'HOUR') return value >= 7 && value <= 500;
  if (unit === 'YEAR') return value >= 10000 && value <= 1000000;
  return false;
}

function formatMoney(value, unit) {
  const options = unit === 'YEAR'
    ? { maximumFractionDigits: 0 }
    : { minimumFractionDigits: 0, maximumFractionDigits: 2 };
  return `$${value.toLocaleString('en-US', options)}`;
}

function payRecord(minimum, maximum, unit, source) {
  if (!unit) return null;
  let min = numberValue(minimum);
  let max = numberValue(maximum);
  if (min == null && max == null) return null;
  if (min == null) min = max;
  if (max == null) max = min;
  if (!plausible(min, unit) || !plausible(max, unit)) return null;
  if (min > max) [min, max] = [max, min];
  const suffix = unit === 'HOUR' ? ' / hour' : ' / year';
  const pay = min === max
    ? `${formatMoney(min, unit)}${suffix}`
    : `${formatMoney(min, unit)}–${formatMoney(max, unit)}${suffix}`;
  return {
    pay,
    salaryMin: min,
    salaryMax: max,
    salarySortMax: unit === 'HOUR' ? Math.round(max * 2080) : max,
    source
  };
}

function salaryFromNode(node) {
  for (const item of Array.isArray(node) ? node : [node]) {
    if (!item || typeof item !== 'object') continue;
    const currency = String(item.currency || item.value?.currency || '').trim().toUpperCase();
    if (currency && currency !== 'USD') continue;
    const value = item.value && typeof item.value === 'object' ? item.value : item;
    const unit = salaryUnit(value.unitText || value.unitCode || item.unitText || item.unitCode);
    const min = value.minValue ?? item.minValue ?? value.value ?? item.value;
    const max = value.maxValue ?? item.maxValue ?? value.value ?? item.value;
    const record = payRecord(min, max, unit, 'jobposting-jsonld');
    if (record) return record;
  }
  return null;
}

function payFromJsonLd(html) {
  for (const posting of jobPostings(html)) {
    for (const field of ['baseSalary', 'estimatedSalary']) {
      const record = salaryFromNode(posting?.[field]);
      if (record) return record;
    }
  }
  return null;
}

function payFromText(html) {
  const text = clean(String(html || ''));
  const pattern = /\$([\d,]+(?:\.\d{1,2})?)\s*(?:\/|per\s+)?\s*(year|yr|hour|hr)?\s*(?:-|–|—|to)\s*\$([\d,]+(?:\.\d{1,2})?)\s*(?:\/|per\s+)?\s*(year|yr|hour|hr)?/i;
  const match = text.match(pattern);
  if (!match) return null;
  const min = numberValue(match[1]);
  const max = numberValue(match[3]);
  let unit = salaryUnit(match[2] || match[4]);
  if (!unit && min != null && max != null) {
    if (min >= 10000 && max >= 10000) unit = 'YEAR';
    else if (min <= 500 && max <= 500) unit = 'HOUR';
  }
  return payRecord(min, max, unit, 'page-text');
}

function extractPay(html) {
  return payFromJsonLd(html) || payFromText(html);
}

function payFields(job) {
  return {
    pay: String(job?.pay || '').trim(),
    salaryMin: Number.isFinite(Number(job?.salaryMin)) ? Number(job.salaryMin) : null,
    salaryMax: Number.isFinite(Number(job?.salaryMax)) ? Number(job.salaryMax) : null,
    salarySortMax: Number.isFinite(Number(job?.salarySortMax)) ? Number(job.salarySortMax) : null
  };
}

function samePay(a, b) {
  return a.pay === b.pay && a.salaryMin === b.salaryMin && a.salaryMax === b.salaryMax && a.salarySortMax === b.salarySortMax;
}

function missingPayLabel(value) {
  return /^\s*(?:pay|salary|compensation)\s+not\s+(?:listed|provided|available)\s*$/i.test(String(value || ''));
}

const jobs = await readJson(JOBS_PATH, []);
const snapshot = await readJson(SNAPSHOT_PATH, []);
const status = await readJson(STATUS_PATH, {});
if (!Array.isArray(jobs)) throw new Error(`${JOBS_PATH} must contain an array.`);
if (!Array.isArray(snapshot)) throw new Error(`${SNAPSHOT_PATH} must contain an array.`);

const candidates = snapshot
  .filter(job => job?.company === COMPANY && canonicalUrl(job?.sourceUrl))
  .slice(0, MAX_ROLES);
const updates = new Map();
const diagnostics = {
  checkedAt: new Date().toISOString(),
  candidates: candidates.length,
  fetched: 0,
  payRecovered: 0,
  jsonLdRecovered: 0,
  textRecovered: 0,
  blankLabelsCleared: 0,
  samples: [],
  errors: []
};

for (const job of candidates) {
  const url = canonicalUrl(job.sourceUrl);
  try {
    const html = await fetchText(url);
    diagnostics.fetched += 1;
    const pay = extractPay(html);
    const current = payFields(job);
    let next = current;

    if (pay) {
      next = { pay: pay.pay, salaryMin: pay.salaryMin, salaryMax: pay.salaryMax, salarySortMax: pay.salarySortMax };
      if (!samePay(current, next)) {
        diagnostics.payRecovered += 1;
        if (pay.source === 'jobposting-jsonld') diagnostics.jsonLdRecovered += 1;
        if (pay.source === 'page-text') diagnostics.textRecovered += 1;
        if (diagnostics.samples.length < 12) diagnostics.samples.push({ id: job.id, title: job.title, location: job.location, pay: pay.pay, source: pay.source });
      }
    } else if (missingPayLabel(current.pay)) {
      next = { pay: '', salaryMin: null, salaryMax: null, salarySortMax: null };
      diagnostics.blankLabelsCleared += 1;
    }

    if (!samePay(current, next)) {
      updates.set(String(job.id || url), next);
      updates.set(url, next);
    }
  } catch (error) {
    if (diagnostics.errors.length < 20) diagnostics.errors.push(`${job.id || url}: ${String(error.message || error)}`);
  }
}

function applyUpdates(records) {
  let changed = 0;
  const next = records.map(job => {
    if (job?.company !== COMPANY) return job;
    const url = canonicalUrl(job?.sourceUrl);
    const update = updates.get(String(job?.id || '')) || (url ? updates.get(url) : null);
    if (!update) return job;
    const current = payFields(job);
    if (samePay(current, update)) return job;
    changed += 1;
    return { ...job, ...update };
  });
  return { next, changed };
}

const snapshotResult = applyUpdates(snapshot);
const jobsResult = applyUpdates(jobs);
const totalChanged = snapshotResult.changed + jobsResult.changed;

if (!totalChanged) {
  console.log(`Meta pay enrichment checked ${diagnostics.fetched}/${diagnostics.candidates} role(s); no compensation changes detected.`);
  if (diagnostics.errors.length) console.warn(`Meta pay enrichment warnings: ${diagnostics.errors.join(' | ')}`);
  process.exit(0);
}

await writeFile(SNAPSHOT_PATH, JSON.stringify(snapshotResult.next, null, 2) + '\n');
await writeFile(JOBS_PATH, JSON.stringify(jobsResult.next, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify({
  ...status,
  updatedAt: diagnostics.checkedAt,
  metaCareers: {
    ...(status.metaCareers || {}),
    payEnrichment: { ...diagnostics, changedRecords: totalChanged }
  }
}, null, 2) + '\n');

console.log(`Meta pay enrichment updated ${totalChanged} record(s); recovered ${diagnostics.payRecovered} employer-listed compensation range(s) and cleared ${diagnostics.blankLabelsCleared} placeholder label(s).`);
if (diagnostics.errors.length) console.warn(`Meta pay enrichment warnings: ${diagnostics.errors.join(' | ')}`);
