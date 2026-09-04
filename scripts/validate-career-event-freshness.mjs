import { readFile } from 'node:fs/promises';

const events = JSON.parse(await readFile('data/career-events.json', 'utf8'));
if (!Array.isArray(events)) throw new Error('career-events.json must contain an array');

const today = new Date();
const todayIso = today.toISOString().slice(0, 10);
const maxVerificationAgeMs = 30 * 24 * 60 * 60 * 1000;
const allowedAudiences = new Set([
  'students',
  'interns',
  'apprentices',
  'early-career',
  'career-changers',
  'military'
]);

for (const event of events) {
  if (!event?.id) throw new Error('Career event missing id');
  if (String(event.date || '') < todayIso) throw new Error(`Expired career event must be pruned: ${event.id}`);
  if (event.source !== 'Organizer page') throw new Error(`Career event must use organizer-page verification: ${event.id}`);
  if (event.country !== 'US') throw new Error(`Career event must be U.S.-based: ${event.id}`);
  if (!String(event.url || '').startsWith('https://')) throw new Error(`Career event must use an HTTPS organizer URL: ${event.id}`);

  if (!Array.isArray(event.audiences) || !event.audiences.length) {
    throw new Error(`Career event missing mission-fit audience tags: ${event.id}`);
  }
  const invalidAudiences = event.audiences.filter(audience => !allowedAudiences.has(audience));
  if (invalidAudiences.length) {
    throw new Error(`Career event has unsupported audience tags (${invalidAudiences.join(', ')}): ${event.id}`);
  }

  const verifiedAt = new Date(`${event.verifiedAt}T00:00:00Z`);
  if (!Number.isFinite(verifiedAt.getTime())) throw new Error(`Career event has invalid verifiedAt: ${event.id}`);
  if (verifiedAt.getTime() > today.getTime()) throw new Error(`Career event verifiedAt cannot be in the future: ${event.id}`);
  if (today.getTime() - verifiedAt.getTime() > maxVerificationAgeMs) {
    throw new Error(`Career event verification is older than 30 days: ${event.id}`);
  }
}

console.log(`Career-event freshness passed: ${events.length} upcoming U.S. organizer-verified, mission-fit events.`);
