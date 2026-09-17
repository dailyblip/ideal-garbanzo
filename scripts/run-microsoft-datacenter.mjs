const MIN_INTERVAL_MS = Number(process.env.MICROSOFT_FETCH_MIN_INTERVAL_MS || 1500);
const BASE_429_COOLDOWN_MS = Number(process.env.MICROSOFT_FETCH_429_COOLDOWN_MS || 8000);
const MAX_429_COOLDOWN_MS = Number(process.env.MICROSOFT_FETCH_MAX_429_COOLDOWN_MS || 60000);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function finiteNonNegative(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function retryAfterMs(value, nowMs = Date.now()) {
  const text = String(value || '').trim();
  if (!text) return null;

  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const dateMs = Date.parse(text);
  if (!Number.isFinite(dateMs)) return null;
  return Math.max(0, dateMs - nowMs);
}

function cooldownMs(retryAfter, strike = 0, nowMs = Date.now()) {
  const base = finiteNonNegative(BASE_429_COOLDOWN_MS, 8000);
  const max = Math.max(base, finiteNonNegative(MAX_429_COOLDOWN_MS, 60000));
  const exponential = base * (2 ** Math.min(Math.max(0, strike), 3));
  const header = retryAfterMs(retryAfter, nowMs) || 0;
  return Math.min(max, Math.max(base, exponential, header));
}

function runPolicyTests() {
  const now = Date.parse('2026-09-17T12:00:00.000Z');
  const cases = [
    [retryAfterMs('5', now), 5000, 'numeric Retry-After'],
    [retryAfterMs('Wed, 17 Sep 2026 12:00:09 GMT', now), 9000, 'HTTP-date Retry-After'],
    [retryAfterMs('invalid', now), null, 'invalid Retry-After'],
    [cooldownMs('', 0, now), finiteNonNegative(BASE_429_COOLDOWN_MS, 8000), 'base cooldown'],
    [cooldownMs('', 1, now), Math.min(Math.max(finiteNonNegative(BASE_429_COOLDOWN_MS, 8000), finiteNonNegative(MAX_429_COOLDOWN_MS, 60000)), finiteNonNegative(BASE_429_COOLDOWN_MS, 8000) * 2), 'escalated cooldown']
  ];

  const failures = cases.filter(([actual, expected]) => actual !== expected);
  if (failures.length) {
    for (const [actual, expected, label] of failures) {
      console.error(`Microsoft throttle regression: ${label} expected ${expected}, got ${actual}`);
    }
    process.exit(1);
  }

  if (!(finiteNonNegative(MIN_INTERVAL_MS, 1500) >= 1000)) {
    throw new Error('Microsoft request pacing must stay at or above 1000ms unless the policy test is updated deliberately.');
  }

  console.log('Microsoft request-throttle policy passed 5 regression cases.');
}

if (process.argv.includes('--test-rate-limit-policy')) {
  runPolicyTests();
  process.exit(0);
}

const nativeFetch = globalThis.fetch;
if (typeof nativeFetch !== 'function') throw new Error('Global fetch is unavailable in this Node runtime.');

const minimumIntervalMs = Math.max(1000, finiteNonNegative(MIN_INTERVAL_MS, 1500));
let gate = Promise.resolve();
let lastStartedAt = 0;
let blockedUntil = 0;
let consecutive429 = 0;

globalThis.fetch = (input, init) => {
  const task = gate.then(async () => {
    const now = Date.now();
    const earliest = Math.max(lastStartedAt + minimumIntervalMs, blockedUntil);
    if (earliest > now) await sleep(earliest - now);

    lastStartedAt = Date.now();
    const response = await nativeFetch(input, init);

    if (response.status === 429) {
      const wait = cooldownMs(response.headers.get('retry-after'), consecutive429, Date.now());
      consecutive429 += 1;
      blockedUntil = Math.max(blockedUntil, Date.now() + wait);
      console.warn(`Microsoft careers throttled a request; enforcing an additional ${Math.ceil(wait / 1000)}s cooldown before the next request.`);
    } else if (response.ok) {
      consecutive429 = 0;
      if (blockedUntil <= Date.now()) blockedUntil = 0;
    }

    return response;
  });

  gate = task.then(() => undefined, () => undefined);
  return task;
};

await import('./collect-microsoft-datacenter.mjs');
