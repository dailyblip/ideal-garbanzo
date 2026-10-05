import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SOURCES, OWNED_PATHS, applyDiagnostic, identity, reconcileFiles, reconcileSnapshot, snapshotJobs } from './reconcile-qa-dead-snapshots.mjs';

const checkedAt = '2026-10-04T05:10:00.000Z';
const nowMs = Date.parse('2026-10-04T05:11:00.000Z');
const status = { postQa: { checkedAt } };
const sourceFor = company => SOURCES.find(source => source.company === company);
const reportFor = checks => ({ checkedAt, deadJobLinksRemoved: checks });
const dead = (job, extra = {}) => ({ id: job.id, company: job.company, url: job.sourceUrl, state: 'dead', status: 404, ...extra });
const sample = (source, number) => {
  const slug = source.company.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  let sourceUrl = `https://example.com/${slug}/jobs/${number}`;
  let id = `${slug}-${number}`;
  if (source.company === 'Amazon Web Services') {
    sourceUrl = `https://www.amazon.jobs/en/jobs/${number}/data-center-technician`;
    id = `amazon-${number}`;
  }
  if (source.company === 'TierPoint') {
    sourceUrl = `https://careers-tierpoint.icims.com/jobs/${number}/mep-technician-ii/job`;
    id = `icims-tierpoint-${number}`;
  }
  return { id, company: source.company, title: 'Data Center Technician', location: 'Dallas, TX', sourceUrl };
};

for (const source of SOURCES) {
  const closed = sample(source, 1001), live = sample(source, 1002);
  const unrelated = { ...closed, company: 'Unrelated employer' };
  const result = reconcileSnapshot({ snapshot: [closed, live, unrelated], report: reportFor([dead(closed)]), status, source, nowMs });
  assert.deepEqual(result.removed, [closed], `${source.company}: remove only the confirmed same-employer requisition`);
  assert.deepEqual(result.kept, [live, unrelated], `${source.company}: preserve unflagged roles and other owners`);
  for (const check of [
    dead(closed, { state: 'blocked', status: 403 }),
    dead(closed, { state: 'transient', status: 503 }),
    dead(closed, { state: 'transient', status: null, error: 'timeout' }),
    dead(closed, { state: 'ok', status: 200 }),
    dead(closed, { status: 503 }),
    dead(closed, { status: null }),
    dead(closed, { company: 'Unrelated employer' }),
    dead(closed, { status: 200, reason: 'redirected-to-generic-career-page', finalUrl: closed.sourceUrl })
  ]) {
    assert.equal(reconcileSnapshot({ snapshot: [closed], report: reportFor([check]), status, source, nowMs }).removed.length, 0,
      `${source.company}: outages, unsupported dead states and other employers cannot retire roles`);
  }
  assert.equal(reconcileSnapshot({ snapshot: [closed], report: reportFor([dead(closed, { status: 410 })]), status, source, nowMs }).removed.length, 1);
  assert.equal(reconcileSnapshot({ snapshot: [closed], report: reportFor([dead(closed, { status: 200, reason: 'redirected-to-generic-career-page', finalUrl: 'https://example.com/careers' })]), status, source, nowMs }).removed.length, 1);
}

const novva = sourceFor('Novva Data Centers');
const novvaJob = { id: 'novva-command-center-operator-utah', company: novva.company, sourceUrl: 'https://www.novva.com/portfolio/command-center-operator-utah/' };
const novvaReport = reportFor([dead(novvaJob)]);
for (const [testStatus, testNow, testReport] of [
  [{ postQa: { checkedAt: '2026-10-03T05:10:00.000Z' } }, nowMs, novvaReport],
  [status, nowMs + 3 * 60 * 60 * 1000, novvaReport],
  [status, Date.parse(checkedAt) - 1, novvaReport],
  [{}, nowMs, novvaReport],
  [{ postQa: { checkedAt: 'invalid' } }, nowMs, { ...novvaReport, checkedAt: 'invalid' }]
]) {
  const result = reconcileSnapshot({ snapshot: [novvaJob], report: testReport, status: testStatus, source: novva, nowMs: testNow });
  assert.equal(result.skipped, true, 'stale, future, invalid or unmatched reports must not prune');
  assert.deepEqual(result.kept, [novvaJob]);
}
assert.deepEqual(reconcileSnapshot({ snapshot: [novvaJob], report: novvaReport, status, source: novva, nowMs }).kept, [], 'the Oct 4 Novva public-zero/snapshot-one regression must clear its exact confirmed-dead role');
const degraded = { sourceHealthy: false, qualifyingRoles: 0, preservedPrevious: 1, usedPreviousSnapshot: true, lastHealthyAt: '2026-09-28T23:29:33.585Z', checkedAt: '2026-09-30T05:57:09.505Z' };
applyDiagnostic(degraded, novva, 0, [novvaJob], checkedAt);
assert.equal(degraded.qualifyingRoles, 0);
assert.equal(degraded.preservedPrevious, 0);
assert.equal(degraded.sourceHealthy, false);
assert.equal(degraded.lastHealthyAt, '2026-09-28T23:29:33.585Z');
assert.equal(degraded.checkedAt, '2026-09-30T05:57:09.505Z');

