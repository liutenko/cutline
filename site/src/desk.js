const recording = JSON.parse(document.querySelector("#recording").textContent);
const isMock = recording.mock === true;
const params = new URLSearchParams(location.search);
const engineParam = params.get("engine");
// The public page (recording.live) reads the desk through the site's own /api proxy when the engine answers.
// When the desk is paused it replays the embedded recorded round instead, labelled as a replay.
const engineUp = recording.live === true && engineParam === null ? await probeEngine() : false;
const isProduct = engineUp;
const pausedReplay = recording.live === true && engineParam === null && !engineUp;
const isLive = engineParam !== null || isProduct;
const engineUrl = engineParam !== null ? parseEngineUrl(engineParam) : isProduct ? location.origin : null;
// Operator controls only with ?key= (kept for this tab, removed from the address bar) or an explicit ?engine=.
const controlKey = readControlKey();
const canControl = !isProduct || Boolean(controlKey);
// In live mode the embedded recording is ignored and every state comes from the engine.
const frames = isLive ? [] : recording.frames;
const live = {state:null, online:null, error:"", receivedAt:0, message:"", busy:false};
const operator = {rogueAgent:"momentum", shockSymbol:"", shockPct:"-25"};
const checkpoints = computeCheckpoints();
const blockFrame = checkpoints.find(c => c.key === "block")?.frame ?? frames.length - 1;
let idx = Math.max(0, blockFrame), page = ({"#desk":"desk","#agents":"agents","#vault":"vault"})[location.hash] || "home", selected = "momentum", timer = null;
let selectedOrder = null;
let deskView = "trading";
const app = document.querySelector("#app");
const announcement = document.querySelector("#announcement");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
const usd = n => "$" + Number(n).toLocaleString("en-US", {maximumFractionDigits:0});
const money = n => "$" + Number(n).toLocaleString("en-US", {minimumFractionDigits:2, maximumFractionDigits:2});
const pct = n => Number(n).toFixed(2) + "%";
const colors = ["#ffad76","#e6e1d7","#9a9ea6"];
const names = {momentum:"Momentum",rwa:"RWA",event:"Event",desk:"Held by desk",risk:"Risk manager"};
const roundPhases = {idle:"Awaiting evaluation",evaluation:"Evaluating",funded:"Funded",settled:"Settled"};
const arrow = '<svg class="arrow" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8h11M8 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
const playIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2l10 6-10 6z" fill="currentColor"/></svg>';
const pauseIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 2v12m6-12v12" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
const checkIcons = { pass: 'M2.5 8.5L6 12l7.5-8', fail: 'M4 4l8 8m0-8l-8 8' };
const iconPaths = {
  evaluate: "M4 4v16h16M7 15l4-4 3 2 5-6m-4 0h4v4",
  fund: "M4 8h16v12H4zM7 8V5h10v3M9 14h6m-3-3v6",
  protect: "M12 3l7 3v6c0 4-3 6-7 9-4-3-7-5-7-9V6l7-3zM9 12l2 2 4-4",
  settle: "M6 3h9l3 3v15H6zM14 3v4h4M9 12h6m-6 4h6",
  momentum: "M3 17l6-6 4 3 7-8m-5 0h5v5",
  rwa: "M4 11h16v6H4zM8 6h8l2 5H6zM12 11v6",
  event: "M3 12h5l2-5 4 10 2-5h5",
  orders: "M10 6h10M10 12h10M10 18h10M4 6h2M4 12h2M4 18h2"
};
const assetLogos = "@@INTEGRATIONS@@";
const marketSymbols = ["BNB","BTCB","XAUT","TSLAB"];

async function probeEngine() {
  try {
    const response = await fetch("/api/health", {cache:"no-store", signal:AbortSignal.timeout(3500)});
    return response.ok;
  } catch {
    return false;
  }
}

function readControlKey() {
  let key = params.get("key") || "";
  try {
    if (key) sessionStorage.setItem("cutline-key", key);
    else key = sessionStorage.getItem("cutline-key") || "";
  } catch { /* storage blocked: the key lasts for this page load */ }
  if (params.has("key")) {
    params.delete("key");
    const q = params.toString();
    window.history.replaceState(null, "", location.pathname + (q ? "?" + q : "") + location.hash);
  }
  return key;
}

function parseEngineUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return (url.origin + url.pathname).replace(/\/+$/, "");
  } catch {
    return null;
  }
}

// Checkpoints come from the recorded frames, not from fixed indexes.
function computeCheckpoints() {
  if (!frames.length) return [];
  const firstFrame = test => frames.findIndex(f => test(f.state));
  let cut = firstFrame(s => !s.railPending && s.agents.some(a => a.status === "cut" && Number(a.realAllocation) === 0));
  if (cut < 0) cut = firstFrame(s => s.agents.some(a => a.status === "cut"));
  const cutAgent = cut >= 0 ? frames[cut].state.agents.find(a => a.status === "cut") : null;
  let settle = firstFrame(s => s.round.phase === "settled" && (s.scorecards?.length || 0) > 0);
  if (settle < 0) settle = frames.length - 1;
  return [
    {key:"evaluate", frame:firstFrame(s => s.round.phase === "evaluation"), title:"Paper evaluation", text:"Agents trade on paper accounts."},
    {key:"fund", frame:firstFrame(s => !s.railPending && s.agents.some(a => a.status === "funded" && Number(a.realAllocation) > 0)), title:"Agents funded", text:"Qualified agents receive test tokens on BNB Smart Chain testnet."},
    {key:"block", frame:firstFrame(s => (s.events || []).some(e => e.type === "decision" && e.decision?.approved === false)), title:"Order blocked", text:"See which checks rejected the order."},
    {key:"cut", frame:cut, title:"Agent cut", text:cutAgent ? `${cutAgent.name} loses its allocation.` : "The risk manager cuts an agent."},
    {key:"settle", frame:settle, title:"Round settled", text:"Review final allocations in Capital."}
  ].filter(c => c.frame >= 0).sort((a,b) => a.frame - b.frame);
}

// Status changes first; the allocation follows when the transaction lands.
function allocPending(a, s) {
  const alloc = Number(a.realAllocation);
  return Boolean(s?.railPending) && ((a.status === "funded" && alloc === 0) || (a.status === "cut" && alloc > 0));
}

function currentState() {
  return isLive ? live.state : frames[idx]?.state ?? null;
}

function agentName(id, s = currentState()) {
  return s?.agents?.find(a => a.agentId === id)?.name || names[id] || id;
}

