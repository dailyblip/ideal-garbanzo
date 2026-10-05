import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const NOW = '2026-10-05T12:00:00.000Z';
const ANCHOR = '2026-10-05T03:41:00.000Z';
const EXPIRY = '2026-10-09T03:41:00.000Z';
const otherJob = { id: 'other-1', company: 'Other', title: 'Other role', type: 'entry-level', experience: '0-2-years', postedHours: 9999 };
const otherStatus = { sourceHealthy: true, marker: 'untouched' };
const previous = Array.from({ length: 20 }, (_, index) => ({
  id: `microsoft-${100000000 + index}`,
  company: 'Microsoft', title: 'Datacenter Technician',
  location: index ? `Testcity${index}, VA` : 'Boydton, VA',
  type: 'entry-level', experience: index % 2 ? '2-5-years' : '0-2-years',
  tags: [], source: 'Official Microsoft Careers',
  sourceUrl: `https://apply.careers.microsoft.com/careers/job/${100000000 + index}?hl=en`,
  active: true, demo: false, postedHours: 9999
}));
const originalSnapshot = { verifiedAt: ANCHOR, expiresAt: EXPIRY, jobs: previous, marker: 'original verification' };
const encode = value => JSON.stringify(value, null, 2) + '\n';
let scenarios = 0;

// Execute real entrypoints in temporary fixtures, intercept every network request,
// and advance the source clock so a later persistence run cannot impersonate a crawl.
async function run(cwd, script, { mode = 'unavailable', now = NOW } = {}) {
  const code = `
    const RealDate = Date;
    let now = RealDate.parse(${JSON.stringify(now)});
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    };
    const mode = ${JSON.stringify(mode)};
    const jobs = ${JSON.stringify(previous)};
    globalThis.fetch = async input => {
      now += 1000;
      const url = new URL(String(input));
      if (url.origin === 'https://apply.careers.microsoft.com' && url.pathname === '/api/pcsx/search') {
        if (['unavailable', 'legacy-failure'].includes(mode)) return new Response('', { status: 503 });
        const start = Number(url.searchParams.get('start'));
        return Response.json({ data: { count: jobs.length, positions: jobs.slice(start, start + 10).map(job => ({
          id: job.id.slice(10), name: job.title, location: job.location + ', United States'
        })) } });
      }
      if (url.origin === 'https://apply.careers.microsoft.com' && url.pathname === '/api/pcsx/position_details') {
        const id = url.searchParams.get('position_id');
        const index = jobs.findIndex(job => job.id === 'microsoft-' + id);
        if (index < 0) throw new Error('Unexpected detail request: ' + url);
        if (mode === 'all-detail-failure' || (mode === 'partial-detail-failure' && index === 1)) return new Response('', { status: 503 });
        const job = jobs[index];
        const years = index === 19 ? 6 : index % 2 ? 3 : 1;
        return Response.json({ data: { id, name: job.title, positionUrl: job.sourceUrl, publicUrl: job.sourceUrl, location: job.location + ', United States',
          jobDescription: 'Required Qualifications ' + years + ' years of experience in data center operations.' } });
      }
      if (url.origin === 'https://careers.microsoft.com' && ['/v2/global/en/datacentertechnicians.html', '/v2/global/en/datacenters.html'].includes(url.pathname)) {
        if (mode === 'legacy-failure') return new Response('', { status: 503 });
        return new Response('<h3>Datacenter Technician</h3><p>United States, Virginia, Boydton Fully on-site Overview Required Qualifications 3 years of experience in data center operations.</p><a href="' + jobs[0].sourceUrl + '">Apply</a>');
      }
      throw new Error('Unexpected network request: ' + url);
    };
    await import(${JSON.stringify(new URL(script, import.meta.url).href)});
  `;
  return exec(process.execPath, ['--input-type=module', '--eval', code], { cwd, maxBuffer: 4 * 1024 * 1024 });
}

