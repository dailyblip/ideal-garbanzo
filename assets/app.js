(() => {
  const state = { jobs: [], filters: new Set(), query: '', region: '', sort: 'newest' };
  const jobList = document.getElementById('jobList');
  const emptyState = document.getElementById('emptyState');
  const search = document.getElementById('jobSearch');
  const regionSearch = document.getElementById('regionSearch');
  const sort = document.getElementById('sortJobs');
  const clear = document.getElementById('clearFilters');
  const toast = document.getElementById('toast');
  const resultCount = document.getElementById('resultCount');
  const activeFilters = document.getElementById('activeFilters');
  const filtersPanel = document.getElementById('filtersPanel');
  const filterToggle = document.getElementById('filterToggle');
  const filterClose = document.getElementById('mobileFilterClose');
  const header = document.querySelector('.site-header');
  const menu = document.querySelector('.menu-button');
  const alertForm = document.getElementById('alertForm');
  const heroSearchForm = document.getElementById('heroSearchForm');

  const escapeHtml = value => String(value ?? '').replace(/[&<>'\"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','\"':'&quot;'}[ch]));
  const safeUrl = value => /^https:\/\//i.test(String(value || '')) ? String(value) : '#';
  const typeFilters = new Set(['internship','apprenticeship','trainee','entry-level']);
  const experienceFilters = new Set(['no-experience','0-2-years','2-5-years']);
  const regionTerms = {
    'mid-atlantic':['virginia','maryland','washington, dc','district of columbia','ashburn','manassas'],
    'texas':['texas','dallas','austin','fort worth','san antonio','houston'],
    'southwest':['arizona','nevada','new mexico','phoenix'],
    'midwest':['ohio','illinois','indiana','michigan','iowa','wisconsin','minnesota','missouri'],
    'southeast':['georgia','florida','north carolina','south carolina','tennessee','alabama','mississippi'],
    'northeast':['new york','new jersey','pennsylvania','massachusetts','connecticut','rhode island','maine','vermont','new hampshire'],
    'west':['california','oregon','washington','utah','idaho','colorado']
  };
  const filterLabels = {
    internship:'Internships', apprenticeship:'Apprenticeships', trainee:'Trainee programs', 'entry-level':'Jobs',
    'no-experience':'No experience', '0-2-years':'0–2 years', '2-5-years':'2–5 years'
  };

  const typeLabel = type => ({'entry-level':'JOB','internship':'INTERNSHIP','apprenticeship':'APPRENTICE','trainee':'TRAINEE'})[type] || String(type || '').toUpperCase();
  const experienceLabel = value => ({'no-experience':'NO EXPERIENCE','0-2-years':'0–2 YEARS','2-5-years':'2–5 YEARS'})[value] || value;
  const showToast = message => {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), 2600);
  };
  const matchesRegion = (location, region) => {
    if (!region) return true;
    const value = String(location || '').toLowerCase();
    return (regionTerms[region] || []).some(term => value.includes(term));
  };
  const postedLabel = hours => {
    if (hours >= 9999) return 'Recently listed';
    if (hours < 24) return `${hours}h ago`;
    return `${Math.max(1, Math.round(hours / 24))}d ago`;
  };

  function updateActiveFilters() {
    const chips = [];
    if (state.query) chips.push({key:'query', label:`“${state.query}”`});
    if (state.region) chips.push({key:'region', label: regionSearch?.selectedOptions?.[0]?.textContent || 'Region'});
    for (const value of state.filters) chips.push({key:value, label:filterLabels[value] || value});
    if (!activeFilters) return;
    activeFilters.hidden = chips.length === 0;
    activeFilters.innerHTML = chips.map(chip => `<button type="button" data-remove-filter="${escapeHtml(chip.key)}">${escapeHtml(chip.label)} ×</button>`).join('');
  }

  function filteredJobs() {
    const q = state.query.toLowerCase();
    const selectedTypes = [...state.filters].filter(filter => typeFilters.has(filter));
    const selectedExperience = [...state.filters].filter(filter => experienceFilters.has(filter));
    return state.jobs.filter(job => {
      const haystack = [job.title, job.company, job.location, job.experience, ...(job.tags || [])].join(' ').toLowerCase();
      if (q && !haystack.includes(q)) return false;
      if (!matchesRegion(job.location, state.region)) return false;
      if (selectedTypes.length && !selectedTypes.includes(job.type)) return false;
      if (selectedExperience.length && !selectedExperience.includes(job.experience)) return false;
      return true;
    });
  }

  function render() {
    const jobs = filteredJobs().sort((a,b) => state.sort === 'salary'
      ? (b.salarySortMax ?? b.salaryMax ?? 0) - (a.salarySortMax ?? a.salaryMax ?? 0)
      : (a.postedHours || 9999) - (b.postedHours || 9999));

    if (resultCount) resultCount.textContent = jobs.length;
    updateActiveFilters();
    jobList.innerHTML = jobs.map(job => `
      <article class="job-card">
        <div class="job-card-top">
          <div>
            <h3>${escapeHtml(job.title)} <span class="badge">${escapeHtml(typeLabel(job.type))}</span></h3>
            <div class="job-meta">${escapeHtml(job.company)} <span>•</span> ${escapeHtml(job.location)}</div>
            <div class="job-tags"><span>${escapeHtml(experienceLabel(job.experience))}</span>${(job.tags || []).filter(tag => tag !== experienceLabel(job.experience)).map(tag => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
            <div class="job-pay">${escapeHtml(job.pay || 'Pay not listed')}</div>
          </div>
          <div class="posted">${escapeHtml(postedLabel(job.postedHours))}<br><small>${job.demo ? 'DEMO' : 'Employer site'}</small></div>
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

  document.querySelectorAll('[data-quick-filter]').forEach(button => {
    button.addEventListener('click', () => {
      const value = button.dataset.quickFilter;
      const input = document.querySelector(`.filters input[value="${value}"]`);
      if (input) input.checked = true;
      state.filters.add(value);
      render();
      document.getElementById('jobs')?.scrollIntoView({behavior:'smooth'});
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
  heroSearchForm?.addEventListener('submit', event => {
    event.preventDefault();
    state.query = search?.value.trim() || '';
    state.region = regionSearch?.value || '';
    render();
    document.getElementById('jobs')?.scrollIntoView({behavior:'smooth'});
  });

  clear?.addEventListener('click', () => {
    state.filters.clear(); state.query = ''; state.region = '';
    if (search) search.value = '';
    if (regionSearch) regionSearch.value = '';
    document.querySelectorAll('.filters input').forEach(input => input.checked = false);
    render();
  });

  activeFilters?.addEventListener('click', event => {
    const button = event.target.closest('[data-remove-filter]');
    if (!button) return;
    const key = button.dataset.removeFilter;
    if (key === 'query') { state.query=''; if(search) search.value=''; }
    else if (key === 'region') { state.region=''; if(regionSearch) regionSearch.value=''; }
    else { state.filters.delete(key); const input=document.querySelector(`.filters input[value="${key}"]`); if(input) input.checked=false; }
    render();
  });

  alertForm?.addEventListener('submit', event => {
    event.preventDefault();
    showToast('Job alerts are being connected. Your address was not stored yet.');
  });
  document.querySelectorAll('.demo-action').forEach(button => button.addEventListener('click', () => showToast('This feature is being connected now.')));

  filterToggle?.addEventListener('click', () => filtersPanel?.classList.add('open'));
  filterClose?.addEventListener('click', () => filtersPanel?.classList.remove('open'));
  menu?.addEventListener('click', () => {
    const open = header.classList.toggle('menu-open');
    menu.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  loadJobs();
})();