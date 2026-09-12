(() => {
  const form = document.getElementById('employerPlacementForm');
  if (!form) return;

  const status = document.getElementById('employerInquiryStatus');
  const recipient = String(form.dataset.inquiryEmail || '').trim();
  const options = {
    standardJob: 'Standard Listing ($0 / regular placement)',
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

    const optionKey = clean(event.submitter?.value);
    const option = options[optionKey];
    if (!option) {
      setStatus('Choose Standard, Highlighted or Spotlight to start the job submission.');
      return;
    }

    const workEmail = clean(form.elements.email?.value);
    const jobUrl = clean(form.elements.metadata__job_url?.value);
    if (!recipient || !workEmail || !jobUrl) return;

    const optionName = option.replace(/ \(.+$/, '');
    const isStandard = optionKey === 'standardJob';
    const subject = `Data Center Careers ${isStandard ? 'job submission' : 'placement request'} — ${optionName}`;
    const body = [
      'Employer job submission',
      '',
      `Work email: ${workEmail}`,
      `Official job URL: ${jobUrl}`,
      `Requested option: ${option}`,
      '',
      'Please review this official employer role for mission fit before publication or promotion.'
    ].join('\n');

    setStatus(isStandard
      ? 'Opening your email app with the standard listing submission. Standard review is free and does not automatically publish the job or subscribe you to candidate alerts.'
      : 'Opening your email app with the placement request. Paid promotion is optional and sending the email does not subscribe you to candidate job alerts.');
    window.location.href = `mailto:${recipient}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  });
})();
