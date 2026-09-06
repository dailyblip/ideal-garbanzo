import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const baseUrl = (process.env.VISUAL_QA_BASE_URL || 'https://datacentercareers.us').replace(/\/$/, '');
const outputDir = process.env.VISUAL_QA_OUTPUT_DIR || 'artifacts/visual-qa';
const profiles = [
  { name: 'desktop-1440', width: 1440, height: 1000, mode: 'desktop' },
  { name: 'tablet-1024', width: 1024, height: 900, mode: 'tablet' },
  { name: 'iphone-390', width: 390, height: 844, mode: 'mobile' },
  { name: 'iphone-430', width: 430, height: 932, mode: 'mobile' }
];

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const reports = [];
let failed = false;

for (const profile of profiles) {
  const context = await browser.newContext({
    viewport: { width: profile.width, height: profile.height },
    deviceScaleFactor: 1,
    isMobile: profile.mode === 'mobile',
    hasTouch: profile.mode === 'mobile'
  });
  const page = await context.newPage();
  const runtimeErrors = [];
  page.on('pageerror', error => runtimeErrors.push(error.message));
  const errors = [];

  try {
    const response = await page.goto(`${baseUrl}/?visualqa=${Date.now()}-${profile.name}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!response?.ok()) errors.push(`Homepage returned HTTP ${response?.status() ?? 'unknown'}.`);
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}' });
    await page.evaluate(async () => { if (document.fonts?.ready) await document.fonts.ready; });
    await page.waitForFunction(() => Number(document.querySelector('#resultCount')?.textContent || 0) > 0, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1400);

    const geometry = await page.evaluate(({ mode }) => {
      const errors = [];
      const metrics = {};
      const visible = element => {
        const style = getComputedStyle(element);
        const r = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0.01 && r.width > 0 && r.height > 0;
      };
      const rect = selector => {
        const element = document.querySelector(selector);
        if (!element || !visible(element)) return null;
        const r = element.getBoundingClientRect();
        return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height };
      };
      const close = (a,b,tolerance=4) => Math.abs(a-b) <= tolerance;
      const fail = message => errors.push(message);

      const overflow = document.documentElement.scrollWidth - window.innerWidth;
      metrics.horizontalOverflow = overflow;
      if (overflow > 2) fail(`Horizontal page overflow is ${Math.round(overflow)}px.`);

      const broken = document.body.innerText.match(/\bundefined\b|\bNaN\b|\[object Object\]/g) || [];
      if (broken.length) fail(`Broken text token visible: ${[...new Set(broken)].join(', ')}.`);

      const escaped = [];
      for (const element of document.querySelectorAll('body *')) {
        if (!visible(element)) continue;
        const r = element.getBoundingClientRect();
        if (r.left < -2 || r.right > window.innerWidth + 2) {
          const label = element.id ? `#${element.id}` : element.classList.length ? `.${[...element.classList].slice(0,2).join('.')}` : element.tagName.toLowerCase();
          escaped.push(`${label} (${Math.round(r.left)}..${Math.round(r.right)})`);
          if (escaped.length >= 8) break;
        }
      }
      if (escaped.length) fail(`Visible elements escape viewport: ${escaped.join('; ')}.`);

      const clipped = [];
      for (const element of document.querySelectorAll('button,input:not([type="hidden"]),select,a.apply-link,a.employer-cta')) {
        if (!visible(element)) continue;
        if (element.scrollWidth > element.clientWidth + 4) {
          clipped.push((element.textContent || element.getAttribute('placeholder') || element.getAttribute('aria-label') || element.tagName).trim().slice(0,50));
          if (clipped.length >= 6) break;
        }
      }
      if (clipped.length) fail(`Control text appears clipped: ${clipped.join('; ')}.`);

      const hero = rect('.hero-grid');
      const alert = rect('.alert-strip');
      const events = rect('.events-section');
      const jobs = rect('.jobs-shell');
      if (!hero || !alert || !events || !jobs) fail('One or more core homepage sections are missing or hidden.');

      if (hero && alert) {
        const gap = alert.top - hero.bottom;
        metrics.heroAlertGap = gap;
        if (gap < 10 || gap > 60) fail(`Hero-to-newsletter gap is ${Math.round(gap)}px; expected 10–60px.`);
      }
      if (alert && events) {
        const gap = events.top - alert.bottom;
        metrics.alertEventsGap = gap;
        if (gap < 10 || gap > 50) fail(`Newsletter-to-events gap is ${Math.round(gap)}px; expected 10–50px.`);
      }

      if (mode !== 'mobile' && hero && alert && events) {
        if (!close(hero.left, alert.left, 3) || !close(hero.right, alert.right, 3)) fail('Hero and newsletter outer edges are misaligned.');
        if (!close(alert.left, events.left, 3) || !close(alert.right, events.right, 3)) fail('Newsletter and career-events outer edges are misaligned.');
        const region = rect('#alertRegion');
        const email = rect('#alertEmail');
        const join = rect('#weeklyAlertForm button[type="submit"]');
        if (!region || !email || !join) fail('Newsletter controls are missing.');
        else {
          metrics.newsletterBottomDelta = Math.max(Math.abs(region.bottom-email.bottom), Math.abs(region.bottom-join.bottom));
          if (!close(region.bottom, email.bottom, 5) || !close(email.bottom, join.bottom, 3)) fail('Newsletter controls do not share a clean bottom baseline.');
          if (!close(email.height, join.height, 3)) fail('Newsletter email field and submit button heights are mismatched.');
        }
      }

      if (mode === 'mobile') {
        for (const selector of ['#alertRegion','#alertEmail','#weeklyAlertForm button[type="submit"]','.hero-search .btn']) {
          const r = rect(selector);
          if (!r) fail(`Mobile control missing: ${selector}.`);
          else if (r.height < 44) fail(`Mobile touch target ${selector} is only ${Math.round(r.height)}px high.`);
        }
        if (alert && events && (!close(alert.left, events.left, 2) || !close(alert.right, events.right, 2))) fail('Mobile newsletter and events cards are not horizontally aligned.');
      }

      const cards = [...document.querySelectorAll('#jobList .job-card')].filter(visible).map(element => element.getBoundingClientRect());
      for (let i=1;i<cards.length;i++) {
        if (cards[i].top < cards[i-1].bottom - 1) {
          fail(`Job cards overlap around positions ${i} and ${i+1}.`);
          break;
        }
      }
      const motivators = document.querySelectorAll('#jobList .career-motivator').length;
      metrics.careerMotivators = motivators;
      if (mode === 'desktop' && (motivators < 2 || motivators > 3)) fail(`Expected 2–3 career-ceiling cards in the default desktop view; found ${motivators}.`);

      return { errors, metrics };
    }, { mode: profile.mode });

    errors.push(...geometry.errors);
    if (runtimeErrors.length) errors.push(`Browser runtime errors: ${runtimeErrors.join(' | ')}`);
    const screenshot = `${outputDir}/${profile.name}.png`;
    await page.screenshot({ path: screenshot, fullPage: true });
    reports.push({ profile, errors, metrics: geometry.metrics, screenshot });
  } catch (error) {
    errors.push(`Visual QA execution failed: ${error.message}`);
    reports.push({ profile, errors, metrics: {}, screenshot: null });
  }

  if (errors.length) failed = true;
  await context.close();
}

await browser.close();
await writeFile(`${outputDir}/report.json`, JSON.stringify({ checkedAt:new Date().toISOString(), baseUrl, passed:!failed, reports }, null, 2) + '\n');

for (const report of reports) {
  console.log(`${report.profile.name}: ${report.errors.length ? 'FAIL' : 'PASS'}`);
  for (const error of report.errors) console.error(`- ${error}`);
}
if (failed) process.exit(1);
console.log('Visual composition QA passed at all desktop, tablet, and iPhone viewports.');
