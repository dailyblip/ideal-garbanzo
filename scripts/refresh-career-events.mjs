import { readFile, writeFile } from 'node:fs/promises';
import { verifyEventContent } from './career-event-evidence.mjs';

const EVENTS_PATH = 'data/career-events.json';
const TIMEOUT_MS = 15000;
const CONCURRENCY = 4;
const MAX_UNVERIFIED_AGE_DAYS = 30;
const RESTAMP_AFTER_DAYS = 7;
const MAX_BODY_CHARS = 1_500_000;
const allowedAudiences = new Set([
  'students',
  'interns',
  'apprentices',
  'early-career',
  'career-changers',
  'military'
]);

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const todayIso = new Date().toISOString().slice(0, 10);
const todayMs = Date.parse(`${todayIso}T00:00:00Z`);
const dayMs = 24 * 60 * 60 * 1000;

function verificationAgeDays(event) {
  const verifiedAt = Date.parse(`${clean(event?.verifiedAt)}T00:00:00Z`);
  if (!Number.isFinite(verifiedAt)) return Infinity;
  return Math.floor((todayMs - verifiedAt) / dayMs);
}

function validateEventShape(event, index) {
  const label = clean(event?.id) || `event at index ${index}`;
  for (const field of ['id', 'date', 'name', 'location', 'organizer', 'url', 'verifiedAt']) {
    if (!clean(event?.[field])) throw new Error(`Career event missing ${field}: ${label}`);
  }
  if (event.source !== 'Organizer page') throw new Error(`Career event must use organizer-page verification: ${label}`);
  if (event.country !== 'US') throw new Error(`Career event must be U.S.-based: ${label}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean(event.date)) || !Number.isFinite(Date.parse(`${event.date}T00:00:00Z`))) {
    throw new Error(`Career event has invalid date: ${label}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean(event.verifiedAt)) || !Number.isFinite(Date.parse(`${event.verifiedAt}T00:00:00Z`))) {
    throw new Error(`Career event has invalid verifiedAt: ${label}`);
  }
  if (!clean(event.url).startsWith('https://')) throw new Error(`Career event must use an HTTPS organizer URL: ${label}`);
  if (!Array.isArray(event.audiences) || !event.audiences.length) {
    throw new Error(`Career event missing mission-fit audience tags: ${label}`);
  }
  const invalidAudiences = event.audiences.filter(audience => !allowedAudiences.has(audience));
  if (invalidAudiences.length) {
    throw new Error(`Career event has unsupported audience tags (${invalidAudiences.join(', ')}): ${label}`);
  }
}

async function checkOrganizerUrl(event) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(event.url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; DataCenterCareersEventVerifier/1.0; +https://datacentercareers.us/)',
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8'
      }
    });
    const status = response.status;
    if (status === 404 || status === 410) return { state: 'dead', status, finalUrl: response.url };
    if (status >= 200 && status < 400) {
      const body = (await response.text()).slice(0, MAX_BODY_CHARS);
      const evidence = verifyEventContent(event, body);
      if (!evidence.matched) {
        return {
          state: 'unverifiable',
          status,
          finalUrl: response.url,
          reason: evidence.reason,
          contentEvidence: evidence
        };
      }
      return { state: 'ok', status, finalUrl: response.url, contentEvidence: evidence };
    }
    if ([401, 403, 405, 429].includes(status) || status >= 500) {
      return { state: 'unverifiable', status, finalUrl: response.url, reason: `http-${status}` };
    }
    return { state: 'warning', status, finalUrl: response.url, reason: `http-${status}` };
  } catch (error) {
    return {
      state: 'unverifiable',
      status: null,
      reason: error.name === 'AbortError' ? 'timeout' : 'fetch-error',
      error: error.name === 'AbortError' ? 'timeout' : clean(error.message || error)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
  return results;
}

const events = JSON.parse(await readFile(EVENTS_PATH, 'utf8'));
if (!Array.isArray(events)) throw new Error('career-events.json must contain an array');

const ids = new Set();
for (const [index, event] of events.entries()) {
  validateEventShape(event, index);
  if (ids.has(event.id)) throw new Error(`Duplicate career event id: ${event.id}`);
  ids.add(event.id);
}

const upcoming = [];
const expired = [];
for (const event of events) {
  if (event.date < todayIso) expired.push(event);
  else upcoming.push(event);
}

const checks = await mapLimit(upcoming, CONCURRENCY, async event => ({
  event,
  check: await checkOrganizerUrl(event)
}));

const kept = [];
const dead = [];
const staleUnverifiable = [];
const restamped = [];
const warnings = [];

for (const { event, check } of checks) {
  const ageDays = verificationAgeDays(event);
  if (check.state === 'dead') {
    dead.push({ id: event.id, status: check.status, url: event.url });
    continue;
  }

  if (check.state === 'ok') {
    if (ageDays >= RESTAMP_AFTER_DAYS || ageDays < 0 || !Number.isFinite(ageDays)) {
      kept.push({ ...event, verifiedAt: todayIso });
      restamped.push(event.id);
    } else {
      kept.push(event);
    }
    continue;
  }

  if (ageDays > MAX_UNVERIFIED_AGE_DAYS || !Number.isFinite(ageDays)) {
    staleUnverifiable.push({ id: event.id, state: check.state, status: check.status, reason: check.reason, ageDays, url: event.url });
    continue;
  }

  kept.push(event);
  warnings.push({ id: event.id, state: check.state, status: check.status, reason: check.reason, ageDays, url: event.url });
}

kept.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
const nextContent = JSON.stringify(kept, null, 2) + '\n';
const currentContent = JSON.stringify(events, null, 2) + '\n';
if (nextContent !== currentContent) await writeFile(EVENTS_PATH, nextContent);

console.log(`Career-event refresh: ${events.length} -> ${kept.length} published events.`);
if (expired.length) console.log(`Pruned ${expired.length} expired event(s): ${expired.map(event => event.id).join(', ')}`);
if (dead.length) console.log(`Pruned ${dead.length} event(s) with confirmed dead organizer links: ${dead.map(item => item.id).join(', ')}`);
if (staleUnverifiable.length) {
  console.log(`Pruned ${staleUnverifiable.length} event(s) that could not be reverified within ${MAX_UNVERIFIED_AGE_DAYS} days: ${staleUnverifiable.map(item => item.id).join(', ')}`);
}
if (restamped.length) console.log(`Renewed organizer verification for ${restamped.length} event(s) after confirming the event name and date are still present.`);
if (warnings.length) {
  console.warn(`Retained ${warnings.length} temporarily unverifiable event(s) within the verification window: ${warnings.map(item => `${item.id}:${item.status ?? item.state}:${item.reason ?? 'unverified'}`).join(' | ')}`);
}
