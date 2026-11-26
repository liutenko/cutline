// On-chain links shown on the dashboard: the Scorecard and DeskVault deployments on BNB Smart Chain testnet.
import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface OnchainLink {
  label: string;
  explorerUrl: string;
  txHash: string;
}

const EXPLORERS: Record<number, { name: string; url: string }> = {
  56: { name: 'BNB Smart Chain', url: 'https://bscscan.com' },
  97: { name: 'BNB Smart Chain testnet', url: 'https://testnet.bscscan.com' },
};

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

type Deployed = { address?: unknown; txHash?: unknown; chainId?: unknown };
const obj = (x: unknown): Deployed | null => (x && typeof x === 'object' ? (x as Deployed) : null);

function link(label: string, d: Deployed | null, chainId: unknown): OnchainLink | null {
  if (!d || typeof d.txHash !== 'string' || !d.txHash) return null;
  const ex = typeof chainId === 'number' ? EXPLORERS[chainId] : undefined;
  if (!ex) return null;
  const at = typeof d.address === 'string' && d.address ? ` at ${d.address}` : '';
  return { label: `${label} deployed on ${ex.name}${at}`, explorerUrl: `${ex.url}/tx/${d.txHash}`, txHash: d.txHash };
}

/**
 * Reads contracts/deployments/bscTestnet.json (Scorecard) and contracts/deployments/bscTestnet-vault.json
 * (DeskVault and its Test USD token). The vault file may hold the vault at the top level or under
 * `vault`/`deskVault`, and the token under `token`/`testUsd`/`tusd`; chainId at the top or per entry.
 * Missing or malformed files give no links.
 */
export function loadOnchainLinks(repoRoot: string): OnchainLink[] {
  const dir = path.join(repoRoot, 'contracts', 'deployments');
  const links: (OnchainLink | null)[] = [];
  const sc = obj(readJson(path.join(dir, 'bscTestnet.json')));
  if (sc) links.push(link('Scorecard contract', sc, sc.chainId));
  const v = obj(readJson(path.join(dir, 'bscTestnet-vault.json'))) as (Deployed & Record<string, unknown>) | null;
  if (v) {
    const vault = obj(v.vault) ?? obj(v.deskVault) ?? v;
    const token = obj(v.token) ?? obj(v.testUsd) ?? obj(v.tusd);
    links.push(link('DeskVault contract', vault, vault.chainId ?? v.chainId));
    links.push(link('Test USD token', token, token?.chainId ?? v.chainId));
  }
  return links.filter((l): l is OnchainLink => l !== null);
}

/** Re-reads the files at most every `ttlMs`, so new transactions appear without a restart. */
export function cachedOnchainLinks(repoRoot: string, ttlMs = 5000): () => OnchainLink[] {
  let at = 0;
  let cache: OnchainLink[] = [];
  return () => {
    const now = Date.now();
    if (now - at > ttlMs) {
      cache = loadOnchainLinks(repoRoot);
      at = now;
    }
    return cache;
  };
}
