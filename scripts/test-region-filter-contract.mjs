import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const multiLocation = 'San Jose, CA; Englewood, CO; Miami, FL; Atlanta, GA; Chicago, IL; Secaucus, NJ; Dallas, TX; Ashburn, VA; Seattle, WA';
const expectedRegions = ['west', 'texas', 'mid-atlantic', 'midwest', 'southeast', 'northeast'];
const excludedRegion = 'southwest';

function runContract(name, matchesRegion) {
  const multi = { region: 'west', location: multiLocation };
  for (const region of expectedRegions) {
    assert.equal(matchesRegion(multi, region), true, `${name}: multi-location role must match ${region}`);
  }
  assert.equal(matchesRegion(multi, excludedRegion), false, `${name}: multi-location role must not match ${excludedRegion}`);

  const single = { region: 'west', location: 'San Jose, CA' };
  assert.equal(matchesRegion(single, 'west'), true, `${name}: primary region must match`);
  assert.equal(matchesRegion(single, 'texas'), false, `${name}: single-location role must not leak into Texas`);

  const nationwide = { region: 'nationwide', location: 'United States' };
  assert.equal(matchesRegion(nationwide, 'texas'), true, `${name}: nationwide role must match a regional filter`);

  const explicitRegions = { region: 'west', regions: ['west', 'texas'], location: 'Multiple locations' };
  assert.equal(matchesRegion(explicitRegions, 'texas'), true, `${name}: explicit regions array must be honored`);
  assert.equal(matchesRegion(explicitRegions, 'northeast'), false, `${name}: explicit regions must not overmatch`);
}

const appSource = await readFile('assets/app.js', 'utf8');
const appProbe = appSource.replace(
  '  loadSiteData();\n})();',
  '  globalThis.__matchesRegion = matchesRegion;\n})();'
);
assert.notEqual(appProbe, appSource, 'app.js probe injection point changed');
const appSandbox = {
  document: {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => []
  },
  setTimeout,
  clearTimeout,
  URL,
  Intl,
  Date,
  console
};
vm.runInNewContext(appProbe, appSandbox, { filename: 'assets/app.js' });
assert.equal(typeof appSandbox.__matchesRegion, 'function', 'app.js must expose matchesRegion to the test probe');
runContract('app.js', appSandbox.__matchesRegion);

const seoSource = await readFile('scripts/generate-region-seo.mjs', 'utf8');
const seoStart = seoSource.indexOf('const regionTerms = {');
const seoEnd = seoSource.indexOf('const typeLabel =');
assert.ok(seoStart >= 0 && seoEnd > seoStart, 'regional SEO matcher block not found');
const seoProbe = `${seoSource.slice(seoStart, seoEnd)}\nglobalThis.__matchesRegion = jobMatchesRegion;`;
const seoSandbox = {
  clean: value => String(value ?? '').replace(/\s+/g, ' ').trim()
};
vm.runInNewContext(seoProbe, seoSandbox, { filename: 'scripts/generate-region-seo.mjs#matcher' });
assert.equal(typeof seoSandbox.__matchesRegion, 'function', 'regional SEO must expose jobMatchesRegion to the test probe');
runContract('regional SEO', seoSandbox.__matchesRegion);

const digestSource = await readFile('scripts/send-weekly-digest.mjs', 'utf8');
const digestStart = digestSource.indexOf('const DIGEST_REGION_TERMS = {');
const digestEnd = digestSource.indexOf('const slugify =');
assert.ok(digestStart >= 0 && digestEnd > digestStart, 'weekly digest matcher block not found');
const digestProbe = `${digestSource.slice(digestStart, digestEnd)}\nglobalThis.__matchesRegion = digestJobMatchesRegion;`;
const digestSandbox = {};
vm.runInNewContext(digestProbe, digestSandbox, { filename: 'scripts/send-weekly-digest.mjs#matcher' });
assert.equal(typeof digestSandbox.__matchesRegion, 'function', 'weekly digest must expose digestJobMatchesRegion to the test probe');
runContract('weekly digest', digestSandbox.__matchesRegion);

console.log('Multi-location regional filtering contract passed for app, SEO, and weekly digest.');
