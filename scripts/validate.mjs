import { readFile } from 'node:fs/promises';

const requiredFiles = ['index.html','assets/styles.css','assets/app.js','data/jobs.json'];
for (const file of requiredFiles) {
  const value = await readFile(file, 'utf8');
  if (!value.trim()) throw new Error(`${file} is empty`);
}

const jobs = JSON.parse(await readFile('data/jobs.json', 'utf8'));
if (!Array.isArray(jobs)) throw new Error('jobs.json must contain an array');

const ids = new Set();
for (const [i, job] of jobs.entries()) {
  for (const key of ['id','title','company','location','type','experience']) {
    if (!String(job[key] || '').trim()) throw new Error(`Job ${i} missing ${key}`);
  }
  if (ids.has(job.id)) throw new Error(`Duplicate job id: ${job.id}`);
  ids.add(job.id);
  if (!['entry-level','internship','apprenticeship','trainee'].includes(job.type)) {
    throw new Error(`Unsupported job type: ${job.type}`);
  }
  if (!['no-experience','0-2-years'].includes(job.experience)) {
    throw new Error(`Unsupported experience band: ${job.experience}`);
  }
}

const html = await readFile('index.html','utf8');
for (const phrase of ['Launch Your','Data Center','Career','FEATURED OPPORTUNITY','For Employers']) {
  if (!html.includes(phrase)) throw new Error(`Locked design marker missing: ${phrase}`);
}

console.log(`Validation passed: ${jobs.length} jobs and ${requiredFiles.length} required files.`);
