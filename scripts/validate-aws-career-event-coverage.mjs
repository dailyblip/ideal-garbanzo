import { readFile } from 'node:fs/promises';

const EVENTS_PATH = 'data/career-events.json';
const TIMEOUT_MS = 15000;
const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
};
const MONTH_PATTERN = Object.keys(MONTHS).map(name => name[0].toUpperCase() + name.slice(1)).join('|');
const EXACT_DATE_PATTERN = new RegExp(
  `\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:\\s*[–—-]\\s*(?:(?:${MONTH_PATTERN})\\s+)?\\d{1,2})?\\s*,\\s*(20\\d{2})\\b`,
  'gi'
);

const SOURCES = [
  {
    label: 'AWS I2PA',
    url: 'https://aws.1110ths.org/i2pa/',
    minExactUpcomingDates: 1,
    endMarkers: ['No upcoming I2PA programs', 'Past Programs']
  },
  {
    label: 'AWS Fiber Optic Fusion Splicing',
    url: 'https://aws.1110ths.org/fiber-optic-fusion-splicing/',
    minExactUpcomingDates: 3,
    endMarkers: ['No sessions in your area yet?', 'Past Program Workshops and Events']
  }
];

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const todayIso = new Date().toISOString().slice(0, 10);

function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&ndash;|&#8211;|&#x2013;/gi, '–')
    .replace(/&mdash;|&#8212;|&#x2014;/gi, '—');
}

function pageTextFromHtml(html) {
  return clean(decodeEntities(String(html ?? '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')));
}

function upcomingText(text, source) {
  const normalized = clean(text);
  const start = normalized.toLowerCase().indexOf('upcoming programs');
  if (start === -1) throw new Error(`${source.label}: could not find the Upcoming Programs section.`);
  const afterStart = normalized.slice(start + 'upcoming programs'.length);
  const lower = afterStart.toLowerCase();
  let end = afterStart.length;
  for (const marker of source.endMarkers) {
    const index = lower.indexOf(marker.toLowerCase());
    if (index !== -1 && index < end) end = index;
  }
  return afterStart.slice(0, end);
}

function startDatesFromUpcomingText(text) {
  const found = new Set();
  EXACT_DATE_PATTERN.lastIndex = 0;
  let match;
  while ((match = EXACT_DATE_PATTERN.exec(text)) !== null) {
    const month = MONTHS[match[1].toLowerCase()];
    const day = Number(match[2]);
    const year = Number(match[3]);
    const candidate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const parsed = new Date(`${candidate}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== candidate) continue;
    if (candidate < todayIso) continue;
    found.add(candidate);
  }
  return [...found].sort();
}

function runRegressionTests() {
  const i2pa = startDatesFromUpcomingText('Columbus, OH Dates not set Covington, GA October 19 – November 13, 2026');
  if (i2pa.join(',') !== '2026-10-19') throw new Error(`I2PA date parser regression: ${i2pa.join(',')}`);
  const fiber = startDatesFromUpcomingText('October 5–6, 2026 October 7, 2026 October 8–9, 2026');
  if (fiber.join(',') !== '2026-10-05,2026-10-07,2026-10-08') throw new Error(`Fiber date parser regression: ${fiber.join(',')}`);
  console.log('AWS career-event coverage parser passed 2 regression cases.');
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; DataCenterCareersEventCoverage/1.0; +https://datacentercareers.us/)',
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'
      }
    });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function isAwsWorkforceEvent(event = {}) {
  const organizer = clean(event.organizer).toLowerCase();
  const url = clean(event.url).toLowerCase();
  return organizer.includes('amazon web services') && url.startsWith('https://aws.1110ths.org/');
}

runRegressionTests();

if (process.argv.includes('--self-test')) process.exit(0);

const events = JSON.parse(await readFile(EVENTS_PATH, 'utf8'));
if (!Array.isArray(events)) throw new Error(`${EVENTS_PATH} must contain a JSON array.`);
const coveredDates = new Set(events.filter(isAwsWorkforceEvent).map(event => clean(event.date)));
const uncovered = [];

for (const source of SOURCES) {
  const html = await fetchText(source.url);
  const text = pageTextFromHtml(html);
  const upcoming = upcomingText(text, source);
  const exactDates = startDatesFromUpcomingText(upcoming);
  if (exactDates.length < source.minExactUpcomingDates) {
    throw new Error(`${source.label}: found only ${exactDates.length} exact upcoming date(s); expected at least ${source.minExactUpcomingDates}. Source markup may have changed.`);
  }
  const missing = exactDates.filter(date => !coveredDates.has(date));
  if (missing.length) uncovered.push({ source: source.label, url: source.url, dates: missing });
  console.log(`${source.label}: ${exactDates.length} exact upcoming start date(s), ${missing.length} missing from career-events.json.`);
}

if (uncovered.length) {
  const detail = uncovered.map(item => `${item.source}: ${item.dates.join(', ')} (${item.url})`).join(' | ');
  throw new Error(`Verified AWS workforce source coverage gap. Review and add the missing mission-fit event(s): ${detail}`);
}

console.log('AWS workforce career-event discovery coverage is complete for all exact-dated upcoming programs.');
