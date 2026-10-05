import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const START = '2026-10-05T12:00:00.000Z';
const ANCHOR = '2026-10-04T12:00:00.000Z';
const EXPIRY = '2026-10-08T12:00:00.000Z';
const GLOBAL_UPDATED = '2099-01-01T00:00:00.000Z';
const unrelatedSource = { sourceHealthy: true, checkedAt: ANCHOR, marker: 'untouched' };
const unrelatedJob = { id: 'other-1', company: 'Other', title: 'Other role', location: 'Test, TX', type: 'entry-level', experience: '0-2-years' };
const previousJobs = ['11111111', '22222222'].map((id, index) => ({
  id: `coresite-${id}`,
  title: index ? 'SkillBridge Data Center Operations Technician Internship' : 'Data Center Operations Technician I',
  company: 'CoreSite',
  location: index ? 'Chicago, IL' : 'Reston, VA',
  type: index ? 'internship' : 'entry-level',
  experience: index ? '2-5-years' : '0-2-years',
  tags: [],
  source: 'CoreSite Careers',
  sourceUrl: `https://jobs.coresite.com/jobs/${id}-technician`,
  active: true,
  demo: false
}));
const fallback = {
  verifiedAt: ANCHOR,
  expiresAt: EXPIRY,
  officialSource: 'https://jobs.coresite.com/search/data-center-operations/jobs/in',
  reason: 'Earlier verified evidence',
  jobs: previousJobs,
  reverification: { checkedAt: ANCHOR, marker: 'original provenance' }
};
const originalFallbackText = JSON.stringify(fallback, null, 2) + '\n';
let scenarios = 0;

// Run the production entry point against deterministic employer responses in an
// isolated Git fixture. Advance the clock for each fetch to catch startup/global
// timestamps being mistaken for source-verification completion.
async function runScript(cwd, script, mode = 'healthy') {
  const code = `
    import { readFile, writeFile } from 'node:fs/promises';
    const RealDate = Date;
    const priorClock = await readFile('completion-clock.json', 'utf8').then(JSON.parse).catch(() => null);
    let now = RealDate.parse(priorClock?.completedAt || ${JSON.stringify(START)});
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    };
    const mode = ${JSON.stringify(mode)};
    const jobs = ${JSON.stringify(previousJobs)};
    globalThis.fetch = async input => {
      now += 1000;
      const url = new URL(String(input));
      if (url.origin !== 'https://jobs.coresite.com') throw new Error('Unexpected network request: ' + url);
      if (url.pathname.startsWith('/search/')) {
        if (mode === 'listing-failure' || (mode === 'root-recovery' && url.pathname.includes('/data-center-operations/'))) {
          return new Response('', { status: 403 });
        }
        if (mode === 'empty-listing') return new Response('<p>No jobs found</p>');
        const page = Number(url.searchParams.get('page') || 1);
        if (mode === 'listing-page-failure' && page > 1) return new Response('', { status: 503 });
        const partial = ['repeated-partial-listing', 'listing-page-failure'].includes(mode);
        const rows = mode === 'paginated' ? [jobs[page - 1]] : jobs;
        return new Response('<p>Showing 1-' + rows.length + ' of ' + (partial ? 3 : 2) + ' results</p>'
          + rows.map(job => '<a href="' + job.sourceUrl + '">' + job.title + '</a>').join(''));
      }
      const job = jobs.find(item => item.sourceUrl === String(url));
      if (!job) throw new Error('Unexpected detail URL: ' + url);
      const second = job.id.endsWith('22222222');
      if (mode === 'detail-failure' || (['partial-detail-failure', 'new-detail-failure'].includes(mode) && second)) {
        return new Response('', { status: 503 });
      }
      const years = mode === 'zero-qualifying' ? 9 : second ? 3 : 1;
      const experience = mode === 'retained-parse-failure' && second ? '' : years + ' years of data center experience.';
      return new Response('<h1>' + job.title + '</h1><p>Location: ' + job.location
        + ', United States Salary Range: $30 - $35 Description ' + experience + '</p>');
    };
    await import(${JSON.stringify(new URL(script, import.meta.url).href)});
    await writeFile('completion-clock.json', JSON.stringify({ completedAt: new Date().toISOString() }));
  `;
  await exec(process.execPath, ['--input-type=module', '--eval', code], { cwd, maxBuffer: 10 * 1024 * 1024 });
}