function assetLabel(s) {
  const asset = s?.railState?.asset;
  return !asset || asset === "tusd" ? "tUSD" : asset.toUpperCase();
}

function safeUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : null;
}

function txLink(url, hash, text) {
  const href = safeUrl(url);
  const label = esc(text || (hash ? hash.slice(0,12) : "View transaction"));
  return href ? `<a class="tx-link mono" href="${esc(href)}" target="_blank" rel="noopener">${label}</a>` : `<span class="dim mono">${label}</span>`;
}

const sentence = text => /[.!?]$/.test(text) ? text : text + ".";

function capitalNote(s) {
  if (isMock) return "Mock data. Capital, transactions, Cournot results and scorecards are simulated.";
  return s?.rail === "local"
    ? "Paper trades. Capital moves on a local ledger, not on chain."
    : "Paper trades. Capital is test tokens on BNB Smart Chain testnet.";
}

function sourceLabel(s) {
  if (isProduct) {
    if (!s) return live.online === false ? "The live desk is not reachable right now." : "Connecting to the live desk.";
    return "Live desk on BNB Smart Chain testnet. Agents trade on paper at live prices; rounds run back to back.";
  }
  if (isLive) {
    if (!engineUrl) return "Live engine address is not a valid http or https URL.";
    if (!s) return live.online === false ? `Live engine at ${engineUrl} is offline.` : `Connecting to the live engine at ${engineUrl}.`;
    return `Live engine at ${engineUrl}, mode ${s.mode}.`;
  }
  if (isMock) return "Mock data for design review. Not a real round.";
  return recording.label || "Recorded round.";
}

function headerPill(s) {
  if (isProduct) {
    if (!s || live.online === false) return `Live<span class="mode-network"> / ${live.online === null ? "connecting" : "offline"}</span>`;
    return 'Live<span class="mode-network"> / BNB testnet</span>';
  }
  if (isLive) {
    if (!s || live.online === false) return `Live engine<span class="mode-network"> / ${live.online === null && engineUrl ? "connecting" : "offline"}</span>`;
    return `Live engine<span class="mode-network"> / mode: ${esc(s.mode)}</span>`;
  }
  if (isMock) return 'Mock data<span class="mode-network"> / BNB testnet</span>';
  if (pausedReplay) return 'Desk paused<span class="mode-network"> / replay</span>';
  return 'Recording<span class="mode-network"> / BNB testnet</span>';
}

function lineIcon(name) {
  if (!Object.hasOwn(iconPaths,name)) return "";
  return `<svg class="line-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${iconPaths[name]}"/></svg>`;
}

function go(p) {
  const changed = page !== p;
  page = p;
  location.hash = p;
  render();
  window.scrollTo(0, 0);
  if (changed) app.querySelector("h1")?.focus({preventScroll:true});
}

function jump(i) {
  if (isLive || !frames[i]) { go("desk"); return; }
  const changed = page !== "desk";
  idx = i;
  selectedOrder = null;
  page = "desk";
  location.hash = "desk";
  render();
  if (changed) {
    window.scrollTo(0, 0);
    app.querySelector("h1").focus({preventScroll:true});
  } else {
    const label = checkpoints.find(c => c.frame === i)?.title;
    if (label) announcement.textContent = `${label}, frame ${i + 1} of ${frames.length}.`;
  }
}

function choose(id) {
  selected = id;
  selectedOrder = null;
  render();
  announceSelection();
}

function chooseOrder(id, agent) {
  selected = agent;
  selectedOrder = id;
  render();
  announceSelection();
}

// Playback follows the recorded `at` times, with long gaps compressed to 1.5 s.
function frameDelay(i) {
  const gap = Number(frames[i + 1]?.at) - Number(frames[i]?.at);
  return Number.isFinite(gap) ? Math.min(1500, Math.max(350, gap)) : 950;
}

function scheduleNext() {
  timer = setTimeout(() => {
    if (idx < frames.length - 1) idx++;
    else if (pausedReplay) idx = 0;
    if (idx >= frames.length - 1 && !pausedReplay) timer = null;
    else scheduleNext();
    render();
  }, idx >= frames.length - 1 && pausedReplay ? 6000 : frameDelay(idx));
}

function play() {
  selectedOrder = null;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  } else {
    if (idx === frames.length - 1) idx = 0;
    scheduleNext();
  }
  render();
}

function announceSelection() {
  const result = app.querySelector(".order-state");
  const orderId = app.querySelector(".order-id");
  announcement.textContent = result
    ? `Order inspector, ${agentName(selected)}. ${orderId.textContent}. ${result.textContent.trim()}.`
    : `No orders for ${agentName(selected)} yet.`;
}

function history(a) {
  return a.equityHistory?.length ? a.equityHistory : [a.equityUsd];
}

function chart(ag, tick) {
  const all = ag.flatMap(history);
  const padding = Math.max((Math.max(...all) - Math.min(...all)) * 0.15, 25);
  const lo = Math.floor((Math.min(...all) - padding) / 25) * 25;
  const hi = Math.ceil((Math.max(...all) + padding) / 25) * 25;
  const range = hi - lo || 1;
  const marks = Array.from({length:5}, (_, i) => ({
    y: 16 + i * 43, label: usd(hi - range * i / 4)
  }));
  const lines = marks.map(({y}) => `<path class="gridline" d="M0 ${y}H580" vector-effect="non-scaling-stroke"/>`).join("");
  const ticks = marks.map(({y,label}) => `<span style="top:${y / 2}%">${label}</span>`).join("");
  const paths = ag.map((a,i) => {
    const v = history(a);
    const points = v.map((x,j) => `${j * 580 / Math.max(1,v.length - 1)},${16 + (hi - x) / range * 172}`).join(" ");
    return `<polyline class="series" points="${points}" stroke="${colors[i]}"/>`;
  }).join("");
  const label = `Paper equity in US dollars, from round start to tick ${tick}. ${ag.map(a => `${a.name} ${usd(a.equityUsd)}`).join(", ")}.`;
  return `<figure class="chart" role="img" aria-label="${esc(label)}">
    <svg aria-hidden="true" viewBox="0 0 580 200" preserveAspectRatio="none">${lines}${paths}</svg>
    <div class="chart-axis" aria-hidden="true">${ticks}</div>
    <div class="chart-x" aria-hidden="true"><span>Round start</span><span>Tick ${esc(tick)}</span></div>
  </figure>`;
}

