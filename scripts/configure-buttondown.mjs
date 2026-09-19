const apiKey = String(process.env.BUTTONDOWN_API_KEY || '').trim();
if (!apiKey) throw new Error('BUTTONDOWN_API_KEY is required.');

const USERNAME = 'datacentercareers';
const REDIRECT_URL = 'https://datacentercareers.us/subscribed/';
const ALERT_TAG = 'weekly-job-alerts';
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
const newsletter = newsletters.find(item => String(item?.username || '').toLowerCase() === USERNAME);
if (!newsletter?.id) throw new Error(`Buttondown newsletter ${USERNAME} was not found.`);

// Keep the subscriber portal available without removing any other newsletter
// features that may already be enabled in Buttondown.
const enabledFeatures = new Set(Array.isArray(newsletter.enabled_features) ? newsletter.enabled_features : []);
enabledFeatures.add('portal');

const updated = await apiRequest(`https://api.buttondown.com/v1/newsletters/${encodeURIComponent(newsletter.id)}`, {
  method: 'PATCH',
  body: JSON.stringify({
    subscription_redirect_url: REDIRECT_URL,
    subscription_confirmation_redirect_url: `${REDIRECT_URL}?confirmed=1`,
    enabled_features: [...enabledFeatures]
  })
});

// The weekly sender fails closed when this audience tag is missing. Upsert it
// during configuration so the alert pipeline is ready before the first signup
// or Monday scheduler run instead of depending on a subscriber to create it.
const alertTag = await apiRequest('https://api.buttondown.com/v1/tags', {
  method: 'POST',
  headers: { 'X-Buttondown-Collision-Behavior': 'overwrite' },
  body: JSON.stringify({
    name: ALERT_TAG,
    color: '#A64636',
    description: 'Subscribers to the Data Center Careers weekly job alert.',
    subscriber_editable: false
  })
});
if (!alertTag?.id || String(alertTag?.name || '') !== ALERT_TAG) {
  throw new Error(`Buttondown did not confirm the ${ALERT_TAG} audience tag.`);
}

console.log(`Buttondown alert service configured for ${updated?.username || USERNAME}: redirects, subscriber portal and ${ALERT_TAG} audience tag are ready.`);
