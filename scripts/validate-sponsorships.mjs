import { readFile } from 'node:fs/promises';

const ALLOWED_TYPES = new Set(['commercial', 'issue-advocacy', 'political']);
const ALLOWED_PLACEMENTS = new Set(['homepage', 'jobs', 'apprenticeships', 'internships', 'career-events', 'region', 'job-detail', 'sitewide']);
const ALLOWED_REGIONS = new Set(['all', 'mid-atlantic', 'texas', 'southwest', 'midwest', 'southeast', 'northeast', 'west']);
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const fail = message => { throw new Error(`Sponsorship validation failed: ${message}`); };

const records = JSON.parse(await readFile('data/sponsorships.json', 'utf8'));
if (!Array.isArray(records)) fail('data/sponsorships.json must contain an array.');

const ids = new Set();
for (const campaign of records) {
  if (!campaign || typeof campaign !== 'object') fail('Every sponsorship record must be an object.');
  const id = clean(campaign.id);
  if (!id) fail('Every sponsorship must have an id.');
  if (ids.has(id)) fail(`Duplicate sponsorship id: ${id}`);
  ids.add(id);

  if (!['draft', 'scheduled', 'active', 'ended'].includes(campaign.status)) fail(`${id}: invalid status.`);
  if (!ALLOWED_TYPES.has(campaign.campaignType)) fail(`${id}: invalid campaignType.`);

  for (const key of ['sponsorName', 'headline', 'body', 'ctaText', 'destinationUrl', 'startsAt', 'endsAt']) {
    if (!clean(campaign[key])) fail(`${id}: missing ${key}.`);
  }
  if (!/^https:\/\//i.test(clean(campaign.destinationUrl))) fail(`${id}: destinationUrl must use HTTPS.`);

  const starts = Date.parse(campaign.startsAt);
  const ends = Date.parse(campaign.endsAt);
  if (!Number.isFinite(starts) || !Number.isFinite(ends) || ends <= starts) fail(`${id}: invalid campaign date range.`);

  if (!Array.isArray(campaign.placements) || campaign.placements.length === 0) fail(`${id}: placements must be a non-empty array.`);
  for (const placement of campaign.placements) if (!ALLOWED_PLACEMENTS.has(placement)) fail(`${id}: unsupported placement ${placement}.`);

  if (!Array.isArray(campaign.regions) || campaign.regions.length === 0) fail(`${id}: regions must be a non-empty array.`);
  for (const region of campaign.regions) if (!ALLOWED_REGIONS.has(region)) fail(`${id}: unsupported region ${region}.`);

  if (campaign.campaignType === 'political' || campaign.campaignType === 'issue-advocacy') {
    if (!clean(campaign.paidForBy)) fail(`${id}: political/issue ads require paidForBy.`);
    if (!clean(campaign.disclaimer)) fail(`${id}: political/issue ads require a visible disclaimer.`);
  }

  if (campaign.status === 'active') {
    if (clean(campaign.headline).length > 110) fail(`${id}: active headline is too long.`);
    if (clean(campaign.body).length > 260) fail(`${id}: active body is too long.`);
    if (clean(campaign.ctaText).length > 36) fail(`${id}: active CTA is too long.`);
  }
}

console.log(`Sponsorship validation passed: ${records.length} campaign record(s), ${records.filter(record => record.status === 'active').length} active.`);