function landingPreview(preview) {
  if (!preview) {
    return `<section class="feature" aria-labelledby="preview-title">
      <div class="feature-top"><h2 id="preview-title">Agent performance</h2><span>Live engine</span></div>
      <p class="source-note">${esc(sourceLabel(null))}</p>
      <a class="quiet-link" href="#desk" data-page="desk">Open desk ${arrow}</a>
    </section>`;
  }
  const blocked = (preview.events || []).some(e => e.type === "decision" && e.decision?.approved === false);
  const jumpAttr = isLive ? 'data-page="desk"' : `data-jump="${blockFrame}"`;
  const tag = isLive ? "Live engine" : pausedReplay ? "Latest recorded round" : blocked ? "Block checkpoint" : "Latest frame";
  return `<section class="feature" aria-labelledby="preview-title">
        <div class="feature-top"><h2 id="preview-title">Agent performance</h2><span>${tag}</span></div>
        <div class="feature-content">
          <div class="preview-head"><div><span class="preview-label">Total paper equity</span><div class="huge">${money(preview.agents.reduce((n,a) => n + a.equityUsd,0))}</div></div>
          <button type="button" class="quiet-link text-button" ${jumpAttr}>Inspect desk ${arrow}</button></div>
          <div class="preview-chart">${chart(preview.agents, preview.round.tick ?? 0)}</div>
          <table class="ledger preview-table">
            <caption class="visually-hidden">Agent paper performance${blocked && !isLive ? " at the order block checkpoint" : ""}</caption>
            <thead class="visually-hidden"><tr><th scope="col">Agent and status</th><th scope="col">Paper return</th></tr></thead>
            <tbody>${preview.agents.map(a => `<tr><th scope="row"><span class="preview-agent">${esc(a.name)}</span><span class="preview-status">${esc(a.status)}</span></th><td class="preview-return ${a.pnlPct >= 0 ? "green" : "red"}">${pct(a.pnlPct)}</td></tr>`).join("")}</tbody>
          </table>
        </div>
        ${blocked ? `<div class="preview-alert"><strong class="red">Order blocked</strong><button type="button" class="quiet-link text-button" ${jumpAttr}>Inspect order ${arrow}</button></div>` : ""}
      </section>`;
}

function landing() {
  const preview = isLive ? live.state : frames[Math.max(0, blockFrame)]?.state;
  const paperSize = preview?.config?.paperAccountUsd;
  const hasFund = Boolean(preview?.fund);
  const heroNote = pausedReplay
    ? "Beta on BNB Smart Chain testnet. Live data is paused for now because we reached our data credit limit, so the desk page replays the latest recorded round. We switch it back on for the live demo, or as soon as we have more credits."
    : "Beta on BNB Smart Chain testnet. The desk is live: agents trade on paper at live prices, and rounds run back to back.";
  return `<div class="landing">
    <section class="hero" aria-labelledby="landing-title">
      <div class="hero-copy">
        <p class="hero-network source-note">${esc(isProduct || pausedReplay ? heroNote : sourceLabel(preview))}</p>
        <h1 id="landing-title" tabindex="-1">Capital has <span>a cutline.</span></h1>
        <p class="hero-lead">A prop desk for AI trading agents.</p>
        <p class="hero-description">Agents qualify on paper accounts before receiving test-token capital. Every order runs through six risk checks, including liquidity, price agreement and event risk.</p>
        <div class="hero-actions"><a class="primary" href="#agents" data-page="agents">Apply as an agent ${arrow}</a><a class="secondary" href="#vault" data-page="vault">Back the desk ${arrow}</a></div>
        <p class="hero-watch"><a class="quiet-link" href="#desk" data-page="desk">${pausedReplay ? "Watch the latest round" : "Watch the desk live"} ${arrow}</a></p>
      </div>
      <figure class="hero-visual">
        <img src="@@asset:cutline-hero.jpg@@" alt="" width="1440" height="1080" fetchpriority="high">
      </figure>
    </section>
    ${isMock ? "" : betaFigures()}
    ${isMock ? "" : betaAudiences()}
    <section class="strip" aria-labelledby="sources-title"><h2 id="sources-title">Data sources</h2><div class="integrations">${assetLogos}</div></section>
    <div class="landing-secondary">
    <section class="lifecycle-section" aria-labelledby="funding-title">
      <h2 class="section-title" id="funding-title" tabindex="-1">How funding works</h2>
      <ol class="lifecycle" role="list">
        ${[
          ["evaluate", "Evaluate", paperSize ? `Agents qualify on ${usd(paperSize)} paper accounts.` : "Agents qualify on paper accounts."],
          ["fund", "Fund", "Qualified agents receive test tokens from DeskVault." + (hasFund ? " Depositors can back the desk through a vault contract on testnet." : "")],
          ["protect", "Protect", "Six checks screen each order. Rule breaches can trigger a cut."],
          ["settle", "Settle", "At round close, the desk returns capital and writes agent scorecards."]
        ].map(([icon,title,detail],i) => `<li><div class="step-visual" aria-hidden="true">${lineIcon(icon)}<span class="step">0${i + 1}</span></div><h3>${title}</h3><p>${detail}</p></li>`).join("")}
      </ol>
    </section>
      ${landingPreview(preview)}
    </div>
    ${isMock ? '<footer class="foot">Cutline / Agent capital</footer>' : betaFooter()}
  </div>`;
}

function agentTable(agents, asset) {
  return `<div class="table-scroll" tabindex="0" role="region" aria-label="Agent performance table" data-focus-key="agent-scroll" data-scroll-key="agents">
    <table class="ledger agents-table">
      <thead><tr><th scope="col">Agent</th><th scope="col">Status</th><th scope="col" class="numeric">Paper equity (USD)</th><th scope="col" class="numeric">Paper return</th><th scope="col" class="numeric">Drawdown</th><th scope="col" class="numeric">Allocation (${esc(asset)})</th></tr></thead>
      <tbody>${agents.map((a,i) => {
        const active = selected === a.agentId;
        const status = a.status === "cut" ? "red" : a.status === "funded" ? "green" : "blue";
        return `<tr class="${active ? "selected" : ""}" data-select="agent" data-agent="${esc(a.agentId)}" style="--agent-mark:${colors[i] || "var(--muted)"}">
          <th scope="row" class="row-cell"><button type="button" class="row-button" aria-controls="inspector" aria-pressed="${active}" data-focus-key="agent-${esc(a.agentId)}">${lineIcon(a.agentId)}<span>${esc(a.name)}</span>${active ? arrow : ""}</button></th>
          <td><span class="status ${status}">${esc(a.status)}</span>${a.rogue ? '<span class="rogue-tag">Rogue mode (demo control)</span>' : ""}</td>
          <td class="numeric">${money(a.equityUsd)}</td>
          <td class="numeric ${a.pnlPct >= 0 ? "green" : "red"}">${pct(a.pnlPct)}</td>
          <td class="numeric ${a.drawdownPct >= 6 ? "red" : ""}">${pct(a.drawdownPct)}</td>
          <td class="numeric">${Number(a.realAllocation).toFixed(3)}${allocPending(a, currentState()) ? '<span class="alloc-pending">transaction pending</span>' : ""}</td>
        </tr>`;
      }).join("")}</tbody>
    </table>
  </div>`;
}

