import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const START = '2026-10-05T12:00:00.000Z';
const ANCHOR = '2026-10-04T12:00:00.000Z';
const FUTURE = '2099-01-01T00:00:00.000Z';
const COMPANY = 'H5 Data Centers';
const unrelatedSource = { sourceHealthy: true, checkedAt: ANCHOR, marker: 'unchanged' };
const otherJob = { id: 'other-1', company: 'Other', title: 'Other role', location: 'Austin, TX', type: 'entry-level', experience: '0-2-years' };
const previous = Array.from({ length: 12 }, (_, index) => ({
  id: `adp-h5-prior-${index}`, title: 'Data Center Operations Technician I', company: COMPANY,
  location: `Prior City ${index}, TX`, type: 'entry-level', experience: '0-2-years',
  sourceUrl: `https://workforcenow.adp.com/previous/${index}`, active: true, demo: false,
  marker: 'previously verified, keep intact on partial failure'
}));
const rows = Array.from({ length: 34 }, (_, index) => ({
  itemID: `fixture-${index}`,
  requisitionTitle: index === 13 ? 'Senior Data Center Technician' : 'Data Center Operations Technician I',
  customFieldGroup: { stringFields: [{ nameCode: { codeValue: 'ExternalJobID' }, stringValue: `external-${index}` }] },
  requisitionLocations: [{ nameCode: { shortName: `Fixture City ${index}, TX` }, address: { countryCode: { codeValue: index === 12 ? 'CA' : 'US' } } }],
  postDate: '2026-10-01T00:00:00Z'
}));
let scenarios = 0;

// Execute the real entry points with only deterministic official-source mocks.
// Advancing time at every request catches startup/global/stamp timestamps being
// substituted for the actual completion of listing and detail verification.
async function run(cwd, script, { mode = 'healthy', now = START } = {}) {
  const code = String.raw`
    import { writeFileSync } from 'node:fs';
    const RealDate = Date;
    let now = RealDate.parse(${JSON.stringify(now)});
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    };
    process.on('exit', () => writeFileSync('completion-clock.json', JSON.stringify({ completedAt: new Date().toISOString() })));
    globalThis.setTimeout = callback => { queueMicrotask(callback); return 0; };
    const mode = ${JSON.stringify(mode)};
    let rows = ${JSON.stringify(rows)};
    if (mode === 'missing-id') rows[4].customFieldGroup.stringFields = [];
    if (mode === 'missing-title') rows[4].requisitionTitle = '';
    if (mode === 'missing-item-id') delete rows[4].itemID;
    if (mode === 'duplicate-listing') rows.push(rows[3]);
    if (mode === 'pagination') rows.push(...Array.from({ length: 70 }, (_, index) => ({ ...rows[33], itemID: 'fixture-' + (index + 34), customFieldGroup: { stringFields: [{ nameCode: { codeValue: 'ExternalJobID' }, stringValue: 'external-' + (index + 34) }] } })));
    globalThis.fetch = async input => {
      now += 1000;
      const url = new URL(String(input));
      if (url.origin !== 'https://workforcenow.adp.com') throw new Error('Unexpected network request ' + url);
      if (url.pathname.endsWith('/job-requisitions')) {
        if (mode === 'listing-failure') return new Response('', { status: 503 });
        if (mode === 'empty-listing') return Response.json({ jobRequisitions: [], meta: { totalNumber: 0 } });
        const skip = Number(url.searchParams.get('$skip'));
        const total = rows.length + (mode === 'incomplete-listing' ? 1 : ['positive-drift', 'duplicate-listing'].includes(mode) ? -1 : 0);
        return Response.json({ jobRequisitions: rows.slice(skip, skip + 100), meta: { totalNumber: total } });
      }
      const match = url.pathname.match(/\/external-(\d+)$/);
      if (!match) throw new Error('Unexpected detail URL ' + url);
      const index = Number(match[1]);
      if (mode === 'all-detail-failure' || (mode === 'partial-detail-failure' && index === 4)) return new Response('', { status: 503 });
      const itemID = mode === 'identity-mismatch' && index === 4 ? 'wrong-id' : mode === 'missing-detail-id' && index === 4 ? undefined : 'fixture-' + index;
      const requisitionDescription = mode === 'missing-description' && index === 4 ? '' : (index < 12 && mode !== 'zero-qualifying' ? '2' : '7') + ' years of experience supporting mission-critical data center facilities.';
      return Response.json({ itemID, requisitionDescription });
    };
    await import(${JSON.stringify(new URL(script, import.meta.url).href)});
  `;
  return exec(process.execPath, ['--input-type=module', '--eval', code], { cwd, maxBuffer: 10 * 1024 * 1024 });
}

