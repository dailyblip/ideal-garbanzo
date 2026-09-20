import { readFile } from 'node:fs/promises';

const status = JSON.parse(await readFile('data/collector-status.json', 'utf8'));
const jobs = JSON.parse(await readFile('data/jobs.json', 'utf8'));

if (!status || typeof status !== 'object' || Array.isArray(status)) {
  throw new Error('data/collector-status.json must contain an object.');
}
if (!Array.isArray(jobs)) {
  throw new Error('data/jobs.json must contain an array.');
}

const genericSourceDiagnostics = [
  ...(Array.isArray(status?.genericDirectSources?.sourceDiagnostics) ? status.genericDirectSources.sourceDiagnostics : []),
  ...(Array.isArray(status?.sourceDiagnostics) ? status.sourceDiagnostics : [])
];
const genericSourceDiagnostic = company => genericSourceDiagnostics.find(item => String(item?.company || '').trim() === company);

const prioritySources = [
  ['Amazon Web Services', value => value.amazonDatacenter],
  ['Google', value => value.googleCareers],
  ['Microsoft', value => value.microsoftDatacenter],
  ['Meta', value => value.metaCareers],
  ['Oracle', value => value.oracleCareers],
  ['Equinix', value => value.priorityEmployerExpansion?.Equinix],
  ['Digital Realty', value => value.digitalRealty],
  ['DataBank', value => value.databank],
  ['CoreSite', value => value.coreSite],
  ['Iron Mountain', value => value.ironMountain],
  ['Sabey Data Centers', value => value.sabeyCareers],
  ['Novva Data Centers', value => value.novvaCareers],
  ['Flexential', value => value.flexential],
  ['Switch', value => value.switchCareers],
  ['Cologix', value => value.cologix],
  ['T5 Data Centers', value => value.t5DataCenters],
  ['TierPoint', value => value.tierPoint],
  ['Crusoe', () => genericSourceDiagnostic('Crusoe')],
  ['Compass Datacenters', value => value.compass],
  ['Stream Data Centers', value => value.streamDataCenters],
  ['EdgeConneX', value => value.edgeconnexCareers],
  ['Prime Data Centers', value => value.primeDataCenters],
  ['CoreWeave', value => value.coreWeaveCareers],
  ['Vantage Data Centers', value => value.majorSources?.employerDiagnostics?.['Vantage Data Centers']],
  ['QTS Data Centers', value => value.majorSources?.employerDiagnostics?.['QTS Data Centers']],
  ['CyrusOne', value => value.majorSources?.employerDiagnostics?.CyrusOne],
  ['STACK Infrastructure', value => value.majorSources?.employerDiagnostics?.['STACK Infrastructure']],
  ['NTT Global Data Centers', value => value.majorSources?.employerDiagnostics?.['NTT Global Data Centers']],
  ['Aligned Data Centers', value => value.majorSources?.employerDiagnostics?.['Aligned Data Centers']]
];

const violations = [];
const summary = [];

for (const [company, resolveDiagnostic] of prioritySources) {
  const diagnostic = resolveDiagnostic(status);
  if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)) {
    violations.push(`${company}: collector health diagnostic is missing`);
    continue;
  }
  if (typeof diagnostic.sourceHealthy !== 'boolean') {
    violations.push(`${company}: collector health diagnostic must report sourceHealthy as a boolean`);
    continue;
  }

  const publicRoles = jobs.filter(job =>
    String(job?.company || '').trim() === company &&
    job?.active === true &&
    job?.demo !== true
  ).length;
  summary.push(`${company}=${diagnostic.sourceHealthy ? 'healthy' : 'degraded'}:${publicRoles}`);
}

if (violations.length) {
  for (const violation of violations) console.error(`Priority source diagnostics guard: ${violation}`);
  throw new Error(`Blocked ${violations.length} priority source diagnostic regression(s).`);
}

console.log(`Priority source diagnostics present for all ${prioritySources.length} strategic employers. ${summary.join(', ')}`);

