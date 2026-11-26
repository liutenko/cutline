import { readFileSync, writeFileSync } from 'node:fs';
const load = (n) => JSON.parse(readFileSync(new URL(`../artifacts/contracts/${n}.sol/${n}.json`, import.meta.url), 'utf8')).abi;
writeFileSync(
  new URL('../src/vaultAbi.ts', import.meta.url),
  '// Generated from artifacts/contracts/{DeskVault,TestUSD}.sol. Run: npm run abi\n' +
    `export const deskVaultAbi = ${JSON.stringify(load('DeskVault'), null, 2)} as const;\n\n` +
    `export const testUsdAbi = ${JSON.stringify(load('TestUSD'), null, 2)} as const;\n`,
);
