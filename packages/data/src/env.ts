import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Repo root: packages/data/src -> ../../.. */
export const REPO_ROOT = path.resolve(here, '../../..');
export const DATA_DIR = path.join(REPO_ROOT, 'data');
export const PROOFS_DIR = path.join(DATA_DIR, 'proofs');
export const RECORDINGS_DIR = path.join(DATA_DIR, 'recordings');
export const PACKAGE_DIR = path.resolve(here, '..');

let loaded = false;
/** Loads the repo-root .env once, from an explicit path. Never prints values. */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  config({ path: path.join(REPO_ROOT, '.env'), quiet: true } as Parameters<typeof config>[0]);
}
