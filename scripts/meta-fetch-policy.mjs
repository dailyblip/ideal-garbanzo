const nativeFetch = globalThis.fetch.bind(globalThis);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const META_HOSTS = new Set(['metacareers.com', 'www.metacareers.com']);
const DETAIL_PATH = /^\/profile\/job_details\/\d+\/?$/i;
const BASE_DETAIL_INTERVAL_MS = Math.max(250, Number(process.env.META_DETAIL_INTERVAL_MS || 1200));
const MAX_RETRY_AFTER_MS = Math.max(1000, Number(process.env.META_MAX_RETRY_AFTER_MS || 12000));
const MAX_DETAIL_ATTEMPTS = Math.max(1, Number(process.env.META_DETAIL_ATTEMPTS || 3));
const RATE_LIMIT_STREAK_LIMIT = Math.max(2, Number(process.env.META_RATE_LIMIT_STREAK_LIMIT || 3));
const PERSISTENT_COOLDOWN_MS = Math.max(
  BASE_DETAIL_INTERVAL_MS,
  Number(process.env.META_PERSISTENT_COOLDOWN_MS || 3500)
);

let detailTail = Promise.resolve();
let nextDetailAt = 0;
let consecutiveRateLimits = 0;

function requestUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input?.url || '';
}

function retryAfterMs(response) {
  const value = String(response?.headers?.get('retry-after') || '').trim();
  if (!value) return 0;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.min(MAX_RETRY_AFTER_MS, Math.ceil(Number(value) * 1000));
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, at - Date.now())) : 0;
}

async function pacedDetailFetch(input, init) {
  const waitForSlot = Math.max(0, nextDetailAt - Date.now());
  if (waitForSlot) await sleep(waitForSlot);

  let lastResponse;
  for (let attempt = 1; attempt <= MAX_DETAIL_ATTEMPTS; attempt += 1) {
    const startedAt = Date.now();
    lastResponse = await nativeFetch(input, init);
    const rateLimited = lastResponse.status === 429 || lastResponse.status === 503;

    if (!rateLimited) {
      consecutiveRateLimits = 0;
      nextDetailAt = Math.max(Date.now(), startedAt + BASE_DETAIL_INTERVAL_MS);
      return lastResponse;
    }

    consecutiveRateLimits += 1;
    const serverDelay = retryAfterMs(lastResponse);

    // If Meta is persistently rejecting detail traffic from the runner, stop
    // retrying every requisition. Preserve Retry-After when present, otherwise
    // use a modest cooldown. This keeps the six-hour source job bounded while
    // still failing closed instead of publishing unverifiable roles.
    if (consecutiveRateLimits >= RATE_LIMIT_STREAK_LIMIT || attempt >= MAX_DETAIL_ATTEMPTS) {
      const cooldown = Math.max(
        BASE_DETAIL_INTERVAL_MS,
        serverDelay || Math.min(MAX_RETRY_AFTER_MS, PERSISTENT_COOLDOWN_MS)
      );
      nextDetailAt = Date.now() + cooldown;
      return lastResponse;
    }

    try { await lastResponse.arrayBuffer(); } catch {}
    const adaptiveDelay = Math.min(
      MAX_RETRY_AFTER_MS,
      BASE_DETAIL_INTERVAL_MS * Math.min(8, 2 ** Math.min(3, consecutiveRateLimits))
    );
    const cooldown = Math.max(serverDelay, adaptiveDelay) + Math.floor(Math.random() * 250);
    nextDetailAt = Date.now() + cooldown;
    await sleep(cooldown);
  }

  return lastResponse;
}

globalThis.fetch = async (input, init = {}) => {
  let parsed;
  try { parsed = new URL(requestUrl(input)); } catch { return nativeFetch(input, init); }
  if (!META_HOSTS.has(parsed.hostname.toLowerCase())) return nativeFetch(input, init);

  // Preserve the collector's existing facebookexternalhit identity for every
  // Meta request. Meta returns HTTP 400 when job-detail requests are rewritten
  // to a browser identity. Reliability comes from serialized pacing and bounded
  // Retry-After-aware backoff, not from changing the request identity.
  if (!DETAIL_PATH.test(parsed.pathname)) return nativeFetch(input, init);

  const run = detailTail.then(() => pacedDetailFetch(input, init));
  detailTail = run.then(() => undefined, () => undefined);
  return run;
};
