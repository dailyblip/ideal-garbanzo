import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const products = JSON.parse(await readFile('data/employer-products.json', 'utf8'));
const employerPage = await readFile('employers/index.html', 'utf8');
const inquiryScript = await readFile('assets/employer-inquiry.js', 'utf8');

const standard = products?.standardJob;
if (!standard) throw new Error('Missing standard employer job submission product');
if (Number(standard.priceUsd) !== 0) throw new Error('Standard employer job submission must remain free');
if (standard.priorityPlacement !== false) throw new Error('Standard employer job submission must not receive paid priority placement');
if (standard.requiresOfficialEmployerUrl !== true) throw new Error('Standard employer job submission must require an official employer URL');
if (standard.reviewRequired !== true) throw new Error('Standard employer job submission must require mission-fit review');
if (!Array.isArray(standard.benefits) || !standard.benefits.some(item => /no payment required/i.test(String(item)))) {
  throw new Error('Standard employer job submission must state that no payment is required');
}

const checkoutOptions = Array.isArray(products?.checkoutOptions) ? products.checkoutOptions : [];
if (checkoutOptions.includes('standardJob')) throw new Error('Free standard submissions must not enter the paid checkout lifecycle');
for (const paid of ['highlightedJob', 'spotlightJob']) {
  if (!checkoutOptions.includes(paid)) throw new Error(`Paid checkout options missing ${paid}`);
}

if (!/submit a qualifying role at no charge/i.test(employerPage)) throw new Error('Employer page must clearly offer free standard submissions');
if (!/paid promotion is optional/i.test(employerPage)) throw new Error('Employer page must clearly state that paid promotion is optional');
if (!/submission does not guarantee publication/i.test(employerPage)) throw new Error('Employer page must avoid promising publication for standard submissions');
if (!/type="url"[^>]*name="metadata__job_url"|name="metadata__job_url"[^>]*type="url"/i.test(employerPage)) {
  throw new Error('Employer submission form must collect an official job URL');
}

const standardButton = /type="submit"[^>]*name="metadata__tier"[^>]*value="standardJob"|name="metadata__tier"[^>]*value="standardJob"[^>]*type="submit"|value="standardJob"[^>]*name="metadata__tier"[^>]*type="submit"/i;
if (!standardButton.test(employerPage)) throw new Error('Employer submission form is missing the Standard Listing action');
for (const paid of ['highlightedJob', 'spotlightJob']) {
  if (!new RegExp(`value="${paid}"`, 'i').test(employerPage)) throw new Error(`Employer submission form lost paid option ${paid}`);
}

if (!inquiryScript.includes("standardJob: 'Standard Listing ($0 / regular placement)'")) {
  throw new Error('Employer inquiry runtime is not wired to the standard listing option');
}
if (!inquiryScript.includes("optionKey === 'standardJob'")) throw new Error('Employer inquiry runtime must distinguish standard submissions from paid placement requests');
if (!inquiryScript.includes('mission fit before publication or promotion')) throw new Error('Employer inquiry handoff must preserve mission-fit review language');
if (!inquiryScript.includes('mailto:') || !inquiryScript.includes('event.submitter')) throw new Error('Employer submission must preserve the direct-email handoff and selected option');
if (!inquiryScript.includes('isOfficialJobUrl(jobUrl)') || !inquiryScript.includes('setCustomValidity')) {
  throw new Error('Employer intake must fail closed on non-official job URLs before opening the email handoff');
}

const policyStart = inquiryScript.indexOf('  const clean =');
const policyEnd = inquiryScript.indexOf('\n\n  const setStatus', policyStart);
if (policyStart < 0 || policyEnd <= policyStart) throw new Error('Employer URL policy helpers could not be isolated for regression testing');
const policyProbe = `${inquiryScript.slice(policyStart, policyEnd)}\nglobalThis.__isOfficialJobUrl = isOfficialJobUrl;`;
const sandbox = { URL };
vm.runInNewContext(policyProbe, sandbox, { filename: 'assets/employer-inquiry.js#official-job-url-policy' });
const isOfficialJobUrl = sandbox.__isOfficialJobUrl;
if (typeof isOfficialJobUrl !== 'function') throw new Error('Employer URL policy helper is not testable');

const allowedOfficialUrls = [
  'https://careers.microsoft.com/v2/global/en/job/123/data-center-technician',
  'https://www.amazon.jobs/en/jobs/123/data-center-technician',
  'https://careers.google.com/jobs/results/123/data-center-technician',
  'https://company.wd1.myworkdayjobs.com/en-US/careers/job/123',
  'https://boards.greenhouse.io/company/jobs/123',
  'https://jobs.lever.co/company/123'
];
for (const url of allowedOfficialUrls) {
  if (!isOfficialJobUrl(url)) throw new Error(`Employer intake rejected a valid employer or ATS URL: ${url}`);
}

const rejectedUrls = [
  'http://careers.microsoft.com/job/123',
  'https://www.linkedin.com/jobs/view/123',
  'https://www.indeed.com/viewjob?jk=123',
  'https://jobs.glassdoor.com/job/123',
  'https://example.ziprecruiter.com/jobs/123',
  'https://www.monster.com/job-openings/123',
  'https://datacentercareers.us/jobs/example/',
  'not a url'
];
for (const url of rejectedUrls) {
  if (isOfficialJobUrl(url)) throw new Error(`Employer intake accepted a non-official or unsafe job URL: ${url}`);
}

if (/buttondown\.com\/api\/emails\/embed-subscribe/i.test(employerPage)) throw new Error('Employer submissions must not use the candidate newsletter endpoint');
if (/name="tag"/i.test(employerPage)) throw new Error('Employer submissions must not attach candidate newsletter tags');

console.log(`Employer submission contract passed: free standard review plus optional paid visibility are distinct, mission-fit gated, and employer-direct URL guarded (${allowedOfficialUrls.length} allow / ${rejectedUrls.length} reject cases).`);
