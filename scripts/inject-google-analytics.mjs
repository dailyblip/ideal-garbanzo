import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MEASUREMENT_ID = 'G-TD86GFYGW5';
const EVENTS_SCRIPT = '<script defer src="/assets/analytics-events.js"></script>';
const SPONSORSHIP_SCRIPT = '<script defer src="/assets/sponsorships.js"></script>';
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

// Employer landing pages are generated from the same verified feed and link
// each job detail page back to a crawlable company page. Run them after regions
// so the jobs hub can expose both browse paths before analytics is injected.
await import('./generate-company-seo.mjs');

// Paid campaigns fail closed. Invalid dates, destinations, placements, or
// missing political/issue disclosure fields stop the build before publication.
await import('./validate-sponsorships.mjs');

// The advertising page is generated from current inventory so the media kit
// never hard-codes stale job or employer counts. It also enters the sitemap
// before analytics and sponsorship delivery are injected across HTML pages.
await import('./generate-advertising-page.mjs');

// The apprenticeship page uses current feed evidence to build its proof bar,
// fresh-opening module, accessible filters, conversion-focused cards and
// BreadcrumbList data. Generate that final page before analytics scans HTML.
await import('./enhance-apprenticeship-page.mjs');

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
let sponsorshipInjected = 0;
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

  if (!html.includes('/assets/sponsorships.js')) {
    if (!/<\/head>/i.test(html)) throw new Error(`Cannot inject sponsorship delivery; ${file} has no </head> element.`);
    html = html.replace(/<\/head>/i, `${SPONSORSHIP_SCRIPT}\n</head>`);
    sponsorshipInjected += 1;
    changed = true;
  }

  if (changed) await writeFile(file, html);
}

console.log(`Google Analytics ${MEASUREMENT_ID}: tag injected into ${tagInjected} HTML files; custom event tracking injected into ${eventsInjected}; sponsorship delivery injected into ${sponsorshipInjected}.`);
