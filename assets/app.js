(() => {
  const HOME_LIMIT = 15;
  const state = { jobs: [], featuredIds: new Set(), product: null, filters: new Set(), query: '', region: '', sort: 'newest' };
  const jobList = document.getElementById('jobList');
  const emptyState = document.getElementById('emptyState');
  const search = document.getElementById('jobSearch');
  const regionSearch = document.getElementById('regionSearch');
  const sort = document.getElementById('sortJobs');
  const clear = document.getElementById('clearFilters');
  const toast = document.getElementById('toast');
  const resultCount = document.getElementById('resultCount');
  const shownCount = document.getElementById('shownCount');
  const activeFilters = document.getElementById('activeFilters');
  const filtersPanel = document.getElementById('filtersPanel');
  const filterToggle = document.getElementById('filterToggle');
  const filterClose = document.getElementById('mobileFilterClose');
  const header = document.querySelector('.site-header');
  const menu = document.querySelector('.menu-button');
  const alertForm = document.getElementById('alertForm');
  const heroSearchForm = document.getElementById('heroSearchForm');
  const featuredJobPrice = document.getElementById('featuredJobPrice');
  const employerCheckoutLink = document.getElementById('employerCheckoutLink');
  const employerCheckoutStatus = document.getElementById('employerCheckoutStatus');
  const eventsList = document.getElementById('eventsList');

  const escapeHtml = value => String(value ?? '').replace(/[&<>'\"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','\"':'&quot;'}[ch]));
  const safeUrl = value => /^https:\/\//i.test(String(value || '')) ? String(value) : '#';
  const slugify = value => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,70) || 'job';
  const jobSlug = job => `${slugify(job.title)}-${slugify(job.company).slice(0,32)}-${String(job.id || '').replace(/[^a-zA-Z0-9]/g,'').slice(-10)}`;
  const typeFilters = new Set(['internship','apprenticeship','trainee','entry-level']);
  const experienceFilters = new Set(['no-experience','0-2-years','2-5-years']);
  const regionTerms = {
    'mid-atlantic':['district of columbia','delaware','maryland','virginia','west virginia',', dc',', de',', md',', va',', wv','ashburn','manassas'],
    'texas':['texas',', tx','dallas','austin','fort worth','san antonio','houston'],
    'southwest':['arizona','new mexico','nevada','oklahoma',', az',', nm',', nv',', ok','phoenix','mesa'],
    'midwest':['illinois','indiana','iowa','kansas','michigan','minnesota','missouri','nebraska','north dakota','ohio','south dakota','wisconsin',', il',', in',', ia',', ks',', mi',', mn',', mo',', ne',', nd',', oh',', sd',', wi'],
    'southeast':['alabama','arkansas','florida','georgia','kentucky','louisiana','mississippi','north carolina','south carolina','tennessee',', al',', ar',', fl',', ga',', ky',', la',', ms',', nc',', sc',', tn'],
    'northeast':['connecticut','maine','massachusetts','new hampshire','new jersey','new york','pennsylvania','rhode island','vermont',', ct',', me',', ma',', nh',', nj',', ny',', pa',', ri',', vt'],
    'west':['alaska','california','colorado','hawaii','idaho','montana','oregon','utah','washington','wyoming',', ak',', ca',', co',', hi',', id',', mt',', or',', ut',', wa',', wy']
  };
  const filterLabels = {
    internship:'Internships', apprenticeship:'Apprenticeships', trainee:'Trainee programs', 'entry-level':'Jobs',
    'no-experience':'No experience', '0-2-years':'0–2 years', '2-5-years':'2–5 years'
  };

  const typeLabel = type => ({'entry-level':'JOB','internship':'INTERNSHIP','apprenticeship':'APPRENTICE','trainee':'TRAINEE'})[type] || String(type || '').toUpperCase();
  const experienceLabel = value => ({'no-experience':'NO EXPERIENCE','0-2-years':'0–2 YEARS','2-5-years':'2–5 YEARS'})[value] || value;
  const earlyCareerRank = job => {
    const typeRank = {apprenticeship:0, internship:1, trainee:2, 'entry-level':3}[job.type] ?? 4;
    const experienceRank = {'no-experience':0, '0-2-years':1, '2-5-years':4}[job.experience] ?? 2;
    return typeRank * 10 + experienceRank;
  };
  const isFeatured = job => state.featuredIds.has(String(job.id));
  const showToast = message => {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), 2600);
  };
  const matchesRegion = (job, region) => {
    if (!region) return true;
    if (job?.region) return job.region === region;
    const value = String(job?.location || '').toLowerCase();
    if (value.includes('washington, dc') || value.includes('washington, d.c.')) return region === 'mid-atlantic';
    return (regionTerms[region] || []).some(term => value.includes(term));
  };
  const postedLabel = hours => {
    if (hours >= 9999) return 'Recently listed';
    if (hours < 24) return `${hours}h ago`;
    return `${Math.max(1, Math.round(hours / 24))}d ago`;
  };
  const localIsoDate = date => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };
  const eventDateLabel = value => {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return '';
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
    return new Intl.DateTimeFormat('en-US', { month:'short', day:'numeric', timeZone:'UTC' }).format(date).toUpperCase();
  };

  function activeFeaturedIds(records) {
    const now = Date.now();
    return new Set((Array.isArray(records) ? records : []).filter(record => {
      if (!record || !record.jobId) return false;
      const starts = record.startsAt ? Date.parse(record.startsAt) : null;
      const expires = record.expiresAt ? Date.parse(record.expiresAt) : null;
      if (starts && Number.isFinite(starts) && starts > now) return false;
      if (expires && Number.isFinite(expires) && expires <= now) return false;
      return true;
    }).map(record => String(record.jobId)));
  }

  function activeCareerEvents(records) {
    const today = localIsoDate(new Date());
    return (Array.isArray(records) ? records : []).filter(event => {
      if (!event || !/^\d{4}-\d{2}-\d{2}$/.test(String(event.date || ''))) return false;
      if (!/^https:\/\//i.test(String(event.url || ''))) return false;
      return event.date >= today && event.name && event.location && event.organizer;
    }).sort((a,b) => String(a.date).localeCompare(String(b.date)));
  }

  function renderCareerEvents(records) {
    if (!eventsList) return;
    const events = activeCareerEvents(records).slice(0, 3);
    eventsList.setAttribute('aria-busy', 'false');
    eventsList.innerHTML = events.length ? events.map(event => `
      <a class="event-row" href="${escapeHtml(safeUrl(event.url))}" target="_blank" rel="noopener noreferrer">
        <b>${escapeHtml(eventDateLabel(event.date))}</b>
        <div><strong>${escapeHtml(event.name)}</strong><span>${escapeHtml(event.location)} · ${escapeHtml(event.organizer)}</span></div>
      </a>`).join('') : '<p>No verified upcoming events are currently listed. Check back soon.</p>';
  }

  function configureEmployerProduct(product) {
    state.product = product || null;
    if (featuredJobPrice && Number.isFinite(Number(product?.priceUsd))) featuredJobPrice.textContent = `$${Number(product.priceUsd)}`;
    const enabled = product?.checkoutEnabled === true && /^https:\/\//i.test(String(product?.checkoutUrl || ''));
    if (employerCheckoutLink) {
      employerCheckoutLink.hidden = !enabled;
      if (enabled) {
        employerCheckoutLink.href = product.checkoutUrl;
        employerCheckoutLink.target = '_blank';
        employerCheckoutLink.rel = 'noopener noreferrer';
      }
    }
    if (employerCheckoutStatus) {
      employerCheckoutStatus.hidden = enabled;
      if (!enabled) employerCheckoutStatus.textContent = 'Employer checkout is being finalized.';
    }
  }

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
      if (!matchesRegion(job, state.region)) return false;
      if (selectedTypes.length && !selectedTypes.includes(job.type)) return false;
      if (selectedExperience.length && !selectedExperience.includes(job.experience)) return false;
      return true;
    });
  }

  function render() {
    const jobs = filteredJobs().sort((a,b) => {
      const featuredRank = Number(isFeatured(b)) - Number(isFeatured(a));
      if (featuredRank) return featuredRank;
      if (state.sort === 'salary') return (b.salarySortMax ?? b.salaryMax ?? 0) - (a.salarySortMax ?? a.salaryMax ?? 0);
      return earlyCareerRank(a) - earlyCareerRank(b) || (a.postedHours || 9999) - (b.postedHours || 9999);
    });
    const activeDiscovery = Boolean(state.query || state.region || state.filters.size || state.sort === 'salary');
    const visibleJobs = activeDiscovery ? jobs : jobs.slice(0, HOME_LIMIT);

    if (resultCount) resultCount.textContent = jobs.length;
    if (shownCount) shownCount.textContent = visibleJobs.length;
    updateActiveFilters();
    jobList.innerHTML = visibleJobs.map(job => {
      const featured = isFeatured(job);
      return `
      <article class="job-card${featured ? ' featured-job' : ''}">
        <div class="job-card-top">
          <div>
            <h3><a href="jobs/${escapeHtml(jobSlug(job))}/">${escapeHtml(job.title)}</a> <span class="badge">${escapeHtml(typeLabel(job.type))}</span>${featured ? ' <span class="featured-badge">FEATURED</span>' : ''}</h3>
            <div class="job-meta">${escapeHtml(job.company)} <span>•</span> ${escapeHtml(job.location)}</div>
            <div class="job-tags"><span>${escapeHtml(experienceLabel(job.experience))}</span>${(job.tags || []).filter(tag => tag !== experienceLabel(job.experience)).map(tag => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
            <div class="job-pay">${escapeHtml(job.pay || 'Pay not listed')}</div>
          </div>
          <div class="posted">${escapeHtml(postedLabel(job.postedHours))}<br><small>Employer site</small></div>
        </div>
        <div class="job-card-actions"><a class="apply-link" href="jobs/${escapeHtml(jobSlug(job))}/">Job details →</a><a class="apply-link" href="${escapeHtml(safeUrl(job.sourceUrl))}" target="_blank" rel="noopener noreferrer">View & Apply →</a></div>
      </article>`;
    }).join('');
    emptyState.hidden = jobs.length > 0;
  }

  async function loadSiteData() {
    try {
      const [jobsResponse, featuredResponse, productsResponse, eventsResponse] = await Promise.all([
        fetch('data/jobs.json', { cache: 'no-store' }),
        fetch('data/featured-jobs.json', { cache: 'no-store' }),
        fetch('data/employer-products.json', { cache: 'no-store' }),
        fetch('data/career-events.json', { cache: 'no-store' })
      ]);
      if (!jobsResponse.ok) throw new Error('Unable to load jobs');
      state.jobs = await jobsResponse.json();
      if (featuredResponse.ok) state.featuredIds = activeFeaturedIds(await featuredResponse.json());
      if (productsResponse.ok) {
        const products = await productsResponse.json();
        configureEmployerProduct(products.featuredJob);
      }
      if (eventsResponse.ok) renderCareerEvents(await eventsResponse.json());
      else renderCareerEvents([]);
      render();
    } catch {
      renderCareerEvents([]);
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
    state.filters.clear(); state.query = ''; state.region = ''; state.sort = 'newest';
    if (search) search.value = '';
    if (regionSearch) regionSearch.value = '';
    if (sort) sort.value = 'newest';
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

  filterToggle?.addEventListener('click', () => filtersPanel?.classList.add('open'));
  filterClose?.addEventListener('click', () => filtersPanel?.classList.remove('open'));
  menu?.addEventListener('click', () => {
    const open = header.classList.toggle('menu-open');
    menu.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  loadSiteData();
})();