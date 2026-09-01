import { readFile } from 'node:fs/promises';

const requiredFiles = ['index.html','assets/styles.css','assets/app.js','data/jobs.json'];
for (const file of requiredFiles) {
  const value = await readFile(file, 'utf8');
  if (!value.trim()) throw new Error(`${file} is empty`);
}

const jobs = JSON.parse(await readFile('data/jobs.json', 'utf8'));
if (!Array.isArray(jobs)) throw new Error('jobs.json must contain an array');

const normalizeIdentity = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const seniorTitlePattern = /\b(?:senior|sr\.?|lead|principal|manager|director|vice president|vp|head of|staff engineer|supervisor|superintendent|foreman|counsel|attorney|architect|recruiter|sales|account executive)\b/i;
function canonicalTitle(job) {
  let title = String(job.title || '').trim();
  const location = normalizeIdentity(job.location);
  const locationTokens = new Set(location.split(' ').filter(token => token.length > 1));
  const tailBelongsToLocation = tail => {
    const tokens = normalizeIdentity(tail).split(' ').filter(token => token.length > 1);
    return tokens.length > 0 && tokens.every(token => locationTokens.has(token));
  };
  title = title.replace(/\s+[-–—]\s+([^|]+)$/u, (full, tail) => tailBelongsToLocation(tail) ? '' : full);
  title = title.replace(/\s*\(([^)]+)\)\s*$/u, (full, tail) => tailBelongsToLocation(tail) ? '' : full);
  return normalizeIdentity(title);
}

const ids = new Set();
const urls = new Set();
const semanticJobs = new Set();
for (const [i, job] of jobs.entries()) {
  for (const key of ['id','title','company','location','type','experience']) {
    if (!String(job[key] || '').trim()) throw new Error(`Job ${i} missing ${key}`);
  }
  if (ids.has(job.id)) throw new Error(`Duplicate job id: ${job.id}`);
  ids.add(job.id);
  if (!['entry-level','internship','apprenticeship','trainee'].includes(job.type)) throw new Error(`Unsupported job type: ${job.type}`);
  if (!['no-experience','0-2-years','2-5-years'].includes(job.experience)) throw new Error(`Unsupported experience band: ${job.experience}`);
  if (job.demo) throw new Error(`Demo job cannot be published: ${job.id}`);
  if (seniorTitlePattern.test(String(job.title || ''))) throw new Error(`Senior-title drift in early-career feed: ${job.title}`);
  if (!/^https:\/\//.test(job.sourceUrl || '')) throw new Error(`Real job ${job.id} missing valid sourceUrl`);
  if (urls.has(job.sourceUrl)) throw new Error(`Duplicate job URL: ${job.sourceUrl}`);
  urls.add(job.sourceUrl);
  if (job.active !== true) throw new Error(`Published real job ${job.id} is not active`);

  const semanticKey = [normalizeIdentity(job.company), canonicalTitle(job), normalizeIdentity(job.location)].join('|');
  if (semanticJobs.has(semanticKey)) throw new Error(`Near-duplicate published job: ${job.company} / ${job.title} / ${job.location}`);
  semanticJobs.add(semanticKey);
}

const html = await readFile('index.html','utf8');
for (const phrase of ['DATA CENTER CAREER','Search jobs','CURRENT OPENINGS','CAREER EVENTS','JOB ALERTS','FOR EMPLOYERS']) {
  if (!html.includes(phrase)) throw new Error(`Required product marker missing: ${phrase}`);
}
for (const phrase of ['SKILLED WORK · MODERN INFRASTRUCTURE · REAL OPPORTUNITY','Build your future in <em>data centers.</em>','Real openings for interns, apprentices, first-time applicants and workers ready for their next step.']) {
  if (!html.includes(phrase)) throw new Error(`Approved hero copy changed: ${phrase}`);
}
if (/FEATURED OPPORTUNITY\s*·?\s*DEMO|Summit Data Centers/i.test(html)) throw new Error('Demo featured opportunity must not appear on the production homepage');
if (/<style[\s>]/i.test(html)) throw new Error('Inline <style> blocks are prohibited; keep the UI in assets/styles.css');
if (/hero-overrides\.css/i.test(html)) throw new Error('Obsolete hero-overrides.css must not be linked');
const stylesheetLinks = [...html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi)];
if (stylesheetLinks.length !== 1 || !stylesheetLinks[0][0].includes('assets/styles.css')) throw new Error('Homepage must use exactly one stylesheet: assets/styles.css');

console.log(`Validation passed: ${jobs.length} jobs and ${requiredFiles.length} required files.`);
