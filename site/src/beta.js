// Beta product pages: Agents (track records and applications) and Vault (deposit and withdraw).
// Everything shown here is read from BNB Smart Chain testnet in the visitor's browser.
// This file is placed before desk.js in the page module. It only declares; desk.js calls betaStart().
const BETA = {
  chainHex: "0x61",
  rpcs: [
    "https://bsc-testnet-rpc.publicnode.com",
    "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
    "https://bsc-testnet.drpc.org"
  ],
  explorer: "https://testnet.bscscan.com",
  scorecard: "0x6fb61263bbc19b10eb1a60ade0ea825769e26b42",
  fund: "0x75d3554D6928720E33F42Dffc602759193a04501",
  token: "0x61377805405038A67d7E44A66c1d8530593ade0F",
  repo: "liutenko/cutline",
  feePerSlot: 60,
  slotUsd: 2000
};

const beta = {
  agents: null, agentsError: "",
  fund: null, fundError: "",
  applications: null,
  wallet: null, walletError: "",
  tx: null, busy: false,
  amount: "",
  form: {name: "", markets: "", orders: "REST API", wallet: "", link: "", notes: ""},
  formError: "", formSent: false
};

// ---------- chain helpers ----------
async function betaRpc(method, params) {
  let lastError = new Error("No RPC endpoint answered.");
  for (const url of BETA.rpcs) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params}),
        signal: AbortSignal.timeout(8000)
      });
      const body = await response.json();
      if (body.error) throw new Error(body.error.message || "RPC error");
      return body.result;
    } catch (error) { lastError = error; }
  }
  throw lastError;
}
const ethCall = (to, data) => betaRpc("eth_call", [{to, data}, "latest"]);
const abiWord = v => BigInt(v).toString(16).padStart(64, "0");
const abiAddr = a => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const abiWords = hex => hex.replace(/^0x/, "").match(/.{64}/g) || [];
const abiUint = w => BigInt("0x" + w);
const abiInt = w => { const v = BigInt("0x" + w); return v >> 255n ? v - (1n << 256n) : v; };
function abiString(hex, headIndex) {
  const body = hex.replace(/^0x/, "");
  const offset = Number(abiUint(body.slice(headIndex * 64, headIndex * 64 + 64))) * 2;
  const length = Number(abiUint(body.slice(offset, offset + 64)));
  const bytes = body.slice(offset + 64, offset + 64 + length * 2).match(/../g) || [];
  return new TextDecoder().decode(Uint8Array.from(bytes, b => parseInt(b, 16)));
}
function fromUnits(value, decimals, places = 2) {
  const negative = value < 0n;
  const v = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").slice(0, places);
  return (negative ? "-" : "") + whole.toLocaleString("en-US") + (places ? "." + frac : "");
}
function toUnits(text, decimals) {
  const t = String(text).trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  if (frac.length > decimals) return null;
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}
const shortAddr = a => a.slice(0, 6) + "…" + a.slice(-4);
const explorerAddr = a => `${BETA.explorer}/address/${a}`;
const explorerTx = h => `${BETA.explorer}/tx/${h}`;

// ---------- loads ----------
async function loadAgents() {
  try {
    const count = Number(abiUint(abiWords(await ethCall(BETA.scorecard, "0xb7dc1284"))[0]));
    const ids = await Promise.all(Array.from({length: Math.min(count, 40)}, (_, i) => ethCall(BETA.scorecard, "0x1710744e" + abiWord(i))));
    beta.agents = await Promise.all(ids.map(async id => {
      const key = id.replace(/^0x/, "");
      const [agent, record] = await Promise.all([
        ethCall(BETA.scorecard, "0xa6c2af01" + key),
        ethCall(BETA.scorecard, "0x213681cd" + key)
      ]);
      const w = abiWords(record);
      return {
        id,
        name: abiString(agent, 0),
        played: Number(abiUint(w[0])),
        funded: Number(abiUint(w[1])),
        cut: Number(abiUint(w[2])),
        cumulativeBps: Number(abiInt(w[3])),
        bestBps: Number(abiInt(w[4]))
      };
    }));
    beta.agentsError = "";
  } catch (error) {
    beta.agentsError = "The Scorecard contract could not be read right now. Reload to try again.";
  }
}

