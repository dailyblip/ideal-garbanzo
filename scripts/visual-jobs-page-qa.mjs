import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const baseUrl = (process.env.VISUAL_QA_BASE_URL || 'https://datacentercareers.us').replace(/\/$/, '');
const expectedSha = String(process.env.JOBS_QA_EXPECTED_SHA || '').trim();
const repository = String(process.env.GITHUB_REPOSITORY || 'dailyblip/ideal-garbanzo').trim();
const githubToken = String(process.env.GITHUB_TOKEN || '').trim();
const outputDir = process.env.VISUAL_QA_OUTPUT_DIR || 'artifacts/jobs-page-visual-qa';
const profiles = [
  { name: 'desktop-1440', width: 1440, height: 1000, mode: 'desktop' },
  { name: 'tablet-1024', width: 1024, height: 900, mode: 'tablet' },
  { name: 'iphone-390', width: 390, height: 844, mode: 'mobile' },
  { name: 'iphone-430', width: 430, height: 932, mode: 'mobile' }
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function readLiveRevision() {
  const response = await fetch(`${baseUrl}/deployment-version.json?jobsqa=${Date.now()}`, {
    headers: { 'Cache-Control': 'no-cache' }
  });
  if (!response.ok) throw new Error(`Unable to verify deployed revision: HTTP ${response.status}`);
  const revision = await response.json();
  const sha = String(revision?.sha || '').trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error('Live deployment revision is missing or malformed.');
  return sha;
}

async function compareRevision(expected, live) {
  if (expected === live) return 'identical';
  if (!repository.includes('/')) throw new Error(`Cannot compare live revision because GITHUB_REPOSITORY is invalid: ${repository || 'missing'}.`);

  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'data-center-careers-jobs-visual-qa',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;

  const response = await fetch(`https://api.github.com/repos/${repository}/compare/${expected}...${live}`, { headers });
  if (!response.ok) throw new Error(`Unable to compare deployed revisions: GitHub HTTP ${response.status}`);
  const comparison = await response.json();
  return String(comparison?.status || '').trim().toLowerCase();
}

await mkdir(outputDir, { recursive: true });

let deployedSha = null;
let deploymentRelation = expectedSha ? 'unknown' : 'unchecked';
if (expectedSha) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    deployedSha = await readLiveRevision();
    deploymentRelation = await compareRevision(expectedSha, deployedSha);

    if (deploymentRelation === 'identical') break;
    if (deploymentRelation === 'ahead') {
      console.log(`Live revision ${deployedSha} is newer than triggering deployment ${expectedSha}; validating the current live jobs page.`);
      break;
    }
    if (deploymentRelation === 'behind' && attempt < 4) {
      console.log(`Live revision ${deployedSha} is still behind expected ${expectedSha}; retrying revision check (${attempt}/4).`);
      await sleep(5000);
      continue;
    }

    throw new Error(`Live revision ${deployedSha} is ${deploymentRelation || 'unrelated'} relative to expected ${expectedSha}; refusing to report a visual regression against the wrong deployment lineage.`);
  }
}

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
    const response = await page.goto(`${baseUrl}/jobs/?jobsqa=${Date.now()}-${profile.name}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!response?.ok()) errors.push(`Jobs page returned HTTP ${response?.status() ?? 'unknown'}.`);
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}' });
    await page.evaluate(async () => { if (document.fonts?.ready) await document.fonts.ready; });
    await page.waitForSelector('[data-jobs-newsletter]', { state: 'visible', timeout: 10000 });
    await page.waitForSelector('[data-jobs-browser]', { state: 'visible', timeout: 10000 });
    await page.waitForSelector('[data-job-results] .seo-job-card', { state: 'visible', timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(800);

    const geometry = await page.evaluate(({ mode }) => {
      const errors = [];
      const metrics = {};
      const fail = message => errors.push(message);
      const close = (a,b,tolerance=4) => Math.abs(a-b) <= tolerance;
      const visible = element => {
        if (!element) return false;
        const style = getComputedStyle(element);
        const r = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0.01 && r.width > 0 && r.height > 0;
      };
      const rect = selector => {
        const element = document.querySelector(selector);
        if (!visible(element)) return null;
        const r = element.getBoundingClientRect();
        return { left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height };
      };
      const rgb = selector => {
        const element = document.querySelector(selector);
        return element ? getComputedStyle(element) : null;
      };

      const newsletter = rect('[data-jobs-newsletter]');
      const browser = rect('[data-jobs-browser]');
      const copy = rect('.jobs-newsletter-copy');
      const form = rect('.jobs-newsletter-form');
      const email = rect('#jobs-newsletter-email');
      const submit = rect('.jobs-newsletter-submit');
      const controls = [email, submit];

      if (!newsletter || !browser || !copy || !form || controls.some(value => !value)) {
        fail('Jobs newsletter, search panel, email field, or submit control is missing.');
        return { errors, metrics };
      }

      const overflow = document.documentElement.scrollWidth - window.innerWidth;
      metrics.horizontalOverflow = overflow;
      if (overflow > 2) fail(`Horizontal page overflow is ${Math.round(overflow)}px.`);

      if (newsletter.top >= browser.top || newsletter.bottom > browser.top) fail('Newsletter must sit directly above the search/filter panel.');
      const gap = browser.top - newsletter.bottom;
      metrics.newsletterSearchGap = gap;
      if (gap < 6 || gap > 20) fail(`Newsletter-to-search gap is ${Math.round(gap)}px; expected 6–20px.`);
      if (!close(newsletter.left, browser.left, 3) || !close(newsletter.right, browser.right, 3)) fail('Newsletter and search/filter panel outer edges are misaligned.');

      const newsletterStyle = rgb('[data-jobs-newsletter]');
      const kickerStyle = rgb('[data-jobs-newsletter] .seo-kicker');
      const submitStyle = rgb('.jobs-newsletter-submit');
      metrics.newsletterBackground = newsletterStyle?.backgroundColor;
      metrics.kickerColor = kickerStyle?.color;
      metrics.submitBackground = submitStyle?.backgroundColor;
      if (newsletterStyle?.backgroundColor !== 'rgb(23, 50, 77)') fail(`Newsletter background is ${newsletterStyle?.backgroundColor}; expected site navy.`);
      if (kickerStyle?.color !== 'rgb(201, 148, 47)') fail(`Newsletter kicker is ${kickerStyle?.color}; expected site gold accent.`);
      if (submitStyle?.backgroundColor !== 'rgb(169, 79, 69)') fail(`Newsletter CTA is ${submitStyle?.backgroundColor}; expected muted brick red.`);

      for (const [label, control] of [['email',email],['submit',submit]]) {
        if (control.height < 44) fail(`Newsletter ${label} touch target is only ${Math.round(control.height)}px high.`);
      }

      if (mode !== 'mobile') {
        metrics.newsletterHeight = newsletter.height;
        if (newsletter.height > 82) fail(`Desktop/tablet newsletter is ${Math.round(newsletter.height)}px high; expected a condensed one-row bar.`);
        const controlTops = controls.map(control => control.top);
        const controlBottoms = controls.map(control => control.bottom);
        if (Math.max(...controlTops) - Math.min(...controlTops) > 4 || Math.max(...controlBottoms) - Math.min(...controlBottoms) > 4) {
          fail('Newsletter email and CTA controls do not share one row/baseline.');
        }
        const copyCenter = copy.top + copy.height / 2;
        const formCenter = form.top + form.height / 2;
        if (!close(copyCenter, formCenter, 6)) fail('Newsletter copy and controls are not vertically centered on the same row.');
      } else {
        metrics.newsletterHeight = newsletter.height;
        if (newsletter.height > 160) fail(`Mobile newsletter is ${Math.round(newsletter.height)}px high; expected compact wrapping.`);
        const emailStyle = rgb('#jobs-newsletter-email');
        if (Number.parseFloat(emailStyle?.fontSize || '0') < 16) fail('Mobile newsletter email field uses text smaller than 16px.');
      }

      // Buttondown's current free plan uses one email-only audience. Region and
      // experience filtering stay on the jobs page; newsletter metadata fields
      // are deliberately not part of this visual contract.
      const formElement = document.querySelector('#jobs-newsletter-form');
      if (formElement?.getAttribute('action') !== 'https://buttondown.com/api/emails/embed-subscribe/datacentercareers') fail('Newsletter form is not wired to the configured Buttondown list.');

      return { errors, metrics };
    }, { mode: profile.mode });

    errors.push(...geometry.errors);
    if (runtimeErrors.length) errors.push(`Browser runtime errors: ${runtimeErrors.join(' | ')}`);
    const screenshot = `${outputDir}/${profile.name}-jobs.png`;
    await page.screenshot({ path: screenshot, fullPage: true });
    reports.push({ profile, errors, metrics: geometry.metrics, screenshot });
  } catch (error) {
    errors.push(`Jobs visual QA execution failed: ${error.message}`);
    reports.push({ profile, errors, metrics: {}, screenshot: null });
  }

  if (errors.length) failed = true;
  await context.close();
}

await browser.close();
await writeFile(`${outputDir}/report.json`, JSON.stringify({
  checkedAt:new Date().toISOString(),
  baseUrl,
  expectedSha:expectedSha || null,
  deployedSha,
  deploymentRelation,
  passed:!failed,
  reports
}, null, 2) + '\n');

for (const report of reports) {
  console.log(`${report.profile.name}: ${report.errors.length ? 'FAIL' : 'PASS'}`);
  for (const error of report.errors) console.error(`- ${error}`);
}
if (failed) process.exit(1);
console.log('Jobs page visual QA passed at desktop, tablet, and iPhone viewports.');
