// Generates money/index.html from frontend/index.html.
//
//   node scripts/build-money.js
//
// mintd.money runs the same application as mintd.fun, pointed at Arc and
// wearing a different skin. Keeping a second 400KB copy by hand guarantees the
// two drift, and the one that drifts is the one nobody is looking at. So there
// is one source file and this transforms it.
//
// This is NOT a build step in the Netlify sense: the output is committed and
// Netlify still publishes a static folder with no command. Run this after
// editing frontend/index.html, exactly like running the stats indexer before
// pushing fresh numbers.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "frontend", "index.html");
const OUT = path.join(ROOT, "money", "index.html");
const LANDING = path.join(ROOT, "money", "landing.html");

let s = fs.readFileSync(SRC, "utf8");
const before = s.length;
const subs = [];
function sub(name, from, to, opts = {}) {
  const count = s.split(from).length - 1;
  if (count === 0 && !opts.optional) throw new Error(`build-money: pattern not found: ${name}`);
  if (count > 1 && !opts.all) throw new Error(`build-money: pattern matched ${count}x, expected 1: ${name}`);
  s = opts.all ? s.split(from).join(to) : s.replace(from, to);
  subs.push(`${name} (${count})`);
}

// ---------------------------------------------------------------- identity
sub("title", "<title>mintd.fun", "<title>mintd.money");
sub("meta description",
  'content="Launch, trade and earn on Stable and Arc. Memecoin launchpad, MINTR reserve token, tokenized gold and yield farms."',
  'content="Agentic treasury and liquidity infrastructure on Arc. Launch, trade and manage positions with agents that cannot choose a price."');
sub("wordmark",
  "<span>mintd<b>.fun</b><small>LAUNCH FOR $1</small></span>",
  "<span>mintd<b>.money</b><small>AGENTIC LIQUIDITY</small></span>");

// ------------------------------------------------------------------ chains
// Arc only. A chain switcher offering Stable would send someone to a different
// product on a different chain from a site that is meant to be one thing.
sub("default chain", 'return "stable";', 'return "arc-testnet";');
sub("NET fallback", "CHAINS[CHAIN_KEY] || CHAINS.stable", "CHAINS[CHAIN_KEY] || CHAINS['arc-testnet']");

// Point at MintdLaunchpad, the fully fixed pad, and drop the earlier ones.
// ArcLaunchpad carried the dead-prevrandao brick vector, and the v1 pad held a
// throwaway $MINTD from bring-up; surfacing either would imply an Arc MINTD
// exists (it does not) or route launches through the old code. Fresh start on
// the secure factory, so the community's first coin is genuinely token #0.
sub("arc pad", `      pad: "0xcF22a3E32dE43787881b9a87B5424E34F3BF65E6",
      oldPad: "0xd6fdA9A0Fd4b4ee724ab0c0B958a712E5bb37E96",`,
  `      pad: "0x6C8C1Ec953D64e01BEF454A5946A1Aae87914cfD",
      oldPad: null,`);

// Metadata registry follows the pad.
sub("arc registry", `meta: "0x09c419226e83A91323FDC170144526D8C4a39B75",`,
  `meta: "0x923FEFeD25E79bec3d5b127494e5955eDCBFC721",`);

// MINTR is deployed on Arc but is not part of this product yet.
sub("arc features",
  "features: { launch: true, swap: true, earn: false, mintr: true, gold: false, locker: true, burn: true, screener: true, bridge: false, agent: false },",
  "features: { launch: true, swap: true, earn: true, mintr: false, gold: false, locker: true, burn: true, screener: true, bridge: false, holders: false, agent: true },");

// The burn PAGE (the Furnace) works on Arc and stays. The burn STAT counts
// MINTD sent to the dead address, and there is no MINTD on Arc, so the tile is
// suppressed separately from the feature.
sub("burn stat tile", 'const tiles = { stMintrTvl: "mintr", stBurn: "burn" };',
  'const tiles = { stMintrTvl: "mintr", stBurn: "mintdStat" };');

// Drop Stable from the registry entirely so nothing can switch into it.
const stableStart = s.indexOf("  stable: {");
const arcStart = s.indexOf('  "arc-testnet": {');
if (stableStart === -1 || arcStart === -1 || arcStart < stableStart) {
  throw new Error("build-money: could not locate the CHAINS entries");
}
s = s.slice(0, stableStart) + s.slice(arcStart);
subs.push("removed the stable chain entry (1)");

// ------------------------------------------------------------------- theme
// mintd.fun is light by default with a dark variant. This product asks people
// to hand over funds, so it is dark-first and more restrained, matching
// money/landing.html. Both variables blocks are replaced so the light theme is
// not merely unused but absent.
// There are FOUR palette blocks in the source: an original pair and a later
// pair from the pons-inspired restyle that overrides it. Only the later pair is
// live. Patching the dead one changes nothing visible, which is exactly what
// happened first time round.
sub("active light palette",
  `    --bg: #ffffff; --panel: #ffffff; --panel2: #f2f5f9; --line: #e6ebf2;
    --ink: #0b1119; --dim: #6b7a8d; --green: #2f7fe0; --green2: #1f6bc9;
    --green-soft: #e8f1fd; --red: #e0483d; --radius: 14px;`,
  `    --bg: #07090c; --panel: #0d1116; --panel2: #131920; --line: #1b222b;
    --ink: #e8edf2; --dim: #8b98a8; --green: #4ade80; --green2: #22c55e;
    --green-soft: rgba(74,222,128,.1); --red: #f05252; --radius: 12px;`);

