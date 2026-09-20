import { readFile } from 'node:fs/promises';

const config = JSON.parse(await readFile('data/mailing-list.json', 'utf8'));
const apiKey = String(process.env.BUTTONDOWN_API_KEY || '').trim();
if (!apiKey) throw new Error('BUTTONDOWN_API_KEY is required.');
if (config?.provider !== 'buttondown' || config?.enabled !== true) throw new Error('Buttondown mailing-list integration must be enabled before provider configuration runs.');

const USERNAME = String(config.username || '').trim();
const REDIRECT_URL = String(config.subscriptionRedirectUrl || '').trim();
const CONFIRMATION_REDIRECT_URL = String(config.subscriptionConfirmationRedirectUrl || '').trim();
if (!USERNAME) throw new Error('Mailing-list username is required.');
if (!REDIRECT_URL || !CONFIRMATION_REDIRECT_URL) throw new Error('Mailing-list redirect URLs are required.');

const headers = {
  Authorization: `Token ${apiKey}`,
  'Content-Type': 'application/json',
  'X-API-Version': '2026-04-01'
};

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...headers,
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!response.ok) {
    throw new Error(`Buttondown ${options.method || 'GET'} ${url} failed (${response.status}): ${text.slice(0, 800)}`);
  }
  return payload;
}

const payload = await apiRequest('https://api.buttondown.com/v1/newsletters');
const newsletters = Array.isArray(payload) ? payload : Array.isArray(payload?.results) ? payload.results : [];
const newsletter = newsletters.find(item => String(item?.username || '').toLowerCase() === USERNAME.toLowerCase());
if (!newsletter?.id) throw new Error(`Buttondown newsletter ${USERNAME} was not found.`);

// Keep the subscriber portal available without removing any other newsletter
// features that may already be enabled in Buttondown. Tags and subscriber
// metadata are intentionally not configured here because this newsletter is
// currently on Buttondown's free plan; both features require Basic or higher.
const enabledFeatures = new Set(Array.isArray(newsletter.enabled_features) ? newsletter.enabled_features : []);
enabledFeatures.add('portal');

const updated = await apiRequest(`https://api.buttondown.com/v1/newsletters/${encodeURIComponent(newsletter.id)}`, {
  method: 'PATCH',
  body: JSON.stringify({
    subscription_redirect_url: REDIRECT_URL,
    subscription_confirmation_redirect_url: CONFIRMATION_REDIRECT_URL,
    enabled_features: [...enabledFeatures]
  })
});

console.log(`Buttondown alert service configured for ${updated?.username || USERNAME}: redirects and subscriber portal are ready for the weekly all-subscriber digest.`);
