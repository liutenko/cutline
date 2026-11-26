/**
 * Runs a memory call so it can never crash a trading round: any throw or rejection is logged
 * (message only, never keys) and turned into null.
 */
export async function safe<T>(
  label: string,
  fn: () => Promise<T> | T,
  log: (msg: string) => void = (m) => console.warn(m),
): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    log(`[memory] ${label} failed, continuing without memory: ${(e as Error)?.message ?? String(e)}`);
    return null;
  }
}
