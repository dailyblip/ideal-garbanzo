(() => {
  const root = document.querySelector('[data-jobs-browser]');
  if (!root) return;

  const list = document.querySelector('.seo-list[data-job-results]');
  const pagination = document.querySelector('.seo-pagination');
  const search = document.getElementById('jobs-search');
  const sort = document.getElementById('jobs-sort');
  const type = document.getElementById('jobs-type');
  const experience = document.getElementById('jobs-experience');
  const region = document.getElementById('jobs-region');
  const reset = document.getElementById('jobs-reset');
  const summary = document.getElementById('jobs-results-summary');
  const empty = document.getElementById('jobs-results-empty');
  if (!list || !search || !sort || !type || !experience || !region || !reset || !summary || !empty) return;

  function addNewsletterBar() {
    if (document.querySelector('[data-jobs-newsletter]')) return;
    const section = document.createElement('section');
    section.className = 'jobs-browser';
    section.setAttribute('data-jobs-newsletter', '');
    section.setAttribute('aria-labelledby', 'jobs-newsletter-heading');
    section.innerHTML = `
      <div class="jobs-tools-head">
        <div><span class="seo-kicker">WEEKLY JOB ALERTS</span><h2 id="jobs-newsletter-heading">Get new openings every Monday.</h2></div>
      </div>
      <form class="jobs-search-row" id="jobs-newsletter-form" action="https://buttondown.com/api/emails/embed-subscribe/datacentercareers" method="post">
        <label class="jobs-field" for="jobs-newsletter-email"><span>Email address</span><input id="jobs-newsletter-email" name="email" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com" required></label>
        <button class="jobs-reset" type="submit">Join weekly list</button>
        <input type="hidden" id="jobs-newsletter-region" name="metadata__region" value="all">
        <input type="hidden" name="metadata__focus" value="all">
        <input type="hidden" name="embed" value="1">
        <input type="hidden" name="tag" value="weekly-job-alerts">
        <input type="hidden" name="utm_source" value="datacentercareers.us">
        <input type="hidden" name="utm_medium" value="jobs-page">
        <input type="hidden" name="utm_campaign" value="weekly-job-alerts">
      </form>
      <p class="jobs-results-summary">One email a week with new employer-direct data center openings. If you choose a region above, we’ll save that preference with your signup.</p>`;
    root.insertAdjacentElement('afterend', section);

    const form = section.querySelector('#jobs-newsletter-form');
    const regionValue = section.querySelector('#jobs-newsletter-region');
    const submit = form?.querySelector('button[type="submit"]');
    form?.addEventListener('submit', () => {
      if (regionValue) regionValue.value = region.value || 'all';
      if (submit) {
        submit.disabled = true;
        submit.textContent = 'Opening signup…';
      }
    });
  }

  addNewsletterBar();

  const PAGE_SIZE = 25;
  const state = { jobs: [], page: 1 };
  const validSorts = new Set(['recommended','newest','company','location','pay']);
  const validTypes = new Set(['','apprenticeship','internship','trainee','entry-level']);
  const validExperience = new Set(['','no-experience','0-2-years','2-5-years']);
  const validRegions = new Set(['','mid-atlantic','texas','southwest','midwest','southeast','northeast','west']);
  const regionTerms = {
    'mid-atlantic':['district of columbia','delaware','maryland','virginia','west virginia',', dc',', de',', md',', va',', wv','ashburn','manassas'],
    'texas':['texas',', tx','dallas','austin','fort worth','san antonio','houston'],
    'southwest':['arizona','new mexico','nevada','oklahoma',', az',', nm',', nv',', ok','phoenix','mesa'],
    'midwest':['illinois','indiana','iowa','kansas','michigan','minnesota','missouri','nebraska','north dakota','ohio','south dakota','wisconsin',', il',', in',', ia',', ks',', mi',', mn',', mo',', ne',', nd',', oh',', sd',', wi'],
    'southeast':['alabama','arkansas','florida','georgia','kentucky','louisiana','mississippi','north carolina','south carolina','tennessee',', al',', ar',', fl',', ga',', ky',', la',', ms',', nc',', sc',', tn'],
    'northeast':['connecticut','maine','massachusetts','new hampshire','new jersey','new york','pennsylvania','rhode island','vermont',', ct',', me',', ma',', nh',', nj',', ny',', pa',', ri',', vt'],
    'west':['alaska','california','colorado','hawaii','idaho','montana','oregon','utah','washington','wyoming',', ak',', ca',', co',', hi',', id',', mt',', or',', ut',', wa',', wy']
  };

  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const slugify = value => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,70) || 'job';
  const jobSlug = job => `${slugify(job.title)}-${slugify(job.company).slice(0,32)}-${String(job.id || '').replace(/[^a-zA-Z0-9]/g,'').slice(-10)}`;
  const typeLabel = value => ({internship:'Internship',apprenticeship:'Apprenticeship',trainee:'Trainee program','entry-level':'Entry-level job'})[value] || 'Data center job';
  const experienceLabel = value => ({'no-experience':'No experience required','0-2-years':'0–2 years','2-5-years':'2–5 years'})[value] || value;
  const displayPay = value => {
    const pay = String(value ?? '').trim();
    return !pay || /^pay not listed$/i.test(pay) ? '' : pay;
  };
  const earlyRank = job => {
    const t = {apprenticeship:0,internship:1,trainee:2,'entry-level':3}[job.type] ?? 4;
    const e = {'no-experience':0,'0-2-years':1,'2-5-years':4}[job.experience] ?? 2;
    return t * 10 + e;
  };
  const postedHours = job => Number.isFinite(Number(job.postedHours)) ? Number(job.postedHours) : 9999;
  const postedLabel = hours => {
    const value = Number(hours);
    if (!Number.isFinite(value) || value >= 9999) return 'Recently listed';
    if (value < 24) return `${Math.max(1, Math.round(value))}h ago`;
    return `${Math.max(1, Math.round(value / 24))}d ago`;
  };

  function hydrateFromUrl() {
    const params = new URLSearchParams(window.location.search);
    search.value = String(params.get('q') || '').slice(0, 120);
    const requestedSort = params.get('sort') || 'recommended';
    sort.value = validSorts.has(requestedSort) ? requestedSort : 'recommended';
    const requestedType = params.get('type') || '';
    type.value = validTypes.has(requestedType) ? requestedType : '';
    const requestedExperience = params.get('experience') || '';
    experience.value = validExperience.has(requestedExperience) ? requestedExperience : '';
    const requestedRegion = params.get('region') || '';
    region.value = validRegions.has(requestedRegion) ? requestedRegion : '';
    const requestedPage = Number.parseInt(params.get('page') || '1', 10);
    state.page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  }

  function syncUrl() {
    const params = new URLSearchParams();
    const query = search.value.trim();
    if (query) params.set('q', query);
    if (sort.value !== 'recommended') params.set('sort', sort.value);
    if (type.value) params.set('type', type.value);
    if (experience.value) params.set('experience', experience.value);
    if (region.value) params.set('region', region.value);
    if (state.page > 1) params.set('page', String(state.page));
    const queryString = params.toString();
    const nextUrl = `${window.location.pathname}${queryString ? `?${queryString}` : ''}${window.location.hash || ''}`;
    window.history.replaceState(null, '', nextUrl);
  }

  function locationMatchesRegion(location, selectedRegion) {
    const value = String(location || '').toLowerCase().trim();
    if (/^(?:united states|usa|us)$/.test(value)) return true;
    if (value.includes('washington, dc') || value.includes('washington, d.c.')) return selectedRegion === 'mid-atlantic';
    return (regionTerms[selectedRegion] || []).some(term => value.includes(term));
  }

  function matchesRegion(job, selectedRegion) {
    if (!selectedRegion) return true;
    if (job?.region === 'nationwide') return true;
    if (Array.isArray(job?.regions) && job.regions.includes(selectedRegion)) return true;
    if (job?.region === selectedRegion) return true;
    const location = String(job?.location || '');
    if (!job?.region || location.includes(';')) return locationMatchesRegion(location, selectedRegion);
    return false;
  }

  function card(job) {
    const internal = `${window.location.origin}/jobs/${jobSlug(job)}/`;
    const pay = displayPay(job.pay);
    return `<article class="seo-job-card">
      <div class="seo-job-main">
        <span class="seo-kicker">${escapeHtml(typeLabel(job.type))}</span>
        <h2><a href="${internal}">${escapeHtml(job.title)}</a></h2>
        <p class="seo-meta"><strong>${escapeHtml(job.company)}</strong> · ${escapeHtml(job.location)}</p>
        <div class="seo-tags"><span>${escapeHtml(experienceLabel(job.experience))}</span>${(job.tags || []).map(tag => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
        ${pay ? `<p class="seo-pay">${escapeHtml(pay)}</p>` : ''}
      </div>
      <div class="seo-job-side"><span>${escapeHtml(postedLabel(job.postedHours))}</span><a href="${internal}">Job details →</a></div>
    </article>`;
  }

  function filteredJobs() {
    const query = search.value.trim().toLowerCase();
    const selectedType = type.value;
    const selectedExperience = experience.value;
    const selectedRegion = region.value;
    const filtered = state.jobs.filter(job => {
      if (selectedType && job.type !== selectedType) return false;
      if (selectedExperience && job.experience !== selectedExperience) return false;
      if (!matchesRegion(job, selectedRegion)) return false;
      if (query) {
        const haystack = [job.title, job.company, job.location, job.experience, ...(job.tags || [])].join(' ').toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });

    return filtered.sort((a, b) => {
      if (sort.value === 'newest') return postedHours(a) - postedHours(b) || earlyRank(a) - earlyRank(b);
      if (sort.value === 'company') return String(a.company || '').localeCompare(String(b.company || '')) || String(a.title || '').localeCompare(String(b.title || ''));
      if (sort.value === 'location') return String(a.location || '').localeCompare(String(b.location || '')) || String(a.title || '').localeCompare(String(b.title || ''));
      if (sort.value === 'pay') return Number(b.salarySortMax || b.salaryMax || 0) - Number(a.salarySortMax || a.salaryMax || 0) || postedHours(a) - postedHours(b);
      return earlyRank(a) - earlyRank(b) || postedHours(a) - postedHours(b);
    });
  }

  function renderPagination(totalPages) {
    if (!pagination) return;
    if (totalPages <= 1) {
      pagination.hidden = true;
      pagination.innerHTML = '';
      return;
    }
    pagination.hidden = false;
    pagination.innerHTML = `
      ${state.page > 1 ? '<button type="button" data-page="prev">← Previous</button>' : '<span></span>'}
      <span>Page ${state.page} of ${totalPages}</span>
      ${state.page < totalPages ? '<button type="button" data-page="next">Next →</button>' : '<span></span>'}`;
  }

  function render() {
    const jobs = filteredJobs();
    const totalPages = Math.max(1, Math.ceil(jobs.length / PAGE_SIZE));
    state.page = Math.min(state.page, totalPages);
    const start = (state.page - 1) * PAGE_SIZE;
    const shown = jobs.slice(start, start + PAGE_SIZE);
    list.innerHTML = shown.map(card).join('');
    empty.hidden = jobs.length !== 0;
    const startNumber = jobs.length ? start + 1 : 0;
    const endNumber = jobs.length ? start + shown.length : 0;
    summary.textContent = jobs.length
      ? `Showing ${startNumber}–${endNumber} of ${jobs.length} matching opportunities`
      : 'No opportunities match those filters';
    renderPagination(totalPages);
    syncUrl();
  }

  function onFilterChange() {
    state.page = 1;
    render();
  }

  let searchTimer;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(onFilterChange, 120);
  });
  [sort, type, experience, region].forEach(control => control.addEventListener('change', onFilterChange));
  reset.addEventListener('click', () => {
    search.value = '';
    sort.value = 'recommended';
    type.value = '';
    experience.value = '';
    region.value = '';
    state.page = 1;
    render();
    search.focus();
  });
  pagination?.addEventListener('click', event => {
    const button = event.target.closest('button[data-page]');
    if (!button) return;
    state.page += button.dataset.page === 'next' ? 1 : -1;
    render();
    root.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  hydrateFromUrl();
  fetch(`${window.location.origin}/data/jobs.json`, { cache: 'no-store' })
    .then(response => {
      if (!response.ok) throw new Error('Unable to load job data');
      return response.json();
    })
    .then(jobs => {
      state.jobs = Array.isArray(jobs) ? jobs.filter(job => job && job.active !== false && job.demo !== true) : [];
      root.classList.add('is-ready');
      render();
    })
    .catch(() => {
      summary.textContent = 'Search tools are temporarily unavailable. Browse the current listings below.';
      root.classList.add('has-error');
    });
})();