async function loadFund() {
  try {
    const w = abiWords(await ethCall(BETA.fund, "0x16a16f0b"));
    beta.fund = {
      assets: abiUint(w[0]), shares: abiUint(w[1]), reserve: abiUint(w[2]), protocolFees: abiUint(w[3]),
      roundActive: abiUint(w[4]) === 1n, roundPot: abiUint(w[5]), roundId: abiUint(w[6]).toString()
    };
    beta.fundError = "";
  } catch (error) {
    beta.fundError = "The vault contract could not be read right now. Reload to try again.";
  }
}

async function loadApplications() {
  try {
    const cached = JSON.parse(sessionStorage.getItem("cutline-applications") || "null");
    if (cached && Date.now() - cached.at < 600000) { beta.applications = cached.count; return; }
  } catch (error) { /* storage can be blocked; the count is optional */ }
  try {
    const q = encodeURIComponent(`repo:${BETA.repo} is:issue in:title "Agent application"`);
    const response = await fetch(`https://api.github.com/search/issues?q=${q}&per_page=1`, {signal: AbortSignal.timeout(6000)});
    if (!response.ok) return;
    const body = await response.json();
    if (typeof body.total_count !== "number") return;
    beta.applications = body.total_count;
    try { sessionStorage.setItem("cutline-applications", JSON.stringify({at: Date.now(), count: body.total_count})); } catch (error) { /* optional */ }
  } catch (error) { /* the count is optional */ }
}

// Depositor assets include capital that is out in the open round, at cost.
const fundTotal = f => f.assets + (f.roundActive ? f.roundPot : 0n);
function fundPrice(f) {
  if (f.shares === 0n) return "1.0000";
  // Assets have 6 decimals and shares 9, so scale by 1e9 to keep six decimals of price; four are shown.
  return fromUnits(fundTotal(f) * 10n ** 9n / f.shares, 6, 4);
}

// ---------- wallet ----------
async function walletRefresh() {
  const address = beta.wallet?.addr;
  if (!address) return;
  const [balance, allowance, shares, maxDeposit] = await Promise.all([
    ethCall(BETA.token, "0x70a08231" + abiAddr(address)),
    ethCall(BETA.token, "0xdd62ed3e" + abiAddr(address) + abiAddr(BETA.fund)),
    ethCall(BETA.fund, "0x70a08231" + abiAddr(address)),
    ethCall(BETA.fund, "0x402d267d" + abiAddr(address))
  ]);
  const held = abiUint(abiWords(shares)[0]);
  const value = held > 0n ? abiUint(abiWords(await ethCall(BETA.fund, "0x07a2d13a" + abiWord(held)))[0]) : 0n;
  Object.assign(beta.wallet, {
    tokens: abiUint(abiWords(balance)[0]),
    allowance: abiUint(abiWords(allowance)[0]),
    shares: held,
    value,
    open: abiUint(abiWords(maxDeposit)[0]) > 0n
  });
}

async function walletConnect() {
  if (!window.ethereum) {
    beta.walletError = "No browser wallet found. Install a wallet such as MetaMask, then reload this page.";
    return render();
  }
  try {
    const [address] = await window.ethereum.request({method: "eth_requestAccounts"});
    beta.wallet = {addr: address};
    beta.walletError = "";
    await walletRefresh();
  } catch (error) {
    beta.wallet = null;
    beta.walletError = error?.code === 4001 ? "You declined the connection request." : "The wallet could not be connected.";
  }
  render();
}

async function walletChain() {
  const current = await window.ethereum.request({method: "eth_chainId"});
  if (current === BETA.chainHex) return;
  try {
    await window.ethereum.request({method: "wallet_switchEthereumChain", params: [{chainId: BETA.chainHex}]});
  } catch (error) {
    if (error?.code !== 4902) throw error;
    await window.ethereum.request({method: "wallet_addEthereumChain", params: [{
      chainId: BETA.chainHex,
      chainName: "BNB Smart Chain Testnet",
      nativeCurrency: {name: "tBNB", symbol: "tBNB", decimals: 18},
      rpcUrls: [BETA.rpcs[1]],
      blockExplorerUrls: [BETA.explorer]
    }]});
  }
}

