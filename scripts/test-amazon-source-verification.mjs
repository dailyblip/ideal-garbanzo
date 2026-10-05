import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const NOW = '2026-10-05T12:00:00.000Z';
const LATER = '2026-10-05T13:00:00.000Z';
const ANCHOR = '2026-10-03T12:00:00.000Z';
const RAW_AT = '2026-10-04T12:00:00.000Z';
const RECOVERY_AT = '2026-10-04T13:00:00.000Z';
const BOUNDARY = '2026-10-01T12:00:00.000Z';
const FUTURE = '2026-10-06T12:00:00.000Z';
const COMPANY = 'Amazon Web Services';
const unrelatedSource = { sourceHealthy: true, checkedAt: ANCHOR, evidence: 'unchanged' };
const otherJob = {
  id: 'unrelated-1', title: 'Data Center Technician', company: 'Other Employer',
  location: 'Ashburn, VA', type: 'entry-level', experience: '0-2-years',
  sourceUrl: 'https://example.com/jobs/1', active: true, demo: false
};
const rows = ['1111111', '2222222'].map((id, index) => ({
  id_icims: id,
  title: 'Data Center Technician',
  location: index ? 'USA, OH, Columbus' : 'USA, VA, Ashburn',
  country_code: 'USA',
  job_path: `/en/jobs/${id}/data-center-technician`,
  description: 'Work in data center operations.',
  // The second role requires the real recovery script's detail hydration.
  basic_qualifications: index ? '' : '2 years of experience in data center operations.'
}));
const previousJobs = rows.map((row, index) => ({
  id: `amazon-${row.id_icims}`, title: row.title, company: COMPANY,
  location: index ? 'Columbus, OH' : 'Ashburn, VA', type: 'entry-level',
  experience: '0-2-years', source: 'Official Amazon Jobs',
  sourceUrl: `https://www.amazon.jobs${row.job_path}`, active: true, demo: false
}));

function rawDiagnostic(extra = {}) {
  return {
    attemptSource: 'raw-collection', checkedAt: RAW_AT, sourceHealthy: true,
    lastHealthyAt: ANCHOR, queriesAttempted: 5, queriesSucceeded: 5,
    preservedPreviousRoles: 0, qualifyingRoles: 2, ...extra
  };
}

function recoveryDiagnostic(extra = {}) {
  return {
    attemptSource: 'detail-recovery', checkedAt: RECOVERY_AT,
    sourceHealthy: true, fullSearchHealthy: true, lastHealthyAt: ANCHOR,
    queriesAttempted: 5, queriesSucceeded: 5, preservedPrevious: 0,
    qualifyingRoles: 2, ...extra
  };
}

// Import the actual production entry points in a fresh subprocess and temporary
// cwd. Every employer request and wall-clock read is deterministic and offline.
async function runScript(cwd, script, { now = NOW, mode = 'healthy' } = {}) {
  const entry = new URL(script, import.meta.url).href;
  const code = `
    const now = Date.parse(${JSON.stringify(now)});
    const RealDate = Date;
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    };
    const mode = ${JSON.stringify(mode)};
    const rows = ${JSON.stringify(rows)};
    globalThis.fetch = async value => {
      const url = new URL(String(value));
      if (url.origin !== 'https://www.amazon.jobs') throw new Error('Unexpected network request: ' + url);
      if (['/en/search.json', '/search.json'].includes(url.pathname)) {
        if (mode === 'search-failure' || (mode === 'partial-search' && url.searchParams.get('base_query') === 'data center technician')) {
          throw new Error('Mock Amazon search unavailable');
        }
        const jobs = mode === 'empty-search' ? [] : mode === 'partial-search' ? rows.slice(0, 1) : rows;
        return Response.json({ jobs, hits: jobs.length });
      }
      if (/^\\/en\\/jobs\\/(1111111|2222222)\\//.test(url.pathname)) {
        if (mode === 'detail-failure') throw new Error('Mock Amazon detail unavailable');
        return new Response('<h2>Data Center Technician</h2><h3>Basic Qualifications</h3><p>2 years of experience in data center operations.</p><h3>Preferred Qualifications</h3>');
      }
      throw new Error('Unexpected network request: ' + url);
    };
    await import(${JSON.stringify(entry)});
  `;
  await exec(process.execPath, ['--input-type=module', '--eval', code], { cwd });
}

