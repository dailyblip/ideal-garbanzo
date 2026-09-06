import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';

const records = JSON.parse(await readFile('data/career-motivators.json', 'utf8'));
const errors = [];
const forbiddenTitle = /\b(?:senior|sr\.?|principal|director|vice president|vp|head of|chief|executive|staff engineer|lead|manager)\b/i;
const allowedSource = /^(?:https:\/\/openai\.com\/careers\/|https:\/\/(?:www\.)?amazon\.jobs\/|https:\/\/(?:www\.)?(?:metacareers\.com|meta\.com\/careers))/i;
const context = /data\s*cent(?:er|re)|datacenter|supercomput|rack|power|hardware|infrastructure|interconnect/i;
const today = Date.now();

if (!Array.isArray(records)) errors.push('data/career-motivators.json must contain an array.');
else {
  if (records.length < 2 || records.length > 3) errors.push(`Career motivators must contain 2–3 records; found ${records.length}.`);
  const ids = new Set();
  for (const record of records) {
    if (!record?.id || ids.has(record.id)) errors.push(`Missing or duplicate career motivator id: ${record?.id || '(missing)'}`);
    ids.add(record?.id);
    if (!record?.title || !record?.company || !record?.location) errors.push(`Career motivator ${record?.id} is missing title/company/location.`);
    if (forbiddenTitle.test(String(record?.title || ''))) errors.push(`Career motivator ${record?.id} has a too-senior title: ${record?.title}`);
    if (!Number.isFinite(Number(record?.salaryMax)) || Number(record.salaryMax) < 300000) errors.push(`Career motivator ${record?.id} must have a verified $300K+ upper compensation range.`);
    if (!Number.isFinite(Number(record?.minYears)) || Number(record.minYears) > 8) errors.push(`Career motivator ${record?.id} must stay below the very-senior experience tier.`);
    if (!allowedSource.test(String(record?.sourceUrl || ''))) errors.push(`Career motivator ${record?.id} must use an official OpenAI, Meta, or Amazon career URL.`);
    if (!context.test(`${record?.title || ''} ${record?.summary || ''}`)) errors.push(`Career motivator ${record?.id} is not clearly tied to data center / AI infrastructure work.`);
    const verified = Date.parse(`${record?.verifiedAt || ''}T00:00:00Z`);
    if (!Number.isFinite(verified) || verified > today + 86400000 || (today - verified) > 8 * 86400000) errors.push(`Career motivator ${record?.id} verification is missing or stale.`);
  }
}

try { await access('assets/career-motivators.js', constants.F_OK); } catch { errors.push('assets/career-motivators.js is missing.'); }
const loader = await readFile('assets/mailing-list.js', 'utf8');
if (!loader.includes('assets/career-motivators.js')) errors.push('Homepage does not load career-motivators.js.');

if (errors.length) {
  console.error('Career motivator validation failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Career motivator validation passed: ${records.length} verified $300K+ career-ceiling roles.`);
