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
