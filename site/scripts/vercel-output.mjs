// Assembles .vercel/output (Build Output API v3) from dist/ for `vercel deploy --prebuilt`.
//   /                 the live desk (dist/index.html); /api/* is proxied to the engine at ENGINE_ORIGIN
//   /demo-<slug>      the unlisted demo page (noindex, linked from nowhere)
// The mock page and the raw recordings are not published.
// Usage: ENGINE_ORIGIN=http://<host>:8787 node scripts/vercel-output.mjs
import { readFile, readdir, rm, mkdir, copyFile, writeFile } from "node:fs/promises";

const origin = process.env.ENGINE_ORIGIN;
if (!origin || !/^https?:\/\/[^/]+$/.test(origin)) throw new Error("Set ENGINE_ORIGIN to the engine's origin, for example http://203.0.113.5:8787");
const site = new URL("../", import.meta.url);
const out = new URL(".vercel/output/", site);
const dist = new URL("dist/", site);

const slug = (await readFile(new URL(".demo-slug", site), "utf8")).trim();
const demo = `demo-${slug}.html`;
const files = await readdir(dist);
for (const f of ["index.html", demo]) if (!files.includes(f)) throw new Error(`dist/${f} is missing; run npm run build first`);

await rm(new URL("static/", out), { recursive: true, force: true });
await mkdir(new URL("static/", out), { recursive: true });
await copyFile(new URL("index.html", dist), new URL("static/index.html", out));
await copyFile(new URL(demo, dist), new URL(`static/${demo}`, out));

const config = {
  version: 3,
  routes: [
    { src: "/api/(state|health)", dest: `${origin}/api/$1`, headers: { "cache-control": "no-store" } },
    { src: "/api/control", methods: ["POST", "OPTIONS"], dest: `${origin}/api/control`, headers: { "cache-control": "no-store" } },
    { src: "/api/(.*)", status: 404 },
    { src: `/demo-${slug}`, dest: `/${demo}`, headers: { "x-robots-tag": "noindex, nofollow", "cache-control": "no-store" } },
    { src: "/demo-.*", status: 404 },
    { handle: "filesystem" },
    { src: "/.*", status: 404 }
  ]
};
await writeFile(new URL("config.json", out), JSON.stringify(config, null, 2));
console.log(`Packaged / (live desk, /api -> engine) and /demo-${slug} (unlisted) into .vercel/output`);