function orderTable(decisions, activeId) {
  return `<div class="orderscroll" tabindex="0" role="region" aria-label="Order activity table" data-focus-key="order-scroll" data-scroll-key="orders">
    <table class="ledger orders-table">
      <thead><tr><th scope="col">Agent</th><th scope="col">Side / asset</th><th scope="col" class="numeric">Paper notional (USD)</th><th scope="col">Decision</th></tr></thead>
      <tbody>${decisions.slice().reverse().map(e => {
        const {order, decision} = e;
        const agent = agentName(order.agentId);
        const active = activeId === order.id;
        const side = `${order.side.toUpperCase()} ${order.symbol}`;
        return `<tr class="${active ? "selected" : ""}" data-select="order" data-order="${esc(order.id)}" data-agent="${esc(order.agentId)}">
          <th scope="row" class="row-cell"><button type="button" class="row-button" aria-controls="inspector" aria-pressed="${active}" aria-label="${esc(`${agent}, ${side}, ${order.id}`)}" data-focus-key="order-${esc(order.id)}">${esc(agent)}${active ? arrow : ""}</button></th>
          <td>${esc(side)}</td><td class="numeric">${usd(order.notionalUsd)}</td>
          <td class="${decision.approved ? "green" : "red"}">${decision.approved ? "Approved" : "Blocked"}</td>
        </tr>`;
      }).join("") || '<tr><td colspan="4">No orders yet</td></tr>'}</tbody>
    </table>
  </div>`;
}

function eventSourceLabel(ev) {
  if (isMock) return "Cournot mock";
  return ev?.live ? "Cournot, live call" : "Cournot, cached proof";
}

function inspector(d, dec, rejected, ev, cour, m, evidenceOpen) {
  const checks = d ? [...d.decision.checks].sort((a,b) => Number(a.pass) - Number(b.pass)) : [];
  const failed = checks.filter(check => !check.pass).length;
  return `<section class="surface inspector" data-scroll-key="inspector" id="inspector" aria-labelledby="inspector-title">
    <button class="inspector-close" data-focus-key="close-inspector" type="button" data-close-inspector>Close</button><div class="sectionhead"><h2 id="inspector-title" tabindex="-1" data-focus-key="inspector">Order inspector</h2><span class="dim small">${rejected.length} blocked / ${dec.length} paper orders</span></div>
    ${d ? `<div class="inspector-summary ${d.decision.approved ? "is-approved" : "is-blocked"}">
      <div class="order-meta"><b>${esc(agentName(d.order.agentId))}</b><span class="mono order-id">${esc(d.order.id)}</span></div>
      <div class="order-state"><strong class="${d.decision.approved ? "green" : "red"}">${d.decision.approved ? "Approved" : "Blocked"}</strong>
        <span>${esc(d.order.side.toUpperCase())} ${esc(d.order.symbol)} / ${usd(d.order.notionalUsd)} paper</span></div>
      ${checks.length ? `<div class="risk-summary">
        <div class="risk-segments" aria-hidden="true">${checks.map(({pass}) => `<span class="${pass ? "pass" : "fail"}"></span>`).join("")}</div>
        <span>${failed ? `${failed} of ${checks.length} checks failed` : `All ${checks.length} checks passed`}</span>
      </div>` : ""}
      <details class="order-rationale" data-disclosure="rationale"><summary data-focus-key="strategy-rationale">Strategy rationale</summary><p>${esc(d.order.rationale)}</p></details>
    </div>
    <ul class="check-list" role="list" aria-label="Order risk checks">
      ${checks.map(c => `<li class="check ${c.pass ? "pass" : "fail"}"><svg class="flag ${c.pass ? "green" : "red"}" viewBox="0 0 16 16" aria-hidden="true"><path d="${c.pass ? checkIcons.pass : checkIcons.fail}" fill="none" stroke="currentColor" stroke-width="2"/></svg>
        <div>${c.pass ? `<details data-check="${esc(c.name)}"><summary data-focus-key="check-${esc(c.name)}">` : ""}<b class="check-title">${esc(c.name.replaceAll("-"," "))}</b> <span class="source">/ ${esc(c.source)}</span><span class="visually-hidden"> ${c.pass ? "Passed." : "Failed."}</span>${c.pass ? '</summary>' : ''}<p>${esc(c.detail)}</p>${c.pass ? '</details>' : ''}</div>
      </li>`).join("")}
    </ul>` : `<div class="inspector-summary"><b>${esc(agentName(selected))}</b><p class="dim small">No orders for this agent yet.</p></div>`}
    <div class="event"><h3>Event risk <span class="dim">/ ${esc(eventSourceLabel(ev))}</span></h3>
      ${ev ? `<p class="claim">${esc(ev.claim)}</p>
        <div class="event-stats">
          <div><span class="meta-label">Probability</span><div class="value">${(ev.cournotProbability * 100).toFixed(1)}%</div></div>
          <div><span class="meta-label">Venue price</span><div class="value">${ev.venuePrice == null ? "N/A" : (ev.venuePrice * 100).toFixed(1) + "¢"}</div></div>
          <div><span class="meta-label">Budget retained</span><div class="value blue">${m.toFixed(0)}%</div></div>
        </div>
        <div class="budget" aria-hidden="true"><i style="width:${m}%"></i></div>
        ${cour ? `<div class="event-example"><p class="small dim">Latest event-budget rejection / ${esc(agentName(cour.order.agentId))} / ${esc(cour.order.id)}</p><p class="small red">${esc(cour.decision.checks.find(c => c.name === "event-budget")?.detail)}</p></div>` : ""}
        <details class="evidence" ${evidenceOpen ? "open" : ""}>
          <summary data-focus-key="evidence">${isMock ? "Evidence and request ID (mock)" : ev.requestId ? "Evidence and request ID" : "Evidence"}</summary>
          ${ev.requestId ? `<p class="mono">${esc(ev.requestId)}</p>` : ""}
          ${(ev.sources || []).map(e => {
            const href = safeUrl(e.url);
            const title = href ? `<a href="${esc(href)}" target="_blank" rel="noopener"><b>${esc(e.title)}</b></a>` : `<b>${esc(e.title)}</b>`;
            return `<p>${title}${e.snippet ? ` · ${esc(e.snippet)}` : ""}</p>`;
          }).join("")}
        </details>` : '<p class="dim">No assessment available.</p>'}
    </div>
  </section>`;
}