sub("active dark palette",
  `    --bg: #0a0d12; --panel: #12171f; --panel2: #161d26; --line: #1e2732;
    --ink: #f2f5f9; --dim: #8a97a8; --green: #4d9bf0; --green2: #6fb2f5;
    --green-soft: #10233a; --red: #ff6b5e;`,
  `    --bg: #07090c; --panel: #0d1116; --panel2: #131920; --line: #1b222b;
    --ink: #e8edf2; --dim: #8b98a8; --green: #4ade80; --green2: #22c55e;
    --green-soft: rgba(74,222,128,.1); --red: #f05252;`);

sub("legacy light palette",
  `    --bg: #f2f8f6; --panel: #ffffff; --panel2: #e8f2ee; --line: #d3e3dd;
    --ink: #1e1f24; --dim: #5f7a73; --green: #2f9c80; --green2: #5bccae;
    --green-soft: #dcf2ea; --gold: #b8891f; --gold-soft: #f8f0dc;
    --red: #c2453f; --radius: 6px; --mono: "SF Mono", ui-monospace, Menlo, monospace;`,
  `    --bg: #07090c; --panel: #0d1116; --panel2: #131920; --line: #1b222b;
    --ink: #e8edf2; --dim: #8b98a8; --green: #4ade80; --green2: #22c55e;
    --green-soft: rgba(74,222,128,.1); --gold: #f0a500; --gold-soft: rgba(240,165,0,.1);
    --red: #f05252; --radius: 8px; --mono: "SF Mono", ui-monospace, Menlo, monospace;`);

sub("legacy dark palette",
  `    --bg: #0d1917; --panel: #132320; --panel2: #1a2e29; --line: #24413a;
    --ink: #e6f4ef; --dim: #7fa39a; --green: #5bccae; --green2: #7fdcc3;
    --green-soft: #14332b; --gold: #e6bf52; --gold-soft: #2e2711;`,
  `    --bg: #07090c; --panel: #0d1116; --panel2: #131920; --line: #1b222b;
    --ink: #e8edf2; --dim: #8b98a8; --green: #4ade80; --green2: #22c55e;
    --green-soft: rgba(74,222,128,.1); --gold: #f0a500; --gold-soft: rgba(240,165,0,.1);`);

// ---------------------------------------------------------------- branding
// mintd.money has its own mark (money/logo.svg and the icon set rasterised from
// it), so the header image and the favicon point at the SVG rather than the
// launchpad's logo.png. Both header uses and the favicon are switched.
sub("header logo",
  `<img src="logo.png" alt="" style="width:34px;height:34px;border-radius:9px" onerror="this.style.display='none'" />`,
  `<img src="logo.svg" alt="" style="width:34px;height:34px;border-radius:9px" onerror="this.style.display='none'" />`);
sub("platform token avatar", `t.platform ? \`<img src="logo.png" onerror="this.remove()">\``,
  `t.platform ? \`<img src="logo.svg" onerror="this.remove()">\``);
sub("favicon", `<link rel="icon" type="image/png" href="logo.png" />`,
  `<link rel="icon" type="image/svg+xml" href="logo.svg" />`);

fs.writeFileSync(OUT, s);

// ------------------------------------------------------------------ assets
// Only assets the launchpad and this site genuinely SHARE are copied. The
// brand mark is NOT: money/logo.svg and the icon PNGs rasterised from it are
// money-specific and committed, and copying the launchpad's logo over them
// would silently rebrand this site back on every build.
const ASSETS = ["mintr.png", "mgld.png", "sw.js"];
let copied = 0;
for (const f of ASSETS) {
  const from = path.join(ROOT, "frontend", f);
  if (!fs.existsSync(from)) { console.log(`  skip missing asset ${f}`); continue; }
  fs.copyFileSync(from, path.join(ROOT, "money", f));
  copied++;
}

// The manifest carries the app name shown on a home-screen install, so it
// cannot be copied verbatim from the launchpad.
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "frontend", "manifest.webmanifest"), "utf8"));
manifest.name = "mintd.money";
manifest.short_name = "mintd.money";
manifest.description = "Agentic treasury and liquidity infrastructure on Arc.";
manifest.theme_color = "#07090c";
manifest.background_color = "#07090c";
fs.writeFileSync(path.join(ROOT, "money", "manifest.webmanifest"), JSON.stringify(manifest, null, 2) + "\n");
subs.push(`copied ${copied} assets and rewrote the manifest (1)`);

// The landing copy lives on its own so it can be edited without regenerating,
// and is reachable at /about.
if (!fs.existsSync(LANDING)) {
  console.log("note: money/landing.html missing, /about will 404");
}

console.log(`built ${path.relative(ROOT, OUT)}`);
console.log(`  ${(before / 1024).toFixed(0)}KB in, ${(s.length / 1024).toFixed(0)}KB out`);
for (const x of subs) console.log(`  ${x}`);
