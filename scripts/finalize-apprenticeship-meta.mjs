import { readFile, writeFile } from 'node:fs/promises';

const path = 'apprenticeships/index.html';
const description = 'Browse current data center apprenticeships in electrical, mechanical and operations. See experience requirements and apply through verified employer listings on employer sites.';
let html = await readFile(path, 'utf8');

html = html.replace(/<meta name="description" content="[^"]*">/i, `<meta name="description" content="${description}">`);
html = html.replace(/<meta property="og:description" content="[^"]*">/i, `<meta property="og:description" content="${description}">`);
html = html.replace(/<meta name="twitter:description" content="[^"]*">/i, `<meta name="twitter:description" content="${description}">`);

await writeFile(path, html);
console.log(`Apprenticeship search-result copy finalized at ${description.length} characters.`);
