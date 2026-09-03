import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MEASUREMENT_ID = 'G-TD86GFYGW5';
const SKIP_DIRS = new Set(['.git', '.github', 'node_modules']);

const tag = `<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', '${MEASUREMENT_ID}');
</script>`;

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

let injected = 0;
let alreadyPresent = 0;
for (const file of await htmlFiles()) {
  let html = await readFile(file, 'utf8');
  if (html.includes(MEASUREMENT_ID)) {
    alreadyPresent += 1;
    continue;
  }
  if (!/<head(?:\s[^>]*)?>/i.test(html)) throw new Error(`Cannot inject Google Analytics; ${file} has no <head> element.`);
  html = html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}\n${tag}`);
  await writeFile(file, html);
  injected += 1;
}

console.log(`Google Analytics ${MEASUREMENT_ID}: injected into ${injected} HTML files; already present in ${alreadyPresent}.`);
