import { readFile } from 'node:fs/promises';

const jobs = JSON.parse(await readFile('data/jobs.json', 'utf8'));
if (!Array.isArray(jobs)) throw new Error('data/jobs.json must contain an array');

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

// Independent deployment-time backstop for the same obvious drift repaired by
// filter-mission-fit.mjs. Keep this deliberately narrow so valid hands-on data
// center operations roles are not rejected.
const obviousNonMissionTitlePattern = /\b(?:administrative business partner|business analyst|financial operations|financial analyst|finance analyst|finance|accounting|accountant|procurement|purchasing|cost management|cost estimator|cost analyst|cost controls|security operations|security engineer|security analyst|security specialist|security technician|security officer|security guard|physical security|global security operations center|gsoc|wireless intrusion detection|cybersecurity|information security|software engineer|software developer|site reliability engineer|machine learning engineer|ml engineer|data scientist|product manager|program manager|talent acquisition|human resources|recruiter|account executive|sales representative|sales manager|marketing manager|marketing specialist|legal counsel|corporate counsel|legal assistant|legal intern|paralegal|law clerk|enterprise it support|enterprise applications|process analytics|project controls analyst|material planner|cnc operator|assembly technician|quality technician|assurance operations analyst)\b/i;
const obviousSeniorTitlePattern = /\b(?:senior|sr\.?|lead|leader|principal|chief|manager|mgr\.?|director|vice president|vp|head of|staff|supervisor|superintendent|foreman|architect)\b/i;

const canadianProvinceCodePattern = /,\s*(?:AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)\b(?:\s*,?\s*Canada)?\s*$/i;
const canadianProvinceNamePattern = /,\s*(?:Alberta|British Columbia|Manitoba|New Brunswick|Newfoundland(?: and Labrador)?|Nova Scotia|Northwest Territories|Nunavut|Ontario|Prince Edward Island|Quebec|Saskatchewan|Yukon)\b(?:\s*,?\s*Canada)?\s*$/i;
const foreignCountryPattern = /(?:^|[,;]\s*)(?:Canada|Mexico|Ireland|United Kingdom|UK|England|Germany|France|Netherlands|Switzerland|India|Japan|Taiwan|Singapore|Australia|China|Malaysia|Indonesia|Thailand|Brazil|South Africa|United Arab Emirates)\s*$/i;

function clearlyNonUsLocation(location = '') {
  return clean(location).split(';').map(part => part.trim()).filter(Boolean).some(segment =>
    canadianProvinceCodePattern.test(segment) ||
    canadianProvinceNamePattern.test(segment) ||
    foreignCountryPattern.test(segment)
  );
}

const regressionCases = [
  ['Business Analyst, Budget Planning & Financial Operations, Global', 'Ashburn, VA', true],
  ['Security Operations Engineer', 'Dallas, TX', true],
  ['Staff Electrical Operator', 'Phoenix, AZ', true],
  ['Critical Operations Technician I', 'Ontario, CA', false],
  ['Data Center Operations Technician', 'Cambridge, ON', true],
  ['Critical Facilities Engineer', 'Dublin, Ireland', true],
  ['Data Center Operations Technician', 'Ashburn, VA', false]
];

for (const [title, location, expectedBlocked] of regressionCases) {
  const blocked = obviousNonMissionTitlePattern.test(title) || obviousSeniorTitlePattern.test(title) || clearlyNonUsLocation(location);
  if (blocked !== expectedBlocked) {
    throw new Error(`Mission-fit validator regression for ${title} / ${location}: expected blocked=${expectedBlocked}, got ${blocked}`);
  }
}

const failures = [];
for (const job of jobs) {
  const title = clean(job?.title);
  const location = clean(job?.location);
  if (obviousNonMissionTitlePattern.test(title)) failures.push(`${job.id}: non-mission role family: ${title}`);
  else if (obviousSeniorTitlePattern.test(title)) failures.push(`${job.id}: senior/executive title: ${title}`);
  else if (clearlyNonUsLocation(location)) failures.push(`${job.id}: clearly non-US location: ${title} / ${location}`);
}

if (failures.length) {
  throw new Error(`Mission-fit publication validation failed for ${failures.length} role(s):\n${failures.slice(0, 25).join('\n')}${failures.length > 25 ? '\n…' : ''}`);
}

console.log(`Mission-fit publication validation passed for ${jobs.length} published jobs.`);