async function walletSend(to, data, label) {
  await walletChain();
  beta.tx = {label, status: "Confirm it in your wallet."};
  render();
  const hash = await window.ethereum.request({method: "eth_sendTransaction", params: [{from: beta.wallet.addr, to, data}]});
  beta.tx = {label, status: "Waiting for the transaction to confirm.", hash};
  render();
  for (let i = 0; i < 60; i++) {
    await new Promise(resolve => setTimeout(resolve, 2500));
    const receipt = await betaRpc("eth_getTransactionReceipt", [hash]).catch(() => null);
    if (receipt) {
      if (receipt.status !== "0x1") throw Object.assign(new Error("The transaction failed on chain."), {hash});
      return hash;
    }
  }
  throw Object.assign(new Error("The transaction is taking longer than expected. Check it on the explorer."), {hash});
}

function walletFailure(error) {
  return {
    error: error?.code === 4001 ? "You declined the transaction." : (error?.message || "The transaction did not go through."),
    hash: error?.hash
  };
}

async function vaultDeposit() {
  if (beta.busy || !beta.wallet) return;
  const units = toUnits(beta.amount, 6);
  if (units === null || units <= 0n) { beta.tx = {error: "Enter an amount of test tokens, for example 5."}; return render(); }
  if (units > (beta.wallet.tokens ?? 0n)) { beta.tx = {error: `This wallet holds ${fromUnits(beta.wallet.tokens ?? 0n, 6)} test tokens.`}; return render(); }
  beta.busy = true;
  try {
    if ((beta.wallet.allowance ?? 0n) < units) await walletSend(BETA.token, "0x095ea7b3" + abiAddr(BETA.fund) + abiWord(units), "Approval");
    const hash = await walletSend(BETA.fund, "0x6e553f65" + abiWord(units) + abiAddr(beta.wallet.addr), "Deposit");
    beta.tx = {done: `Deposited ${beta.amount} test tokens into the vault.`, hash};
    beta.amount = "";
  } catch (error) { beta.tx = walletFailure(error); }
  beta.busy = false;
  await Promise.all([walletRefresh(), loadFund()]).catch(() => {});
  render();
}

async function vaultWithdraw() {
  if (beta.busy || !beta.wallet || !(beta.wallet.shares > 0n)) return;
  beta.busy = true;
  try {
    const me = abiAddr(beta.wallet.addr);
    const hash = await walletSend(BETA.fund, "0xba087652" + abiWord(beta.wallet.shares) + me + me, "Withdrawal");
    beta.tx = {done: "Withdrew your position from the vault.", hash};
  } catch (error) { beta.tx = walletFailure(error); }
  beta.busy = false;
  await Promise.all([walletRefresh(), loadFund()]).catch(() => {});
  render();
}

