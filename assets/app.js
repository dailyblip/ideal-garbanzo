(() => {
  const state = { jobs: [], filters: new Set(), query: '', region: '', sort: 'newest' };
  const jobList = document.getElementById('jobList');
  const emptyState = document.getElementById('emptyState');
  const search = document.getElementById('jobSearch');
  const regionSearch = document.getElementById('regionSearch');
  const sort = document.getElementById('sortJobs');
  const clear = document.getElementById('clearFilters');
  const toast = document.getElementById('toast');
  const header = document.querySelector('.site-header');
  const menu = document.querySelector('.menu-button');
  const alertForm = document.getElementById('alerts');

  const escapeHtml = value => String(value ?? '').replace(/[&<>'\"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','\"':'&quot;'}[ch]));
  const safeUrl = value => /^https:\/\//i.test(String(value || '')) ? String(value) : '#';
  const regionTerms = {
    'mid-atlantic':['virginia','maryland','washington, dc','district of columbia','ashburn','manassas'],
    'texas':['texas','dallas','austin','fort worth','san antonio','houston'],
    'southwest':['arizona','nevada','new mexico','phoenix'],
    'midwest':['ohio','illinois','indiana','michigan','iowa','wisconsin','minnesota','missouri'],
    'southeast':['georgia','florida','north carolina','south carolina','tennessee','alabama','mississippi'],
    'northeast':['new york','new jersey','pennsylvania','massachusetts','connecticut','rhode island','maine','vermont','new hampshire'],
    'west':['california','oregon','washington','utah','idaho','colorado']
  };

  function typeLabel(type) {
    return ({'entry-level':'JOB','internship':'INTERNSHIP','apprenticeship':'APPRENTICE','trainee':'TRAINEE'})[type] || type.toUpperCase();
  }
  function experienceLabel(value) {
    return ({'no-experience':'NO EXPERIENCE','0-2-years':'0–2 YEARS','2-5-years':'2–5 YEARS'})[value] || value;
  }
  function showToast(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), 2600);
  }
  function matchesRegion(location, region) {
    if (!region) return true;
    const value = String(location || '').toLowerCase();
    return (regionTerms[region] || []).some(term => value.includes(term));
  }
  function render() {
    const q = state.query.toLowerCase();
    let jobs = state.jobs.filter(job => {
      const haystack = [job.title, job.company, job.location, job.experience, ...(job.tags || [])].join(' ').toLowerCase();
      if (q && !haystack.includes(q)) return false;
      if (!matchesRegion(job.location, state.region)) return false;
      if (!state.filters.size) return true;
      return [...state.filters].every(filter => job.type === filter || job.experience === filter);
    });

    jobs.sort((a,b) => state.sort === 'salary'
      ? (b.salaryMax || 0) - (a.salaryMax || 0)
      : (a.postedHours || 9999) - (b.postedHours || 9999));

    jobList.innerHTML = jobs.map(job => `
      <article class="job-card">
        <div class="job-card-top">
          <div>
            <h3>${escapeHtml(job.title)} <span class="badge">${escapeHtml(typeLabel(job.type))}</span></h3>
            <div class="job-meta">${escapeHtml(job.company)} <span>•</span> ${escapeHtml(job.location)}</div>
            <div class="job-tags"><span>${escapeHtml(experienceLabel(job.experience))}</span>${(job.tags || []).map(tag => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
            <div class="job-pay">${escapeHtml(job.pay || 'Pay not listed')}</div>
          </div>
          <div class="posted">${job.postedHours < 9999 ? `${escapeHtml(job.postedHours)}h ago` : 'Recently listed'}<br><small>${job.demo ? 'DEMO' : escapeHtml(job.source || '')}</small></div>
        </div>
        <div class="job-card-actions">${job.demo ? '' : `<a class="btn btn-outline apply-link" href="${escapeHtml(safeUrl(job.sourceUrl))}" target="_blank" rel="noopener noreferrer">View & Apply →</a>`}</div>
      </article>`).join('');
    emptyState.hidden = jobs.length > 0;
  }

  async function loadJobs() {
    try {
      const response = await fetch('data/jobs.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('Unable to load jobs');
      state.jobs = await response.json();
      render();
    } catch {
      emptyState.hidden = false;
      emptyState.textContent = 'Job data could not be loaded. Please refresh.';
    }
  }

  document.querySelectorAll('.filters input[type="checkbox"]').forEach(input => {
    input.addEventListener('change', () => {
      input.checked ? state.filters.add(input.value) : state.filters.delete(input.value);
      render();
    });
  });

  document.querySelectorAll('[data-filter-link]').forEach(link => {
    link.addEventListener('click', () => {
      const value = link.dataset.filterLink;
      const input = document.querySelector(`.filters input[value="${value}"]`);
      if (input) { input.checked = true; state.filters.add(value); render(); }
    });
  });

  search?.addEventListener('input', () => { state.query = search.value.trim(); render(); });
  regionSearch?.addEventListener('change', () => { state.region = regionSearch.value; render(); });
  sort?.addEventListener('change', () => { state.sort = sort.value; render(); });
  clear?.addEventListener('click', () => {
    state.filters.clear();
    state.query = '';
    state.region = '';
    if (search) search.value = '';
    if (regionSearch) regionSearch.value = '';
    document.querySelectorAll('.filters input').forEach(input => input.checked = false);
    render();
  });

  alertForm?.addEventListener('submit', event => {
    event.preventDefault();
    showToast('Email alerts are being connected. Your address was not stored yet.');
  });
  document.querySelectorAll('.demo-action').forEach(button => button.addEventListener('click', () => showToast('This feature is being connected now.')));

  menu?.addEventListener('click', () => {
    const open = header.classList.toggle('menu-open');
    menu.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  loadJobs();
})();