const read = async (cwd, file) => JSON.parse(await readFile(join(cwd, 'data', file), 'utf8'));
const published = async cwd => (await read(cwd, 'jobs.json')).filter(job => job.company === 'Microsoft');
async function scenario(check, { jobs = previous, snapshot = originalSnapshot, source = {} } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'microsoft-fallback-'));
  try {
    await mkdir(join(cwd, 'data'));
    await writeFile(join(cwd, 'data/jobs.json'), encode([otherJob, ...jobs]));
    await writeFile(join(cwd, 'data/collector-status.json'), encode({
      updatedAt: '2099-01-01T00:00:00.000Z', otherSource: otherStatus,
      errors: ['Other source: unchanged'],
      microsoftDatacenter: { sourceHealthy: true, sourceMode: 'eightfold-pcsx',
        snapshotFallback: { active: false, verifiedAt: ANCHOR, expiresAt: EXPIRY, roles: jobs.length }, ...source }
    }));
    if (snapshot) await writeFile(join(cwd, 'data/microsoft-jobs.json'), encode(snapshot));
    await check(cwd);
    assert.deepEqual((await read(cwd, 'jobs.json')).filter(job => job.company !== 'Microsoft'), [otherJob]);
    const status = await read(cwd, 'collector-status.json');
    assert.deepEqual(status.otherSource, otherStatus);
    assert.ok(status.errors.includes('Other source: unchanged'));
    scenarios++;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

for (const mode of ['unavailable', 'partial-detail-failure', 'all-detail-failure', 'legacy-failure']) {
  await scenario(async cwd => {
    await run(cwd, 'collect-microsoft-datacenter.mjs', { mode });
    const status = (await read(cwd, 'collector-status.json')).microsoftDatacenter;
    assert.equal(status.sourceHealthy, false);
    assert.equal(status.sourceMode, 'retained-previous');
    assert.equal(status.retainedPrevious, true);
    assert.equal(status.qualifyingRoles, 20);
    assert.equal(status.snapshotFallback.verifiedAt, ANCHOR);
    assert.deepEqual(await published(cwd), previous, 'partial discovery must preserve canonical rows and classifications');
    if (mode !== 'legacy-failure') assert.equal(status.legacyFallback.qualifyingRoles, 1);
    await run(cwd, 'persist-microsoft-snapshot.mjs');
    assert.equal(await readFile(join(cwd, 'data/microsoft-jobs.json'), 'utf8'), encode(originalSnapshot));
    await run(cwd, 'enforce-microsoft-fallback-freshness.mjs');
    const fallback = (await read(cwd, 'collector-status.json')).microsoftDatacenter.snapshotFallback;
    assert.equal(fallback.active, true);
    assert.equal(fallback.verifiedAt, ANCHOR);
    assert.equal(fallback.expiresAt, EXPIRY);
    await run(cwd, 'validate-microsoft-snapshot.mjs');
  });
}

// The existing zero-collapse restoration runs before collection and remains usable.
await scenario(async cwd => {
  await run(cwd, 'apply-microsoft-verified-fallback.mjs');
  await run(cwd, 'collect-microsoft-datacenter.mjs');
  await run(cwd, 'persist-microsoft-snapshot.mjs');
  assert.deepEqual(await published(cwd), previous);
  assert.deepEqual(await read(cwd, 'microsoft-jobs.json'), originalSnapshot);
}, { jobs: [] });

// Fresh direct evidence can supersede the old snapshot and remove a role whose
// current detail now requires six years, without using the legacy page's labels.
for (const prior of [true, false]) {
  await scenario(async cwd => {
    await run(cwd, 'collect-microsoft-datacenter.mjs', { mode: 'healthy' });
    const direct = (await read(cwd, 'collector-status.json')).microsoftDatacenter;
    assert.equal(direct.sourceHealthy, true);
    assert.equal(direct.detailVerified, 20);
    assert.equal(direct.qualifyingRoles, 19, JSON.stringify(direct));
    assert.equal(direct.legacyFallback, null);
    assert.equal((await published(cwd))[0].experience, '0-2-years');
    assert.equal((await published(cwd))[1].experience, '2-5-years');
    await run(cwd, 'persist-microsoft-snapshot.mjs', { now: '2026-10-05T13:00:00.000Z' });
    const snapshot = await read(cwd, 'microsoft-jobs.json');
    assert.equal(snapshot.verifiedAt, direct.checkedAt);
    assert.notEqual(snapshot.verifiedAt, ANCHOR);
    assert.equal(Date.parse(snapshot.expiresAt) - Date.parse(snapshot.verifiedAt), 96 * 36e5);
    assert.equal(snapshot.jobs.length, 19);
    assert.deepEqual(snapshot.jobs, await published(cwd));
    assert.equal((await read(cwd, 'collector-status.json')).microsoftDatacenter.snapshotFallback.active, false);
    await run(cwd, 'persist-microsoft-snapshot.mjs', { now: '2026-10-05T14:00:00.000Z' });
    assert.deepEqual(await read(cwd, 'microsoft-jobs.json'), snapshot, 'rerunning persistence cannot renew verification');
    await run(cwd, 'validate-microsoft-snapshot.mjs', { now: '2026-10-05T14:00:00.000Z' });
    await run(cwd, 'collect-microsoft-datacenter.mjs', { now: '2026-10-05T15:00:00.000Z' });
    await run(cwd, 'persist-microsoft-snapshot.mjs', { now: '2026-10-05T15:01:00.000Z' });
    assert.deepEqual(await read(cwd, 'microsoft-jobs.json'), snapshot, 'subsequent outage retains the newly verified full snapshot');
  }, prior ? {} : { jobs: [], snapshot: null });
}

await scenario(async cwd => {
  await run(cwd, 'collect-microsoft-datacenter.mjs');
  await run(cwd, 'enforce-microsoft-fallback-freshness.mjs', { now: '2026-10-09T03:40:59.999Z' });
  assert.equal((await published(cwd)).length, 20);
  await run(cwd, 'enforce-microsoft-fallback-freshness.mjs', { now: EXPIRY });
  assert.equal((await published(cwd)).length, 0);
  const status = (await read(cwd, 'collector-status.json')).microsoftDatacenter;
  assert.equal(status.snapshotFallback.expired, true);
  assert.equal(status.snapshotFallback.verifiedAt, ANCHOR);
  assert.deepEqual(await read(cwd, 'microsoft-jobs.json'), originalSnapshot);
  await run(cwd, 'validate-microsoft-snapshot.mjs', { now: EXPIRY });
});

await scenario(async cwd => {
  const initialStatus = await read(cwd, 'collector-status.json');
  await assert.rejects(run(cwd, 'collect-microsoft-datacenter.mjs'), /no prior verified roles/);
  assert.deepEqual(await published(cwd), [], 'legacy discovery cannot bootstrap unverified rows');
  assert.deepEqual(await read(cwd, 'collector-status.json'), initialStatus);
  await assert.rejects(readFile(join(cwd, 'data/microsoft-jobs.json')), { code: 'ENOENT' });
}, { jobs: [], snapshot: null });

// A previously reconciled positive closure stays removed even when the legacy
// landing page still advertises that closed requisition.
await scenario(async cwd => {
  await run(cwd, 'collect-microsoft-datacenter.mjs');
  await run(cwd, 'persist-microsoft-snapshot.mjs');
  assert.deepEqual(await published(cwd), previous.slice(1));
  assert.deepEqual(await read(cwd, 'microsoft-jobs.json'), { ...originalSnapshot, jobs: previous.slice(1) });
  await run(cwd, 'enforce-microsoft-fallback-freshness.mjs');
  await run(cwd, 'validate-microsoft-snapshot.mjs');
}, { jobs: previous.slice(1), snapshot: { ...originalSnapshot, jobs: previous.slice(1) } });

// Defense in depth: historic legacy/partial statuses cannot overwrite a snapshot.
for (const source of [
  { sourceMode: 'legacy-curated', sourceHealthy: true },
  { sourceMode: 'eightfold-pcsx', sourceHealthy: true, checkedAt: NOW, detailAttempts: 20, detailVerified: 19 },
  { sourceMode: 'eightfold-pcsx', sourceHealthy: true, detailAttempts: 20, detailVerified: 20 }
]) {
  await scenario(async cwd => {
    await run(cwd, 'persist-microsoft-snapshot.mjs');
    assert.deepEqual(await read(cwd, 'microsoft-jobs.json'), originalSnapshot);
  }, { source });
}

console.log(`Microsoft collector fallback passed ${scenarios} isolated offline scenarios.`);
