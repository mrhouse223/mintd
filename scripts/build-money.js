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
sub("title", "<title>mintd.fun", "<title>arcswap.vip");
sub("meta description",
  'content="Launch, trade and earn on Stable and Arc. Memecoin launchpad, MINTR reserve token, tokenized gold and yield farms."',
  'content="Bring USDC from Base to Arc, launch tokens, and run liquidity agents that cannot choose a price. arcswap.vip on Arc mainnet."');
sub("wordmark",
  "<span>mintd<b>.fun</b><small>LAUNCH FOR $1</small></span>",
  "<span>arcswap<b>.vip</b><small>USDC ON ARC</small></span>");

// ------------------------------------------------------------------ socials
// arcswap has its own X account, and no Telegram yet. The whole anchor is
// removed rather than pointed at a placeholder, because a dead social link on a
// site handling money reads as abandoned.
// Two of them: the header button and the docs footer. Both move.
sub("x account",
  'href="https://x.com/mintddotfun"',
  'href="https://x.com/arcswapdotvip"', { all: true });
// There are TWO: the header button and one in the docs. Removing only the
// header left a live Telegram link in the docs, which is exactly the dead link
// this was meant to avoid. Loops until none remain and asserts it found some.
{
  let removed = 0;
  for (;;) {
    const at = s.indexOf('href="https://t.me/mintddotfun"');
    if (at === -1) break;
    const open = s.lastIndexOf("<a ", at);
    const close = s.indexOf("</a>", at);
    if (open === -1 || close === -1) throw new Error("build-money: malformed Telegram anchor");
    s = s.slice(0, open) + s.slice(close + 4);
    removed++;
    if (removed > 8) throw new Error("build-money: runaway Telegram removal");
  }
  if (removed === 0) throw new Error("build-money: no Telegram anchor found");
  subs.push(`removed ${removed} Telegram link(s) (1)`);
}

// -------------------------------------------------------------------- discord
{
  const xAnchorEnd = s.indexOf("</a>", s.indexOf('<a class="themebtn" href="https://x.com/arcswapdotvip"')) + 4;
  if (xAnchorEnd < 4) throw new Error("build-money: could not find the X anchor to insert Discord after");
  const discord = '\n  <a class="themebtn" href="https://discord.gg/EynUpkhge" target="_blank" rel="noopener" title="Discord">'
    + '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">'
    + '<path d="M20.3 4.6A16.6 16.6 0 0 0 16.2 3.4l-.3.7a12.3 12.3 0 0 1 3.6 1.2 11.9 11.9 0 0 0-9-.4 12.4 12.4 0 0 1 2.1-.8l-.3-.7A16.6 16.6 0 0 0 3.7 4.6C1.6 8.1 1 11.6 1.3 15a16.8 16.8 0 0 0 5.1 2.6l.6-1a10 10 0 0 1-1.6-.8l.4-.3a12 12 0 0 0 10.4 0l.4.3a10 10 0 0 1-1.6.8l.6 1A16.8 16.8 0 0 0 22.7 15c.4-4-.6-7.5-2.4-10.4zM8.7 13.2c-1 0-1.8-.9-1.8-1.9s.8-1.9 1.8-1.9 1.8.9 1.8 1.9-.8 1.9-1.8 1.9zm6.6 0c-1 0-1.8-.9-1.8-1.9s.8-1.9 1.8-1.9 1.8.9 1.8 1.9-.8 1.9-1.8 1.9z"/>'
    + '</svg></a>';
  s = s.slice(0, xAnchorEnd) + discord + s.slice(xAnchorEnd);
  subs.push("added the Discord link (1)");
}

// --------------------------------------------------------------- launch page
// "Mint" is the one word left on the launch page that reads as the old brand.
// Arc-only, so mintd.fun keeps its own heading.
sub("launch headline",
  '<h1>Mint it. Lock it.<br /><span class="g">Get paid.</span></h1>',
  '<h1>Launch it. Lock it.<br /><span class="g">Get paid.</span></h1>');

// ---------------------------------------------------------------- hero copy
sub("hero headline",
  '<h1>Launch on <span id="heroChain">Stable</span> for $1.<br /><span class="g">Earn fees instantly.</span></h1>',
  '<h1>The Pons of Arc Mainnet.<br /><span class="g">Launch a coin for 1 USDC.</span></h1>');

