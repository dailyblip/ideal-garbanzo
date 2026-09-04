import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const authoredFiles = [
  'index.html',
  'assets/app.js',
  'scripts/generate-seo.mjs',
  'scripts/generate-career-guide.mjs',
  'scripts/generate-internship-guide.mjs'
];

const generatedRoots = [
  'jobs',
  'apprenticeships',
  'internships',
  'entry-level',
  'no-experience',
  'career-events',
  'how-to-get-a-data-center-job',
  'how-to-get-a-data-center-internship'
];

async function collectHtml(root) {
  const paths = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && path.endsWith('.html')) paths.push(path);
    }
  }
  await walk(root);
  return paths;
}

const files = [...authoredFiles];
for (const root of generatedRoots) files.push(...await collectHtml(root));

const failures = [];
for (const path of [...new Set(files)]) {
  const content = await readFile(path, 'utf8');
  const index = content.indexOf('\u2014');
  if (index !== -1) {
    const before = content.slice(0, index);
    const line = before.split('\n').length;
    failures.push(`${path}:${line}`);
  }
}

if (failures.length) {
  console.error('Em dash found in user-facing site copy:');
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}

console.log(`Site copy check passed across ${new Set(files).size} user-facing files.`);

// Run after SEO and guide generation so every deployable HTML page is checked,
// not only the authored homepage. Keep this dependency-free so accessibility
// regressions cannot be skipped because a browser-test package failed to install.
await import('./validate-accessibility.mjs');
