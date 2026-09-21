import { readFile } from 'node:fs/promises';
import { isValidIsoDate } from './career-event-evidence.mjs';

// Keep organizer-page evidence matching deployment-gated as well as refresh-gated.
// A regression here could otherwise let stale, rescheduled, or cancelled events
// retain fresh verification dates during the next event refresh.
await import('./test-career-event-evidence.mjs');

const events = JSON.parse(await readFile('data/career-events.json', 'utf8'));
if (!Array.isArray(events)) throw new Error('career-events.json must contain an array');

const today = new Date();
const todayIso = today.toISOString().slice(0, 10);
const maxVerificationAgeMs = 7 * 24 * 60 * 60 * 1000;
const allowedAudiences = new Set([
  'students',
  'interns',
  'apprentices',
  'early-career',
  'career-changers',
  'military'
]);
const requiredTextFields = ['id', 'name', 'location', 'organizer'];
const seenIds = new Set();
const seenOccurrences = new Set();

for (const event of events) {
  for (const field of requiredTextFields) {
    if (!String(event?.[field] || '').trim()) throw new Error(`Career event missing ${field}`);
  }

  if (seenIds.has(event.id)) throw new Error(`Duplicate career event id: ${event.id}`);
  seenIds.add(event.id);

  if (!isValidIsoDate(event.date)) throw new Error(`Career event has invalid date: ${event.id}`);
  if (String(event.date) < todayIso) throw new Error(`Expired career event must be pruned: ${event.id}`);
  if (event.source !== 'Organizer page') throw new Error(`Career event must use organizer-page verification: ${event.id}`);
  if (event.country !== 'US') throw new Error(`Career event must be U.S.-based: ${event.id}`);

  let organizerUrl;
  try {
    organizerUrl = new URL(String(event.url || ''));
  } catch {
    throw new Error(`Career event has an invalid organizer URL: ${event.id}`);
  }
  if (organizerUrl.protocol !== 'https:' || !organizerUrl.hostname) {
    throw new Error(`Career event must use an HTTPS organizer URL: ${event.id}`);
  }

  if (!Array.isArray(event.audiences) || !event.audiences.length) {
    throw new Error(`Career event missing mission-fit audience tags: ${event.id}`);
  }
  const invalidAudiences = event.audiences.filter(audience => !allowedAudiences.has(audience));
  if (invalidAudiences.length) {
    throw new Error(`Career event has unsupported audience tags (${invalidAudiences.join(', ')}): ${event.id}`);
  }
  if (new Set(event.audiences).size !== event.audiences.length) {
    throw new Error(`Career event has duplicate audience tags: ${event.id}`);
  }

  if (!isValidIsoDate(event.verifiedAt)) throw new Error(`Career event has invalid verifiedAt: ${event.id}`);
  const verifiedAt = new Date(`${event.verifiedAt}T00:00:00Z`);
  if (verifiedAt.getTime() > today.getTime()) throw new Error(`Career event verifiedAt cannot be in the future: ${event.id}`);
  if (today.getTime() - verifiedAt.getTime() > maxVerificationAgeMs) {
    throw new Error(`Career event verification is older than 7 days: ${event.id}`);
  }

  const occurrenceKey = [event.date, event.name, event.location, event.organizer]
    .map(value => String(value).trim().toLowerCase().replace(/\s+/g, ' '))
    .join('|');
  if (seenOccurrences.has(occurrenceKey)) {
    throw new Error(`Duplicate career event occurrence: ${event.id}`);
  }
  seenOccurrences.add(occurrenceKey);
}

console.log(`Career-event freshness passed: ${events.length} upcoming U.S. organizer-verified, mission-fit events.`);
