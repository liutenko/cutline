// On-chain links shown on the dashboard: Yellow deposit/withdrawal txs and the Scorecard deployment.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

const isLink = (x: unknown): x is OnchainLink =>
  !!x && typeof x === 'object' &&
  typeof (x as OnchainLink).label === 'string' &&
  typeof (x as OnchainLink).explorerUrl === 'string' &&
  typeof (x as OnchainLink).txHash === 'string';

/** Reads data/proofs/yellow/onchain.json and contracts/deployments/*.json. Missing or malformed files give no links. */
export function loadOnchainLinks(repoRoot: string): OnchainLink[] {
  const links: OnchainLink[] = [];
  const yellow = readJson(path.join(repoRoot, 'data', 'proofs', 'yellow', 'onchain.json'));
  if (Array.isArray(yellow)) links.push(...yellow.filter(isLink).map((l) => ({ label: l.label, explorerUrl: l.explorerUrl, txHash: l.txHash })));
  const dir = path.join(repoRoot, 'contracts', 'deployments');
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
      const d = readJson(path.join(dir, f)) as { address?: string; chainId?: number; txHash?: string } | null;
      if (!d || typeof d.txHash !== 'string' || typeof d.chainId !== 'number') continue;
      const ex = EXPLORERS[d.chainId];
      if (!ex) continue;
      links.push({ label: `Scorecard contract deployed on ${ex.name}${d.address ? ` at ${d.address}` : ''}`, explorerUrl: `${ex.url}/tx/${d.txHash}`, txHash: d.txHash });
    }
  }
  return links;
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
