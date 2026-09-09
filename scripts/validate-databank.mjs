import { readFile } from 'node:fs/promises';

const COMPANY = 'DataBank';
const SNAPSHOT_PATH = 'data/databank-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const PORTAL_PREFIX = 'https://www.databankcareers.com/clients/';
const allowedTypes = new Set(['entry-level', 'internship', 'apprenticeship', 'trainee']);
const allowedExperience = new Set(['no-experience', '0-2-years', '2-5-years']);
const excludedTitlePattern = /\b(?:senior|sr\.?|lead|principal|staff|manager|director|vice president|vp|chief|head of|supervisor|superintendent|foreman|architect|security|sales|account executive|solutions engineer|project manager|product manager|analyst|finance|procurement|marketing|software|developer|data scientist|human resources|recruiter)\b/i;
const missionTitlePattern = /\b(?:data cent(?:er|re)|critical infrastructure|critical facilit(?:y|ies)|critical environment|facilit(?:y|ies) technician|electrical technician|mechanical technician)\b/i;
const contextualInfraTitlePattern = /\b(?:technician|operator|engineer|electrician|mechanic|intern|apprentice|trainee)\b/i;
const missionEvidenceTags = new Set(['Critical Facilities', 'Electrical', 'Network / Cabling']);
const stateAbbrPattern = /(?:,|\s)\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)(?:\b|$)/i;
const usStateNames = ['alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa','kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan','minnesota','mississippi','missouri','montana','nebraska','nevada','new hampshire','new jersey','new mexico','new york','north carolina','north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island','south carolina','south dakota','tennessee','texas','utah','vermont','virginia','washington','west virginia','wisconsin','wyoming','district of columbia'];

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const lower = value => clean(value).toLowerCase();
const normalize = value => lower(value).replace(/[^a-z0-9]+/g, ' ').trim();
const isUsLocation = value => stateAbbrPattern.test(clean(value)) || usStateNames.some(state => lower(value).includes(state));
const hasMissionEvidence = job => {
  const title = clean(job?.title);
  if (missionTitlePattern.test(title)) return true;
  if (!contextualInfraTitlePattern.test(title)) return false;
  return (Array.isArray(job?.tags) ? job.tags : []).some(tag => missionEvidenceTags.has(clean(tag)));
};

const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
const sourceStatus = status?.databank || {};
const violations = [];

if (!Array.isArray(snapshot)) violations.push('snapshot is not a JSON array');
if (sourceStatus.sourceHealthy !== true) violations.push('collector status does not mark the employer source healthy');
if (sourceStatus.listingComplete !== true) violations.push('collector status does not mark the TalentReef listing complete');
if (sourceStatus.authoritativeSnapshot !== true) violations.push('collector status does not mark the snapshot authoritative');
if (sourceStatus.officialCareerPage !== 'https://www.databank.com/about-databank/careers-at-databank/') violations.push('official DataBank careers URL drifted');
if (sourceStatus.officialTalentReefPortal !== 'https://www.databankcareers.com') violations.push('official DataBank TalentReef portal drifted');
if (!clean(sourceStatus.talentReefClientId)) violations.push('TalentReef client ID was not recorded');
if (!Number.isFinite(Number(sourceStatus.listedJobs)) || Number(sourceStatus.listedJobs) <= 0) violations.push('TalentReef listing count is missing or zero');
if (Number(sourceStatus.qualifyingRoles) !== snapshot.length) violations.push(`snapshot/status count mismatch: ${snapshot.length} vs ${sourceStatus.qualifyingRoles}`);

const urls = new Set();
const identities = new Set();
for (const job of Array.isArray(snapshot) ? snapshot : []) {
  if (clean(job?.company) !== COMPANY) violations.push(`wrong company: ${clean(job?.company) || '(blank)'}`);
  if (!clean(job?.title)) violations.push(`blank title for ${job?.id || '(no id)'}`);
  if (excludedTitlePattern.test(clean(job?.title))) violations.push(`senior/out-of-scope title survived: ${job.title}`);
  if (!hasMissionEvidence(job)) violations.push(`non-mission title survived without infrastructure evidence: ${job.title}`);
  if (!allowedTypes.has(clean(job?.type))) violations.push(`invalid type ${job?.type} for ${job?.title}`);
  if (!allowedExperience.has(clean(job?.experience))) violations.push(`invalid experience ${job?.experience} for ${job?.title}`);
  if (!isUsLocation(job?.location)) violations.push(`non-US or unresolved location ${job?.location} for ${job?.title}`);
  if (!clean(job?.sourceUrl).startsWith(PORTAL_PREFIX)) violations.push(`non-employer-direct source URL for ${job?.title}: ${job?.sourceUrl}`);
  if (job?.active !== true || job?.demo === true) violations.push(`inactive/demo role in snapshot: ${job?.title}`);

  const url = clean(job?.sourceUrl);
  const identity = [job?.company, job?.title, job?.location].map(normalize).join('|');
  if (url && urls.has(url)) violations.push(`duplicate source URL: ${url}`);
  if (identities.has(identity)) violations.push(`duplicate role identity: ${job?.title} | ${job?.location}`);
  if (url) urls.add(url);
  identities.add(identity);
}

if (violations.length) {
  violations.forEach(violation => console.error(`DataBank source validation: ${violation}`));
  throw new Error(`Blocked ${violations.length} DataBank employer-direct source regression(s).`);
}

console.log(`DataBank employer-direct source passed: ${snapshot.length} qualifying role(s) from ${sourceStatus.listedJobs} public TalentReef postings.`);