function capitalLedger(s, alloc) {
  const asset = assetLabel(s);
  const total = Object.values(alloc).reduce((n,v) => n + Number(v || 0), 0);
  const potLabel = isMock ? "BNB Chain testnet mock" : s.rail === "local" ? "Local ledger, not on chain" : "Test tokens on BNB Smart Chain testnet";
  const receipt = r => `<div class="receipt"><b>${esc(r.kind)}</b> · ${esc(r.memo === "final split paid out" ? "Round closed. Final split settled on-chain." : (r.memo || "Vault session opened"))} ${r.offchain ? '<span class="dim">(local ledger, no transaction)</span>' : txLink(r.explorerUrl, r.txHash)}${isMock ? ' <span class="dim mono">(mock)</span>' : ""}</div>`;
  const scorecard = c => `<div class="receipt green">${isMock ? "Mock scorecard recorded" : "Scorecard written on chain"} ${txLink(c.explorerUrl, c.txHash)}</div>`;
  const links = s.onchainLinks || [];
  return `<section class="surface vault" id="capital-ledger" aria-labelledby="ledger-title">
    <div class="sectionhead"><h2 class="icon-heading" id="ledger-title" tabindex="-1" data-focus-key="ledger">${lineIcon("fund")}Capital ledger</h2><span class="small dim">${esc(potLabel)}</span></div>
    <div class="vaultbody">
      <div class="eventrow"><div class="value">${esc(total ? String(Number(total.toFixed(6))) : s.config.realPot)} ${esc(asset)}</div><span class="small dim">Vault allocation</span></div>
      <div class="bar" aria-hidden="true">${Object.entries(alloc).filter(([k,v]) => Number(v) > 0).map(([k,v],i) => `<i style="flex:${Number(v)};background:${["#737b94",...colors][i % 4]}" title="${esc(k)}"></i>`).join("")}</div>
      <div class="legend">${Object.entries(alloc).filter(([k]) => k !== "risk").map(([k,v]) => `<span>${esc(k === "desk" ? names.desk : agentName(k, s))} <b>${Number(v).toFixed(3)}</b></span>`).join("")}</div>
      ${(s.receipts || []).slice().reverse().map(receipt).join("")}
      ${(s.scorecards || []).map(scorecard).join("")}
      ${links.length ? `<details class="contracts" data-disclosure="contracts"><summary data-focus-key="contracts">Contracts and deployments (${links.length})${isMock ? " (mock)" : ""}</summary>
        <ul role="list">${links.map(l => `<li>${esc(l.label)} ${txLink(l.explorerUrl, l.txHash)}</li>`).join("")}</ul>
      </details>` : ""}
    </div>
  </section>`;
}

// Mid-round the vault contract holds only what is not out in the round; count the round's capital at cost.
function fundAssets(fund) {
  const a = Number(fund.totalAssets) + (fund.roundActive ? Number(fund.roundPot) : 0);
  return String(Math.round(a * 1e6) / 1e6);
}
function fundSharePrice(fund) {
  const sh = Number(fund.totalShares);
  return sh > 0 ? (Number(fundAssets(fund)) / sh).toFixed(6) : "1.000000";
}

function fundVault(fund) {
  if (!fund) return "";
  const href = safeUrl(fund.explorerUrl);
  return `<section class="surface vault fund-vault" id="depositor-vault" aria-labelledby="fund-title">
    <div class="sectionhead"><h2 class="icon-heading" id="fund-title" tabindex="-1">${lineIcon("protect")}Depositor vault <span class="fund-sub">(DeskFund, testnet)</span></h2>${href ? `<a class="quiet-link" href="${esc(href)}" target="_blank" rel="noopener">View contract on testnet explorer ${arrow}</a>` : ""}</div>
    <dl class="fund-stats">
      <div><dt>Depositor assets</dt><dd>${esc(fundAssets(fund))} <span class="unit">tUSD</span></dd>${fund.roundActive ? `<p class="fund-note">Includes ${esc(fund.roundPot)} tUSD out in the open round, at cost.</p>` : ""}</div>
      <div><dt>Shares</dt><dd>${esc(fund.totalShares)}</dd></div>
      <div><dt>Share price</dt><dd>${esc(fundSharePrice(fund))} <span class="unit">tUSD</span></dd>${fund.roundActive ? '<p class="fund-note">Settles when the round closes.</p>' : ""}</div>
      <div><dt>Loss reserve</dt><dd>${esc(fund.reserve)} <span class="unit">tUSD</span></dd><p class="fund-note">Evaluation fees fill the reserve. It pays before depositors.</p></div>
      <div><dt>Protocol fees</dt><dd>${esc(fund.protocolFees)} <span class="unit">tUSD</span></dd></div>
    </dl>
    ${fund.roundActive ? `<p class="fund-round">Capital in this round: <b>${esc(fund.roundPot)} tUSD</b></p>` : ""}
  </section>`;
}

function demoControls() {
  const current = checkpoints.findLastIndex(c => c.frame <= idx);
  const noun = isMock ? "demo" : "replay";
  return `<details class="demo-tools" data-disclosure="demo">
    <summary data-focus-key="demo-controls">${isMock ? "Demo controls" : "Replay controls"}<span class="demo-chevron" aria-hidden="true"></span></summary>
    <section class="demo-panel" aria-labelledby="demo-title">
      <h2 id="demo-title">${isMock ? "Demo scenarios" : "Recorded round"}</h2>
      <p>${isMock ? "Jump to a moment in the mock run." : "Jump to a moment in the recorded round."}</p>
      <ol class="demo-scenarios" role="list">${checkpoints.map((c,step) => `<li>
        <button type="button" aria-pressed="${current === step}" data-focus-key="checkpoint-${c.frame}" data-jump="${c.frame}">
          <span class="demo-number" aria-hidden="true">0${step + 1}</span>
          <span><strong>${esc(c.title)}</strong><small>${esc(c.text)}</small></span>
        </button>
      </li>`).join("")}</ol>
      <div class="demo-playback">
        <button type="button" data-action="play" data-focus-key="replay">${timer ? pauseIcon : playIcon}${timer ? `Pause ${noun}` : `Play ${noun}`}</button>
        <div class="demo-progress"><progress aria-label="${isMock ? "Demo" : "Replay"} playback progress" value="${idx + 1}" max="${frames.length}"></progress><span>${idx + 1} / ${frames.length} frames</span></div>
      </div>
    </section>
  </details>`;
}

function operatorControls(s) {
  const symbols = Object.keys(s.snapshot?.marks || {});
  if (!operator.shockSymbol || !symbols.includes(operator.shockSymbol)) operator.shockSymbol = symbols.includes("CAKE") ? "CAKE" : symbols[0] || "";
  if (!s.agents.some(a => a.agentId === operator.rogueAgent)) operator.rogueAgent = s.agents[0]?.agentId || "";
  const option = (value, label, current) => `<option value="${esc(value)}" ${value === current ? "selected" : ""}>${esc(label)}</option>`;
  const button = (action, label) => `<button type="button" data-control="${action}" data-focus-key="control-${action}" ${live.busy || !live.online ? "disabled" : ""}>${label}</button>`;
  return `<details class="demo-tools operator-tools" data-disclosure="operator">
    <summary data-focus-key="operator-controls">Operator controls<span class="demo-chevron" aria-hidden="true"></span></summary>
    <section class="demo-panel operator-panel" aria-labelledby="operator-title">
      <h2 id="operator-title">Operator controls</h2>
      <p>Actions go to the live engine${isProduct ? "" : ` at ${esc(engineUrl)}`}.</p>
      <div class="operator-row">${button("start","Start")}${button("pause","Pause")}${button("reset","Reset")}${button("close-round","Close round")}</div>
      <div class="operator-row">
        <label>Agent <select data-op="rogueAgent" data-focus-key="op-rogue-agent">${s.agents.map(a => option(a.agentId, a.name, operator.rogueAgent)).join("")}</select></label>
        ${button("rogue","Switch to rogue mode")}
      </div>
      <div class="operator-row">
        <label>Symbol <select data-op="shockSymbol" data-focus-key="op-shock-symbol">${symbols.map(sym => option(sym, sym, operator.shockSymbol)).join("")}</select></label>
        <label>Move (%) <input type="number" inputmode="numeric" step="1" min="-90" max="90" value="${esc(operator.shockPct)}" data-op="shockPct" data-focus-key="op-shock-pct"></label>
        ${button("shock","Simulate shock")}
      </div>
      <p class="operator-status" role="status">${esc(live.message)}</p>
    </section>
  </details>`;
}

async function sendControl(name) {
  if (!engineUrl || live.busy) return;
  let body;
  if (name === "rogue") body = {action:"rogue", agentId:operator.rogueAgent};
  else if (name === "shock") {
    const value = Number(operator.shockPct);
    if (!operator.shockSymbol || !Number.isFinite(value) || value === 0) {
      live.message = "Choose a symbol and a non-zero move.";
      render();
      return;
    }
    body = {action:"shock", symbol:operator.shockSymbol, pct:value};
  } else body = {action:name};
  live.busy = true;
  live.message = `Sending ${name}.`;
  render();
  try {
    const headers = {"content-type":"application/json"};
    if (controlKey) headers.authorization = `Bearer ${controlKey}`;
    const response = await fetch(`${engineUrl}/api/control`, {method:"POST", headers, body:JSON.stringify(body)});
    if (!response.ok) {
      let msg = `Engine answered HTTP ${response.status}`;
      try { msg = (await response.json()).error || msg; } catch { /* keep default */ }
      throw new Error(msg);
    }
    live.message = `Engine accepted ${name}.`;
  } catch (error) {
    live.message = `Control failed: ${error.message}`;
  }
  live.busy = false;
  render();
}

function offlineDesk() {
  const reason = !engineUrl
    ? `The engine address "${esc(engineParam)}" is not a valid http or https URL.`
    : isProduct ? (live.online === null ? "Connecting to the live desk." : "The live desk is not reachable right now. The page keeps retrying.")
    : live.online === null ? `Connecting to ${esc(engineUrl)}.` : `Could not reach ${esc(engineUrl)}. The page keeps retrying.`;
  return `<div class="workspace">
    <div class="round-bar">
      <div class="round-context">
        <h1 id="desk-title" tabindex="-1">Live engine</h1>
        <span class="round-status" data-phase="offline">${live.online === null && engineUrl ? "Connecting" : "Offline"}</span>
      </div>
    </div>
    <section class="offline-panel" aria-labelledby="offline-title">
      <h2 id="offline-title">${live.online === null && engineUrl ? "Waiting for the engine" : "Engine offline"}</h2>
      <p>${reason}</p>
      ${live.error ? `<p class="dim small mono">${esc(live.error)}</p>` : ""}
      ${isProduct ? "" : `<p><a class="quiet-link" href="${esc(location.pathname)}#desk">Open the recorded round instead ${arrow}</a></p>`}
    </section>
    <footer class="foot"><span>Cutline / Agent capital</span></footer>
  </div>`;
}

function roundTitle(s) {
  const match = /^round-(\d+)$/.exec(s.railState?.sessionId || "");
  return match ? `Round ${match[1]}` : `Round ${s.round.id}`;
}

function terminal(evidenceOpen) {
  const s = currentState();
  if (!s) return offlineDesk();
  const ag = s.agents;
  const asset = assetLabel(s);
  const alloc = s.railState?.allocations || {};
  const m = (s.eventMultiplier ?? 1) * 100;
  const events = s.events || [];
  const dec = events.filter(e => e.type === "decision");
  const rejected = dec.filter(e => !e.decision.approved);
  const d = dec.find(e => e.order.id === selectedOrder) || dec.filter(e => e.order.agentId === selected).at(-1);
  const ev = (s.snapshot?.eventRisk || []).filter(e => e.origin === "assessment" && e.polarity === "adverse").sort((a,b) => b.cournotProbability - a.cournotProbability)[0];
  const cour = rejected.filter(e => e.decision.checks.some(c => c.name === "event-budget" && !c.pass)).at(-1);
  const shocks = events.filter(e => e.type === "shock");
  const marks = Object.values(s.snapshot?.marks || {}).filter(a => marketSymbols.includes(a.symbol) || a.synthetic);
  const stale = isLive && live.online === false;
  const roundId = roundTitle(s) === `Round ${s.round.id}` ? "" : `<span class="round-id dim small">Round ID ${esc(s.round.id)}</span>`;

  return `<div class="workspace">
    <div class="round-bar">
      <div class="round-context">
        <h1 id="desk-title" tabindex="-1">${esc(roundTitle(s))}</h1>
        <span class="round-status" data-phase="${esc(s.round.phase)}">${esc(roundPhases[s.round.phase] || s.round.phase)}</span>
        ${roundId}
        ${shocks.map(e => `<span class="round-note">Simulated shock: ${esc(e.symbol)} ${e.pct > 0 ? "+" : ""}${esc(e.pct)}%</span>`).join("")}
      </div>
      ${isLive ? (canControl ? operatorControls(s) : "") : demoControls()}
    </div>
    <p class="source-note desk-source">${esc(sentence(sourceLabel(s)))} ${esc(capitalNote(s))}</p>
    ${pausedReplay ? `<p class="source-note desk-source paused-note">Live data is paused for now because we reached our data credit limit. We switch it back on for the live demo, or as soon as we have more credits.</p>` : ""}
    ${stale ? `<p class="offline-banner" role="status">Engine offline. Showing the last state received at ${esc(new Date(live.receivedAt).toLocaleTimeString())}. Retrying.</p>` : ""}
    <div class="desk-grid"><div class="desk-main">
    <section class="performance" aria-labelledby="equity-title">
      <div class="performance-top">
        <div class="performance-summary"><div><span class="meta-label">Total paper equity / USD</span><div class="paper-equity">${money(ag.reduce((n,a) => n + a.equityUsd,0))}</div></div>
          <dl class="summary-context"><div><dt class="meta-label">Funded agents</dt><dd>${ag.filter(a => a.status === "funded").length} <span class="unit">/ ${ag.length}</span></dd></div><div><dt class="meta-label">Risk budget</dt><dd>${m.toFixed(0)}<span class="unit">%</span></dd></div><div><dt class="meta-label">Held by desk</dt><dd>${Number(alloc.desk || 0).toFixed(3)} <span class="unit">${esc(asset)}</span></dd>${s.railPending ? '<span class="alloc-pending">transaction pending</span>' : ""}</div></dl>
        </div>
        <div class="performance-chart"><div class="chart-caption"><h2 id="equity-title" tabindex="-1">Agent paper equity / USD</h2></div>${chart(ag,s.round.tick ?? idx)}<div class="legend chart-legend">${ag.map((a,i) => `<span><i style="--swatch:${colors[i]}"></i>${esc(a.name)}</span>`).join("")}</div></div>
      </div>
      <div class="agent-metrics"><div class="agent-table-tools"><span class="small dim">Agents · Scroll for columns</span><a class="quiet-link" href="#orders-title" data-section="orders-title">Order activity</a></div>${agentTable(ag, asset)}</div>
      <div class="selection-hint"><a class="quiet-link" href="#inspector-title" data-section="inspector-title" data-focus-key="agent-inspector">View inspector ${arrow}</a></div>
    </section>
    <div class="orders-and-capital">
      <section class="surface orderbook" id="order-activity" aria-labelledby="orders-title"><div class="sectionhead"><h2 class="icon-heading" id="orders-title" tabindex="-1" data-focus-key="orders">${lineIcon("orders")}Order activity</h2><a class="quiet-link" href="#inspector-title" data-section="inspector-title" data-focus-key="order-inspector">Inspect selection ${arrow}</a></div>${orderTable(dec,d?.order.id)}</section>
      ${capitalLedger(s,alloc)}
      ${fundVault(s.fund)}
    </div>
    <section class="market" aria-label="Market prices and DEX liquidity">${marks.length ? marks.map(a => `<div><span class="small dim"><b class="market-label">${esc(a.symbol)}</b> / ${a.synthetic ? '<span class="simulated">Simulated stress test</span>' : a.agreement === "both" ? "Atlas checked" : "CMC only"}</span><strong>${a.cmcPrice < 10 ? "$" + Number(a.cmcPrice).toFixed(3) : usd(a.cmcPrice)}</strong><span class="small dim">DEX liquidity ${usd(s.snapshot.liquidity?.[a.symbol]?.dexLiquidityUsd || 0)}</span></div>`).join("") : '<div><span class="small dim">No market snapshot yet.</span></div>'}</section>
    </div>${inspector(d,dec,rejected,ev,cour,m,evidenceOpen)}</div>
    <button class="mobile-order-toggle" data-focus-key="mobile-order" type="button" data-open-inspector>Order details <strong>${d ? (d.decision.approved ? "Approved" : "Blocked") : "No orders"}</strong>${arrow}</button>
    <button class="inspector-backdrop" type="button" data-close-inspector aria-label="Close order details" tabindex="-1"></button>
    <footer class="foot"><span>Cutline / Agent capital</span></footer>
  </div>`;
}

function render() {
  const disclosureOpen = new Set(Array.from(app.querySelectorAll("[data-disclosure][open]"), el => el.dataset.disclosure));
  const checkOpen = new Set(Array.from(app.querySelectorAll("[data-check][open]"), el => el.dataset.check));
  const focusKey = document.activeElement?.dataset.focusKey;
  const evidenceOpen = app.querySelector(".evidence")?.open ?? false;
  const scrollPositions = new Map(Array.from(app.querySelectorAll("[data-scroll-key]"), el => [el.dataset.scrollKey,[el.scrollLeft,el.scrollTop]]));
  document.body.classList.toggle("terminal", page === "desk");
  document.body.dataset.workspace = deskView;
  document.body.dataset.source = isLive ? "live" : isMock ? "mock" : "recording";
  document.querySelector("#source-mode").innerHTML = headerPill(currentState());
  document.querySelectorAll(".desk-global-nav [data-workspace]").forEach(el => el.setAttribute("aria-pressed", String(el.dataset.workspace === deskView)));
  document.querySelector(".site-nav [data-page='home']").setAttribute("aria-current", page === "home" ? "page" : "false");
  document.querySelector(".site-nav [data-page='desk']").setAttribute("aria-current", page === "desk" ? "page" : "false");
  for (const p of ["agents","vault"]) document.querySelector(`.site-nav [data-page='${p}']`)?.setAttribute("aria-current", page === p ? "page" : "false");
  app.innerHTML = page === "desk" ? terminal(evidenceOpen) : page === "agents" ? agentsPage() : page === "vault" ? vaultPage() : landing();
  for (const el of app.querySelectorAll("[data-disclosure]")) el.open = disclosureOpen.has(el.dataset.disclosure);
  for (const el of app.querySelectorAll("[data-check]")) el.open = checkOpen.has(el.dataset.check);
  for (const el of app.querySelectorAll("[data-scroll-key]")) {
    const position = scrollPositions.get(el.dataset.scrollKey);
    if (position) el.scrollTo(...position);
  }
  if (document.body.classList.contains("inspector-open")) {
    const panel = app.querySelector(".inspector");
    panel?.setAttribute("role","dialog");
    panel?.setAttribute("aria-modal","true");
    document.querySelectorAll(".site-header,.desk-main,.round-bar").forEach(el => el.inert = true);
  }
  if (focusKey) {
    Array.from(app.querySelectorAll("[data-focus-key]")).find(el => el.dataset.focusKey === focusKey)?.focus({preventScroll:true});
  }
}

document.addEventListener("click", event => {
  const demo = app.querySelector(".demo-tools[open]");
  if (demo && !demo.contains(event.target)) demo.open = false;
  const link = event.target.closest("a[data-page], a[data-section]");
  if (link && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    if (link.dataset.page) go(link.dataset.page);
    else {
      const heading = document.getElementById(link.dataset.section);
      heading?.focus({preventScroll:true});
      heading?.scrollIntoView({block:"start"});
    }
    return;
  }
  const control = event.target.closest("[data-jump], [data-action='play'], [data-select], [data-control], button[data-page]");
  if (!control) return;
  if ("control" in control.dataset) sendControl(control.dataset.control);
  else if (control.dataset.page) go(control.dataset.page);
  else if ("jump" in control.dataset) jump(Number(control.dataset.jump));
  else if (control.dataset.action === "play") play();
  else if (control.dataset.select === "agent") choose(control.dataset.agent);
  else if (control.dataset.select === "order") chooseOrder(control.dataset.order, control.dataset.agent);
});

document.addEventListener("input", event => {
  const field = event.target.closest?.("[data-op]");
  if (field) operator[field.dataset.op] = field.value;
});

window.addEventListener("hashchange", () => {
  const next = ({"#desk":"desk","#agents":"agents","#vault":"vault","#home":"home","":"home"})[location.hash] ?? page;
  if (next !== page) {
    page = next;
    render();
    app.querySelector("h1")?.focus();
  }
});


let inspectorReturnKey = null;
function closeOrderDetails() {
  document.body.classList.remove("inspector-open");
  const panel = document.querySelector(".inspector");
  panel?.removeAttribute("role"); panel?.removeAttribute("aria-modal");
  document.querySelectorAll(".site-header,.desk-main,.round-bar").forEach(el => el.inert = false);
  if (inspectorReturnKey) Array.from(document.querySelectorAll("[data-focus-key]")).find(el => el.dataset.focusKey === inspectorReturnKey)?.focus({preventScroll:true});
}
function openOrderDetails(target) {
  if (!matchMedia("(max-width: 1000px)").matches) return;
  const panel = document.querySelector(".inspector");
  if (!panel) return;
  inspectorReturnKey = target?.dataset.focusKey || target?.querySelector("[data-focus-key]")?.dataset.focusKey || null;
  document.body.classList.add("inspector-open");
  panel.setAttribute("role","dialog"); panel.setAttribute("aria-modal","true");
  document.querySelectorAll(".site-header,.desk-main,.round-bar").forEach(el => el.inert = true);
  panel.querySelector("[data-close-inspector]").focus({preventScroll:true});
}
document.addEventListener("click", event => {
  if (event.target.closest("[data-close-inspector]")) {closeOrderDetails(); return;}
  const target = event.target.closest("[data-select], [data-open-inspector], a[data-section='inspector-title']");
  if (target) openOrderDetails(target);
});
document.addEventListener("keydown", event => {
  if (!document.body.classList.contains("inspector-open")) {
    const demo = app.querySelector(".demo-tools[open]");
    if (event.key === "Escape" && demo) {
      event.preventDefault();
      demo.open = false;
      demo.querySelector("summary").focus();
    }
    return;
  }
  if (event.key === "Escape") {event.preventDefault();closeOrderDetails();return;}
  if (event.key === "Tab") {
    const nodes = Array.from(document.querySelectorAll(".inspector button,.inspector a,.inspector summary")).filter(el => el.getClientRects().length);
    const first = nodes[0], last = nodes.at(-1);
    if (event.shiftKey && document.activeElement === first) {event.preventDefault();last?.focus();}
    if (!event.shiftKey && document.activeElement === last) {event.preventDefault();first?.focus();}
  }
});
window.addEventListener("resize", () => {if (!matchMedia("(max-width:1000px)").matches) closeOrderDetails();});
window.addEventListener("hashchange", () => {if (!document.querySelector(".inspector")) closeOrderDetails();});


document.addEventListener("click", event => {
  const tab = event.target.closest(".desk-global-nav [data-workspace]");
  if (!tab) return;
  closeOrderDetails();
  deskView = tab.dataset.workspace;
  render();
  window.scrollTo(0,0);
});

// Live mode: poll the engine about once a second. Without ?engine= the page makes no network calls.
function liveRender(statusChanged) {
  const editing = document.activeElement?.closest?.(".operator-panel") && document.activeElement.matches("select, input");
  if (editing) return;
  if (page === "desk" || statusChanged) render();
}

async function poll() {
  const wasOnline = live.online;
  const hadState = Boolean(live.state);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(`${engineUrl}/api/state`, {cache:"no-store", signal:controller.signal});
    if (!response.ok) throw new Error(`Engine answered HTTP ${response.status}`);
    const state = await response.json();
    if (!state || !state.round || !Array.isArray(state.agents)) throw new Error("The engine response is not a desk state.");
    live.state = state;
    live.online = true;
    live.error = "";
    live.receivedAt = Date.now();
  } catch (error) {
    live.online = false;
    live.error = error.name === "AbortError" ? "Request timed out." : error.message;
  }
  clearTimeout(timeout);
  liveRender(wasOnline !== live.online || hadState !== Boolean(live.state));
  setTimeout(poll, live.online ? (isProduct ? 2500 : 1000) : 3000);
}

if (pausedReplay && frames.length) idx = 0;
render();
if (!isMock) betaStart();
if (isLive && engineUrl) poll();
// The paused public page keeps the replay moving, on a loop.
if (pausedReplay && frames.length > 1) scheduleNext();
