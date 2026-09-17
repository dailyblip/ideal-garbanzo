import { createSign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const STATE_PATH = 'data/google-indexing-state.json';
const API_ENDPOINT = 'https://indexing.googleapis.com/v3/urlNotifications:publish';
const INDEXING_SCOPE = 'https://www.googleapis.com/auth/indexing';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const DEFAULT_MAX_PUBLISH = 170;
const DEFAULT_MIN_INTERVAL_MS = 225;

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const slugify = value => clean(value)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 70) || 'job';
const jobSlug = job => `${slugify(job.title)}-${slugify(job.company).slice(0, 32)}-${String(job.id || '').replace(/[^a-zA-Z0-9]/g, '').slice(-10)}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function parsePositiveInt(value, fallback, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function parseNonNegativeInt(value, fallback, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

function timestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function changeKey(job) {
  return clean(job.lastChangedAt) || clean(job.firstSeenAt) || clean(job.postedAt);
}

function encodeJwtPart(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

async function loadState() {
  try {
    const parsed = JSON.parse(await readFile(STATE_PATH, 'utf8'));
    if (parsed?.version !== 1 || !parsed.jobs || typeof parsed.jobs !== 'object' || Array.isArray(parsed.jobs)) {
      throw new Error(`${STATE_PATH} must contain version 1 with a jobs object.`);
    }
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, jobs: {} };
    throw error;
  }
}

function parseServiceAccount() {
  const raw = process.env.GOOGLE_INDEXING_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_INDEXING_SERVICE_ACCOUNT_JSON is required when dry-run mode is off.');

  let account;
  try {
    account = JSON.parse(raw);
  } catch {
    throw new Error('GOOGLE_INDEXING_SERVICE_ACCOUNT_JSON must be the complete service-account JSON object.');
  }

  if (!clean(account.client_email) || !clean(account.private_key)) {
    throw new Error('Google service-account JSON is missing client_email or private_key.');
  }
  return account;
}

async function getAccessToken(account) {
  const tokenUri = clean(account.token_uri) || DEFAULT_TOKEN_URI;
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: account.client_email,
    scope: INDEXING_SCOPE,
    aud: tokenUri,
    iat: now,
    exp: now + 3600
  };
  const unsigned = `${encodeJwtPart(header)}.${encodeJwtPart(claims)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${signer.sign(account.private_key).toString('base64url')}`;

  const response = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 700);
    throw new Error(`Google OAuth token request failed (${response.status}): ${detail}`);
  }

  const payload = await response.json();
  if (!payload.access_token) throw new Error('Google OAuth token response did not include access_token.');
  return payload.access_token;
}

async function verifyLiveTarget(notification) {
  try {
    const response = await fetch(notification.url, {
      redirect: 'follow',
      headers: { 'user-agent': 'DataCenterCareers-IndexingNotifier/1.0' }
    });

    if (notification.type === 'URL_DELETED') {
      if (response.status === 404 || response.status === 410) return { ready: true };
      if (response.ok) {
        const html = await response.text();
        if (/<meta[^>]+name=["']robots["'][^>]+content=["'][^"']*noindex/i.test(html)
          || /<meta[^>]+content=["'][^"']*noindex[^"']*["'][^>]+name=["']robots["']/i.test(html)) {
          return { ready: true };
        }
      }
      return { ready: false, reason: `live URL still returns ${response.status} without noindex` };
    }

    if (!response.ok) return { ready: false, reason: `live URL returned ${response.status}` };
    const html = await response.text();
    if (!/["']@type["']\s*:\s*["']JobPosting["']/i.test(html)) {
      return { ready: false, reason: 'live URL does not contain JobPosting structured data yet' };
    }
    if (!html.includes(`<link rel="canonical" href="${notification.url}">`)) {
      return { ready: false, reason: 'live canonical does not match notification URL yet' };
    }
    return { ready: true };
  } catch (error) {
    return { ready: false, reason: `live verification failed: ${error.message}` };
  }
}

async function publishNotification(accessToken, notification) {
  const response = await fetch(API_ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ url: notification.url, type: notification.type })
  });

  if (response.ok) return { ok: true };

  const detail = (await response.text()).slice(0, 900);
  const quotaLimited = response.status === 429 || (response.status === 403 && /quota|resource exhausted|rate limit/i.test(detail));
  if (quotaLimited) return { ok: false, quotaLimited: true, detail };
  throw new Error(`Google Indexing API ${notification.type} failed for ${notification.url} (${response.status}): ${detail}`);
}

const domain = clean(await readFile('CNAME', 'utf8')).replace(/^https?:\/\//, '').replace(/\/$/, '');
if (!domain) throw new Error('CNAME is required to build canonical job URLs.');
const baseUrl = `https://${domain}`;
const jobPrefix = `${baseUrl}/jobs/`;
const jobs = JSON.parse(await readFile('data/jobs.json', 'utf8'));
if (!Array.isArray(jobs) || !jobs.length) throw new Error('data/jobs.json must contain a non-empty array.');

const currentById = new Map();
for (const job of jobs) {
  const id = clean(job.id);
  if (!id) throw new Error('Every job must have an id before it can be submitted to Google.');
  if (currentById.has(id)) throw new Error(`Duplicate job id prevents safe indexing notifications: ${id}`);
  const url = `${jobPrefix}${jobSlug(job)}/`;
  currentById.set(id, { job, url, changeKey: changeKey(job) });
}

const state = await loadState();
const notifications = [];

for (const [id, previous] of Object.entries(state.jobs)) {
  const oldUrl = clean(previous?.url);
  if (!oldUrl) continue;
  if (!oldUrl.startsWith(jobPrefix)) throw new Error(`Refusing to notify a URL outside the canonical jobs path: ${oldUrl}`);

  const current = currentById.get(id);
  if (!current) {
    notifications.push({ id, url: oldUrl, type: 'URL_DELETED', reason: 'job removed from current verified feed', priority: 0, sortTime: 0 });
  } else if (current.url !== oldUrl) {
    notifications.push({ id, url: oldUrl, type: 'URL_DELETED', reason: 'canonical job URL changed', priority: 0, sortTime: timestamp(current.changeKey) });
  }
}

for (const [id, current] of currentById) {
  const previous = state.jobs[id];
  const isNew = !previous;
  const urlChanged = previous && clean(previous.url) !== current.url;
  const contentChanged = previous && clean(previous.lastChangedAt) !== current.changeKey;
  if (!isNew && !urlChanged && !contentChanged) continue;

  notifications.push({
    id,
    url: current.url,
    type: 'URL_UPDATED',
    reason: isNew ? 'not yet submitted' : (urlChanged ? 'canonical job URL changed' : 'verified job content changed'),
    priority: isNew ? 1 : 2,
    sortTime: Math.max(timestamp(current.job.firstSeenAt), timestamp(current.changeKey), timestamp(current.job.postedAt))
  });
}

const deduped = [...new Map(notifications.map(item => [`${item.type}:${item.url}`, item])).values()]
  .sort((a, b) => a.priority - b.priority || b.sortTime - a.sortTime || a.url.localeCompare(b.url));

const maxPublish = parsePositiveInt(process.env.GOOGLE_INDEXING_MAX_PUBLISH, DEFAULT_MAX_PUBLISH, 200);
const minIntervalMs = parseNonNegativeInt(process.env.GOOGLE_INDEXING_MIN_INTERVAL_MS, DEFAULT_MIN_INTERVAL_MS, 5000);
const selected = deduped.slice(0, maxPublish);
const deletes = deduped.filter(item => item.type === 'URL_DELETED').length;
const updates = deduped.length - deletes;
const dryRun = process.env.GOOGLE_INDEXING_DRY_RUN === '1';

console.log(`Google JobPosting indexing queue: ${deduped.length} pending (${updates} updates, ${deletes} deletions); up to ${selected.length} selected this run.`);
if (dryRun) {
  for (const item of selected.slice(0, 12)) console.log(`[dry-run] ${item.type} ${item.url} — ${item.reason}`);
  if (selected.length > 12) console.log(`[dry-run] ... ${selected.length - 12} additional selected notifications omitted from log.`);
  process.exit(0);
}

if (!selected.length) {
  console.log('Google JobPosting indexing state is already current; no API calls needed.');
  process.exit(0);
}

const accessToken = await getAccessToken(parseServiceAccount());
let published = 0;
let skippedNotLive = 0;
let quotaStopped = false;

for (let index = 0; index < selected.length; index += 1) {
  const notification = selected[index];
  const live = await verifyLiveTarget(notification);
  if (!live.ready) {
    skippedNotLive += 1;
    console.log(`Deferring ${notification.type} ${notification.url}: ${live.reason}.`);
    continue;
  }

  const result = await publishNotification(accessToken, notification);
  if (result.quotaLimited) {
    quotaStopped = true;
    console.warn(`Google Indexing API quota reached after ${published} successful notifications; remaining URLs stay queued for a later run.`);
    break;
  }

  const current = currentById.get(notification.id);
  if (notification.type === 'URL_DELETED') {
    if (!current) {
      delete state.jobs[notification.id];
    } else {
      // Retire the old slug now. Leaving lastChangedAt blank guarantees the
      // replacement URL is still queued if this run ends before URL_UPDATED.
      state.jobs[notification.id] = { url: current.url, lastChangedAt: '', notifiedAt: '' };
    }
  } else {
    state.jobs[notification.id] = {
      url: current.url,
      lastChangedAt: current.changeKey,
      notifiedAt: new Date().toISOString()
    };
  }

  published += 1;
  console.log(`Submitted ${notification.type} ${notification.url}`);
  if (index < selected.length - 1 && minIntervalMs > 0) await sleep(minIntervalMs);
}

if (published > 0) await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
const remainingEstimate = Math.max(0, deduped.length - published);
console.log(`Google JobPosting indexing run complete: ${published} submitted, ${skippedNotLive} deferred until live deployment, approximately ${remainingEstimate} still pending${quotaStopped ? ' (quota-limited)' : ''}.`);