// "Mintscreener" is a mintd portmanteau, and the one brand mention a plain text
// sweep misses: the wordmark is split across two elements, so neither leaf node
// contains the whole word. Named for the chain instead.
sub("screener wordmark",
  '<h1 style="font-size:40px">Mint<span class="g">screener.</span></h1>',
  '<h1 style="font-size:40px">Arc<span class="g">screener.</span></h1>');

// "Furnace" is the launchpad's name for it. arcswap calls it the Burner, and its
// placeholder page says Burner, so the tab has to match or the two read as
// different features.
sub("burner tab label",
  '</svg> Furnace</button>',
  '</svg> Burner</button>');

// The badge's placeholder is a dash until the pad's creator share is read, and on
// Arc that read needs a connected wallet, so an anonymous visitor saw
// "CREATORS KEEP - OF FEES" directly above a blurb stating 80% as fact. The
// blurb's static copy already commits to 80%; this makes the badge agree rather
// than contradict it, and the live value still overwrites it once read.
sub("hero share placeholder",
  '<span id="heroShare">–</span>',
  '<span id="heroShare">80%</span>');

// The split is stated as 80/20 rather than "the majority". The percentage is
// still read from the deployed pad when one exists, so the sentence cannot drift
// from the contract; only the fallback text names 80 outright.
sub("hero blurb split, known",
  '`Creators claim ${share}% of every trading fee any time`',
  '`Creators claim ${share}% of every trading fee any time, and the remaining ${100 - share}% funds the protocol`');
sub("hero blurb split, fallback",
  '`Creators claim the majority of every trading fee any time`',
  '`Creators claim 80% of every trading fee any time, and the remaining 20% funds the protocol`');

// ---------------------------------------------------------------------- nav
// Bridge belongs in the top bar here, not buried in More: on arcswap it is the
// way in. Moved rather than duplicated, and only on this build, so mintd.fun
// keeps its own arrangement.
{
  const navStart = s.indexOf('<button id="nav-bridge"');
  if (navStart === -1) throw new Error("build-money: could not find the Bridge nav button");
  const navEnd = s.indexOf("</button>", navStart) + 9;
  const btn = s.slice(navStart, navEnd);
  s = s.slice(0, navStart) + s.slice(navEnd);
  // After Swap, so the visible order on Arc reads Discover, Swap, Bridge, Farms
  // once the chain's own feature flags hide Agent, Launch and Screener.
  const afterSwap = s.indexOf("</button>", s.indexOf('<button id="nav-mintswap"')) + 9;
  if (afterSwap < 9) throw new Error("build-money: could not find the Swap nav button");
  s = s.slice(0, afterSwap) + "\n    " + btn.replace(/<svg[\s\S]*?<\/svg>\s*/, "") + s.slice(afterSwap);
  subs.push("moved Bridge into the top bar, after Swap (1)");
}

// "Earn" is called Farms here, which is what it actually is.
sub("farms label", '<button id="nav-earn" onclick="go(\'earn\')">Earn</button>',
  '<button id="nav-earn" onclick="go(\'earn\')">Farms</button>');

// ------------------------------------------------------------------ chains
// Arc only. A chain switcher offering Stable would send someone to a different
// product on a different chain from a site that is meant to be one thing.
sub("default chain", 'return "stable";', 'return "arc-mainnet";');
sub("NET fallback", "CHAINS[CHAIN_KEY] || CHAINS.stable", "CHAINS[CHAIN_KEY] || CHAINS['arc-mainnet']");

// The arc pad, registry and features substitutions used to live here. They
// rewrote the arc-TESTNET entry, which the slice below now discards, so they
// were doing nothing except waiting to break when that entry moves. The
// arc-mainnet entry carries its own addresses and its own features directly in
// frontend/index.html, which is the right place for them: one chain, one
// definition, no rewriting a different chain's block to produce it.
// The burn PAGE (the Furnace) works on Arc and stays. The burn STAT counts
// MINTD sent to the dead address, and there is no MINTD on Arc, so the tile is
// suppressed separately from the feature.
sub("burn stat tile", 'const tiles = { stMintrTvl: "mintr", stBurn: "burn" };',
  'const tiles = { stMintrTvl: "mintr", stBurn: "mintdStat" };');

