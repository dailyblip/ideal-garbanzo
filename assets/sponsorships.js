(() => {
  const DATA_URL = '/data/sponsorships.json';
  const REGION_PATHS = {
    'northern-virginia-mid-atlantic': 'mid-atlantic',
    texas: 'texas',
    southwest: 'southwest',
    midwest: 'midwest',
    southeast: 'southeast',
    northeast: 'northeast',
    west: 'west'
  };
  const impressionKeys = new Set();

  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const safeUrl = value => /^https:\/\//i.test(clean(value)) ? clean(value) : '';
  const esc = value => clean(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const now = () => Date.now();

  function track(name, campaign, extra = {}) {
    const payload = {
      sponsorship_id: clean(campaign.id),
      sponsor_name: clean(campaign.sponsorName),
      campaign_type: clean(campaign.campaignType),
      placement: detectContext().placement,
      page_path: window.location.pathname,
      ...extra
    };
    if (typeof window.gtag === 'function') window.gtag('event', name, payload);
    else {
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push(['event', name, payload]);
    }
  }

  function detectContext() {
    const path = window.location.pathname.replace(/\/+$/, '') || '/';
    if (path === '/') {
      const selected = document.getElementById('regionSearch')?.value || '';
      return { placement: 'homepage', region: selected || 'all' };
    }
    const regionMatch = path.match(/^\/locations\/([^/]+)/);
    if (regionMatch) return { placement: 'region', region: REGION_PATHS[regionMatch[1]] || 'all' };
    if (/^\/jobs\/[^/]+$/.test(path)) return { placement: 'job-detail', region: 'all' };
    if (/^\/jobs(?:\/page\/\d+)?$/.test(path)) return { placement: 'jobs', region: 'all' };
    if (/^\/apprenticeships(?:\/page\/\d+)?$/.test(path)) return { placement: 'apprenticeships', region: 'all' };
    if (/^\/internships(?:\/page\/\d+)?$/.test(path)) return { placement: 'internships', region: 'all' };
    if (path === '/career-events') return { placement: 'career-events', region: 'all' };
    return { placement: 'other', region: 'all' };
  }

  function isActive(campaign) {
    if (!campaign || campaign.status !== 'active') return false;
    const starts = Date.parse(campaign.startsAt || '');
    const ends = Date.parse(campaign.endsAt || '');
    if (!Number.isFinite(starts) || !Number.isFinite(ends)) return false;
    const time = now();
    return starts <= time && time < ends;
  }

  function matchesContext(campaign, context) {
    const placements = Array.isArray(campaign.placements) ? campaign.placements : [];
    const regions = Array.isArray(campaign.regions) ? campaign.regions : [];
    if (!placements.includes(context.placement) && !placements.includes('sitewide')) return false;
    if (!regions.length || regions.includes('all')) return true;
    return context.region !== 'all' && regions.includes(context.region);
  }

  function chooseCampaign(records, context) {
    return (Array.isArray(records) ? records : [])
      .filter(isActive)
      .filter(campaign => matchesContext(campaign, context))
      .sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0))[0] || null;
  }

  function insertionPoint(context) {
    if (context.placement === 'homepage') return document.querySelector('.alert-strip');
    if (context.placement === 'job-detail') return document.querySelector('.seo-detail-card');
    return document.querySelector('.seo-page-head');
  }

  function disclosureText(campaign) {
    const paidForBy = clean(campaign.paidForBy);
    const disclaimer = clean(campaign.disclaimer);
    if (campaign.campaignType === 'political' || campaign.campaignType === 'issue-advocacy') {
      return [paidForBy ? `Paid for by ${paidForBy}.` : '', disclaimer].filter(Boolean).join(' ');
    }
    return paidForBy ? `Sponsored by ${paidForBy}.` : `Sponsored by ${clean(campaign.sponsorName)}.`;
  }

  function renderCampaign(campaign, context) {
    document.querySelectorAll('.sponsored-message').forEach(node => node.remove());
    if (!campaign) return;

    const href = safeUrl(campaign.destinationUrl);
    if (!href) return;
    const aside = document.createElement('aside');
    aside.className = 'sponsored-message';
    aside.dataset.sponsorshipId = clean(campaign.id);
    aside.setAttribute('aria-label', `Sponsored message from ${clean(campaign.sponsorName)}`);
    aside.innerHTML = `
      <div class="sponsored-message__label">SPONSORED</div>
      <div class="sponsored-message__body">
        <div>
          <h2>${esc(campaign.headline)}</h2>
          <p>${esc(campaign.body)}</p>
          <small>${esc(disclosureText(campaign))}</small>
        </div>
        <a class="sponsored-message__cta" href="${esc(href)}" target="_blank" rel="sponsored noopener noreferrer">${esc(campaign.ctaText || 'Learn more')}</a>
      </div>`;

    const anchor = insertionPoint(context);
    if (!anchor?.parentNode) return;
    anchor.insertAdjacentElement('afterend', aside);

    const impressionKey = `${campaign.id}|${window.location.pathname}|${context.region}`;
    if (!impressionKeys.has(impressionKey)) {
      impressionKeys.add(impressionKey);
      track('sponsorship_impression', campaign, { region: context.region });
    }
    aside.querySelector('a')?.addEventListener('click', () => track('sponsorship_click', campaign, {
      region: context.region,
      destination_url: href
    }), { once: true });
  }

  async function loadAndRender() {
    try {
      const response = await fetch(DATA_URL, { cache: 'no-store' });
      if (!response.ok) return;
      const records = await response.json();
      const context = detectContext();
      renderCampaign(chooseCampaign(records, context), context);
    } catch {}
  }

  document.addEventListener('DOMContentLoaded', () => {
    loadAndRender();
    document.getElementById('regionSearch')?.addEventListener('change', loadAndRender);
  });
})();