async function state(cwd) {
  const read = async path => JSON.parse(await readFile(join(cwd, path), 'utf8'));
  return {
    status: await read('data/collector-status.json'), jobs: await read('data/jobs.json'),
    snapshot: await read('data/h5-data-centers-jobs.json'), completedAt: (await read('completion-clock.json')).completedAt
  };
}

async function scenario(verify, { anchor = ANCHOR, source = {}, snapshot = previous } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'h5-source-verification-'));
  try {
    await mkdir(join(cwd, 'data'));
    for (const [path, value] of Object.entries({
      'data/jobs.json': [otherJob, ...snapshot],
      'data/h5-data-centers-jobs.json': snapshot,
      'data/collector-status.json': {
        updatedAt: FUTURE, unrelatedSource,
        h5DataCenters: { sourceHealthy: true, checkedAt: FUTURE, lastHealthyAt: anchor, lastSuccessfulAt: anchor, ...source }
      }
    })) await writeFile(join(cwd, path), JSON.stringify(value, null, 2) + '\n');
    await verify(cwd);
    const final = await state(cwd);
    assert.deepEqual(final.status.unrelatedSource, unrelatedSource);
    assert.deepEqual(final.jobs.filter(job => job.company !== COMPANY), [otherJob]);
    assert.deepEqual(final.jobs.filter(job => job.company === COMPANY), final.snapshot);
    scenarios += 1;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

for (const mode of ['healthy', 'positive-drift', 'duplicate-listing', 'pagination']) {
  await scenario(async cwd => {
    await run(cwd, 'collect-h5-data-centers.mjs', { mode });
    let result = await state(cwd);
    const completedAt = result.completedAt;
    const h5 = result.status.h5DataCenters;
    assert.equal(h5.sourceHealthy, true);
    assert.equal(h5.checkedAt, completedAt);
    assert.notEqual(h5.checkedAt, START);
    assert.notEqual(h5.checkedAt, FUTURE);
    assert.equal(h5.lastSuccessfulAt, completedAt);
    assert.equal(h5.lastHealthyAt, completedAt);
    assert.equal(h5.diagnostics.detailSucceeded, mode === 'pagination' ? 104 : mode === 'duplicate-listing' ? 35 : 34);
    assert.equal(h5.listing.drift, ['positive-drift', 'duplicate-listing'].includes(mode) ? 1 : 0);
    assert.equal(h5.fallbackFreshness.expired, false);
    assert.equal(h5.fallbackFreshness.active, false);
    assert.equal(result.snapshot.length, 12);
    assert.ok(result.snapshot.every(job => job.experience === '0-2-years'));
    await run(cwd, 'enforce-h5-fallback-freshness.mjs', { now: completedAt });
    result = await state(cwd);
    assert.equal(result.snapshot.length, 12, 'immediate enforcer must keep a fresh complete 12-role scan');
    assert.deepEqual(result.status.h5DataCenters, h5);
    for (const now of ['2026-10-05T13:00:00.000Z', '2026-10-05T14:00:00.000Z']) {
      await run(cwd, 'stamp-h5-source-verification.mjs', { now });
      result = await state(cwd);
      assert.equal(result.status.h5DataCenters.checkedAt, completedAt);
      assert.equal(result.status.h5DataCenters.lastSuccessfulAt, completedAt);
      assert.equal(result.status.h5DataCenters.lastHealthyAt, completedAt);
    }
    await run(cwd, 'collect-h5-data-centers.mjs', { mode: 'partial-detail-failure', now: '2026-10-05T15:00:00.000Z' });
    result = await state(cwd);
    assert.equal(result.status.h5DataCenters.sourceHealthy, false);
    assert.equal(result.status.h5DataCenters.lastSuccessfulAt, completedAt);
    assert.equal(result.snapshot.length, 12);
  }, { anchor: null, snapshot: [] });
}

for (const mode of ['listing-failure', 'incomplete-listing', 'partial-detail-failure', 'all-detail-failure', 'missing-id', 'missing-title', 'missing-item-id', 'identity-mismatch', 'missing-detail-id', 'missing-description', 'zero-qualifying']) {
  await scenario(async cwd => {
    await run(cwd, 'collect-h5-data-centers.mjs', { mode });
    let result = await state(cwd);
    const checkedAt = result.completedAt;
    const h5 = result.status.h5DataCenters;
    assert.equal(h5.sourceHealthy, false, mode);
    assert.equal(h5.checkedAt, checkedAt);
    assert.notEqual(h5.checkedAt, START);
    assert.equal(h5.lastHealthyAt, ANCHOR);
    assert.equal(h5.lastSuccessfulAt, ANCHOR);
    assert.equal(h5.fallbackFreshness.active, true);
    assert.equal(h5.usedPreviousSnapshot, true);
    assert.deepEqual(result.snapshot, previous, 'incomplete verification must keep the entire verified set');
    await run(cwd, 'stamp-h5-source-verification.mjs', { now: '2026-10-05T13:00:00.000Z' });
    result = await state(cwd);
    assert.equal(result.status.h5DataCenters.sourceHealthy, false);
    assert.equal(result.status.h5DataCenters.checkedAt, checkedAt);
    assert.equal(result.status.h5DataCenters.lastSuccessfulAt, ANCHOR);
    await run(cwd, 'enforce-h5-fallback-freshness.mjs');
    assert.deepEqual((await state(cwd)).snapshot, previous);
  });
}

for (const anchor of [null, 'invalid-date', FUTURE, '2026-10-01T12:00:00.000Z']) {
  await scenario(async cwd => {
    await run(cwd, 'collect-h5-data-centers.mjs', { mode: 'listing-failure' });
    const result = await state(cwd);
    const expectedAnchor = anchor === '2026-10-01T12:00:00.000Z' ? anchor : null;
    assert.equal(result.status.h5DataCenters.checkedAt, result.completedAt);
    assert.equal(result.status.h5DataCenters.sourceHealthy, false);
    assert.equal(result.status.h5DataCenters.lastSuccessfulAt, expectedAnchor);
    assert.equal(result.status.h5DataCenters.lastHealthyAt, expectedAnchor);
    assert.equal(result.status.h5DataCenters.fallbackFreshness.expired, true);
    assert.equal(result.snapshot.length, 0, 'unverified/expired prior evidence must fail closed');
    await run(cwd, 'stamp-h5-source-verification.mjs');
    await run(cwd, 'enforce-h5-fallback-freshness.mjs');
    assert.equal((await state(cwd)).snapshot.length, 0);
  }, { anchor });
}

for (const anchor of [null, 'invalid-date', FUTURE, '2026-10-01T12:00:00.000Z', '2026-10-01T12:00:01.000Z']) {
  await scenario(async cwd => {
    await run(cwd, 'enforce-h5-fallback-freshness.mjs');
    const result = await state(cwd);
    const kept = anchor === '2026-10-01T12:00:01.000Z';
    assert.equal(result.snapshot.length, kept ? 12 : 0, 'standalone enforcer must expire at exactly 96 hours');
    assert.equal(result.status.h5DataCenters.checkedAt, ANCHOR, 'freshness enforcement is not a source check');
    if (!kept) assert.equal(result.status.h5DataCenters.fallbackFreshness.expired, true);
  }, { anchor, source: { checkedAt: ANCHOR } });
}

for (const source of [
  { checkedAt: null }, { checkedAt: 'invalid-date' }, { checkedAt: FUTURE },
  { checkedAt: ANCHOR },
  { checkedAt: ANCHOR, listing: { advertised: 34, fetched: 34 }, usedPreviousSnapshot: false,
    diagnostics: { listingComplete: true, detailAttempted: 34, detailSucceeded: 33 },
    drops: { missingDetailId: 0, detailFetch: 1, invalidDetail: 0 } }
]) {
  await scenario(async cwd => {
    await run(cwd, 'stamp-h5-source-verification.mjs');
    const h5 = (await state(cwd)).status.h5DataCenters;
    assert.equal(h5.sourceHealthy, false, 'stamping cannot rehabilitate missing, future, legacy or partial evidence');
    assert.equal(h5.lastHealthyAt, ANCHOR);
    assert.equal(h5.lastSuccessfulAt, ANCHOR);
    assert.notEqual(h5.checkedAt, START);
    await run(cwd, 'stamp-h5-source-verification.mjs', { now: '2026-10-05T13:00:00.000Z' });
    assert.equal((await state(cwd)).status.h5DataCenters.lastSuccessfulAt, ANCHOR);
  }, { source });
}

await scenario(async cwd => {
  await run(cwd, 'collect-h5-data-centers.mjs', { mode: 'empty-listing' });
  let result = await state(cwd);
  assert.equal(result.status.h5DataCenters.sourceHealthy, true);
  assert.equal(result.status.h5DataCenters.lastSuccessfulAt, result.completedAt);
  assert.equal(result.snapshot.length, 0);
  await run(cwd, 'collect-h5-data-centers.mjs', { mode: 'listing-failure', now: '2026-10-05T13:00:00.000Z' });
  result = await state(cwd);
  assert.equal(result.snapshot.length, 0, 'later failure must not resurrect an officially empty snapshot');
  assert.equal(result.status.h5DataCenters.sourceHealthy, false);
});

console.log(`H5 source verification integration tests passed: ${scenarios} offline success, partial/failure, source-time, stamp, and expiry scenarios.`);
