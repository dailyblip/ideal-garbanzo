const monthNames = [
  ['January', 'Jan'], ['February', 'Feb'], ['March', 'Mar'], ['April', 'Apr'],
  ['May', 'May'], ['June', 'Jun'], ['July', 'Jul'], ['August', 'Aug'],
  ['September', 'Sep'], ['October', 'Oct'], ['November', 'Nov'], ['December', 'Dec']
];

const stopWords = new Set([
  'and','the','with','from','into','your','for','this','that','our','their','plus','2026','2027'
]);

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const normalize = value => clean(value)
  .toLowerCase()
  .replace(/&amp;/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

export function isValidIsoDate(value) {
  const candidate = clean(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return false;
  const parsed = new Date(`${candidate}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate;
}

export function pageTextFromBody(body) {
  return clean(String(body ?? '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'"));
}

export function eventDateVariants(date) {
  const candidate = clean(date);
  if (!isValidIsoDate(candidate)) return [];
  const match = candidate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const [, year, monthRaw, dayRaw] = match;
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const [longMonth, shortMonth] = monthNames[month - 1];
  return [
    `${year}-${monthRaw}-${dayRaw}`,
    `${monthRaw}/${dayRaw}/${year}`,
    `${month}/${day}/${year}`,
    `${longMonth} ${day}, ${year}`,
    `${longMonth} ${day} ${year}`,
    `${shortMonth} ${day}, ${year}`,
    `${shortMonth} ${day} ${year}`,
    `${day} ${longMonth} ${year}`,
    `${day} ${shortMonth} ${year}`
  ];
}

function eventStatusConflict(event, text) {
  const normalizedText = normalize(text);
  if (!normalizedText) return { conflicted: false, evidence: [] };

  const anchors = [normalize(event?.name), ...eventDateVariants(event?.date).map(normalize)]
    .filter(anchor => anchor.length >= 5);
  const statusPatterns = [
    /\b(?:this\s+)?(?:event|session|career\s+day|workshop|training|info(?:rmation)?\s+session)\s+(?:is|has\s+been|was|will\s+be)\s+(?:cancelled|canceled|postponed|rescheduled)\b/,
    /\bstatus\s+(?:is\s+)?(?:cancelled|canceled|postponed|rescheduled)\b/,
    /\b(?:cancelled|canceled|postponed|rescheduled)\s+(?:event|session|career\s+day|workshop|training|info(?:rmation)?\s+session)\b/
  ];
  const evidence = [];

  for (const anchor of anchors) {
    let index = normalizedText.indexOf(anchor);
    while (index !== -1) {
      const start = Math.max(0, index - 220);
      const end = Math.min(normalizedText.length, index + anchor.length + 220);
      const context = normalizedText.slice(start, end);
      const pattern = statusPatterns.find(candidate => candidate.test(context));
      if (pattern) evidence.push(context.slice(0, 440));
      index = normalizedText.indexOf(anchor, index + Math.max(anchor.length, 1));
    }
  }

  return { conflicted: evidence.length > 0, evidence: [...new Set(evidence)].slice(0, 3) };
}

export function verifyEventContent(event, body) {
  const text = pageTextFromBody(body);
  const normalizedText = normalize(text);
  const normalizedName = normalize(event?.name);
  const dateVariants = eventDateVariants(event?.date);
  const dateMatched = dateVariants.some(variant => normalizedText.includes(normalize(variant)));

  const nameTokens = [...new Set(normalizedName.split(' ')
    .filter(token => token.length >= 4 && !stopWords.has(token)))];
  const matchedNameTokens = nameTokens.filter(token => normalizedText.includes(token));
  const exactNameMatched = normalizedName.length >= 12 && normalizedText.includes(normalizedName);
  const nameMatched = exactNameMatched || matchedNameTokens.length >= Math.min(2, Math.max(1, nameTokens.length));
  const status = eventStatusConflict(event, text);
  const matched = Boolean(dateMatched && nameMatched && !status.conflicted);

  return {
    matched,
    dateMatched,
    nameMatched,
    exactNameMatched,
    matchedNameTokens: matchedNameTokens.slice(0, 8),
    statusConflict: status.conflicted,
    statusEvidence: status.evidence,
    reason: status.conflicted
      ? 'event-cancelled-postponed-or-rescheduled'
      : dateMatched && nameMatched
        ? 'event-date-and-name-present'
        : !dateMatched
          ? 'event-date-not-found'
          : 'event-name-not-found'
  };
}
