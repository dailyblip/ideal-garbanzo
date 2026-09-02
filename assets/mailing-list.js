(() => {
  const form = document.getElementById('weeklyAlertForm');
  if (!form) return;

  const submit = form.querySelector('button[type="submit"]');
  const toast = document.getElementById('toast');

  const showToast = message => {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), 3000);
  };

  const configure = config => {
    const username = String(config?.username || '').trim();
    const ready = config?.provider === 'buttondown' && config?.enabled === true && username;

    if (!ready) {
      form.addEventListener('submit', event => {
        event.preventDefault();
        showToast('Weekly job emails are being connected. Check back soon.');
      });
      return;
    }

    form.action = `https://buttondown.com/api/emails/embed-subscribe/${encodeURIComponent(username)}`;
    form.method = 'post';
    form.addEventListener('submit', () => {
      if (submit) {
        submit.disabled = true;
        submit.textContent = 'Opening signup…';
      }
    });
  };

  fetch('data/mailing-list.json', { cache: 'no-store' })
    .then(response => response.ok ? response.json() : Promise.reject(new Error('Mailing-list config unavailable')))
    .then(configure)
    .catch(() => configure(null));
})();
