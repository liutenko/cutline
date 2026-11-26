import { readFileSync, writeFileSync } from 'node:fs';
const load = (n) => JSON.parse(readFileSync(new URL(`../artifacts/contracts/${n}.sol/${n}.json`, import.meta.url), 'utf8')).abi;
writeFileSync(
  new URL('../src/fundAbi.ts', import.meta.url),
  '// Generated from artifacts/contracts/DeskFund.sol. Run: npm run abi:fund\n' +
    `export const DESK_FUND_ABI = ${JSON.stringify(load('DeskFund'), null, 2)} as const;\n`,
);
