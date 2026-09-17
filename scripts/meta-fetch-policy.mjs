const nativeFetch = globalThis.fetch.bind(globalThis);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const META_HOSTS = new Set(['metacareers.com', 'www.metacareers.com']);
const DETAIL_PATH = /^\/profile\/job_details\/\d+\/?$/i;
const BASE_DETAIL_INTERVAL_MS = Math.max(250, Number(process.env.META_DETAIL_INTERVAL_MS || 650));
const MAX_RETRY_AFTER_MS = Math.max(1000, Number(process.env.META_MAX_RETRY_AFTER_MS || 12000));
const MAX_DETAIL_ATTEMPTS = Math.max(1, Number(process.env.META_DETAIL_ATTEMPTS || 3));
const BROWSER_UA = process.env.META_FETCH_USER_AGENT || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

let detailTail = Promise.resolve();
let nextDetailAt = 0;
let consecutiveRateLimits = 0;

function requestUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input?.url || '';
}

function withMetaHeaders(init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('user-agent', BROWSER_UA);
  headers.set('accept-language', headers.get('accept-language') || 'en-US,en;q=0.9');
  headers.set('accept', headers.get('accept') || 'text/html,application/xhtml+xml');
  return { ...init, headers };
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
    lastResponse = await nativeFetch(input, withMetaHeaders(init));
    const rateLimited = lastResponse.status === 429 || lastResponse.status === 503;

    if (!rateLimited) {
      consecutiveRateLimits = 0;
      nextDetailAt = Math.max(Date.now(), startedAt + BASE_DETAIL_INTERVAL_MS);
      return lastResponse;
    }

    consecutiveRateLimits += 1;
    if (attempt >= MAX_DETAIL_ATTEMPTS) {
      nextDetailAt = Date.now() + Math.min(MAX_RETRY_AFTER_MS, BASE_DETAIL_INTERVAL_MS * Math.min(8, consecutiveRateLimits));
      return lastResponse;
    }

    try { await lastResponse.arrayBuffer(); } catch {}
    const serverDelay = retryAfterMs(lastResponse);
    const adaptiveDelay = Math.min(
      MAX_RETRY_AFTER_MS,
      BASE_DETAIL_INTERVAL_MS * Math.min(12, 2 ** Math.min(4, consecutiveRateLimits))
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

  if (!DETAIL_PATH.test(parsed.pathname)) {
    return nativeFetch(input, withMetaHeaders(init));
  }

  const run = detailTail.then(() => pacedDetailFetch(input, init));
  detailTail = run.then(() => undefined, () => undefined);
  return run;
};
