import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const collectorSource = join(here, 'collect-coresite.mjs');
const workdir = await mkdtemp(join(tmpdir(), 'coresite-failover-'));

const listingHtml = `<!doctype html><html><body>
<p>Showing 1-1 of 1 results</p>
<a href="/jobs/99999999-data-center-operations-technician-i">Data Center Operations Technician I</a>
</body></html>`;
const detailHtml = `<!doctype html><html><body>
<h1>Data Center Operations Technician I</h1>
<p>Location: Testville, VA, United States Salary Range: $30 - $35 Description Minimum 1 year of data center experience. Work includes electrical, UPS, generator and data center operations.</p>
</body></html>`;

const fetchMock = `
const listingHtml = ${JSON.stringify(listingHtml)};
const detailHtml = ${JSON.stringify(detailHtml)};
globalThis.fetch = async input => {
  const url = String(input);
  if (url.includes('/search/data-center-operations/jobs/in')) {
    return { ok: false, status: 403, text: async () => '' };
  }
  if (url.startsWith('https://jobs.coresite.com/search/jobs')) {
    return { ok: true, status: 200, text: async () => listingHtml };
  }
  if (url.includes('/jobs/99999999-data-center-operations-technician-i')) {
    return { ok: true, status: 200, text: async () => detailHtml };
  }
  throw new Error('Unexpected fetch in CoreSite failover test: ' + url);
};
`;

try {
  await mkdir(join(workdir, 'scripts'), { recursive: true });
  await mkdir(join(workdir, 'data'), { recursive: true });
  await copyFile(collectorSource, join(workdir, 'scripts', 'collect-coresite.mjs'));
  await writeFile(join(workdir, 'mock-fetch.mjs'), fetchMock);
  await writeFile(join(workdir, 'data', 'jobs.json'), '[]\n');
  await writeFile(join(workdir, 'data', 'collector-status.json'), '{}\n');

  await exec('git', ['init', '-q'], { cwd: workdir });
  await exec('git', ['config', 'user.email', 'qa@datacentercareers.us'], { cwd: workdir });
  await exec('git', ['config', 'user.name', 'Data Center Careers QA'], { cwd: workdir });
  await exec('git', ['add', 'data/jobs.json', 'data/collector-status.json'], { cwd: workdir });
  await exec('git', ['commit', '-qm', 'baseline'], { cwd: workdir });

  const { stdout, stderr } = await exec(process.execPath, ['--import', './mock-fetch.mjs', './scripts/collect-coresite.mjs'], {
    cwd: workdir,
    maxBuffer: 10 * 1024 * 1024
  });

  const jobs = JSON.parse(await readFile(join(workdir, 'data', 'jobs.json'), 'utf8'));
  const status = JSON.parse(await readFile(join(workdir, 'data', 'collector-status.json'), 'utf8'));
  const job = jobs.find(item => item.id === 'coresite-99999999');

  assert.ok(job, `Failover did not publish the synthetic official CoreSite role.\n${stdout}\n${stderr}`);
  assert.equal(job.company, 'CoreSite');
  assert.equal(job.type, 'entry-level');
  assert.equal(job.experience, '0-2-years');
  assert.equal(job.location, 'Testville, VA');
  assert.equal(status?.coreSite?.sourceHealthy, true);
  assert.equal(status?.coreSite?.officialSource, 'https://jobs.coresite.com/search/jobs');
  assert.equal(status?.coreSite?.diagnostics?.selectedListingPath, '/search/jobs');
  assert.equal(status?.coreSite?.diagnostics?.listingAttempts?.length, 2);
  assert.equal(status.coreSite.diagnostics.listingAttempts[0].sourceHealthy, false);
  assert.match(String(status.coreSite.diagnostics.listingAttempts[0].error || ''), /403/);
  assert.equal(status.coreSite.diagnostics.listingAttempts[1].listingComplete, true);
  assert.deepEqual(status.coreSite.errors, []);

  console.log('CoreSite source failover guard passed: blocked targeted listing recovered through the official root listing without stale-only preservation.');
} finally {
  await rm(workdir, { recursive: true, force: true });
}
