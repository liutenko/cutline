// Preload for the bundled Cournot client (node --import). It records the raw HTTP response of the
// probability call so we keep the complete payload, because the client prints a normalised version.
// It never touches request headers or bodies, so no key or payment data can reach the file.
import { appendFileSync } from 'node:fs';

const out = process.env.COURNOT_RAW_TEE;
const match = process.env.COURNOT_TEE_MATCH || '/intelligence/v1/probability';
const realFetch = globalThis.fetch;
if (out) {
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    const res = await realFetch(input, init);
    if (url.includes(match)) {
      const text = await res.clone().text();
      appendFileSync(out, JSON.stringify({ url, method: init?.method ?? 'GET', status: res.status, receivedAt: Date.now(), body: text }) + '\n');
    }
    return res;
  };
}
