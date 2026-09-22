import { readdir, readFile } from 'node:fs/promises';

const workflowDir = '.github/workflows';
const pagesWorkflow = 'pages.yml';
const sourceWriterNamePattern = /(bootstrap|fallback|skillbridge|targeted-recovery|verified-evidence|detail-recovery)/i;
const violations = [];

function isRecurringSourceFeedWriter(path, text) {
  return sourceWriterNamePattern.test(path)
    && /^\s*schedule:\s*$/m.test(text)
    && text.includes('data/jobs.json')
    && /git\s+push\s+origin\s+HEAD:main/.test(text);
}

function deploymentStepBlocks(text) {
  return text
    .split(/\n(?=\s{6}- name:)/)
    .filter((block) => /gh\s+workflow\s+run\s+pages\.yml\b/.test(block));
}

function hasSuccessfulPublishCondition(block) {
  return /^\s*if:\s*(?:\$\{\{\s*)?steps\.[A-Za-z0-9_-]+\.outputs\.[A-Za-z0-9_-]+\s*==\s*['"]true['"](?:\s*\}\})?\s*$/m.test(block);
}

const conditionRegressionCases = [
  ["      if: steps.publish.outputs.changed == 'true'", true],
  ['      if: steps.publish.outputs.pushed == "true"', true],
  ["      if: ${{ steps.commit.outputs.published == 'true' }}", true],
  ["      if: success()", false],
  ["      if: always()", false]
];
for (const [sample, expected] of conditionRegressionCases) {
  const actual = hasSuccessfulPublishCondition(sample);
  if (actual !== expected) {
    throw new Error(`Source deploy condition regression: expected ${expected}, got ${actual} for ${sample}`);
  }
}

const workflowNames = (await readdir(workflowDir)).filter((name) => name.endsWith('.yml')).sort();
let writersChecked = 0;

for (const name of workflowNames) {
  const path = `${workflowDir}/${name}`;
  const text = await readFile(path, 'utf8');
  if (!isRecurringSourceFeedWriter(path, text)) continue;
  writersChecked += 1;

  if (!/^\s*actions:\s*write\s*$/m.test(text)) {
    violations.push(`${path}: recurring public-feed writer must grant actions: write so a successful publish can dispatch Pages`);
  }

  const deploySteps = deploymentStepBlocks(text);
  if (!deploySteps.length) {
    violations.push(`${path}: recurring public-feed writer must dispatch ${pagesWorkflow} after publishing data/jobs.json`);
    continue;
  }

  const validDeployStep = deploySteps.some((block) =>
    hasSuccessfulPublishCondition(block)
    && /gh\s+workflow\s+run\s+pages\.yml\b[^\n]*--ref\s+main\b/.test(block)
    && /gh\s+workflow\s+run\s+pages\.yml\b[^\n]*-f\s+deploy_only=true\b/.test(block)
  );

  if (!validDeployStep) {
    violations.push(`${path}: Pages dispatch must be gated on a successful publish output and target main with deploy_only=true`);
  }
}

if (!writersChecked) {
  violations.push('No recurring source-feed writers were discovered; deployment guard discovery may have regressed.');
}

if (violations.length) {
  for (const violation of violations) console.error(`Source deployment dispatch violation: ${violation}`);
  throw new Error(`Blocked ${violations.length} source deployment dispatch regression(s).`);
}

console.log(`Source deployment dispatch guard passed for ${writersChecked} recurring source-feed writers. Every successful public-feed publish has an explicit, change-gated Pages deploy dispatch.`);
