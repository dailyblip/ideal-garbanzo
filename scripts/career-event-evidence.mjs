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
  const match = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return [];
  const [, year, monthRaw, dayRaw] = match;
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1 || day > 31) return [];
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

export function verifyEventContent(event, body) {
  const text = pageTextFromBody(body);
  const normalizedText = normalize(text);
  const normalizedName = normalize(event?.name);
  const dateVariants = eventDateVariants(event?.date);
  const dateMatched = dateVariants.some(variant => normalize(text).includes(normalize(variant)));

  const nameTokens = [...new Set(normalizedName.split(' ')
    .filter(token => token.length >= 4 && !stopWords.has(token)))];
  const matchedNameTokens = nameTokens.filter(token => normalizedText.includes(token));
  const exactNameMatched = normalizedName.length >= 12 && normalizedText.includes(normalizedName);
  const nameMatched = exactNameMatched || matchedNameTokens.length >= Math.min(2, Math.max(1, nameTokens.length));

  return {
    matched: Boolean(dateMatched && nameMatched),
    dateMatched,
    nameMatched,
    exactNameMatched,
    matchedNameTokens: matchedNameTokens.slice(0, 8),
    reason: dateMatched && nameMatched ? 'event-date-and-name-present' : !dateMatched ? 'event-date-not-found' : 'event-name-not-found'
  };
}
