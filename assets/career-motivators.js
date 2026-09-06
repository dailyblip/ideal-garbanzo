(() => {
  const HOME_LIMIT = 15;
  const INSERT_AFTER = [4, 9, 12];
  const jobList = document.getElementById('jobList');
  if (!jobList) return;

  const search = document.getElementById('jobSearch');
  const region = document.getElementById('regionSearch');
  const sort = document.getElementById('sortJobs');
  const filters = [...document.querySelectorAll('.filters input[type="checkbox"]')];
  let motivators = [];
  let scheduled = false;
  let rendering = false;

  const escapeHtml = value => String(value ?? '').replace(/[&<>'\"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','\"':'&quot;'}[ch]));
  const safeUrl = value => /^https:\/\//i.test(String(value || '')) ? String(value) : '#';

  const defaultDiscoveryView = () => {
    if (String(search?.value || '').trim()) return false;
    if (String(region?.value || '').trim()) return false;
    if (String(sort?.value || 'newest') !== 'newest') return false;
    if (filters.some(input => input.checked)) return false;
    return true;
  };

  const card = record => {
    const title = escapeHtml(record.title);
    return `
      <article class="job-card highlighted-job career-motivator" data-career-motivator="${escapeHtml(record.id)}">
        <div class="job-card-top">
          <div>
            <h3><a href="${escapeHtml(safeUrl(record.sourceUrl))}" target="_blank" rel="noopener noreferrer">${title}</a> <span class="badge">CAREER PATH</span> <span class="featured-badge highlighted-badge">CAREER CEILING</span></h3>
            <div class="job-meta">${escapeHtml(record.company)} <span>•</span> ${escapeHtml(record.location)}</div>
            <div class="job-tags"><span>${escapeHtml(String(record.experience || '').toUpperCase())}</span><span>DATA CENTER / AI INFRASTRUCTURE</span></div>
            <p class="job-meta">${escapeHtml(record.summary)}</p>
            <div class="job-pay"><strong>${escapeHtml(record.pay)}</strong></div>
          </div>
          <div class="posted">Career ceiling<br><small>Employer site</small></div>
        </div>
        <div class="job-card-actions"><a class="apply-link" href="${escapeHtml(safeUrl(record.sourceUrl))}" target="_blank" rel="noopener noreferrer">View role →</a></div>
      </article>`;
  };

  const observer = new MutationObserver(() => schedule());

  function render() {
    scheduled = false;
    if (rendering) return;
    rendering = true;
    observer.disconnect();
    try {
      jobList.querySelectorAll('.career-motivator').forEach(node => node.remove());
      if (!defaultDiscoveryView() || motivators.length < 2) return;

      const ordinary = [...jobList.querySelectorAll('.job-card:not(.career-motivator)')];
      if (ordinary.length < 8) return;

      motivators.slice(0, 3).forEach((record, index) => {
        const anchor = ordinary[Math.min(INSERT_AFTER[index] ?? ordinary.length - 1, ordinary.length - 1)];
        if (!anchor) return;
        const wrapper = document.createElement('div');
        wrapper.innerHTML = card(record).trim();
        const element = wrapper.firstElementChild;
        anchor.insertAdjacentElement('afterend', element);
      });

      const ordinaryAfter = [...jobList.querySelectorAll('.job-card:not(.career-motivator)')];
      while (jobList.querySelectorAll('.job-card').length > HOME_LIMIT && ordinaryAfter.length) {
        ordinaryAfter.pop()?.remove();
      }
    } finally {
      observer.observe(jobList, { childList: true });
      rendering = false;
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(render);
  }

  for (const element of [search, region, sort, ...filters]) {
    element?.addEventListener('input', schedule);
    element?.addEventListener('change', schedule);
  }
  document.getElementById('heroSearchForm')?.addEventListener('submit', schedule);
  document.getElementById('clearFilters')?.addEventListener('click', schedule);
  document.querySelectorAll('[data-quick-filter]').forEach(element => element.addEventListener('click', schedule));

  observer.observe(jobList, { childList: true });
  fetch('data/career-motivators.json', { cache: 'no-store' })
    .then(response => response.ok ? response.json() : Promise.reject(new Error('Career motivators unavailable')))
    .then(records => {
      motivators = Array.isArray(records) ? records.slice(0, 3) : [];
      schedule();
    })
    .catch(() => {});
})();
