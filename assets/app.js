(() => {
  const state = { jobs: [], filters: new Set(), query: '', sort: 'newest' };
  const jobList = document.getElementById('jobList');
  const emptyState = document.getElementById('emptyState');
  const search = document.getElementById('jobSearch');
  const sort = document.getElementById('sortJobs');
  const clear = document.getElementById('clearFilters');
  const toast = document.getElementById('toast');
  const header = document.querySelector('.site-header');
  const menu = document.querySelector('.menu-button');

  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));

  function typeLabel(type) {
    return ({'entry-level':'ENTRY LEVEL','internship':'INTERNSHIP','apprenticeship':'APPRENTICE','trainee':'TRAINEE'})[type] || type.toUpperCase();
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), 2600);
  }

  function render() {
    const q = state.query.toLowerCase();
    let jobs = state.jobs.filter(job => {
      const haystack = [job.title, job.company, job.location, ...(job.tags || [])].join(' ').toLowerCase();
      if (q && !haystack.includes(q)) return false;
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
            <div class="job-tags">${(job.tags || []).map(tag => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
            <div class="job-pay">${escapeHtml(job.pay || 'Pay not listed')}</div>
          </div>
          <div class="posted">${escapeHtml(job.postedHours)}h ago<br><small>${job.demo ? 'DEMO' : ''}</small></div>
        </div>
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
    search.value = '';
    document.querySelectorAll('.filters input').forEach(input => input.checked = false);
    render();
  });

  document.querySelectorAll('.demo-action').forEach(button => button.addEventListener('click', () => showToast('Demo control. Employer and application flows come in Phase 4.')));

  menu?.addEventListener('click', () => {
    const open = header.classList.toggle('menu-open');
    menu.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  loadJobs();
})();
