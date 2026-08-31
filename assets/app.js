(() => {
  const state = { jobs: [], filters: new Set(), query: '', sort: 'newest', region: 'all' };
  const jobList = document.getElementById('jobList');
  const emptyState = document.getElementById('emptyState');
  const search = document.getElementById('jobSearch');
  const sort = document.getElementById('sortJobs');
  const clear = document.getElementById('clearFilters');
  const toast = document.getElementById('toast');
  const header = document.querySelector('.site-header');
  const menu = document.querySelector('.menu-button');

  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = 'assets/home-tools.css';
  document.head.appendChild(css);

  const escapeHtml = value => String(value ?? '').replace(/[&<>'\"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','\"':'&quot;'}[ch]));
  const safeUrl = value => /^https:\/\//i.test(String(value || '')) ? String(value) : '#';

  function typeLabel(type) {
    return ({'entry-level':'JOB','internship':'INTERNSHIP','apprenticeship':'APPRENTICE','trainee':'TRAINEE'})[type] || type.toUpperCase();
  }
  function experienceLabel(value) {
    return ({'no-experience':'NO EXPERIENCE','0-2-years':'0–2 YEARS','2-5-years':'2–5 YEARS'})[value] || value;
  }
  function regionFor(location='') {
    const l = location.toLowerCase();
    if (/virginia|maryland|washington, dc|district of columbia|ashburn|manassas/.test(l)) return 'mid-atlantic';
    if (/texas|oklahoma|louisiana|arkansas/.test(l)) return 'texas-south';
    if (/arizona|nevada|new mexico/.test(l)) return 'southwest';
    if (/california|oregon|washington|utah|idaho/.test(l)) return 'west';
    if (/ohio|illinois|indiana|michigan|iowa|wisconsin|minnesota/.test(l)) return 'midwest';
    if (/georgia|florida|north carolina|south carolina|tennessee|alabama|mississippi/.test(l)) return 'southeast';
    if (/new york|new jersey|pennsylvania|massachusetts|connecticut|rhode island|maine|vermont|new hampshire/.test(l)) return 'northeast';
    return 'other';
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), 2800);
  }

  function injectHomeTools() {
    const hero = document.querySelector('.hero');
    if (!hero || document.querySelector('.home-tools')) return;
    const heading = document.createElement('div');
    heading.className = 'top-tools-heading';
    heading.innerHTML = '<h2>Start with what matters to you</h2><span>Jobs, events and updates in your area</span>';
    const tools = document.createElement('section');
    tools.className = 'home-tools';
    tools.innerHTML = `
      <div class="home-tool region-tool">
        <span class="tool-kicker">FIND WORK NEAR YOU</span>
        <h3>Search by region</h3>
        <p>Jump straight to openings in major data center markets.</p>
        <div class="tool-row"><select id="topRegion" aria-label="Choose region">
          <option value="all">All regions</option><option value="mid-atlantic">Northern Virginia / Mid-Atlantic</option><option value="texas-south">Texas / South Central</option><option value="southwest">Arizona / Southwest</option><option value="west">West</option><option value="midwest">Midwest</option><option value="southeast">Southeast</option><option value="northeast">Northeast</option>
        </select><a class="btn btn-gold" href="#jobs" id="regionGo">Show Jobs</a></div>
      </div>
      <div class="home-tool events-tool" id="events">
        <span class="tool-kicker">CAREER EVENTS</span>
        <h3>Job fairs & hiring events</h3>
        <p>Meet employers, recruiters and training programs in person or online.</p>
        <div class="event-preview"><div><strong>Upcoming events</strong><small>Regional events feed is being added next.</small></div><button class="btn btn-outline" type="button" id="eventNotify">See Events</button></div>
      </div>
      <div class="home-tool signup-tool">
        <span class="tool-kicker">STAY IN THE LOOP</span>
        <h3>Get new jobs & events by email</h3>
        <p>Simple updates for new openings, internships, apprenticeships and nearby career events.</p>
        <form class="tool-row" id="emailSignup"><input type="email" id="signupEmail" placeholder="you@email.com" aria-label="Email address" required><button class="btn btn-gold" type="submit">Sign Up</button></form>
      </div>`;
    hero.insertAdjacentElement('afterend', tools);
    tools.insertAdjacentElement('beforebegin', heading);

    const filters = document.querySelector('.filters');
    if (filters && !document.getElementById('sideRegion')) {
      const block = document.createElement('div');
      block.className = 'region-filter-block';
      block.innerHTML = `<label for="sideRegion">Region</label><select id="sideRegion"><option value="all">All regions</option><option value="mid-atlantic">Northern Virginia / Mid-Atlantic</option><option value="texas-south">Texas / South Central</option><option value="southwest">Arizona / Southwest</option><option value="west">West</option><option value="midwest">Midwest</option><option value="southeast">Southeast</option><option value="northeast">Northeast</option></select>`;
      filters.insertBefore(block, filters.children[1] || null);
    }

    const topRegion = document.getElementById('topRegion');
    const sideRegion = document.getElementById('sideRegion');
    const setRegion = value => {
      state.region = value;
      if (topRegion) topRegion.value = value;
      if (sideRegion) sideRegion.value = value;
      render();
    };
    topRegion?.addEventListener('change', () => setRegion(topRegion.value));
    sideRegion?.addEventListener('change', () => setRegion(sideRegion.value));
    document.getElementById('regionGo')?.addEventListener('click', () => setRegion(topRegion?.value || 'all'));
    document.getElementById('eventNotify')?.addEventListener('click', () => showToast('Career-event discovery is next in the live-data pipeline.'));
    document.getElementById('emailSignup')?.addEventListener('submit', event => {
      event.preventDefault();
      showToast('Signup form is ready; email delivery backend is the next step.');
    });
  }

  function render() {
    const q = state.query.toLowerCase();
    let jobs = state.jobs.filter(job => {
      const haystack = [job.title, job.company, job.location, job.experience, ...(job.tags || [])].join(' ').toLowerCase();
      if (q && !haystack.includes(q)) return false;
      if (state.region !== 'all' && regionFor(job.location) !== state.region) return false;
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
            <h3>${escapeHtml(job.title)} <span class="badge badge-blue">${escapeHtml(typeLabel(job.type))}</span></h3>
            <div class="job-meta">${escapeHtml(job.company)} <span>•</span> ${escapeHtml(job.location)}</div>
            <div class="job-tags"><span>${escapeHtml(experienceLabel(job.experience))}</span>${(job.tags || []).map(tag => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
            <div class="job-pay">${escapeHtml(job.pay || 'Pay not listed')}</div>
          </div>
          <div class="posted">${job.postedHours < 9999 ? `${escapeHtml(job.postedHours)}h ago` : 'Recently listed'}<br><small>${job.demo ? 'DEMO' : escapeHtml(job.source || '')}</small></div>
        </div>
        <div class="job-card-actions">${job.demo ? '' : `<a class="btn btn-outline apply-link" href="${escapeHtml(safeUrl(job.sourceUrl))}" target="_blank" rel="noopener noreferrer">View & Apply ›</a>`}</div>
      </article>`).join('');
    emptyState.hidden = jobs.length > 0;
  }

  async function loadJobs() {
    try {
      const response = await fetch('data/jobs.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('Unable to load jobs');
      state.jobs = await response.json();
      render();
    } catch (error) {
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
      if (input) {
        input.checked = true;
        state.filters.add(value);
        render();
      }
    });
  });

  search.addEventListener('input', () => { state.query = search.value.trim(); render(); });
  sort.addEventListener('change', () => { state.sort = sort.value; render(); });
  clear.addEventListener('click', () => {
    state.filters.clear();
    state.query = '';
    state.region = 'all';
    search.value = '';
    document.querySelectorAll('.filters input').forEach(input => input.checked = false);
    const sideRegion = document.getElementById('sideRegion'); if (sideRegion) sideRegion.value = 'all';
    const topRegion = document.getElementById('topRegion'); if (topRegion) topRegion.value = 'all';
    render();
  });

  document.querySelectorAll('.demo-action').forEach(button => button.addEventListener('click', () => showToast('Employer posting and promotion checkout is coming next.')));

  menu?.addEventListener('click', () => {
    const open = header.classList.toggle('menu-open');
    menu.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  injectHomeTools();
  loadJobs();
})();
