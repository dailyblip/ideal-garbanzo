import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const MEASUREMENT_ID = 'G-TD86GFYGW5';
const SKIP_DIRS = new Set(['.git', '.github', 'node_modules']);

async function htmlFiles(dir = '.') {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...await htmlFiles(join(dir, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

const files = await htmlFiles();
const missing = [];
const duplicates = [];
for (const file of files) {
  const html = await readFile(file, 'utf8');
  const count = html.split(MEASUREMENT_ID).length - 1;
  if (!count) missing.push(file);
  if (count > 2) duplicates.push(`${file} (${count} occurrences)`);
}

if (missing.length || duplicates.length) {
  console.error('Google Analytics validation failed.');
  if (missing.length) console.error(`Missing ${MEASUREMENT_ID}:\n- ${missing.join('\n- ')}`);
  if (duplicates.length) console.error(`Possible duplicate Google tags:\n- ${duplicates.join('\n- ')}`);
  process.exit(1);
}

console.log(`Google Analytics validation passed for ${files.length} HTML pages using ${MEASUREMENT_ID}.`);
