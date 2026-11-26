// A throwaway BNB Smart Chain testnet wallet for recording the Vault page's deposit flow.
//   - loads or generates one test key in contracts/.demo-wallet.json (gitignored, mode 600, test key only);
//   - the desk tops it up to 0.003 tBNB for gas and mints it up to 25 tUSD;
//   - prints the address and balances, never the key.
// Testnet only: refuses to run on any chain but 97.
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, formatEther, formatUnits, getAddress, http, parseEther, parseUnits, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { chainFor, NETWORKS } from '../src/chains.js';

const root = (p: string) => fileURLToPath(new URL(p, import.meta.url));
config({ path: root('../../.env'), quiet: true });

const net = NETWORKS.bscTestnet;
const rpc = process.env[net.rpcEnv]?.trim() || net.defaultRpc;
const deskKey = process.env.DESK_KEY?.trim();
if (!deskKey) throw new Error('DESK_KEY missing in repo-root .env');
const desk = privateKeyToAccount((deskKey.startsWith('0x') ? deskKey : `0x${deskKey}`) as Hex);
const chain = chainFor('bscTestnet', rpc);
const pub = createPublicClient({ chain, transport: http(rpc) });
const deskWallet = createWalletClient({ account: desk, chain, transport: http(rpc) });

const chainId = await pub.getChainId();
if (chainId !== 97) throw new Error(`RPC is on chain ${chainId}; this script runs on BNB Smart Chain testnet (97) only`);

const dep = JSON.parse(readFileSync(root('../deployments/bscTestnet-fund.json'), 'utf8'));
const token = getAddress(dep.token.address);
const tusdAbi = JSON.parse(readFileSync(root('../artifacts/contracts/TestUSD.sol/TestUSD.json'), 'utf8')).abi;

const KEY_FILE = root('../.demo-wallet.json');
let pk: Hex;
if (existsSync(KEY_FILE)) {
  pk = JSON.parse(readFileSync(KEY_FILE, 'utf8')).privateKey;
} else {
  pk = generatePrivateKey();
  const address = privateKeyToAccount(pk).address;
  writeFileSync(
    KEY_FILE,
    JSON.stringify({ note: 'Throwaway BNB testnet wallet for recording the Vault deposit. Never fund with real assets.', address, privateKey: pk }, null, 2) + '\n',
    { mode: 0o600 },
  );
  console.log('wrote a new demo wallet to contracts/.demo-wallet.json');
}
const me = privateKeyToAccount(pk).address;

const wait = async (label: string, hash: Hex) => {
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
  console.log(`${label}: https://testnet.bscscan.com/tx/${hash}`);
};

const GAS = parseEther('0.003');
const TOKENS = parseUnits('25', 6);
const bnb = await pub.getBalance({ address: me });
if (bnb < GAS) await wait('gas top-up', await deskWallet.sendTransaction({ to: me, value: GAS - bnb }));
const have = (await pub.readContract({ address: token, abi: tusdAbi, functionName: 'balanceOf', args: [me] })) as bigint;
if (have < TOKENS) await wait('mint tUSD', await deskWallet.writeContract({ address: token, abi: tusdAbi, functionName: 'mint', args: [me, TOKENS - have] }));

const finalBnb = await pub.getBalance({ address: me });
const finalTokens = (await pub.readContract({ address: token, abi: tusdAbi, functionName: 'balanceOf', args: [me] })) as bigint;
console.log(`demo wallet ${me}: ${formatEther(finalBnb)} tBNB, ${formatUnits(finalTokens, 6)} tUSD`);
