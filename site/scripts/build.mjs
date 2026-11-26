// Builds three self-contained pages:
//   dist/index.html        the public product: the live desk, read through the site's /api proxy
//   dist/demo-<slug>.html  the unlisted demo page, replaying a real recorded round (DEMO_RECORDING, default run-live.json)
//   dist/mock.html         the designer's mock fixture (src/recording.json), clearly labelled as mock data, not deployed
// The demo slug lives in site/.demo-slug (git-ignored: the repo is public) or DEMO_SLUG.
// Uses only the Node standard library (Node 18 or later).
import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";

const src = new URL("../src/", import.meta.url);
const recordings = new URL("../recordings/", import.meta.url);
const dist = new URL("../dist/", import.meta.url);
const mimeByExtension = new Map([
  ["woff2","font/woff2"],
  ["ttf","font/ttf"],
  ["jpg","image/jpeg"],
  ["png","image/png"],
  ["svg","image/svg+xml"]
]);
// Only the mock fixture is pinned: it must stay the designer's exact 35-frame payload.
const mockDigest = "748106347ef54797d5b903c63f68da90a525a950de9b2d0ced2d04ce53eb0c90";

const [document, base, art, runtime, logos] = await Promise.all(
  ["index.html","base.css","art-direction.css","desk.js","integrations.html"].map(file =>
    readFile(new URL(file,src),"utf8")
  )
);
const mockRecording = await readFile(new URL("recording.json",src),"utf8");
if (createHash("sha256").update(mockRecording).digest("hex") !== mockDigest) {
  throw new Error("The mock recording differs from the handoff baseline.");
}
const realRecording = await readFile(new URL(process.env.DEMO_RECORDING || "run-live.json",recordings),"utf8");
const slugFile = new URL("../.demo-slug", import.meta.url);
let slug = process.env.DEMO_SLUG || (await readFile(slugFile,"utf8").catch(() => "")).trim();
if (!slug) {
  slug = randomBytes(9).toString("base64url");
  await writeFile(slugFile, slug + "\n");
}
if (!/^[A-Za-z0-9_-]{8,}$/.test(slug)) throw new Error("The demo slug must be 8 or more URL-safe characters.");
// The live page also carries the recorded round: it plays it, labelled as a replay, while the desk is paused.
const demoParsed = JSON.parse(realRecording);
const liveRecording = JSON.stringify({
  ...demoParsed,
  live: true,
  label: `Replay of a round recorded on BNB Smart Chain testnet, ${demoParsed.label.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/)?.[0] ?? "earlier"}. The live desk is paused right now.`
});

function checkRecording(text, name, expectMock) {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed.frames) || parsed.frames.length === 0) throw new Error(name + " has no frames.");
  for (const [i,frame] of parsed.frames.entries()) {
    if (typeof frame.at !== "number" || !frame.state?.round || !Array.isArray(frame.state.agents)) {
      throw new Error(name + " frame " + i + " does not match the DeskState recording shape.");
    }
  }
  if (Boolean(parsed.mock) !== expectMock) {
    throw new Error(name + (expectMock ? " must be marked mock: true." : " is marked mock but is used as the real recording."));
  }
  if (!expectMock && !parsed.label) throw new Error(name + " needs a label for the public page.");
  return parsed;
}

const joined = [document, base, art, runtime, logos].join("\n");
const tokenPattern = /@@asset:([a-z0-9.-]+)@@/gi;
const assetFiles = [...new Set([...joined.matchAll(tokenPattern)].map(match => match[1]))];
const assets = new Map(await Promise.all(assetFiles.map(async file => {
  const mime = mimeByExtension.get(file.split(".").at(-1));
  if (!mime) throw new Error("Unsupported asset format " + file);
  const bytes = await readFile(new URL("assets/" + file,src));
  return [file,"data:" + mime + ";base64," + bytes.toString("base64")];
})));

const inlineAssets = text => text.replace(tokenPattern, (_,file) => assets.get(file));
const script = inlineAssets(runtime).replace('"@@INTEGRATIONS@@"', () =>
  JSON.stringify(inlineAssets(logos.trim())).replaceAll("</script", "<\\/script")
);
// JSON inside <script type="application/json"> must not close the tag early.
const embed = text => text.replaceAll("</", "<\\/");

const pages = [
  {
    file: "index.html",
    recording: liveRecording,
    live: true,
    mock: false,
    description: "Cutline is a prop desk for AI trading agents on BNB Smart Chain testnet. Watch the live desk: paper trades at live prices, test-token capital, risk checks on every order."
  },
  {
    file: `demo-${slug}.html`,
    recording: realRecording,
    mock: false,
    unlisted: true,
    description: "Cutline demo: a recorded round on BNB Smart Chain testnet with paper trades and test-token capital."
  },
  {
    file: "mock.html",
    recording: mockRecording,
    mock: true,
    description: "Cutline is a prop desk for AI trading agents. This page replays mock data for design review."
  }
];

await mkdir(dist,{recursive:true});
for (const page of pages) {
  const parsed = page.live ? { ...checkRecording(page.recording, page.file, false), label: "live desk, with a replay while paused" } : checkRecording(page.recording, page.file, page.mock);
  const slots = {
    STYLES: inlineAssets(base + "\n" + art),
    RECORDING: embed(page.recording),
    RUNTIME: script
  };
  const built = inlineAssets(document)
    .replace("@@DESCRIPTION@@", page.description)
    .replace("</head>", page.unlisted || page.mock ? '<meta name="robots" content="noindex, nofollow">\n</head>' : "</head>")
    .replace(/<!-- (STYLES|RECORDING|RUNTIME) -->/g, (_,slot) => slots[slot]);
  await writeFile(new URL(page.file,dist),built);
  const kb = (Buffer.byteLength(built) / 1024).toFixed(0);
  console.log(`Built dist/${page.file} (${kb} KB) with ${parsed.frames.length} frames: ${parsed.label}${page.mock ? " (mock)" : ""}`);
}
