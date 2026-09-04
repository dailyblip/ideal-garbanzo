import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MEASUREMENT_ID = 'G-TD86GFYGW5';
const EVENTS_SCRIPT = '<script defer src="/assets/analytics-events.js"></script>';
const SKIP_DIRS = new Set(['.git', '.github', 'node_modules']);

const tag = `<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', '${MEASUREMENT_ID}');
</script>`;

// Regional pages are generated after the core SEO hardening step so they can
// reuse the final normalized job feed and meaningful last-change dates. Build
// them before analytics injection so every deployable page receives tracking.
await import('./generate-region-seo.mjs');

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

let tagInjected = 0;
let eventsInjected = 0;
for (const file of await htmlFiles()) {
  let html = await readFile(file, 'utf8');
  let changed = false;

  if (!html.includes(MEASUREMENT_ID)) {
    if (!/<head(?:\s[^>]*)?>/i.test(html)) throw new Error(`Cannot inject Google Analytics; ${file} has no <head> element.`);
    html = html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}\n${tag}`);
    tagInjected += 1;
    changed = true;
  }

  if (!html.includes('/assets/analytics-events.js')) {
    if (!/<\/head>/i.test(html)) throw new Error(`Cannot inject analytics event tracking; ${file} has no </head> element.`);
    html = html.replace(/<\/head>/i, `${EVENTS_SCRIPT}\n</head>`);
    eventsInjected += 1;
    changed = true;
  }

  if (changed) await writeFile(file, html);
}

console.log(`Google Analytics ${MEASUREMENT_ID}: tag injected into ${tagInjected} HTML files; custom event tracking injected into ${eventsInjected}.`);
