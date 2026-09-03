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
  const companyFromMeta = meta => text(meta).split('•')[0].trim();

  document.addEventListener('submit', event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;

    if (form.id === 'heroSearchForm') {
      const query = form.querySelector('#jobSearch')?.value?.trim() || '';
      const region = form.querySelector('#regionSearch')?.value || '';
      track('job_search', {
        search_term: query || '(blank)',
        region: region || 'anywhere'
      });
      return;
    }

    if (form.id === 'weeklyAlertForm') {
      track('newsletter_signup', {
        signup_source: 'homepage_weekly_alert',
        provider: 'buttondown'
      });
    }
  }, true);

  document.addEventListener('click', event => {
    const link = event.target.closest('a');
    if (!link) return;

    const href = link.href || '';
    const jobCard = link.closest('.job-card');
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