// Do not collapse ATS requisitions represented only by query parameters, or
// delete a replacement URL because its local ID happened to be reused.
for (const company of ['Switch', 'CoreWeave', 'H5 Data Centers', 'Csquare']) {
  const source = sourceFor(company);
  const first = { ...sample(source, 1), sourceUrl: 'https://example.com/careers?jobId=1' };
  const second = { ...first, sourceUrl: 'https://example.com/careers?jobId=2' };
  assert.deepEqual(reconcileSnapshot({ snapshot: [first, second], report: reportFor([dead(first)]), status, source, nowMs }).kept, [second]);
}
for (const company of ['Amazon Web Services', 'TierPoint']) {
  const source = sourceFor(company);
  const role = sample(source, 1001);
  assert.equal(identity({ ...role, sourceUrl: 'https://unrelated.example/jobs/1001' }, source), '', 'a conflicting foreign URL cannot use the local ID as evidence');
  assert.equal(reconcileSnapshot({ snapshot: [role], report: reportFor([dead(role, { id: '' })]), status, source, nowMs }).removed.length, 1, 'URL-only AWS/TierPoint evidence remains supported');
}
assert.throws(() => snapshotJobs({ roles: [] }, novva), /jobs array/);

// Guard the registry against future dedicated snapshots being added without an
// owner. Featured placements are not source snapshots and must not be pruned.
const snapshotFiles = (await readdir(new URL('../data/', import.meta.url)))
  .filter(file => file.endsWith('-jobs.json') && file !== 'featured-jobs.json')
  .map(file => `data/${file}`);
for (const path of snapshotFiles) assert(OWNED_PATHS.includes(path), `snapshot ownership missing for ${path}`);
assert(!OWNED_PATHS.includes('data/jobs.json'));
assert(!OWNED_PATHS.includes('data/featured-jobs.json'));

