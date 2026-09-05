import { readFile } from 'node:fs/promises';

const STATUS_PATH = 'data/collector-status.json';
const protectedCompanies = [
  'Vantage Data Centers',
  'QTS Data Centers',
  'CyrusOne',
  'STACK Infrastructure',
  'NTT Global Data Centers',
  'Aligned Data Centers'
];

const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
const major = status?.majorSources;
const diagnostics = major?.employerDiagnostics;

// Older committed status files predate per-employer diagnostics. The next full
// refresh writes them; until then, keep deploy-only builds backward compatible.
if (!diagnostics || typeof diagnostics !== 'object' || Array.isArray(diagnostics)) {
  console.log('Major Workday health guard: per-employer diagnostics are not present yet; zero-listing checks begin after the next full refresh.');
  process.exit(0);
}

const violations = [];
for (const company of protectedCompanies) {
  const diag = diagnostics[company];
  if (!diag || typeof diag !== 'object') {
    violations.push(`${company}: missing employer diagnostics`);
    continue;
  }

  const sourceHealthy = diag.sourceHealthy === true;
  const listingComplete = diag.listingComplete === true;
  const usedPreviousSnapshot = diag.usedPreviousSnapshot === true;
  const reportedRows = Number(diag.reportedRows);
  const uniqueRows = Number(diag.uniqueRows);

  if (sourceHealthy && usedPreviousSnapshot) {
    violations.push(`${company}: source is marked healthy while also using the previous snapshot`);
  }

  if (!sourceHealthy && !usedPreviousSnapshot) {
    violations.push(`${company}: unhealthy source did not preserve the previous employer snapshot`);
  }

  if (sourceHealthy && listingComplete) {
    if (!Number.isFinite(reportedRows) || reportedRows < 1) {
      violations.push(`${company}: healthy complete Workday listing reported ${Number.isFinite(reportedRows) ? reportedRows : 'an invalid'} total job(s)`);
      continue;
    }

    if (!Number.isFinite(uniqueRows) || uniqueRows < 1) {
      violations.push(`${company}: healthy Workday listing reported ${reportedRows} jobs but returned no unique postings`);
    } else if (uniqueRows > reportedRows) {
      violations.push(`${company}: Workday returned ${uniqueRows} unique postings for a reported total of ${reportedRows}`);
    }
  }
}

const attempted = Number(major?.attempted);
const succeeded = Number(major?.succeeded);
const listingFallbacks = Number(major?.listingFallbacks);
if (Number.isFinite(attempted) && Number.isFinite(succeeded) && Number.isFinite(listingFallbacks)) {
  if (attempted !== protectedCompanies.length) {
    violations.push(`major Workday refresh attempted ${attempted} employers; expected ${protectedCompanies.length}`);
  }
  if (succeeded + listingFallbacks !== attempted) {
    violations.push(`major Workday refresh accounting is inconsistent: ${succeeded} succeeded + ${listingFallbacks} fallbacks != ${attempted} attempted`);
  }
}

if (violations.length) {
  for (const violation of violations) console.error(`Major Workday health violation: ${violation}`);
  throw new Error(`Blocked ${violations.length} major Workday source-health regression(s).`);
}

console.log(`Major Workday health guard passed for ${protectedCompanies.length} priority employers.`);
