import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const NOW = '2026-10-05T12:00:00.000Z';
const RECENT = '2026-10-04T12:00:00.000Z';
const BOUNDARY = '2026-10-01T12:00:00.000Z';
const SEARCH_BASE = 'https://www.google.com/about/careers/applications/jobs/results/';
const unrelatedSource = { sourceHealthy: true, checkedAt: RECENT, evidence: 'unchanged' };
const previousJobs = ['111111111', '222222222'].map((id, index) => ({
  id: `google-${id}`,
  title: 'Data Center Technician',
  company: 'Google',
  location: index ? 'Omaha, NE' : 'Council Bluffs, IA',
  type: 'entry-level',
  experience: '0-2-years',
  source: 'Google Careers',
  sourceUrl: `${SEARCH_BASE}${id}-data-center-technician`,
  active: true,
  demo: false
}));

// Exercise the real file-writing entry points with deterministic, offline
// employer responses. No repository data or external service is modified.
async function runScript(cwd, script, mode = 'healthy') {
  const entry = new URL(script, import.meta.url).href;
  const code = `
    const now = Date.parse(${JSON.stringify(NOW)});
    const RealDate = Date;
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    };
    const mode = ${JSON.stringify(mode)};
    globalThis.fetch = async value => {
      const url = new URL(String(value));
      if (url.origin !== 'https://www.google.com') throw new Error('Unexpected network request: ' + url.origin);
      if (url.searchParams.has('page')) {
        if (mode === 'listing-failure') throw new Error('Mock listing unavailable');
        return new Response(${JSON.stringify(previousJobs.map(job => `<a href="${job.sourceUrl}">${job.title}</a>`).join(''))});
      }
      const second = url.pathname.includes('222222222');
      if (mode === 'detail-failure' || (mode === 'partial-detail-failure' && second)) {
        throw new Error('Mock detail unavailable');
      }
      const location = second ? 'Omaha, NE, USA' : 'Council Bluffs, IA, USA';
      return new Response('<h2>Data Center Technician</h2><p>' + location + '</p><h3>Minimum qualifications</h3><p>2 years of experience in data center operations.</p><h3>Preferred qualifications</h3>');
    };
    await import(${JSON.stringify(entry)});
  `;
  await exec(process.execPath, ['--input-type=module', '--eval', code], { cwd });
}