async function readState(cwd) {
  const readJson = async name => JSON.parse(await readFile(join(cwd, 'data', name), 'utf8'));
  return {
    status: await readJson('collector-status.json'),
    jobs: await readJson('jobs.json'),
    fallback: await readJson('coresite-verified-fallback.json'),
    fallbackText: await readFile(join(cwd, 'data/coresite-verified-fallback.json'), 'utf8'),
    completedAt: JSON.parse(await readFile(join(cwd, 'completion-clock.json'), 'utf8')).completedAt
  };
}

async function scenario(mode, verify, { anchor = ANCHOR, priorJobs = previousJobs, priorFallback = fallback, expectError = null } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'coresite-persistence-'));
  try {
    await mkdir(join(cwd, 'data'));
    for (const [name, value] of Object.entries({
      'jobs.json': [unrelatedJob, ...priorJobs],
      'coresite-verified-fallback.json': priorFallback,
      'collector-status.json': {
        updatedAt: GLOBAL_UPDATED,
        unrelatedSource,
        coreSite: { sourceHealthy: true, lastHealthyAt: anchor, checkedAt: GLOBAL_UPDATED }
      }
    })) await writeFile(join(cwd, 'data', name), JSON.stringify(value, null, 2) + '\n');
    await exec('git', ['init', '-q'], { cwd });
    await exec('git', ['add', 'data'], { cwd });
    await exec('git', ['-c', 'user.name=CoreSite Offline QA', '-c', 'user.email=qa@example.invalid', 'commit', '-qm', 'fixture'], { cwd });
    if (expectError) {
      await assert.rejects(runScript(cwd, 'collect-coresite.mjs', mode), expectError);
      const { stdout } = await exec('git', ['status', '--porcelain', '--', 'data'], { cwd });
      assert.equal(stdout, '', 'unsafe retirement must stop without changing source data or fallback evidence');
      scenarios += 1;
      return;
    }
    await runScript(cwd, 'collect-coresite.mjs', mode);
    const state = await readState(cwd);
    assert.deepEqual(state.status.unrelatedSource, unrelatedSource);
    assert.deepEqual(state.jobs.find(job => job.id === unrelatedJob.id), unrelatedJob);
    assert.equal(state.status.coreSite.checkedAt, state.completedAt);
    assert.notEqual(state.status.coreSite.checkedAt, START, 'timestamp must follow all source requests');
    assert.notEqual(state.status.coreSite.checkedAt, GLOBAL_UPDATED);
    await verify(state, cwd);
    scenarios += 1;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

for (const mode of ['healthy', 'paginated', 'root-recovery']) {
  await scenario(mode, async ({ status, jobs, fallback: saved, completedAt }, cwd) => {
    const core = status.coreSite;
    assert.equal(core.sourceHealthy, true);
    assert.equal(core.lastHealthyAt, completedAt);
    assert.equal(core.fallbackPersistence.updated, true);
    assert.equal(saved.verifiedAt, completedAt);
    assert.equal(saved.reverification.checkedAt, completedAt);
    assert.equal(Date.parse(saved.expiresAt) - Date.parse(saved.verifiedAt), 96 * 36e5);
    assert.deepEqual(saved.jobs, jobs.filter(job => job.company === 'CoreSite'));
    assert.deepEqual(saved.jobs.map(job => job.type), ['entry-level', 'internship'], 'existing program classifier must survive');
    assert.equal(saved.reverification.diagnostics.listingComplete, true);
    assert.equal(saved.reverification.diagnostics.detailSucceeded, 2);
    assert.equal(saved.reverification.diagnostics.preservedOnFailure, 0);
    assert.equal(saved.officialSource, core.officialSource);
    assert.equal(saved.reverification.collector, 'scripts/collect-coresite.mjs');
    if (mode === 'root-recovery') assert.equal(saved.officialSource, 'https://jobs.coresite.com/search/jobs');
    await runScript(cwd, 'apply-coresite-verified-fallback.mjs');
    await runScript(cwd, 'validate-coresite-source-integrity.mjs');
    await runScript(cwd, 'validate-coresite-fallback.mjs');
    // The new durable evidence must survive the next blocked CI-style scan.
    await runScript(cwd, 'collect-coresite.mjs', 'listing-failure');
    assert.deepEqual((await readState(cwd)).fallback, saved);
    assert.equal((await readState(cwd)).status.coreSite.lastHealthyAt, completedAt);
    await runScript(cwd, 'apply-coresite-verified-fallback.mjs');
    assert.deepEqual((await readState(cwd)).jobs.filter(job => job.company === 'CoreSite'), saved.jobs);
  });
}

for (const mode of ['listing-failure', 'repeated-partial-listing', 'listing-page-failure', 'detail-failure', 'partial-detail-failure', 'retained-parse-failure', 'new-detail-failure', 'empty-listing']) {
  await scenario(mode, async ({ status, fallbackText }, cwd) => {
    assert.equal(status.coreSite.sourceHealthy, false, `${mode} must not declare complete source health`);
    assert.equal(status.coreSite.lastHealthyAt, ANCHOR);
    assert.equal(status.coreSite.fallbackPersistence.updated, false);
    assert.equal(fallbackText, originalFallbackText, `${mode} must preserve fallback content and anchor byte-for-byte`);
    if (mode === 'retained-parse-failure') assert.equal(status.coreSite.diagnostics.preservedOnFailure, 1);
    if (mode === 'new-detail-failure') assert.equal(status.coreSite.diagnostics.preservedOnFailure, 0);
    if (mode === 'repeated-partial-listing') assert.equal(status.coreSite.diagnostics.listingComplete, false);
    await runScript(cwd, 'apply-coresite-verified-fallback.mjs');
    await runScript(cwd, 'validate-coresite-source-integrity.mjs');
    await runScript(cwd, 'validate-coresite-fallback.mjs');
  }, { priorJobs: mode === 'new-detail-failure' ? previousJobs.slice(0, 1) : previousJobs });
}

for (const anchor of [null, 'invalid-date', GLOBAL_UPDATED]) {
  await scenario('listing-failure', ({ status, fallbackText }) => {
    assert.equal(status.coreSite.lastHealthyAt, null, 'neither global nor check timestamps can fabricate a healthy anchor');
    assert.equal(fallbackText, originalFallbackText);
  }, { anchor });
}

await scenario('zero-qualifying', async ({ status, jobs, fallback: retired, completedAt }, cwd) => {
  assert.equal(status.coreSite.sourceHealthy, true);
  assert.equal(status.coreSite.lastHealthyAt, completedAt);
  assert.equal(jobs.filter(job => job.company === 'CoreSite').length, 0);
  assert.equal(retired.verifiedAt, fallback.verifiedAt, 'zero results cannot renew the old verification anchor');
  assert.deepEqual(retired.jobs, fallback.jobs, 'keep the existing nonempty consumer schema');
  assert.deepEqual(retired.reverification, fallback.reverification);
  assert.equal(Date.parse(retired.expiresAt), Date.parse(completedAt) - 1);
  assert.equal(retired.retirement.checkedAt, completedAt);
  assert.equal(retired.retirement.originalExpiresAt, EXPIRY);
  await runScript(cwd, 'apply-coresite-verified-fallback.mjs');
  await runScript(cwd, 'validate-coresite-source-integrity.mjs');
  await runScript(cwd, 'validate-coresite-fallback.mjs');
  await runScript(cwd, 'collect-coresite.mjs', 'listing-failure');
  assert.deepEqual((await readState(cwd)).fallback, retired, 'later failure cannot undo zero-result retirement');
  await runScript(cwd, 'apply-coresite-verified-fallback.mjs');
  assert.equal((await readState(cwd)).jobs.filter(job => job.company === 'CoreSite').length, 0, 'later failure must not resurrect old roles');
  await runScript(cwd, 'validate-coresite-source-integrity.mjs');
  await runScript(cwd, 'validate-coresite-fallback.mjs');
});

await scenario('zero-qualifying', ({ fallback: retired }) => {
  assert.equal(retired.verifiedAt, '2026-09-19T12:00:00.000Z');
  assert.equal(retired.expiresAt, '2026-09-23T12:00:00.000Z', 'zero results must never extend already expired evidence');
}, { priorFallback: { ...fallback, verifiedAt: '2026-09-19T12:00:00.000Z', expiresAt: '2026-09-23T12:00:00.000Z' } });

await scenario('zero-qualifying', null, {
  priorFallback: { ...fallback, verifiedAt: GLOBAL_UPDATED, expiresAt: '2099-01-05T00:00:00.000Z' },
  expectError: /cannot safely retire fallback/
});

console.log(`CoreSite collector persistence integration tests passed: ${scenarios} offline completion, fallback, partial/failure, timestamp, and zero-result scenarios.`);