// Drop Stable from the registry entirely so nothing can switch into it.
const stableStart = s.indexOf("  stable: {");
const mainStart = s.indexOf('  "arc-mainnet": {');
const testStart = s.indexOf('  "arc-testnet": {');
const chainsEnd = s.indexOf("\n};", testStart);
if (stableStart === -1 || mainStart === -1 || testStart === -1 || chainsEnd === -1
    || !(stableStart < mainStart && mainStart < testStart)) {
  throw new Error("build-money: could not locate the CHAINS entries in the expected order");
}
// Drop stable from the front and arc-testnet from the tail, leaving arc-mainnet
// as the only chain. A testnet one click from a site that bridges real USDC is
// how someone sends money to a throwaway chain by mistake.
s = s.slice(0, stableStart) + s.slice(mainStart, testStart) + s.slice(chainsEnd + 1);
subs.push("kept arc-mainnet only, dropped stable and arc-testnet (1)");

// ------------------------------------------------------------------- theme
// arcswap is blue and white, taken from its mark, with a real dark variant so
// the header toggle actually does something. An earlier version of this forced
// dark by writing the SAME values into both the light and the dark block, which
// left the toggle in the header changing nothing at all.
// There are FOUR palette blocks in the source: an original pair and a later
// pair from the pons-inspired restyle that overrides it. Only the later pair is
// live. Patching the dead one changes nothing visible, which is exactly what
// happened first time round.
sub("active light palette",
  `    --bg: #ffffff; --panel: #ffffff; --panel2: #f2f5f9; --line: #e6ebf2;
    --ink: #0b1119; --dim: #6b7a8d; --green: #2f7fe0; --green2: #1f6bc9;
    --green-soft: #e8f1fd; --red: #e0483d; --radius: 14px;`,
  `    --bg: #ffffff; --panel: #ffffff; --panel2: #f4f7fc; --line: #e2e9f3;
    --ink: #0b1220; --dim: #5c6b80; --green: #1a73e8; --green2: #0f5ed6;
    --green-soft: #e8f1fe; --red: #e0483d; --radius: 14px;`);

sub("active dark palette",
  `    --bg: #0a0d12; --panel: #12171f; --panel2: #161d26; --line: #1e2732;
    --ink: #f2f5f9; --dim: #8a97a8; --green: #4d9bf0; --green2: #6fb2f5;
    --green-soft: #10233a; --red: #ff6b5e;`,
  `    --bg: #0a0e14; --panel: #111823; --panel2: #17202c; --line: #212c3a;
    --ink: #eef3fa; --dim: #8a9ab0; --green: #4d94f0; --green2: #7db3f5;
    --green-soft: #11243c; --red: #ff6b5e;`);

sub("legacy light palette",
  `    --bg: #f2f8f6; --panel: #ffffff; --panel2: #e8f2ee; --line: #d3e3dd;
    --ink: #1e1f24; --dim: #5f7a73; --green: #2f9c80; --green2: #5bccae;
    --green-soft: #dcf2ea; --gold: #b8891f; --gold-soft: #f8f0dc;
    --red: #c2453f; --radius: 6px; --mono: "SF Mono", ui-monospace, Menlo, monospace;`,
  `    --bg: #ffffff; --panel: #ffffff; --panel2: #f4f7fc; --line: #e2e9f3;
    --ink: #0b1220; --dim: #5c6b80; --green: #1a73e8; --green2: #0f5ed6;
    --green-soft: #e8f1fe; --gold: #b8891f; --gold-soft: #f8f0dc;
    --red: #e0483d; --radius: 14px; --mono: "SF Mono", ui-monospace, Menlo, monospace;`);

sub("legacy dark palette",
  `    --bg: #0d1917; --panel: #132320; --panel2: #1a2e29; --line: #24413a;
    --ink: #e6f4ef; --dim: #7fa39a; --green: #5bccae; --green2: #7fdcc3;
    --green-soft: #14332b; --gold: #e6bf52; --gold-soft: #2e2711;`,
  `    --bg: #0a0e14; --panel: #111823; --panel2: #17202c; --line: #212c3a;
    --ink: #eef3fa; --dim: #8a9ab0; --green: #4d94f0; --green2: #7db3f5;
    --green-soft: #11243c; --gold: #e6bf52; --gold-soft: #2e2711;`);

// ---------------------------------------------------------------- branding
// mintd.money has its own mark (money/logo.svg and the icon set rasterised from
// it), so the header image and the favicon point at the SVG rather than the
// launchpad's logo.png. Both header uses and the favicon are switched.
sub("header logo",
  `<img src="/logo.png" alt="" style="width:34px;height:34px;border-radius:9px" onerror="this.style.display='none'" />`,
  `<img src="/logo.svg" alt="" style="width:34px;height:34px;border-radius:9px" onerror="this.style.display='none'" />`);