async function scenario({ amazon = rawDiagnostic(), recovery, snapshot = previousJobs, history = false } = {}, verify) {
  const cwd = await mkdtemp(join(tmpdir(), 'amazon-source-verification-'));
  try {
    await mkdir(join(cwd, 'data'));
    const writeStatus = async status => writeFile(join(cwd, 'data/collector-status.json'), JSON.stringify(status));
    const initialStatus = {
      updatedAt: NOW, unrelatedSource, amazonDatacenter: amazon,
      ...(recovery ? { amazonDetailRecovery: recovery } : {})
    };
    await writeFile(join(cwd, 'data/jobs.json'), JSON.stringify([...snapshot, otherJob]));
    await writeFile(join(cwd, 'data/amazon-jobs.json'), JSON.stringify(snapshot));
    if (history) {
      // Real local history proves an explicit null cannot accidentally fall back
      // to a healthy-looking Git commit timestamp. No repository data is used.
      await exec('git', ['init', '--quiet'], { cwd });
      await writeStatus({ updatedAt: ANCHOR, amazonDatacenter: rawDiagnostic() });
      await exec('git', ['add', 'data/collector-status.json'], { cwd });
      await exec('git', ['-c', 'user.name=Offline Test', '-c', 'user.email=offline@example.invalid',
        'commit', '--quiet', '-m', 'Recover verified AWS roles and refresh QA'], {
        cwd, env: { ...process.env, GIT_AUTHOR_DATE: ANCHOR, GIT_COMMITTER_DATE: ANCHOR }
      });
    }
    await writeStatus(initialStatus);
    const readState = async () => ({
      status: JSON.parse(await readFile(join(cwd, 'data/collector-status.json'), 'utf8')),
      jobs: JSON.parse(await readFile(join(cwd, 'data/jobs.json'), 'utf8')),
      snapshot: JSON.parse(await readFile(join(cwd, 'data/amazon-jobs.json'), 'utf8'))
    });
    await verify({ cwd, readState, writeStatus });
    const final = await readState();
    assert.deepEqual(final.status.unrelatedSource, unrelatedSource, 'AWS scripts must preserve unrelated source diagnostics');
    assert.equal(final.jobs.filter(job => job.id === otherJob.id).length, 1, 'AWS scripts must preserve unrelated jobs');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function assertHealthy(amazon, checkedAt, source) {
  assert.equal(amazon.sourceHealthy, true);
  assert.equal(amazon.checkedAt, checkedAt, 'stamp must use the actual source attempt time');
  assert.equal(amazon.lastHealthyAt, checkedAt, 'healthy anchor must be the source attempt, not stamp time');
  assert.equal(amazon.attemptSource, source);
  assert.equal(amazon.verificationSource, source);
  assert.equal(amazon.queriesAttempted, 5);
  assert.equal(amazon.queriesSucceeded, 5);
  assert.equal(amazon.preservedPreviousRoles, 0);
  assert.equal(amazon.fallbackFreshness.lastHealthyAt, checkedAt);
  assert.equal(amazon.fallbackFreshness.active, false);
}

function assertUnhealthy(amazon, anchor = ANCHOR) {
  assert.equal(amazon.sourceHealthy, false);
  assert.equal(amazon.lastHealthyAt, anchor, 'degraded evidence must never renew the previous healthy anchor');
  assert.equal(amazon.fallbackFreshness.lastHealthyAt, anchor);
}

await test('initial collect/recover/stamp owns attempt times and hydrates missing qualifications', async () => {
  await scenario({ snapshot: [], amazon: { lastHealthyAt: null } }, async ({ cwd, readState }) => {
    await runScript(cwd, 'collect-amazon-datacenter.mjs', { now: RAW_AT });
    let state = await readState();
    assert.equal(state.status.amazonDatacenter.attemptSource, 'raw-collection');
    assert.equal(state.status.amazonDatacenter.checkedAt, RAW_AT);
    assert.equal(state.status.amazonDatacenter.lastHealthyAt, null, 'collector cannot create an anchor before stamping');
    assert.equal(state.snapshot.length, 1);
    await runScript(cwd, 'recover-amazon-details.mjs', { now: RECOVERY_AT });
    state = await readState();
    assert.equal(state.status.amazonDetailRecovery.attemptSource, 'detail-recovery');
    assert.equal(state.status.amazonDetailRecovery.checkedAt, RECOVERY_AT);
    assert.equal(state.status.amazonDetailRecovery.lastHealthyAt, null, 'recovery cannot create an anchor before stamping');
    assert.equal(state.status.amazonDetailRecovery.sourceHealthy, true);
    assert.equal(state.status.amazonDetailRecovery.detailRecovered, 1);
    assert.equal(state.snapshot.length, 2);
    await runScript(cwd, 'stamp-amazon-source-verification.mjs');
    assertHealthy((await readState()).status.amazonDatacenter, RECOVERY_AT, 'detail-recovery');
    await runScript(cwd, 'stamp-amazon-source-verification.mjs', { now: LATER });
    assertHealthy((await readState()).status.amazonDatacenter, RECOVERY_AT, 'detail-recovery');
  });
});

for (const mode of ['search-failure', 'partial-search', 'empty-search']) {
  await test(`${mode} recovery supersedes healthy raw diagnostics without renewing its anchor`, async () => {
    await scenario({}, async ({ cwd, readState }) => {
      await runScript(cwd, 'recover-amazon-details.mjs', { now: RECOVERY_AT, mode });
      let state = await readState();
      assert.equal(state.status.amazonDetailRecovery.checkedAt, RECOVERY_AT);
      assert.equal(state.status.amazonDetailRecovery.lastHealthyAt, ANCHOR);
      assert.equal(state.status.amazonDetailRecovery.sourceHealthy, false);
      assert.equal(state.status.amazonDetailRecovery.fullSearchHealthy, mode === 'empty-search');
      assert.equal(state.snapshot.length, 2, 'failed/partial recovery must retain previous rows');
      const preserved = mode === 'partial-search' ? 1 : 2;
      assert.equal(state.status.amazonDetailRecovery.preservedPrevious, preserved);
      await runScript(cwd, 'stamp-amazon-source-verification.mjs');
      state = await readState();
      assertUnhealthy(state.status.amazonDatacenter);
      assert.equal(state.status.amazonDatacenter.checkedAt, RECOVERY_AT);
      assert.equal(state.status.amazonDatacenter.verificationSource, 'detail-recovery');
      assert.equal(state.status.amazonDatacenter.preservedPreviousRoles, preserved);
      assert.equal(state.status.amazonDatacenter.queriesSucceeded, mode === 'partial-search' ? 4 : mode === 'empty-search' ? 5 : 0);
      assert.equal(state.status.amazonDatacenter.qualifyingRoles, 2);
      await runScript(cwd, 'stamp-amazon-source-verification.mjs', { now: LATER });
      state = await readState();
      assertUnhealthy(state.status.amazonDatacenter);
      assert.equal(state.status.amazonDatacenter.checkedAt, RECOVERY_AT, 'repeated stamps cannot refresh failed attempt time');
      await runScript(cwd, 'recover-amazon-details.mjs', { now: LATER, mode });
      assert.equal((await readState()).status.amazonDetailRecovery.lastHealthyAt, ANCHOR, 'retry must carry the original anchor');
      await runScript(cwd, 'stamp-amazon-source-verification.mjs', { now: LATER });
      assertUnhealthy((await readState()).status.amazonDatacenter);
    });
  });
}

await test('healthy recovery supersedes failed raw collection and renews only at recovery time', async () => {
  await scenario({ amazon: rawDiagnostic({ sourceHealthy: false, queriesSucceeded: 0, preservedPreviousRoles: 2 }) }, async ({ cwd, readState }) => {
    await runScript(cwd, 'recover-amazon-details.mjs', { now: RECOVERY_AT });
    assert.equal((await readState()).status.amazonDetailRecovery.lastHealthyAt, ANCHOR);
    await runScript(cwd, 'stamp-amazon-source-verification.mjs');
    assertHealthy((await readState()).status.amazonDatacenter, RECOVERY_AT, 'detail-recovery');
  });
});

for (const recovery of [
  recoveryDiagnostic({ checkedAt: ANCHOR, sourceHealthy: false, fullSearchHealthy: false, queriesSucceeded: 0, preservedPrevious: 2 }),
  { fullSearchHealthy: false, queriesAttempted: 5, queriesSucceeded: 0, preservedPrevious: 2 }
]) {
  await test(`new raw-only collection ignores ${recovery.checkedAt ? 'older timestamped' : 'legacy unstamped'} recovery`, async () => {
    await scenario({ recovery }, async ({ cwd, readState }) => {
      await runScript(cwd, 'collect-amazon-datacenter.mjs', { now: RAW_AT });
      const collected = (await readState()).status.amazonDatacenter;
      assert.equal(collected.lastHealthyAt, ANCHOR, 'raw collection must carry explicit verification evidence');
      assert.equal(collected.attemptSource, 'raw-collection');
      await runScript(cwd, 'stamp-amazon-source-verification.mjs');
      assertHealthy((await readState()).status.amazonDatacenter, RAW_AT, 'raw-collection');
    });
  });
}

await test('failed raw-only retry retains the last explicit anchor across collection and stamping', async () => {
  await scenario({}, async ({ cwd, readState }) => {
    await runScript(cwd, 'collect-amazon-datacenter.mjs', { now: RECOVERY_AT, mode: 'search-failure' });
    assert.equal((await readState()).status.amazonDatacenter.lastHealthyAt, ANCHOR);
    await runScript(cwd, 'stamp-amazon-source-verification.mjs');
    const state = await readState();
    assertUnhealthy(state.status.amazonDatacenter);
    assert.equal(state.status.amazonDatacenter.verificationSource, 'raw-collection');
    assert.equal(state.status.amazonDatacenter.checkedAt, RECOVERY_AT);
    assert.equal(state.snapshot.length, 2);
  });
});

for (const evidence of [
  { label: 'no timestamps even with Git history', history: true, amazon: rawDiagnostic({ checkedAt: undefined, lastHealthyAt: null }) },
  { label: 'legacy markerless timestamp', amazon: rawDiagnostic({ attemptSource: undefined, lastHealthyAt: null }) },
  { label: 'future raw timestamp', amazon: rawDiagnostic({ checkedAt: FUTURE, lastHealthyAt: null }) },
  { label: 'missing marked recovery timestamp', recovery: recoveryDiagnostic({ checkedAt: undefined }) },
  { label: 'invalid marked recovery timestamp', recovery: recoveryDiagnostic({ checkedAt: 'invalid-date' }) },
  { label: 'future recovery timestamp', recovery: recoveryDiagnostic({ checkedAt: FUTURE }) },
  { label: 'anchor newer than raw attempt', amazon: rawDiagnostic({ checkedAt: '2026-10-02T12:00:00.000Z' }) },
  { label: 'anchor newer than recovery attempt', recovery: recoveryDiagnostic({ checkedAt: '2026-10-03T11:00:00.000Z' }), amazon: rawDiagnostic({ checkedAt: '2026-10-02T12:00:00.000Z' }) }
]) {
  await test(`${evidence.label} cannot fabricate or renew healthy source evidence`, async () => {
    await scenario(evidence, async ({ cwd, readState }) => {
      await runScript(cwd, 'stamp-amazon-source-verification.mjs');
      const amazon = (await readState()).status.amazonDatacenter;
      assert.equal(amazon.sourceHealthy, false);
      assert.notEqual(amazon.lastHealthyAt, NOW, 'global updatedAt and stamp time cannot become verification evidence');
      if (evidence.amazon?.lastHealthyAt === null) assert.equal(amazon.lastHealthyAt, null);
      else assert.ok(amazon.lastHealthyAt === ANCHOR || amazon.lastHealthyAt === null, 'invalid ordering may retain or discard the prior anchor, never renew it');
    });
  });
}

for (const checkedAt of [undefined, 'invalid-date', FUTURE]) {
  await test(`repeated stamps cannot forget ${checkedAt || 'missing'} raw evidence and revive an older recovery`, async () => {
    await scenario({ amazon: rawDiagnostic({ checkedAt }), recovery: recoveryDiagnostic() }, async ({ cwd, readState }) => {
      await runScript(cwd, 'stamp-amazon-source-verification.mjs');
      assertUnhealthy((await readState()).status.amazonDatacenter);
      await runScript(cwd, 'stamp-amazon-source-verification.mjs', { now: LATER });
      assertUnhealthy((await readState()).status.amazonDatacenter);
      // Fail-closed evidence must not prevent a genuinely new complete scan.
      await runScript(cwd, 'collect-amazon-datacenter.mjs', { now: LATER });
      await runScript(cwd, 'stamp-amazon-source-verification.mjs', { now: LATER });
      assertHealthy((await readState()).status.amazonDatacenter, LATER, 'raw-collection');
    });
  });
}

await test('older recovery cannot erase a newer failed verification across repeated stamps', async () => {
  await scenario({
    amazon: rawDiagnostic({ attemptSource: 'detail-recovery', verificationSource: 'detail-recovery',
      checkedAt: RECOVERY_AT, sourceHealthy: false, queriesSucceeded: 0, preservedPreviousRoles: 2 }),
    recovery: recoveryDiagnostic({ checkedAt: RAW_AT })
  }, async ({ cwd, readState }) => {
    await runScript(cwd, 'stamp-amazon-source-verification.mjs');
    assertUnhealthy((await readState()).status.amazonDatacenter);
    await runScript(cwd, 'stamp-amazon-source-verification.mjs', { now: LATER });
    assertUnhealthy((await readState()).status.amazonDatacenter);
    await runScript(cwd, 'recover-amazon-details.mjs', { now: LATER });
    await runScript(cwd, 'stamp-amazon-source-verification.mjs', { now: LATER });
    assertHealthy((await readState()).status.amazonDatacenter, LATER, 'detail-recovery');
  });
});

for (const anchor of ['2026-10-01T13:00:00.000Z', BOUNDARY]) {
  await test(`degraded recovery fallback ${anchor === BOUNDARY ? 'expires at 96 hours' : 'remains available at 95 hours'}`, async () => {
    await scenario({ amazon: rawDiagnostic({ lastHealthyAt: anchor }) }, async ({ cwd, readState }) => {
      await runScript(cwd, 'recover-amazon-details.mjs', { now: RECOVERY_AT, mode: 'search-failure' });
      await runScript(cwd, 'stamp-amazon-source-verification.mjs');
      await runScript(cwd, 'enforce-amazon-fallback-freshness.mjs');
      const state = await readState();
      assertUnhealthy(state.status.amazonDatacenter, anchor);
      assert.equal(state.status.amazonDatacenter.fallbackFreshness.expired, anchor === BOUNDARY);
      assert.equal(state.snapshot.length, anchor === BOUNDARY ? 0 : 2);
      assert.equal(state.jobs.filter(job => job.company === COMPANY).length, anchor === BOUNDARY ? 0 : 2);
      if (anchor === BOUNDARY) {
        assert.equal(state.status.amazonDatacenter.qualifyingRoles, 0);
        assert.equal(state.status.amazonDatacenter.fallbackFreshness.rolesRemoved, 2);
        await runScript(cwd, 'stamp-amazon-source-verification.mjs', { now: LATER });
        const restamped = await readState();
        assertUnhealthy(restamped.status.amazonDatacenter, anchor);
        assert.equal(restamped.status.amazonDatacenter.qualifyingRoles, 0);
        assert.equal(restamped.status.amazonDatacenter.preservedPreviousRoles, 0, 'restamping expired evidence must not resurrect removed-role counts');
        assert.equal(restamped.snapshot.length, 0);
        await runScript(cwd, 'recover-amazon-details.mjs', { now: LATER });
        await runScript(cwd, 'stamp-amazon-source-verification.mjs', { now: LATER });
        const recovered = await readState();
        assertHealthy(recovered.status.amazonDatacenter, LATER, 'detail-recovery');
        assert.equal(recovered.snapshot.length, 2, 'new verified recovery may repopulate an expired snapshot');
      }
    });
  });
}

for (const nestedAnchor of [false, true]) {
  await test(`explicit ${nestedAnchor ? 'nested and top-level' : 'top-level'} null fails closed despite global time and healthy-looking Git history`, async () => {
    await scenario({
      history: true,
      amazon: rawDiagnostic({ sourceHealthy: false, queriesSucceeded: 0, preservedPreviousRoles: 2, lastHealthyAt: null,
        ...(nestedAnchor ? { fallbackFreshness: { active: true, expired: false, lastHealthyAt: null, checkedAt: NOW } } : {}) })
    }, async ({ cwd, readState }) => {
      await runScript(cwd, 'enforce-amazon-fallback-freshness.mjs');
      const state = await readState();
      assert.equal(state.status.amazonDatacenter.lastHealthyAt, null);
      assert.equal(state.status.amazonDatacenter.fallbackFreshness.lastHealthyAt, null, 'Git commit time must not replace explicit null verification evidence');
      assert.equal(state.status.amazonDatacenter.fallbackFreshness.expired, true);
      assert.equal(state.snapshot.length, 0);
      assert.equal(state.jobs.filter(job => job.company === COMPANY).length, 0);
    });
  });
}
