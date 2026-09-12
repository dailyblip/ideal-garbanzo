(() => {
  const browser = document.querySelector('[data-apprenticeship-browser]');
  if (!browser) return;

  const cards = [...document.querySelectorAll('[data-apprenticeship-card]')];
  const state = document.getElementById('apprenticeship-state');
  const focus = document.getElementById('apprenticeship-focus');
  const noExperience = document.getElementById('apprenticeship-no-experience');
  const reset = document.getElementById('apprenticeship-reset');
  const summary = document.getElementById('apprenticeship-results-summary');
  const empty = document.getElementById('apprenticeship-empty');

  if (!state || !focus || !noExperience || !reset || !summary || !empty) return;

  const values = element => String(element.dataset.states || element.dataset.focus || '').split(/\s+/).filter(Boolean);

  function applyFilters({ track = true } = {}) {
    const selectedState = state.value;
    const selectedFocus = focus.value;
    const onlyNoExperience = noExperience.checked;
    let visible = 0;

    for (const card of cards) {
      const stateMatch = !selectedState || values({ dataset: { states: card.dataset.states } }).includes(selectedState);
      const focusMatch = !selectedFocus || values({ dataset: { focus: card.dataset.focus } }).includes(selectedFocus);
      const experienceMatch = !onlyNoExperience || card.dataset.experience === 'no-experience';
      const show = stateMatch && focusMatch && experienceMatch;
      card.hidden = !show;
      if (show) visible += 1;
    }

    const filtersActive = Boolean(selectedState || selectedFocus || onlyNoExperience);
    summary.textContent = filtersActive
      ? `Showing ${visible} of ${cards.length} current apprenticeships.`
      : `Showing all ${cards.length} current apprenticeships.`;
    empty.hidden = visible !== 0;

    if (track && typeof window.gtag === 'function') {
      window.gtag('event', 'apprenticeship_filter', {
        state: selectedState || 'all',
        focus: selectedFocus || 'all',
        no_experience_only: onlyNoExperience,
        visible_results: visible
      });
    }
  }

  state.addEventListener('change', () => applyFilters());
  focus.addEventListener('change', () => applyFilters());
  noExperience.addEventListener('change', () => applyFilters());
  reset.addEventListener('click', () => {
    state.value = '';
    focus.value = '';
    noExperience.checked = false;
    applyFilters();
    state.focus();
  });

  applyFilters({ track: false });
})();
