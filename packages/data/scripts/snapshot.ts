// Prints one live snapshot as JSON. Run: npm run snapshot
import { createLiveProvider } from '../src/provider.js';

const provider = createLiveProvider({ priceToleranceBps: Number(process.env.PRICE_TOLERANCE_BPS ?? 50) });
const snap = await provider.snapshot();
console.log(JSON.stringify(snap, null, 2));
if (provider.cmc.client.fallbacks.length) console.error('[data] keyed calls answered through keyless fallback:', provider.cmc.client.fallbacks);
