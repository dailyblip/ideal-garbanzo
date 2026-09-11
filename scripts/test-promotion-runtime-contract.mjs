import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile('assets/app.js', 'utf8');
const rankMatch = source.match(/  const PROMOTION_RANK = \{[^\n]+\};/);
assert.ok(rankMatch, 'promotion rank declaration not found in app.js');

const functionStart = source.indexOf('  function activePromotions(');
const functionEnd = source.indexOf('\n\n  function activeCareerEvents', functionStart);
assert.ok(functionStart >= 0 && functionEnd > functionStart, 'activePromotions function not found in app.js');

const probe = `${rankMatch[0]}\n${source.slice(functionStart, functionEnd)}\nglobalThis.__activePromotions = activePromotions;`;
const sandbox = {};
vm.runInNewContext(probe, sandbox, { filename: 'assets/app.js#promotion-runtime' });
const activePromotions = sandbox.__activePromotions;
assert.equal(typeof activePromotions, 'function', 'promotion runtime function must be testable');

const time = Date.parse('2026-09-11T12:00:00Z');
const active = activePromotions([
  {
    jobId: 'job-a',
    tier: 'highlightedJob',
    startsAt: '2026-09-10T00:00:00Z',
    expiresAt: '2026-09-20T00:00:00Z'
  },
  {
    jobId: 'job-a',
    tier: 'spotlightJob',
    startsAt: '2026-09-10T00:00:00Z',
    expiresAt: '2026-09-20T00:00:00Z'
  },
  {
    jobId: 'job-b',
    tier: 'highlightedJob',
    startsAt: '2026-09-11T00:00:00Z',
    expiresAt: '2026-09-12T00:00:00Z'
  },
  {
    jobId: 'future',
    tier: 'spotlightJob',
    startsAt: '2026-09-12T00:00:00Z',
    expiresAt: '2026-09-20T00:00:00Z'
  },
  {
    jobId: 'expired',
    tier: 'spotlightJob',
    startsAt: '2026-09-01T00:00:00Z',
    expiresAt: '2026-09-10T00:00:00Z'
  },
  {
    jobId: 'missing-start',
    tier: 'spotlightJob',
    expiresAt: '2026-09-20T00:00:00Z'
  },
  {
    jobId: 'bad-start',
    tier: 'spotlightJob',
    startsAt: 'not-a-date',
    expiresAt: '2026-09-20T00:00:00Z'
  },
  {
    jobId: 'missing-expiry',
    tier: 'spotlightJob',
    startsAt: '2026-09-10T00:00:00Z'
  },
  {
    jobId: 'bad-expiry',
    tier: 'spotlightJob',
    startsAt: '2026-09-10T00:00:00Z',
    expiresAt: 'not-a-date'
  },
  {
    jobId: 'reversed-window',
    tier: 'spotlightJob',
    startsAt: '2026-09-20T00:00:00Z',
    expiresAt: '2026-09-19T00:00:00Z'
  },
  {
    jobId: 'unknown-tier',
    tier: 'premiumForever',
    startsAt: '2026-09-10T00:00:00Z',
    expiresAt: '2026-09-20T00:00:00Z'
  },
  {
    jobId: '',
    tier: 'spotlightJob',
    startsAt: '2026-09-10T00:00:00Z',
    expiresAt: '2026-09-20T00:00:00Z'
  }
], time);

assert.equal(active.size, 2, 'only valid, currently active promotions should reach the homepage');
assert.equal(active.get('job-a')?.tier, 'spotlightJob', 'the highest valid tier should win for a duplicate job promotion');
assert.equal(active.get('job-b')?.tier, 'highlightedJob', 'a valid highlighted promotion should remain active');
for (const id of ['future', 'expired', 'missing-start', 'bad-start', 'missing-expiry', 'bad-expiry', 'reversed-window', 'unknown-tier']) {
  assert.equal(active.has(id), false, `malformed or inactive promotion must fail closed: ${id}`);
}
assert.equal(activePromotions(null, time).size, 0, 'non-array promotion data must fail closed');

console.log('Promotion runtime contract passed: malformed, expired, future, and unknown-tier records fail closed.');
