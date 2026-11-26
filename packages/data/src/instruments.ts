import type { Instrument } from '../../../shared/src/types.js';

/**
 * Instruments tradable on BNB Chain (chain 56). Every cmcId and bscAddress was verified against
 * CoinMarketCap responses (/v2/cryptocurrency/info and /v1/dex/search, 2026-11-26).
 * atlasFeed is an Atlas push feed on BNB Smart Chain mainnet, verified with a live eth_call
 * (latestRoundData) and listed on atlasoracle.io/feeds. It is optional config; ATLAS_FEEDS overrides it.
 *
 * BNB uses the WBNB contract as bscAddress because DEX liquidity is quoted on the wrapped token.
 */
export const INSTRUMENTS: Instrument[] = [
  { symbol: 'BNB', name: 'BNB (WBNB on PancakeSwap)', cmcId: 1839, kind: 'major', bscAddress: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', atlasFeed: '0x9c0517f5b4c8657c7f18d68d2d79e2b3b1cd6438' },
  { symbol: 'CAKE', name: 'PancakeSwap', cmcId: 7186, kind: 'major', bscAddress: '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82', atlasFeed: '0x55ad1d026d1bc49939b0ba9a451e393c79ad8e93' },
  { symbol: 'BTCB', name: 'Binance-Peg Bitcoin (BTCB)', cmcId: 4023, kind: 'major', bscAddress: '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c', atlasFeed: '0x9489981eb5bccf97042c549301d38de0560a412c' },
  { symbol: 'ETH', name: 'Binance-Peg Ethereum', cmcId: 1027, kind: 'major', bscAddress: '0x2170ed0880ac9a755fd29b2688956bd959f933f8', atlasFeed: '0x7942b8dd9f552c57eb94d16ea8215aef6cac948f' },
  { symbol: 'XAUT', name: 'Tether Gold (tokenized gold)', cmcId: 5176, kind: 'rwa', bscAddress: '0x21caef8a43163eea865baee23b9c2e327696a3bf' },
  { symbol: 'XAUM', name: 'Matrixdock Gold (tokenized gold)', cmcId: 34212, kind: 'rwa', bscAddress: '0x23ae4fd8e7844cdbc97775496ebd0e8248656028' },
  { symbol: 'TSLAB', name: 'Tesla Tokenized bStocks (tokenized stock)', cmcId: 40214, kind: 'rwa', bscAddress: '0x5b1910eaad6450e50f816082aa078c41f10c292f', atlasFeed: '0x63950c265e7cdb4016ba60c288c46291c0148ce2' },
  { symbol: 'MTHT', name: 'Mermaid Treasure Hunt Token (thin pool)', cmcId: 40787, kind: 'thin', bscAddress: '0xc968f1c545f2714c3140208e1e0adbf1958f2ff7' },
];
