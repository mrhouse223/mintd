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
sub("platform token avatar", `t.platform ? \`<img src="/logo.png" onerror="this.remove()">\``,
  `t.platform ? \`<img src="/logo.svg" onerror="this.remove()">\``);
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
