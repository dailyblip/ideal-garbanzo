import { readFile } from 'node:fs/promises';

const status = JSON.parse(await readFile('data/collector-status.json', 'utf8'));
const jobs = JSON.parse(await readFile('data/jobs.json', 'utf8'));

if (!status || typeof status !== 'object' || Array.isArray(status)) {
  throw new Error('data/collector-status.json must contain an object.');
}
if (!Array.isArray(jobs)) {
  throw new Error('data/jobs.json must contain an array.');
}

const prioritySources = [
  ['Amazon Web Services', value => value.amazonDatacenter],
  ['Google', value => value.googleCareers],
  ['Microsoft', value => value.microsoftDatacenter],
  ['Meta', value => value.metaCareers],
  ['Oracle', value => value.oracleCareers],
  ['Equinix', value => value.priorityEmployerExpansion?.Equinix],
  ['Digital Realty', value => value.digitalRealty],
  ['CoreSite', value => value.coreSite],
  ['Iron Mountain', value => value.ironMountain],
  ['Novva Data Centers', value => value.novvaCareers],
  ['Flexential', value => value.flexential],
  ['Switch', value => value.switchCareers],
  ['Cologix', value => value.cologix],
  ['T5 Data Centers', value => value.t5DataCenters],
  ['Compass Datacenters', value => value.compass],
  ['Stream Data Centers', value => value.streamDataCenters],
  ['EdgeConneX', value => value.edgeconnexCareers],
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

// Comparable operators are also part of the mission-critical source backbone.
// Validate their direct-source integrity and snapshot/public-feed parity whenever
// the shared priority diagnostic guard runs.
await import('./validate-compass-datacenters.mjs');
await import('./validate-stream-data-centers.mjs');
await import('./validate-edgeconnex-snapshot.mjs');
await import('./validate-edgeconnex.mjs');