async function scenario({ script = 'collect-google-careers-fresh.mjs', mode = 'healthy', anchor = RECENT, google = {}, snapshot = previousJobs, transforms = false }, verify) {
  const cwd = await mkdtemp(join(tmpdir(), 'google-collector-freshness-'));
  try {
    await mkdir(join(cwd, 'data'));
    for (const [name, value] of Object.entries({
      'jobs.json': snapshot,
      'google-jobs.json': snapshot,
      'major-jobs.json': [],
      'career-events.json': [],
      'collector-status.json': {
        updatedAt: NOW,
        unrelatedSource,
        googleCareers: { sourceHealthy: true, lastHealthyAt: anchor, ...google }
      }
    })) await writeFile(join(cwd, 'data', name), JSON.stringify(value));

    await runScript(cwd, script, mode);
    const readState = async () => ({
      status: JSON.parse(await readFile(join(cwd, 'data/collector-status.json'), 'utf8')),
      jobs: JSON.parse(await readFile(join(cwd, 'data/jobs.json'), 'utf8')),
      snapshot: JSON.parse(await readFile(join(cwd, 'data/google-jobs.json'), 'utf8'))
    });
    const state = await readState();
    assert.deepEqual(state.status.unrelatedSource, unrelatedSource, 'Google collector must preserve other source diagnostics');
    verify(state);

    if (transforms) {
      for (const transform of ['filter-mission-fit.mjs', 'normalize-job-locations.mjs', 'dedupe-normalized-jobs.mjs', 'normalize-display-copy.mjs', 'stamp-job-history.mjs']) {
        await runScript(cwd, transform);
        const transformed = await readState();
        assert.deepEqual(transformed.status.googleCareers, state.status.googleCareers, `${transform} must preserve Google verification metadata`);
      }
    }
    await runScript(cwd, 'validate-google-freshness.mjs');
    await runScript(cwd, 'validate-google-snapshot.mjs');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

for (const script of ['collect-google-careers.mjs', 'collect-google-careers-fresh.mjs']) {
  await scenario({ script, anchor: BOUNDARY, google: { fallbackExpired: true }, snapshot: [], transforms: true }, ({ status, snapshot }) => {
    assert.equal(status.googleCareers.sourceHealthy, true);
    assert.equal(status.googleCareers.lastHealthyAt, NOW, `${script} must own a new anchor after genuine verification`);
    assert.equal(status.googleCareers.checkedAt, NOW);
    assert.notEqual(status.googleCareers.fallbackExpired, true);
    assert.equal(snapshot.length, 2);
  });

  for (const mode of ['listing-failure', 'detail-failure', 'partial-detail-failure']) {
    await scenario({ script, mode }, ({ status, snapshot }) => {
      assert.equal(status.googleCareers.sourceHealthy, false);
      assert.equal(status.googleCareers.lastHealthyAt, RECENT, `${mode} must preserve the earlier verification time`);
      assert.equal(snapshot.length, 2);
      if (mode === 'partial-detail-failure') {
        assert.equal(status.googleCareers.diagnostics.detailVerified, 1);
        assert.equal(status.googleCareers.diagnostics.preservedFromPrevious, 1);
      }
    });
  }
}

await scenario({ mode: 'listing-failure', anchor: '2026-10-01T13:00:00.000Z' }, ({ status, snapshot }) => {
  assert.equal(status.googleCareers.fallbackExpired, false);
  assert.equal(status.googleCareers.fallbackAgeHours, 95);
  assert.equal(status.googleCareers.usedPreviousSnapshot, true);
  assert.equal(snapshot.length, 2);
});

for (const mode of ['listing-failure', 'partial-detail-failure']) {
  await scenario({ mode, anchor: BOUNDARY }, ({ status, jobs, snapshot }) => {
    assert.equal(status.googleCareers.lastHealthyAt, BOUNDARY);
    assert.equal(status.googleCareers.fallbackExpired, true, 'fallback must expire at exactly 96 hours');
    assert.equal(status.googleCareers.fallbackExpiresAt, NOW);
    assert.equal(status.googleCareers.qualifyingRoles, 0);
    assert.equal(status.googleCareers.usedPreviousSnapshot, false);
    assert.equal(jobs.length, 0);
    assert.equal(snapshot.length, 0);
  });
}

for (const anchor of [null, 'invalid-date']) {
  await scenario({ mode: 'listing-failure', anchor, google: { sourceHealthy: true, checkedAt: NOW, freshnessCheckedAt: NOW } }, ({ status, jobs, snapshot }) => {
    assert.equal(status.googleCareers.lastHealthyAt, null, 'global and check timestamps must not fabricate missing verification evidence');
    assert.equal(status.googleCareers.fallbackExpired, true);
    assert.equal(status.googleCareers.qualifyingRoles, 0);
    assert.equal(jobs.length, 0);
    assert.equal(snapshot.length, 0);
  });
}

await scenario({ mode: 'listing-failure', anchor: BOUNDARY, google: { sourceHealthy: false, fallbackExpired: true }, snapshot: [] }, ({ status, snapshot }) => {
  assert.equal(status.googleCareers.lastHealthyAt, BOUNDARY);
  assert.equal(status.googleCareers.fallbackExpired, true);
  assert.equal(snapshot.length, 0);
});

console.log('Google collector freshness integration tests passed: 14 offline success, fallback, expiry, recovery, and shared-transform scenarios.');