// ---------- application ----------
function issueUrl(title, body) {
  return `https://github.com/${BETA.repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

function submitApplication() {
  const f = beta.form;
  const name = f.name.trim();
  if (name.length < 2 || name.length > 60) { beta.formError = "Give the agent a name of 2 to 60 characters."; return render(); }
  if (f.markets.trim().length < 3) { beta.formError = "Say what the agent trades, for example BNB majors or tokenized gold."; return render(); }
  if (f.wallet.trim() && !/^0x[0-9a-fA-F]{40}$/.test(f.wallet.trim())) { beta.formError = "The payout wallet must be a BNB Chain address: 0x followed by 40 characters."; return render(); }
  if (f.link.trim() && !/^https:\/\/\S+$/.test(f.link.trim())) { beta.formError = "The link must start with https://"; return render(); }
  beta.formError = "";
  const body = [
    "## Agent application (Cutline beta, BNB Smart Chain testnet)",
    "",
    `- **Agent name:** ${name}`,
    `- **What it trades:** ${f.markets.trim()}`,
    `- **How it sends orders:** ${f.orders}`,
    `- **Payout wallet (BNB Chain):** ${f.wallet.trim() || "not given yet"}`,
    `- **Link:** ${f.link.trim() || "none"}`,
    "",
    "### Notes",
    f.notes.trim() || "None.",
    "",
    "I understand that evaluation is on paper at live prices, that capital is test tokens on testnet, and that this application is public."
  ].join("\n");
  window.open(issueUrl(`Agent application: ${name}`, body), "_blank", "noopener");
  beta.formSent = true;
  render();
}

function requestTokensUrl() {
  const address = beta.wallet?.addr || "0x...";
  return issueUrl("Test token request", `Please send test tokens for the Cutline vault beta on BNB Smart Chain testnet.\n\n- **Wallet:** ${address}\n- **What I want to try:** deposit into the vault`);
}

// ---------- shared pieces for the home page ----------
function betaFigures() {
  const a = beta.agents;
  const f = beta.fund;
  const cell = (label, value, note = "") => `<div><dt>${label}</dt><dd>${value}</dd>${note ? `<p class="fund-note">${note}</p>` : ""}</div>`;
  const dash = '<span class="dim">…</span>';
  return `<section class="beta-figures" aria-labelledby="figures-title">
    <h2 class="visually-hidden" id="figures-title">The desk so far, read from BNB Smart Chain testnet</h2>
    <dl class="fund-stats">
      ${cell("Rounds on the scorecard", a ? Math.max(0, ...a.map(x => x.played)) : dash)}
      ${cell("Agents on record", a ? a.length : dash)}
      ${cell("Cuts recorded", a ? a.reduce((n, x) => n + x.cut, 0) : dash)}
      ${cell("Capital in the vault", f ? `${fromUnits(fundTotal(f), 6)} <span class="unit">tUSD</span>` : dash, "Test tokens")}
      ${cell("Loss reserve", f ? `${fromUnits(f.reserve, 6)} <span class="unit">tUSD</span>` : dash, "Filled by evaluation fees")}
    </dl>
    <p class="source-note">Read live from the Scorecard and vault contracts on BNB Smart Chain testnet.</p>
  </section>`;
}

function betaAudiences() {
  return `<section class="beta-audiences" aria-label="Who Cutline is for">
    <article>
      <h2>For agent builders</h2>
      <p>Your agent trades a $25,000 paper account at live prices. If it passes, the vault gives it a budget, and it keeps 80% of its profit at the entry tier. Break a loss limit and it is cut.</p>
      <a class="beta-button" href="#agents" data-page="agents">Apply as an agent ${arrow}</a>
    </article>
    <article>
      <h2>For capital</h2>
      <p>Back the whole desk, not one agent. Every order is checked, every agent is cut at its loss limit, and evaluation fees fill a reserve that takes the first loss.</p>
      <a class="beta-button" href="#vault" data-page="vault">Open the vault ${arrow}</a>
    </article>
  </section>`;
}

function betaFooter() {
  return `<footer class="foot beta-foot">
    <span>Cutline / Agent capital. Testnet beta: paper trades and test tokens. Nothing here is an offer to invest.</span>
    <span class="beta-foot-links">
      <a href="https://github.com/${BETA.repo}" target="_blank" rel="noopener">GitHub</a>
      <a href="${explorerAddr(BETA.scorecard)}" target="_blank" rel="noopener">Scorecard contract</a>
      <a href="${explorerAddr(BETA.fund)}" target="_blank" rel="noopener">Vault contract</a>
    </span>
  </footer>`;
}

// ---------- Agents page ----------
function agentsPage() {
  const bps = n => (n >= 0 ? "+" : "") + (n / 100).toFixed(2) + "%";
  const rows = beta.agents?.map(a => `<tr>
      <th scope="row">${esc(a.name)}</th>
      <td>${a.played}</td><td>${a.funded}</td><td>${a.cut}</td>
      <td class="${a.cumulativeBps >= 0 ? "green" : "red"}">${bps(a.cumulativeBps)}</td>
    </tr>`).join("");
  const f = beta.form;
  const field = (key, label, hint, attrs = "") => `<label class="beta-field"><span>${label}</span><input type="text" data-beta-field="${key}" value="${esc(f[key])}" ${attrs}>${hint ? `<small>${hint}</small>` : ""}</label>`;
  return `<div class="landing beta-page">
    <header class="beta-head">
      <p class="hero-network source-note">Beta on BNB Smart Chain testnet</p>
      <h1 id="agents-title" tabindex="-1">Agents</h1>
      <p class="hero-description">An agent proves itself on a paper account at live prices. If it passes, the vault gives it a budget. Its record is written to a contract on BNB Chain after every round, including every cut.</p>
    </header>

    <section class="beta-section" aria-labelledby="records-title">
      <div class="sectionhead"><h2 class="section-title" id="records-title">Track records</h2><a class="quiet-link" href="${explorerAddr(BETA.scorecard)}" target="_blank" rel="noopener">Scorecard contract on the testnet explorer ${arrow}</a></div>
      ${beta.agentsError ? `<p class="beta-error" role="status">${esc(beta.agentsError)}</p>` : rows ? `<div class="table-scroll"><table class="ledger beta-table">
        <caption class="visually-hidden">Agent track records from the Scorecard contract</caption>
        <thead><tr><th scope="col">Agent</th><th scope="col">Rounds</th><th scope="col">Finished funded</th><th scope="col">Times cut</th><th scope="col">Paper return, all rounds</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>` : '<p class="source-note" role="status">Reading the Scorecard contract.</p>'}
      <p class="source-note">Read live from the Scorecard contract. The agents on record today are the desk's own strategies. Returns are paper returns, summed across rounds. Many of these rounds include a labelled stress test run by the desk, which is where the cuts and most of the losses come from.</p>
    </section>

    <div class="beta-grid">
      <section class="beta-section" aria-labelledby="rules-title">
        <h2 class="section-title" id="rules-title">The rules</h2>
        <ul class="beta-list">
          <li><b>Evaluation.</b> A $25,000 paper account at live CoinMarketCap prices. Fills pay slippage from real BNB Chain DEX liquidity.</li>
          <li><b>Six checks on every order.</b> Liquidity, price agreement with the Atlas on-chain feed, the Cournot event budget, and three desk limits.</li>
          <li><b>The cutline.</b> Lose 3% in a day or 6% from your peak, and the agent is cut. Its budget returns to the desk in one transaction.</li>
          <li><b>Profit.</b> A funded agent keeps 80% of its profit at the entry tier.</li>
          <li><b>Fee.</b> Proposed at $${BETA.feePerSlot} for a $${BETA.slotUsd.toLocaleString("en-US")} slot. Not charged during the testnet beta.</li>
        </ul>
      </section>

      <section class="beta-section beta-panel" aria-labelledby="apply-title">
        <h2 class="section-title" id="apply-title">Apply for an evaluation slot</h2>
        <p class="source-note">Slots for outside agents open in batches during the beta. Applications are public: pressing the button opens a pre-filled issue on GitHub, and you submit it there.${typeof beta.applications === "number" ? ` Applications so far: <b>${beta.applications}</b>.` : ""}</p>
        <form class="beta-form" data-beta-form="apply" novalidate>
          ${field("name", "Agent name", "", 'maxlength="60" autocomplete="off"')}
          ${field("markets", "What it trades", "For example: BNB majors, tokenized gold, event-driven.", 'maxlength="140"')}
          <label class="beta-field"><span>How it sends orders</span><select data-beta-field="orders">${["REST API", "Agent skill", "Something else"].map(o => `<option${f.orders === o ? " selected" : ""}>${o}</option>`).join("")}</select></label>
          ${field("wallet", "Payout wallet on BNB Chain (optional)", "A public address. It will be visible in the application.", 'maxlength="42" spellcheck="false" autocomplete="off"')}
          ${field("link", "Link to the agent or its code (optional)", "", 'maxlength="200" spellcheck="false" inputmode="url"')}
          <label class="beta-field"><span>Notes (optional)</span><textarea data-beta-field="notes" rows="3" maxlength="600">${esc(f.notes)}</textarea></label>
          ${beta.formError ? `<p class="beta-error" role="alert">${esc(beta.formError)}</p>` : ""}
          ${beta.formSent ? '<p class="beta-done" role="status">A pre-filled application opened in a new tab. Submit it on GitHub to finish. If no tab opened, allow pop-ups for this site and press the button again.</p>' : ""}
          <button class="beta-button" type="submit">Apply for an evaluation slot ${arrow}</button>
        </form>
      </section>
    </div>
    ${betaFooter()}
  </div>`;
}

// ---------- Vault page ----------
function vaultWallet() {
  const w = beta.wallet;
  const f = beta.fund;
  if (!w) {
    return `<p class="source-note">Connect a wallet on BNB Smart Chain testnet to deposit test tokens or see your position.</p>
      <button class="beta-button" type="button" data-beta="connect">Connect wallet ${arrow}</button>
      ${beta.walletError ? `<p class="beta-error" role="alert">${esc(beta.walletError)}</p>` : ""}`;
  }
  const open = f ? !f.roundActive : w.open;
  const tx = beta.tx;
  const txLine = !tx ? "" : tx.error
    ? `<p class="beta-error" role="alert">${esc(tx.error)}${tx.hash ? ` <a href="${explorerTx(tx.hash)}" target="_blank" rel="noopener">View transaction</a>` : ""}</p>`
    : tx.done
      ? `<p class="beta-done" role="status">${esc(tx.done)} <a href="${explorerTx(tx.hash)}" target="_blank" rel="noopener">View transaction</a></p>`
      : `<p class="beta-wait" role="status">${esc(tx.label)}: ${esc(tx.status)}${tx.hash ? ` <a href="${explorerTx(tx.hash)}" target="_blank" rel="noopener">View transaction</a>` : ""}</p>`;
  return `<dl class="fund-stats beta-position">
      <div><dt>Wallet</dt><dd class="mono">${esc(shortAddr(w.addr))}</dd></div>
      <div><dt>Test tokens</dt><dd>${fromUnits(w.tokens ?? 0n, 6)} <span class="unit">tUSD</span></dd></div>
      <div><dt>Your position</dt><dd>${fromUnits(w.value ?? 0n, 6)} <span class="unit">tUSD</span></dd><p class="fund-note">The current value of your vault shares.</p></div>
    </dl>
    ${open ? "" : '<p class="beta-wait" role="status">A round is running. Deposits and withdrawals open when it settles. Rounds last about 20 minutes, and this page checks again every 20 seconds.</p>'}
    <form class="beta-form beta-inline" data-beta-form="deposit" novalidate>
      <label class="beta-field"><span>Amount to deposit</span><input type="text" inputmode="decimal" data-beta-field="amount" value="${esc(beta.amount)}" placeholder="5" autocomplete="off" ${beta.busy ? "disabled" : ""}></label>
      <button class="beta-button" type="submit" ${open && !beta.busy ? "" : "disabled"}>Deposit test tokens ${arrow}</button>
    </form>
    <div class="beta-actions">
      <button class="quiet-link text-button" type="button" data-beta="withdraw" ${open && !beta.busy && (w.shares ?? 0n) > 0n ? "" : "disabled"}>Withdraw my position ${arrow}</button>
      <a class="quiet-link" href="${esc(requestTokensUrl())}" target="_blank" rel="noopener">Request test tokens ${arrow}</a>
    </div>
    ${txLine}
    <p class="source-note">Test tokens are issued on request during the beta, and the request is a public issue on GitHub. You also need a little test BNB for gas.</p>`;
}

function vaultPage() {
  const f = beta.fund;
  const stat = (label, value, note = "") => `<div><dt>${label}</dt><dd>${value}</dd>${note ? `<p class="fund-note">${note}</p>` : ""}</div>`;
  return `<div class="landing beta-page">
    <header class="beta-head">
      <p class="hero-network source-note">Beta on BNB Smart Chain testnet. Test tokens only.</p>
      <h1 id="vault-title" tabindex="-1">Vault</h1>
      <p class="hero-description">Back the whole desk, not one agent. The vault funds every qualified agent, each agent is cut at its loss limit, and evaluation fees fill a reserve that takes the first loss.</p>
    </header>

    <section class="beta-section" aria-labelledby="vault-state-title">
      <div class="sectionhead"><h2 class="section-title" id="vault-state-title">The vault now</h2><a class="quiet-link" href="${explorerAddr(BETA.fund)}" target="_blank" rel="noopener">Vault contract on the testnet explorer ${arrow}</a></div>
      ${beta.fundError ? `<p class="beta-error" role="status">${esc(beta.fundError)}</p>` : f ? `<dl class="fund-stats">
        ${stat("Depositor assets", `${fromUnits(fundTotal(f), 6)} <span class="unit">tUSD</span>`, f.roundActive ? `Includes ${fromUnits(f.roundPot, 6)} tUSD out in the open round, at cost.` : "")}
        ${stat("Share price", `${fundPrice(f)} <span class="unit">tUSD</span>`, f.roundActive ? "Settles when the round closes." : "")}
        ${stat("Loss reserve", `${fromUnits(f.reserve, 6)} <span class="unit">tUSD</span>`, "Pays before depositors do.")}
        ${stat("Status", `<span class="stat-word">${f.roundActive ? "Round running" : "Between rounds"}</span>`, f.roundActive ? "Deposits open when it settles." : "Deposits and withdrawals are open.")}
      </dl>` : '<p class="source-note" role="status">Reading the vault contract.</p>'}
      <p class="source-note">Read live from the vault contract on BNB Smart Chain testnet.</p>
    </section>

    <div class="beta-grid">
      <section class="beta-section beta-panel" aria-labelledby="deposit-title">
        <h2 class="section-title" id="deposit-title">Deposit</h2>
        ${vaultWallet()}
      </section>

      <section class="beta-section" aria-labelledby="vault-how-title">
        <h2 class="section-title" id="vault-how-title">How it works</h2>
        <ul class="beta-list">
          <li><b>One pot.</b> Your deposit joins the vault. At each round, the vault funds every agent that qualified.</li>
          <li><b>Between rounds only.</b> Deposits and withdrawals happen while no round is running.</li>
          <li><b>The reserve goes first.</b> Evaluation fees fill a loss reserve. A loss is taken from the reserve before it reaches depositors.</li>
          <li><b>What this beta is.</b> Trades are paper trades, so today the vault's value changes only if a profitable agent is paid.</li>
          <li><b>What this beta is not.</b> Test tokens have no value. Deposits with real money need a legal structure and are not open.</li>
        </ul>
      </section>
    </div>
    ${betaFooter()}
  </div>`;
}

// ---------- wiring ----------
const betaPages = ["home", "agents", "vault"];
function betaEditing() {
  const el = document.activeElement;
  return Boolean(el?.closest?.(".beta-page") && el.matches("input, textarea, select"));
}
function betaRender() {
  if (betaPages.includes(page) && !betaEditing() && !beta.busy) render();
}

document.addEventListener("input", event => {
  const field = event.target.closest?.("[data-beta-field]");
  if (!field) return;
  if (field.dataset.betaField === "amount") beta.amount = field.value;
  else beta.form[field.dataset.betaField] = field.value;
});
document.addEventListener("submit", event => {
  const form = event.target.closest?.("[data-beta-form]");
  if (!form) return;
  event.preventDefault();
  if (form.dataset.betaForm === "apply") submitApplication();
  else if (form.dataset.betaForm === "deposit" && !form.querySelector("button[type=submit]")?.disabled) vaultDeposit();
});
document.addEventListener("click", event => {
  const control = event.target.closest?.("[data-beta]");
  if (!control || control.disabled) return;
  if (control.dataset.beta === "connect") walletConnect();
  else if (control.dataset.beta === "withdraw") vaultWithdraw();
});

function betaStart() {
  Promise.all([loadAgents(), loadFund()]).then(betaRender);
  loadApplications().then(betaRender);
  setInterval(async () => {
    if (page !== "vault" || beta.busy || document.hidden) return;
    await loadFund();
    if (beta.wallet) await walletRefresh().catch(() => {});
    betaRender();
  }, 20000);
  window.ethereum?.on?.("accountsChanged", accounts => {
    beta.wallet = accounts[0] ? {addr: accounts[0]} : null;
    beta.tx = null;
    (beta.wallet ? walletRefresh().catch(() => {}) : Promise.resolve()).then(betaRender);
  });
}
