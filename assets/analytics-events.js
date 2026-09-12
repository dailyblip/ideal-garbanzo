(() => {
  const track = (name, params = {}) => {
    const payload = {
      ...params,
      page_path: window.location.pathname
    };
    if (typeof window.gtag === 'function') {
      window.gtag('event', name, payload);
      return;
    }
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push(['event', name, payload]);
  };

  const text = element => String(element?.textContent || '').replace(/\s+/g, ' ').trim();
  const companyFromMeta = meta => text(meta).split(/[•·]/)[0].trim();
  const valueOf = (selector, fallback = '') => String(document.querySelector(selector)?.value || fallback).trim();

  document.addEventListener('submit', event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;

    if (form.id === 'heroSearchForm') {
      const query = form.querySelector('#jobSearch')?.value?.trim() || '';
      const region = form.querySelector('#regionSearch')?.value || '';
      track('job_search', {
        search_source: 'homepage_hero',
        search_term: query || '(blank)',
        region: region || 'anywhere'
      });
      return;
    }

    if (form.id === 'weeklyAlertForm' || form.id === 'jobs-newsletter-form') {
      const jobsPage = form.id === 'jobs-newsletter-form';
      track('newsletter_signup', {
        signup_source: jobsPage ? 'jobs_page_weekly_alert' : 'homepage_weekly_alert',
        provider: 'buttondown',
        region: String(form.elements.metadata__region?.value || 'all'),
        focus: String(form.elements.metadata__focus?.value || 'all')
      });
      return;
    }

    if (form.id === 'employerPlacementForm') {
      const requestedOption = String(event.submitter?.value || 'unknown').trim();
      track('employer_job_submission', {
        requested_option: requestedOption || 'unknown',
        submission_source: 'employer_page'
      });
    }
  }, true);

  document.addEventListener('change', event => {
    const control = event.target;
    if (!(control instanceof HTMLElement)) return;
    const browserControlIds = new Set(['jobs-search', 'jobs-sort', 'jobs-type', 'jobs-experience', 'jobs-region']);
    if (!browserControlIds.has(control.id) || !document.querySelector('[data-jobs-browser]')) return;

    track('job_search', {
      search_source: 'jobs_browser',
      search_term: valueOf('#jobs-search') || '(blank)',
      job_type: valueOf('#jobs-type') || 'all',
      experience: valueOf('#jobs-experience') || 'all',
      region: valueOf('#jobs-region') || 'all',
      sort: valueOf('#jobs-sort') || 'recommended'
    });
  }, true);

  document.addEventListener('click', event => {
    const link = event.target.closest('a');
    if (!link) return;

    const href = link.href || '';
    const sponsorPlacement = link.closest('[data-sponsor-id]');
    if (sponsorPlacement) {
      track('sponsor_click', {
        sponsor_id: sponsorPlacement.dataset.sponsorId || 'unknown',
        placement: sponsorPlacement.dataset.sponsorPlacement || 'unknown',
        sponsor_name: sponsorPlacement.dataset.sponsorName || 'unknown',
        destination_url: href
      });
      return;
    }

    if (link.matches('[data-advertise-action]')) {
      track('advertising_interest_click', {
        action: link.dataset.advertiseAction || text(link) || 'unknown',
        destination_url: href
      });
      return;
    }

    const jobCard = link.closest('.job-card');
    const seoJobCard = link.closest('.seo-job-card');
    if (jobCard || seoJobCard) {
      let destination;
      try { destination = new URL(href, window.location.href); } catch { destination = null; }
      const isInternalJobDetail = destination &&
        destination.origin === window.location.origin &&
        /^\/jobs\/[^/]+\/?$/.test(destination.pathname);
      if (isInternalJobDetail) {
        const container = jobCard || seoJobCard;
        const promotion = jobCard?.classList.contains('spotlight-job') ? 'spotlight' : jobCard?.classList.contains('highlighted-job') ? 'highlighted' : 'standard';
        track('job_detail_click', {
          job_title: text(container?.querySelector('h2, h3')) || 'unknown',
          company: companyFromMeta(container?.querySelector('.job-meta, .seo-meta')) || text(container?.querySelector('.seo-meta strong')) || 'unknown',
          promotion_type: promotion,
          listing_source: jobCard ? 'homepage' : 'jobs_listing'
        });
        return;
      }
    }

    const seoDetail = link.closest('.seo-detail-card');
    const isHomepageApply = Boolean(jobCard && link.target === '_blank' && /apply/i.test(text(link)));
    const isSeoApply = link.classList.contains('seo-apply');

    if (isHomepageApply || isSeoApply) {
      const container = jobCard || seoDetail;
      const jobTitle = text(container?.querySelector('h1, h3 a, h3'));
      const company = companyFromMeta(container?.querySelector('.job-meta')) || text(container?.querySelector('.seo-meta strong'));
      const promotion = jobCard?.classList.contains('spotlight-job') ? 'spotlight' : jobCard?.classList.contains('highlighted-job') ? 'highlighted' : 'standard';
      track('job_apply_click', {
        job_title: jobTitle || 'unknown',
        company: company || 'unknown',
        promotion_type: promotion,
        destination_url: href
      });
      return;
    }

    const employerCard = link.closest('.employer-card');
    const planCard = link.closest('.plan-card');
    const employerCta = link.matches('.employer-cta, #employerCheckoutLink, .plan-button') || Boolean(employerCard && /feature|promotion/i.test(text(link)));
    if (employerCta) {
      const tier = planCard?.classList.contains('spotlight-plan') ? 'spotlight' : planCard?.classList.contains('highlighted-plan') ? 'highlighted' : 'unspecified';
      track('employer_feature_click', {
        placement_tier: tier,
        link_text: text(link),
        destination_url: href
      });
    }
  }, true);
})();
