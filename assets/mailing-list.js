(() => {
  const form = document.getElementById('weeklyAlertForm');
  if (!form) return;

  const submit = form.querySelector('button[type="submit"]');
  const toast = document.getElementById('toast');
  const fallbackAction = form.getAttribute('action') || '';
  const regionSelect = document.getElementById('alertRegion');
  const regionValue = document.getElementById('alertRegionValue');
  const allowedRegions = new Set(['all', 'mid-atlantic', 'texas', 'southwest', 'midwest', 'southeast', 'northeast', 'west']);

  const syncRegionPreference = () => {
    if (!regionValue) return;
    const value = String(regionSelect?.value || 'all').trim();
    regionValue.value = allowedRegions.has(value) ? value : 'all';
  };

  syncRegionPreference();
  regionSelect?.addEventListener('change', syncRegionPreference);

  const showToast = message => {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), 3000);
  };

  const armSubmitState = () => {
    form.addEventListener('submit', () => {
      syncRegionPreference();
      if (submit) {
        submit.disabled = true;
        submit.textContent = 'Opening signup…';
      }
    });
  };

  const configure = config => {
    const username = String(config?.username || '').trim();
    const configured = config?.provider === 'buttondown' && config?.enabled === true && username;

    if (configured) {
      form.action = `https://buttondown.com/api/emails/embed-subscribe/${encodeURIComponent(username)}`;
      form.method = 'post';
      armSubmitState();
      return;
    }

    if (config && config.enabled === false) {
      form.removeAttribute('action');
      form.addEventListener('submit', event => {
        event.preventDefault();
        showToast('Weekly job emails are being connected. Check back soon.');
      });
      return;
    }

    if (fallbackAction) armSubmitState();
  };

  fetch('data/mailing-list.json', { cache: 'no-store' })
    .then(response => response.ok ? response.json() : Promise.reject(new Error('Mailing-list config unavailable')))
    .then(configure)
    .catch(() => {
      // Keep the serverless HTML form action usable if config fetch fails.
      if (fallbackAction) armSubmitState();
    });
})();