// Dedicated hyperscaler/operator snapshots can outlive the source workflow that
// created them. Validate freshness at deployment too so another healthy source
// cannot keep stale retained roles deployable past their verification window.
await import('./validate-dedicated-fallback-freshness.mjs');

// Digital Realty's dedicated Oracle Recruiting Cloud snapshot is authoritative.
// Enforce its employer-direct URLs, audience-fit metadata, source-health evidence,
// and snapshot/public-feed parity during every standard deployment.
await import('./validate-digital-realty.mjs');

// Deployment already invokes this strategic-source diagnostic guard. Keep the
// six major Workday operators fail-closed here as well so a stale or malformed
// fallback state cannot remain deployable merely because an old sourceHealthy
// boolean is still present in collector-status.json.
await import('./validate-major-workday-freshness-state.mjs');

// CoreSite is a major colocation operator and its verified fallback can outlive
// the workflow that produced it. Enforce both its direct-source state and fallback
// parity during every deployment, not only when CoreSite-specific files change.
await import('./validate-coresite-source-integrity.mjs');
await import('./validate-coresite-fallback.mjs');

// DataBank publishes from an authoritative employer-direct TalentReef snapshot.
// Enforce exact source/public parity on every deployment so stale or drifted
// DataBank requisitions cannot remain deployable between collector refreshes.
await import('./validate-databank.mjs');

// Iron Mountain and Novva publish from protected employer-direct snapshots that
// can remain active through bounded source outages. Enforce canonical direct URLs,
// 0-5-year mission fit, fallback freshness, and snapshot/public parity on deploy.
await import('./validate-iron-mountain.mjs');
await import('./validate-novva.mjs');

// Flexential and Cologix also have bounded employer-direct fallback windows. The
// shared freshness guard above protects degraded snapshots; when their sources are
// healthy, additionally require exact direct-link, audience-fit, and public parity.
if (status.flexential?.sourceHealthy === true) {
  await import('./validate-flexential.mjs');
}
if (status.cologix?.sourceHealthy === true) {
  await import('./validate-cologix.mjs');
}

// Switch and T5 publish authoritative employer-direct requisition snapshots with
// no retained degraded publication path. Validate canonical requisition identity,
// 0-5-year scope, senior-role exclusion, regional metadata, and feed parity here.
await import('./validate-switch-careers.mjs');
await import('./validate-t5-data-centers.mjs');

// TierPoint currently publishes from an authoritative iCIMS snapshot. Guard its
// exact requisition/public parity and refuse degraded deployments that would rely
// on the collector's historical unbounded previous-snapshot retention behavior.
await import('./validate-tierpoint.mjs');

// Crusoe is a comparable operator with employer-direct Ashby inventory in the
// public feed. Enforce official-board provenance, 0-5-year scope, senior-role
// exclusion, retention protection, and fresh source/fallback evidence on deploy.
await import('./validate-crusoe.mjs');

// Sabey publishes from a verified employer-recruiter iCIMS snapshot when its
// official careers page is unavailable. Enforce verified-host URLs, freshness,
// supported audience metadata, and exact snapshot/public-feed parity on deploy.
await import('./validate-sabey-snapshot.mjs');

// Prime and CoreWeave are comparable large operators with authoritative direct
// snapshots. Run their source-health, freshness, audience-fit, direct-link, and
// public-feed parity checks through the same standard deployment path.
await import('./validate-prime-data-centers.mjs');
await import('./validate-coreweave.mjs');

// Comparable operators are also part of the mission-critical source backbone.
// Validate their direct-source integrity and snapshot/public-feed parity whenever
// the shared priority diagnostic guard runs.
await import('./validate-compass-datacenters.mjs');
await import('./validate-stream-data-centers.mjs');
await import('./validate-edgeconnex-snapshot.mjs');
await import('./validate-edgeconnex.mjs');

// Regional filtering is part of the user-facing product contract. Run its
// authoritative state-market and beginner-pathway coverage checks through this
// shared guard so standard validation and Pages deployment both fail closed if
// a priority employer silently loses a market or receives the wrong region tag.
await import('./validate-priority-region-coverage.mjs');
