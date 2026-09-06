import { readFile, writeFile } from 'node:fs/promises';

const path = 'scripts/collect-major-jobs.mjs';
let text = await readFile(path, 'utf8');

const helperAnchor = "function relativePostedAt(label = '') {";
const helper = `function workdayLocationLabel(value) {
  if (typeof value === 'string') return clean(value);
  if (!value || typeof value !== 'object') return '';
  return clean(
    value.title || value.name || value.displayName ||
    value.location?.title || value.location?.name ||
    (typeof value.location === 'string' ? value.location : '')
  );
}

function selectWorkdayLocation(row = {}, info = {}) {
  const primary = workdayLocationLabel(info.location);
  const additional = (Array.isArray(info.additionalLocations) ? info.additionalLocations : [])
    .map(workdayLocationLabel)
    .filter(Boolean)
    .filter(value => value !== primary);

  if (primary && !/^\\d+\\s+locations?$/i.test(primary)) {
    return additional.length
      ? \`\${primary} + \${additional.length} more location\${additional.length === 1 ? '' : 's'}\`
      : primary;
  }
  if (additional.length) {
    const [first, ...rest] = additional;
    return rest.length
      ? \`\${first} + \${rest.length} more location\${rest.length === 1 ? '' : 's'}\`
      : first;
  }
  return clean(row.locationsText || primary || 'Location not listed');
}

`;

if (!text.includes('function selectWorkdayLocation(')) {
  const matches = text.split(helperAnchor).length - 1;
  if (matches !== 1) throw new Error(`Expected one helper anchor, found ${matches}`);
  text = text.replace(helperAnchor, helper + helperAnchor);
}

const oldLocation = "        const location = clean(row.locationsText || info.location || 'Location not listed');";
const newLocation = '        const location = selectWorkdayLocation(row, info);';
if (text.includes(oldLocation)) {
  text = text.replace(oldLocation, newLocation);
} else if (!text.includes(newLocation)) {
  throw new Error('Workday location assignment drifted');
}

if (!text.includes('function selectWorkdayLocation(') || !text.includes(newLocation)) {
  throw new Error('Workday location repair did not apply cleanly');
}

await writeFile(path, text);
console.log('Applied Workday detail-location repair.');
