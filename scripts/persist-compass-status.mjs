import { readFile, writeFile } from 'node:fs/promises';

const aggregate = JSON.parse(await readFile('data/collector-status.json', 'utf8'));
const compass = aggregate?.compass;

if (!compass || typeof compass !== 'object') {
  throw new Error('Compass collector diagnostics are missing from data/collector-status.json.');
}

await writeFile('data/compass-status.json', JSON.stringify(compass, null, 2) + '\n');
console.log(`Persisted Compass source health: ${compass.listedPositions || 0} public positions, ${compass.qualifyingRoles || 0} mission-fit roles.`);
