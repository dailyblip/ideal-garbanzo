const apiKey = String(process.env.BUTTONDOWN_API_KEY || '').trim();
if (!apiKey) throw new Error('BUTTONDOWN_API_KEY is required.');

const USERNAME = 'datacentercareers';
const REDIRECT_URL = 'https://datacentercareers.us/subscribed/';
const headers = {
  Authorization: `Token ${apiKey}`,
  'Content-Type': 'application/json',
  'X-API-Version': '2026-04-01'
};

const listResponse = await fetch('https://api.buttondown.com/v1/newsletters', { headers });
if (!listResponse.ok) throw new Error(`Buttondown newsletter lookup failed (${listResponse.status}): ${await listResponse.text()}`);
const payload = await listResponse.json();
const newsletters = Array.isArray(payload) ? payload : Array.isArray(payload?.results) ? payload.results : [];
const newsletter = newsletters.find(item => String(item?.username || '').toLowerCase() === USERNAME);
if (!newsletter?.id) throw new Error(`Buttondown newsletter ${USERNAME} was not found.`);

const updateResponse = await fetch(`https://api.buttondown.com/v1/newsletters/${encodeURIComponent(newsletter.id)}`, {
  method: 'PATCH',
  headers,
  body: JSON.stringify({
    subscription_redirect_url: REDIRECT_URL,
    subscription_confirmation_redirect_url: `${REDIRECT_URL}?confirmed=1`
  })
});
if (!updateResponse.ok) throw new Error(`Buttondown redirect update failed (${updateResponse.status}): ${await updateResponse.text()}`);

const updated = await updateResponse.json();
console.log(`Buttondown signup redirects configured for ${updated?.username || USERNAME}.`);
