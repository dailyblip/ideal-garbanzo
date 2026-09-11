(() => {
  const form = document.getElementById('employerPlacementForm');
  if (!form) return;

  const status = document.getElementById('employerInquiryStatus');
  const recipient = String(form.dataset.inquiryEmail || '').trim();
  const tiers = {
    highlightedJob: 'Highlighted Job ($99 / 30 days)',
    spotlightJob: 'Spotlight Position ($149 / 30 days)'
  };

  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const setStatus = message => {
    if (status) status.textContent = message;
  };

  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!form.reportValidity()) return;

    const tierKey = clean(event.submitter?.value);
    const tier = tiers[tierKey];
    if (!tier) {
      setStatus('Choose Highlighted or Spotlight to start the placement request.');
      return;
    }

    const workEmail = clean(form.elements.email?.value);
    const jobUrl = clean(form.elements.metadata__job_url?.value);
    if (!recipient || !workEmail || !jobUrl) return;

    const subject = `Data Center Careers placement request — ${tier.replace(/ \(.+$/, '')}`;
    const body = [
      'Employer placement request',
      '',
      `Work email: ${workEmail}`,
      `Official job URL: ${jobUrl}`,
      `Requested placement: ${tier}`,
      '',
      'Please review this official employer role for mission fit before activation.'
    ].join('\n');

    setStatus('Opening your email app with the placement request. Sending the email does not subscribe you to candidate job alerts.');
    window.location.href = `mailto:${recipient}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  });
})();