// The platform token avatar is no longer rewritten here: coinLogo() resolves it
// per chain from NET.mintd.platformLogo, so arcswap points at its own coin art.
sub("favicon", `<link rel="icon" type="image/png" href="/logo.png" />`,
  `<link rel="icon" type="image/svg+xml" href="/logo.svg" />`);

// ------------------------------------------------------------------- colour
// Every remaining hardcoded green becomes the mark's blue. The palette
// variables cover most of the UI, but a handful of literals were written
// directly into rules and gradients and would otherwise stay green on a blue
// site. Substituted by value so a missed one is visible rather than silent.
{
  const GREEN_TO_BLUE = {
    "#5bccae": "#4d94f0",
    "#7fdcc3": "#7db3f5",
    "#2f9c80": "#1a73e8",
    "#34d399": "#4d94f0",
    "#dcf2ea": "#e8f1fe",
    "#14332b": "#11243c",
  };
  let n = 0;
  for (const [from, to] of Object.entries(GREEN_TO_BLUE)) {
    const re = new RegExp(from, "gi");
    const hits = (s.match(re) || []).length;
    if (hits) { s = s.replace(re, to); n += hits; }
  }
  subs.push(`recoloured ${n} hardcoded green literal(s) to blue (1)`);
}

// ------------------------------------------------------- squared-off treatment
// arcswap runs a squarer, flatter look than the launchpad's rounded one. This is
// appended as the LAST rule in the stylesheet rather than editing the dozens of
// radii in place: the values are spread across ~19 pill rules, a dozen card
// rules and a handful of inline style attributes, and rewriting each one is both
// a bigger diff and a permanent merge conflict with mintd.fun's own styling.
//
// !important is load-bearing here, not laziness. Several radii live in inline
// style attributes in the markup, which beat any stylesheet rule on specificity,
// so a plain rule silently loses to them.
//
// Status dots keep their circle deliberately. A squared live indicator does not
// read as a design decision, it reads as a rendering fault.
const SQUARE_CSS = `
  /* arcswap: squared, flatter, more institutional than the launchpad's look */
  :root { --radius: 2px; }
  button, .btn, .chip, .badgepill, .sidetabs, .onb, .themebtn, .createbtn,
  .bigsearch, .search, input, textarea, select, .amtbox, .gstep, .trade,
  .stat, .hstat, .feecard, .chartcard, .lform, .tokhead, .gradcard, .seccard,
  .mbox, .feerow, .tcard, .card, .avatar, .pill, .tokbtn, .gmono, .toast,
  .empty, .cnt, .gnum, .modal, .panel, img {
    border-radius: 2px !important;
  }
  /* a live indicator has to stay round */
  .dot { border-radius: 50% !important; }
  /* flat over glossy: the soft drop shadows and the diagonal gradient bands are
     the other half of what reads as playful rather than professional */
  .seccard, .mbox, .toast, .modal, .tokhead, .trade, .card, .tcard {
    box-shadow: none !important;
  }
`;
if (s.includes("</style>")) {
  s = s.replace("</style>", SQUARE_CSS + "</style>");
  subs.push("appended the squared-off style override (1)");
} else {
  // Never fail silently: a missing hook means the override shipped as nothing
  // and the site would just look unchanged with no error anywhere.
  throw new Error("no </style> to append the squared-off override to");
}

fs.writeFileSync(OUT, s);

// ------------------------------------------------------------------ assets
// Only assets the launchpad and this site genuinely SHARE are copied. The
// brand mark is NOT: money/logo.svg and the icon PNGs rasterised from it are
// money-specific and committed, and copying the launchpad's logo over them
// would silently rebrand this site back on every build.
//
// This comment used to claim the PNGs were rasterised from money/logo.svg while
// they were still byte-identical to the launchpad's green mark, so the arcswap
// avatar and every installed-app icon were mintd's logo. They are now genuinely
// generated from the SVG. To regenerate after editing money/logo.svg:
//   for s in 512 192 180; do qlmanage -t -s $s -o /tmp/ic money/logo.svg; done
// then copy the 512 over logo.png, icon-512.png and icon-maskable-512.png, the
// 192 over icon-192.png, and the 180 over apple-touch-icon.png. Note that five
// of the platform-avatar call sites reference /logo.png rather than the SVG, so
// leaving the PNGs stale does not fail loudly, it just shows the old brand.
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
