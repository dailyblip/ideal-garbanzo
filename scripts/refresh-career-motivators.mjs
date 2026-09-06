import { readFile, writeFile } from 'node:fs/promises';

const MAX_CARDS = 3;
const MIN_CARDS = 2;
const MAX_STALE_DAYS = 7;
const TODAY = new Date().toISOString().slice(0, 10);
const forbiddenTitle = /\b(?:senior|sr\.?|principal|director|vice president|vp|head of|chief|executive|staff engineer|lead|manager)\b/i;
const dataCenterContext = /data\s*cent(?:er|re)|datacenter|critical facilit|critical environment|supercomput|rack|power management|first[- ]party hardware|interconnect|infrastructure/i;

const clean = value => String(value ?? '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/\s+/g, ' ').trim();
const readJson = async (path, fallback) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; } };
const daysOld = iso => (Date.now() - Date.parse(`${iso}T00:00:00Z`)) / 86400000;

function salaryMaxFromText(text) {
  const values = [];
  for (const match of text.matchAll(/\$\s*([\d,.]+)\s*([Kk])?\s*(?:-|–|to)\s*\$?\s*([\d,.]+)\s*([Kk])?/g)) {
    let max = Number(String(match[3]).replace(/,/g, ''));
    if (match[4]) max *= 1000;
    if (Number.isFinite(max)) values.push(max);
  }
  return values.length ? Math.max(...values) : null;
}

function yearsFromText(text) {
  const values = [...text.matchAll(/(\d{1,2})\+?\s+years?\b/gi)].map(match => Number(match[1])).filter(Number.isFinite);
  return values.length ? Math.min(...values) : null;
}

async function verifyCandidate(candidate, previous) {
  let response;
  try {
    response = await fetch(candidate.sourceUrl, {
      redirect: 'follow',
      headers: { 'user-agent': 'DataCenterCareersCareerPathBot/1.0 (+https://datacentercareers.us/)' },
      signal: AbortSignal.timeout(15000)
    });
  } catch (error) {
    if (previous && previous.verifiedAt && daysOld(previous.verifiedAt) <= MAX_STALE_DAYS) {
      return { record: previous, status: `transient source failure; retained verified card (${error.message})` };
    }
    return { record: null, status: `source failure: ${error.message}` };
  }

  if (response.status === 404 || response.status === 410) return { record: null, status: `closed (${response.status})` };
  if (!response.ok) {
    if (previous && previous.verifiedAt && daysOld(previous.verifiedAt) <= MAX_STALE_DAYS) {
      return { record: previous, status: `HTTP ${response.status}; retained verified card` };
    }
    return { record: null, status: `HTTP ${response.status}` };
  }

  const text = clean(await response.text());
  if (!text.toLowerCase().includes(clean(candidate.title).toLowerCase())) return { record: null, status: 'title no longer present on source page' };
  const sourceSalaryMax = salaryMaxFromText(text);
  const sourceYears = yearsFromText(text);
  if (!candidate.monitorOnly && (!sourceSalaryMax || sourceSalaryMax < 300000)) return { record: null, status: `source compensation no longer reaches $300K (${sourceSalaryMax || 'unknown'})` };
  if (!candidate.monitorOnly && sourceYears != null && sourceYears > 8) return { record: null, status: `source now requires ${sourceYears}+ years` };
  if (forbiddenTitle.test(candidate.title)) return { record: null, status: 'title is too senior for career-ceiling placement' };

  return {
    record: {
      id: candidate.id,
      title: candidate.title,
      company: candidate.company,
      location: candidate.location,
      experience: candidate.experience,
      minYears: candidate.minYears,
      pay: candidate.pay,
      salaryMax: sourceSalaryMax || candidate.salaryMax,
      source: candidate.source,
      sourceUrl: candidate.sourceUrl,
      summary: candidate.summary,
      verifiedAt: TODAY
    },
    status: candidate.monitorOnly ? `monitored; below $300K display threshold (${candidate.pay})` : 'verified'
  };
}

function feedMotivators(jobs) {
  return jobs.filter(job => {
    const company = String(job.company || '');
    if (!/^(?:Meta|Amazon Web Services|Amazon)$/i.test(company)) return false;
    if (job.experience !== '2-5-years') return false;
    if (forbiddenTitle.test(String(job.title || ''))) return false;
    const salaryMax = Number(job.salaryMax ?? job.salarySortMax ?? 0);
    if (salaryMax < 300000) return false;
    const context = `${job.title || ''} ${(job.tags || []).join(' ')} ${job.source || ''}`;
    if (!dataCenterContext.test(context)) return false;
    const sourceUrl = String(job.sourceUrl || '');
    if (/^Meta$/i.test(company) && !/metacareers\.com|meta\.com\/careers/i.test(sourceUrl)) return false;
    if (/Amazon/i.test(company) && !/amazon\.jobs/i.test(sourceUrl)) return false;
    return true;
  }).map(job => ({
    id: `career-ceiling-${job.id}`,
    title: job.title,
    company: job.company,
    location: job.location,
    experience: '2–5 years',
    minYears: 2,
    pay: job.pay,
    salaryMax: Number(job.salaryMax ?? job.salarySortMax),
    source: job.source,
    sourceUrl: job.sourceUrl,
    summary: 'A current employer-direct data center role showing where infrastructure experience and training can lead.',
    verifiedAt: TODAY
  }));
}

const candidates = await readJson('data/career-motivator-candidates.json', []);
const previous = await readJson('data/career-motivators.json', []);
const jobs = await readJson('data/jobs.json', []);
const previousById = new Map(previous.map(record => [record.id, record]));
const curated = [];
const statuses = [];

for (const candidate of candidates) {
  const result = await verifyCandidate(candidate, previousById.get(candidate.id));
  statuses.push(`${candidate.id}: ${result.status}`);
  if (result.record && !candidate.monitorOnly && result.record.salaryMax >= 300000) curated.push({ ...result.record, priority: candidate.priority || 0 });
}

const feed = feedMotivators(jobs).sort((a, b) => b.salaryMax - a.salaryMax);
const chosen = [];
for (const companyPattern of [/^Meta$/i, /Amazon/i]) {
  const record = feed.find(item => companyPattern.test(item.company));
  if (record && !chosen.some(item => item.id === record.id)) chosen.push(record);
}
for (const record of curated.sort((a, b) => (b.priority || 0) - (a.priority || 0) || b.salaryMax - a.salaryMax)) {
  if (chosen.length >= MAX_CARDS) break;
  if (!chosen.some(item => item.id === record.id)) chosen.push(record);
}
for (const record of feed) {
  if (chosen.length >= MAX_CARDS) break;
  if (!chosen.some(item => item.id === record.id)) chosen.push(record);
}

const output = chosen.slice(0, MAX_CARDS).map(({ priority, ...record }) => record);
if (output.length < MIN_CARDS) throw new Error(`Only ${output.length} qualifying $300K+ career-ceiling roles remain; expected at least ${MIN_CARDS}.`);

await writeFile('data/career-motivators.json', JSON.stringify(output, null, 2) + '\n');
console.log(`Career motivators refreshed: ${output.length} displayed.`);
for (const status of statuses) console.log(`- ${status}`);
for (const record of output) console.log(`- DISPLAY: ${record.company} — ${record.title} — ${record.pay}`);
