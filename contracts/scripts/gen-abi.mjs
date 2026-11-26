import { readFileSync, writeFileSync } from 'node:fs';
const a = JSON.parse(readFileSync(new URL('../artifacts/contracts/Scorecard.sol/Scorecard.json', import.meta.url), 'utf8'));
writeFileSync(new URL('../src/abi.ts', import.meta.url), '// Generated from artifacts/contracts/Scorecard.sol/Scorecard.json. Run: npm run abi\nexport const scorecardAbi = ' + JSON.stringify(a.abi, null, 2) + ' as const;\n');