const root = await mkdtemp(join(tmpdir(), 'qa-dead-snapshots-'));
try {
  await mkdir(join(root, 'data'));
  const documents = new Map(OWNED_PATHS.map(path => [path, {}]));
  const collector = { postQa: { checkedAt }, majorSources: { employerDiagnostics: {}, reconciliation: { publishedUsJobs: 12 }, publishedJobs: 12, fallbackFreshness: { summaries: [] } } };
  const checks = [];
  const metadata = { verifiedAt: '2026-10-03T05:00:00.000Z', expiresAt: '2026-10-07T05:00:00.000Z', officialSource: 'https://example.com/careers' };
  const durable = { version: 2, employers: {} };
  const diagnostic = () => ({ sourceHealthy: true, qualifyingRoles: 2, snapshotRoles: 2, publishedRoles: 2, preservedPrevious: 0, checkedAt: metadata.verifiedAt, lastHealthyAt: metadata.verifiedAt, fallbackFreshness: { active: false, roles: 2, expiresAt: metadata.expiresAt } });
  for (const source of SOURCES) {
    const jobs = [sample(source, 1001), sample(source, 1002)];
    if (source.major) {
      documents.set(source.snapshotPath, [...(Array.isArray(documents.get(source.snapshotPath)) ? documents.get(source.snapshotPath) : []), ...jobs]);
      collector.majorSources.employerDiagnostics[source.company] = diagnostic();
      collector.majorSources.fallbackFreshness.summaries.push({ company: source.company, state: 'healthy', roles: 2 });
      durable.employers[source.company] = { ...diagnostic(), roles: 2 };
    } else {
      documents.set(source.snapshotPath, ['Microsoft', 'Sabey Data Centers', 'CoreSite'].includes(source.company) ? { ...metadata, jobs } : jobs);
      collector[source.statusKey] = diagnostic();
    }
    checks.push(dead(jobs[0]));
  }
  collector.amazonDetailRecovery = diagnostic();
  documents.set('data/collector-status.json', collector);
  documents.set('data/major-workday-freshness.json', durable);
  for (const path of ['data/compass-status.json', 'data/coreweave-source-evidence.json', 'data/edgeconnex-source-evidence.json']) documents.set(path, diagnostic());
  const saveFixtures = async () => {
    for (const [path, value] of documents) await writeFile(join(root, path), `${JSON.stringify(value, null, 2)}\n`);
    await writeFile(join(root, 'data/qa-report.json'), JSON.stringify(reportFor(checks)));
  };
  await saveFixtures();
  const result = await reconcileFiles({ root, nowMs });
  assert.equal(result.changedPaths.length, OWNED_PATHS.length, 'all owned snapshots and affected sidecars must be returned for commit');
  for (const source of SOURCES) {
    const snapshot = JSON.parse(await readFile(join(root, source.snapshotPath), 'utf8'));
    const jobs = snapshotJobs(snapshot, source).filter(job => job.company === source.company);
    assert.deepEqual(jobs, [sample(source, 1002)], `${source.company}: end-to-end exact closure removal`);
    if (!Array.isArray(snapshot)) assert.deepEqual(Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== 'jobs')), metadata, 'wrapper verification/expiry metadata must be preserved verbatim');
  }
  const afterStatus = JSON.parse(await readFile(join(root, 'data/collector-status.json'), 'utf8'));
  assert.equal(afterStatus.majorSources.reconciliation.publishedUsJobs, 6, 'six sequential owners must preserve shared exact-parity mode');
  assert.equal(afterStatus.majorSources.publishedJobs, 6);
  assert.equal(afterStatus.amazonDetailRecovery.qualifyingRoles, 1);
  for (const path of ['data/compass-status.json', 'data/coreweave-source-evidence.json', 'data/edgeconnex-source-evidence.json']) {
    const sidecar = JSON.parse(await readFile(join(root, path), 'utf8'));
    assert.equal(sidecar.snapshotRoles, 1);
    assert.equal(sidecar.checkedAt, metadata.verifiedAt, 'QA cannot renew source verification');
    assert.equal(sidecar.lastHealthyAt, metadata.verifiedAt);
    assert.equal(sidecar.sourceHealthy, true);
  }
  const beforeRerun = await Promise.all(OWNED_PATHS.map(path => readFile(join(root, path), 'utf8')));
  assert.deepEqual((await reconcileFiles({ root, nowMs })).changedPaths, [], 'reconciliation must be idempotent');
  assert.deepEqual(await Promise.all(OWNED_PATHS.map(path => readFile(join(root, path), 'utf8'))), beforeRerun);

  collector.majorSources.reconciliation.publishedUsJobs = 10;
  await saveFixtures();
  await reconcileFiles({ root, nowMs });
  assert.equal(JSON.parse(await readFile(join(root, 'data/collector-status.json'), 'utf8')).majorSources.reconciliation.publishedUsJobs, 10, 'raw/additive coverage markers must not be promoted to exact parity');

  await saveFixtures();
  await writeFile(join(root, 'data/major-workday-freshness.json'), '{broken');
  const beforeFailure = await readFile(join(root, 'data/amazon-jobs.json'), 'utf8');
  await assert.rejects(reconcileFiles({ root, nowMs }), SyntaxError);
  assert.equal(await readFile(join(root, 'data/amazon-jobs.json'), 'utf8'), beforeFailure, 'bad later evidence must fail before any earlier snapshot is written');
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log(`QA dead-snapshot reconciliation regression tests passed for ${SOURCES.length} employer owners, wrapped snapshots, shared Workday ownership, positive closure evidence, fallback metadata, sidecar counts and idempotence.`);
