// Durable, time-weighted MINTD holding ledger.
//
//   node scripts/holder-ledger.js            one incremental pass
//   node scripts/holder-ledger.js --watch    keep going, every 10 minutes
//   node scripts/holder-ledger.js --report   write docs/mintd-holder-weights.md
//
// WHY THIS EXISTS, AND WHY IT CANNOT WAIT
// Stable's RPC keeps roughly four to five days of logs and has no archive. A
// point-in-time balance can be rebuilt at any moment, but *how long* someone
// held cannot: once the logs age out, that history is gone permanently. An
// airdrop weighted by holding duration therefore has to be recorded as it
// happens. Measured 2026-07-28: MINTD launched 4.86 days ago and its first
// blocks were still readable, with very little margin left.
//
// WHAT IT STORES
// Not daily snapshots, which grow without bound, but the integral of balance
// over blocks. Per address: the current balance, the accumulated
// balance-blocks, and the block that accumulation is settled to. That is O(one
// row per address) forever, and a time-weighted average is
// weighted / (head - startBlock) at any later date.
//
// Blocks, not seconds, are the unit. Block numbers arrive free with every log,
// whereas timestamps would cost an eth_getBlock per transfer block. Convert
// with the measured 0.70s/block only when presenting.
//
// WHAT IT DOES NOT DO
// It records every address without judgement. Pools, contracts, the dead
// address and the owner's own wallets are all in here, and are filtered at
// report time instead. Baking eligibility into the ledger would mean a change
// of policy could not be applied to history that has since been pruned.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
const RPC = process.env.RPC_URL || "https://rpc.stable.xyz";
const MINTD = "0xE62C47074abb52A2bc87B62E47e3411A0020f020";
const PAD = "0x75FAdB240006313294A5B502CA9268cB03Fa9AC0";
const DEAD = "0x000000000000000000000000000000000000dead";
const ZERO = ethers.ZeroAddress.toLowerCase();
const XFER = ethers.id("Transfer(address,address,uint256)");
const SPAN = 500;                 // Stable's hard getLogs ceiling, both caps
const SEC_PER_BLOCK = 0.70;       // measured over 100k blocks, see CLAUDE.md
const LEDGER = path.join(ROOT, "data", "mintd-holder-ledger.json");
const LOCK = path.join(ROOT, "holder-ledger.lock");
const REPORT = path.join(ROOT, "docs", "mintd-holder-weights.md");
const PUBLISHED = path.join(ROOT, "frontend", "holder-scores.json");

const WATCH = process.argv.includes("--watch");
const REPORT_ONLY = process.argv.includes("--report");
const nf = (n, d = 0) => Number(n).toLocaleString("en-US", { maximumFractionDigits: d });

// Wallets the owner controls, and known protocol contracts. Used ONLY for the
// report; the ledger itself stays unfiltered.
const MINE = {
  "0x8fc933374a2c1aa6d19c5f2bda33ad0b6be9eba4": "old deployer (compromised)",
  "0xe5f40204c8e921834c70b0e2631be79f076b0e28": "Safe (current owner)",
  "0xb48f00519c1ccf70c030a781880414c0dc9ac73b": "Safe signer",
  "0xfe93602c1d76834b6370833b9ce7c86939b5d97f": "arb keeper",
  "0x715bfd232483b2e9232d543cd1e99cc5219bb88e": "personal wallet",
  "0x0944f9aa36be35fe1aa148544b1000fdc099e770": "personal wallet",
};
const KNOWN = {
  "0xbef7e37d8f6d9dc70af16ed1b3f7a7db8e13aff6": "Uniswap V3 MINTD/USDT0 pool",
  "0x1f3002eea8b1b22f7fd67280e305ecea540c71be": "MintSwap MINTD/USDT0 LP",
  "0xf246f2b4710e37be0ffeb22119654641b2cbc44e": "MINTD/USDT0 farm",
  "0xd6160cdfb4f9c522a5ba77e05b4741b642b6ff84": "USDT0/WgUSDT farm",
  "0x59ab36b8dab00e13bd4c46d8d41b0ffa96707790": "MGLD/USDT0 farm",
  "0x1833d9442021afda97a573d9cda65e2aa3449160": "TokenLocker",
  "0x55233aef2ecee21a73a4655d9527d44ef13ba0d2": "V3PositionLocker",
  "0x7f007fbc6061806888a39a79763808af5b94f4f4": "BuybackBurner",
  "0x75fadb240006313294a5b502ca9268cb03fa9ac0": "InstantLaunchpad",
  "0x3bdc3437405f7d801b6036532713fc1f179136a6": "Uniswap NPM",
  "0xb9274bedadcf31136f54a9501232e642a35c6eb7": "MintSwap router",
  "0x32eaf9b5d5f2cd7361c5012890c943d7de84c22a": "Uniswap router02",
};

// ---------------------------------------------------------------------- lock
// pm2 running --watch while someone also runs a manual pass would interleave
// two writers on one file. stats.json was published wrong exactly once this
// way; the fix generalises.
function takeLock() {
  try {
    const prev = Number(fs.readFileSync(LOCK, "utf8"));
    try { process.kill(prev, 0); return false; } // still alive
    catch { /* stale, fall through */ }
  } catch { /* no lock file */ }
  fs.writeFileSync(LOCK, String(process.pid));
  return true;
}
const dropLock = () => { try { fs.unlinkSync(LOCK); } catch {} };

// -------------------------------------------------------------------- state
function loadLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER, "utf8")); } catch { return null; }
}
// Temp-then-rename so a crash mid-write cannot leave a truncated ledger. There
// is no second copy of this data anywhere.
function saveLedger(led) {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  const tmp = LEDGER + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(led, null, 2) + "\n");
  fs.renameSync(tmp, LEDGER);
}

async function getLogsOrDie(rp, from, to) {
  for (let a = 0; a < 6; a++) {
    try { return await rp.getLogs({ address: MINTD, topics: [XFER], fromBlock: from, toBlock: to }); }
    catch (e) {
      if (a === 5) throw new Error(`window ${from}-${to} unreadable after 6 attempts: ${e.shortMessage || e.message}`);
      await new Promise((r) => setTimeout(r, 400 * 2 ** a));
    }
  }
}

async function pass() {
  const rp = new ethers.JsonRpcProvider(RPC, 988, { batchMaxCount: 1, staticNetwork: true });
  const head = await rp.getBlockNumber();
  const tok = new ethers.Contract(MINTD, ["function totalSupply() view returns (uint256)"], rp);
  const supply = await tok.totalSupply();

  let led = loadLedger();
  if (!led) {
    // First run. Start at the launch block, derived from createdAt and measured
    // block time with a margin, exactly as holders.js does. Starting late would
    // miss the mint and every balance would be wrong.
    const hb = await rp.getBlock(head);
    const ob = await rp.getBlock(head - 100000);
    const perBlock = (hb.timestamp - ob.timestamp) / 100000;
    const pad = new ethers.Contract(PAD, [
      "function launches(address) view returns (address,address,address,uint256,uint64,uint256,uint256)",
    ], rp);
    const L = await pad.launches(MINTD);
    const created = Number(L[4]);
    const start = Math.max(0, head - Math.ceil((hb.timestamp - created) / perBlock) - 3000);
    console.log(`no ledger yet, starting from block ${start} (launch ${new Date(created * 1000).toISOString()})`);
    led = {
      token: MINTD, chainId: 988, unit: "balance-blocks", secPerBlock: SEC_PER_BLOCK,
      startBlock: start, cursorBlock: start - 1, transfers: 0, runs: 0,
      holders: {},   // addr -> { bal, weighted, lastBlock, firstBlock }
    };
  }

  const from0 = led.cursorBlock + 1;
  if (from0 > head) { console.log(`up to date at block ${head}`); return led; }
  console.log(`scanning ${from0} -> ${head} (${Math.ceil((head - from0 + 1) / SPAN)} windows)`);

  // Work on a copy. The real ledger is only replaced once the whole pass has
  // succeeded AND the completeness check has passed, so a mid-run failure
  // leaves the previous good state and the cursor intact. Advancing the cursor
  // without advancing state is the bug that silently inflated all-time volume
  // in stats-indexer; here it would silently mis-weight an airdrop.
  const H = new Map();
  for (const [a, r] of Object.entries(led.holders)) {
    H.set(a, { bal: BigInt(r.bal), weighted: BigInt(r.weighted), lastBlock: r.lastBlock, firstBlock: r.firstBlock });
  }
  const touch = (a) => {
    let r = H.get(a);
    if (!r) { r = { bal: 0n, weighted: 0n, lastBlock: from0, firstBlock: null }; H.set(a, r); }
    return r;
  };
  // Settle an address's accumulated balance-blocks up to `block` BEFORE its
  // balance changes. Doing it after would credit the new balance for time it
  // was not held.
  const settle = (r, block) => {
    if (block > r.lastBlock) { r.weighted += r.bal * BigInt(block - r.lastBlock); r.lastBlock = block; }
  };

  let transfers = 0, windows = 0;
  for (let from = from0; from <= head; from += SPAN) {
    const to = Math.min(head, from + SPAN - 1);
    const logs = await getLogsOrDie(rp, from, to);
    for (const lg of logs) {
      const f = ("0x" + lg.topics[1].slice(26)).toLowerCase();
      const t = ("0x" + lg.topics[2].slice(26)).toLowerCase();
      const v = BigInt(lg.data);
      const b = lg.blockNumber;
      if (f !== ZERO) { const r = touch(f); settle(r, b); r.bal -= v; }
      if (t !== ZERO) {
        const r = touch(t); settle(r, b); r.bal += v;
        if (r.firstBlock === null && v > 0n) r.firstBlock = b;
      }
      transfers++;
    }
    windows++;
    if (windows % 200 === 0) process.stdout.write(`  ${windows} windows, ${transfers} new transfers\n`);
  }

  // Settle everyone forward to head so the ledger is consistent at its cursor.
  // Without this, an address that never traded would accrue nothing for the
  // whole period, which is precisely backwards: not trading IS holding.
  for (const r of H.values()) settle(r, head);

  // Completeness invariant. If the balances no longer sum to totalSupply a
  // window was lost, and every weight derived from this file would be wrong in
  // a way that looks entirely plausible.
  let sum = 0n;
  for (const r of H.values()) sum += r.bal;
  if (sum !== supply) {
    throw new Error(`balances sum to ${ethers.formatEther(sum)} but totalSupply is ${ethers.formatEther(supply)}. `
      + `Refusing to advance the cursor on an incomplete walk.`);
  }

  led.holders = {};
  for (const [a, r] of H) {
    led.holders[a] = { bal: r.bal.toString(), weighted: r.weighted.toString(), lastBlock: r.lastBlock, firstBlock: r.firstBlock };
  }
  led.cursorBlock = head;
  led.transfers += transfers;
  led.runs += 1;
  led.updatedAt = new Date().toISOString();
  led.checkedSupply = supply.toString();
  saveLedger(led);

  const span = head - led.startBlock;
  console.log(`  +${transfers} transfers, ${H.size} addresses, cursor now ${head}`);
  console.log(`  covered ${span} blocks = ${(span * SEC_PER_BLOCK / 86400).toFixed(2)} days`);
  console.log(`  completeness OK: balances sum to totalSupply`);
  return led;
}

// ------------------------------------------------------------------- report
async function report() {
  const led = loadLedger();
  if (!led) { console.error("no ledger yet. Run without --report first."); process.exit(1); }
  const rp = new ethers.JsonRpcProvider(RPC, 988, { batchMaxCount: 1, staticNetwork: true });

  const span = led.cursorBlock - led.startBlock;
  const days = span * SEC_PER_BLOCK / 86400;
  const rows = [];
  for (const [addr, r] of Object.entries(led.holders)) {
    const weighted = BigInt(r.weighted);
    if (weighted === 0n) continue;
    // Time-weighted average balance over the whole tracked period.
    const twab = Number(ethers.formatEther(weighted / BigInt(span || 1)));
    rows.push({ addr, bal: Number(ethers.formatEther(BigInt(r.bal))), twab, firstBlock: r.firstBlock });
  }

  // Classify only now. Anything with code is a contract, same blunt rule as
  // holders.js: it removes pools and farms correctly, and would also remove a
  // smart-contract wallet belonging to a real person.
  // Whether an address holds code does not change, so it is cached in the
  // ledger. Without this the report costs ~1,300 eth_getCode calls every run,
  // which is too slow to regenerate on the indexer's cadence.
  led.codeCache = led.codeCache || {};
  let looked = 0;
  for (const r of rows) {
    if (r.addr === DEAD) { r.kind = "burned"; r.label = "dead address"; continue; }
    if (MINE[r.addr]) { r.kind = "mine"; r.label = MINE[r.addr]; continue; }
    if (KNOWN[r.addr]) { r.kind = "contract"; r.label = KNOWN[r.addr]; continue; }
    let isC = led.codeCache[r.addr];
    if (isC === undefined) {
      isC = (await rp.getCode(r.addr)) !== "0x" ? 1 : 0;
      led.codeCache[r.addr] = isC;
      if (++looked % 100 === 0) process.stdout.write(`  looked up ${looked} new addresses\n`);
    }
    r.kind = isC ? "contract" : "holder";
    r.label = isC ? "unlabelled contract" : "";
  }
  if (looked) { saveLedger(led); console.log(`  cached ${looked} new address classifications`); }

  const real = rows.filter((r) => r.kind === "holder");
  // Pure time-weighting rewards people who already left: an address that held
  // 13M for four days and then sold everything outranks one still holding 12M.
  // Observed in the first run, top ten, twice.
  //
  // min(time-weighted average, balance now) closes both directions at once.
  // Sold out -> min(large, 0) = 0. Bought yesterday -> the average is tiny, so
  // the size held now cannot rescue it. Only sustained AND continuing holding
  // scores, which is the behaviour an allocation is trying to reward.
  for (const r of real) r.score = Math.min(r.twab, r.bal);
  const byScore = [...real].filter((r) => r.score > 0).sort((a, b) => b.score - a.score);
  const byTwab = [...real].sort((a, b) => b.twab - a.twab);
  const exited = byTwab.filter((r) => r.bal === 0 && r.twab > 0);
  const totalScore = byScore.reduce((s, r) => s + r.score, 0);
  const totalTwab = real.reduce((s, r) => s + r.twab, 0);
  const dt = new Date().toISOString().slice(0, 10);

  const md = `# MINTD time-weighted holdings

Snapshot ${dt}. Generated by \`scripts/holder-ledger.js\`, which accumulates the
integral of each address's balance over blocks.

**This measures how long people held, not what they hold right now.** A wallet
that bought yesterday scores near zero no matter how large it is. A wallet that
has held since launch scores the full period.

## Coverage

| | |
|---|---|
| Token | \`${led.token}\` on Stable (chain 988) |
| Tracked from block | ${led.startBlock} |
| Tracked to block | ${led.cursorBlock} |
| Blocks covered | ${nf(span)} |
| Period | ${days.toFixed(2)} days |
| Transfers processed | ${nf(led.transfers)} |
| Addresses tracked | ${nf(Object.keys(led.holders).length)} |
| Indexer runs | ${led.runs} |

Balances are checked against \`totalSupply\` on every run and the cursor does
not advance unless they match, so there are no silent gaps in this window.

**The record only extends as far back as block ${led.startBlock}.** Stable's RPC
keeps four to five days of logs and has no archive, so nothing earlier can ever
be added. Keep this indexer running; the file is the only copy.

## Top 25 by score

**score = min(time-weighted average, balance now)**, in MINTD. Excludes the
dead address, every contract, and wallets the project controls. "Share" is of
the qualifying total, which is what an allocation would divide.

| # | address | score | time-weighted avg | held now | share |
|---|---|---|---|---|---|
${byScore.slice(0, 25).map((r, i) =>
  `| ${i + 1} | \`${r.addr}\` | ${nf(r.score)} | ${nf(r.twab)} | ${nf(r.bal)} | ${(r.score / (totalScore || 1) * 100).toFixed(2)}% |`).join("\n") || "| – | none yet | – | – | – | – |"}

**${byScore.length}** addresses qualify, ${nf(totalScore)} MINTD of score between
them. ${real.length} held at some point during the window.

## Why the score is a minimum of two numbers

Neither half works alone, and the first run proved it.

A **point-in-time snapshot** is trivially farmed: buy the day before, sell the
day after, collect the same allocation as somebody who held for months.

**Pure time-weighting rewards people who have already left.** In the first run
of this indexer, two of the top ten addresses by time-weighted average held
nothing at all:

| address | time-weighted avg | held now |
|---|---|---|
${exited.slice(0, 5).map((r) => `| \`${r.addr}\` | ${nf(r.twab)} | ${nf(r.bal)} |`).join("\n") || "| (none in this window) | – | – |"}

${exited.length} address(es) in this window have a positive time-weighted average
and a zero balance. Weighting on duration alone would have paid every one of
them.

Taking the **minimum** closes both directions with one rule. Sold out gives
min(large, 0) = 0. Bought yesterday gives a tiny average that the size held now
cannot rescue. Only holding a real amount, for a real duration, and still
holding it, scores.

## Excluded

| kind | addresses | combined time-weighted |
|---|---|---|
| Contracts and pools | ${rows.filter((r) => r.kind === "contract").length} | ${nf(rows.filter((r) => r.kind === "contract").reduce((s, r) => s + r.twab, 0))} |
| Project wallets | ${rows.filter((r) => r.kind === "mine").length} | ${nf(rows.filter((r) => r.kind === "mine").reduce((s, r) => s + r.twab, 0))} |
| Burned | ${rows.filter((r) => r.kind === "burned").length} | ${nf(rows.filter((r) => r.kind === "burned").reduce((s, r) => s + r.twab, 0))} |

## This is not an allocation formula

It is the measurement an allocation could be built from. Publishing a formula
in advance is a specification for gaming it, and any real distribution should
treat this as one input among several. See \`docs/arc-points.md\` for the same
caveat applied to Arc activity.
`;

  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, md);

  // ---------------------------------------------------- published for the site
  // Shares only, never token amounts. There is no Arc token, no supply decision
  // and no live Arc mainnet, so any absolute figure on the site would be a
  // promise the chain cannot keep. A percentage of a tracked total is a
  // statement about the past, which is true today and stays true.
  const scores = {};
  for (const r of byScore) scores[r.addr] = [Math.round(r.score), Math.round(r.twab), Math.round(r.bal)];
  fs.writeFileSync(PUBLISHED, JSON.stringify({
    updated: Math.floor(Date.now() / 1000),
    token: led.token,
    chainId: led.chainId,
    startBlock: led.startBlock,
    cursorBlock: led.cursorBlock,
    days: Number(days.toFixed(3)),
    transfers: led.transfers,
    everHeld: real.length,
    qualifying: byScore.length,
    exitedWithWeight: exited.length,
    totalScore: Math.round(totalScore),
    // [score, timeWeightedAvg, heldNow], all whole MINTD. Only qualifying
    // addresses: a zero score is the same as absent and would triple the file.
    scores,
  }) + "\n");
  console.log(`\n${byScore.length} qualify of ${real.length} who ever held, over ${days.toFixed(2)} days`);
  console.log(`${exited.length} had a positive time-weight but hold nothing now (score 0)\n`);
  for (const r of byScore.slice(0, 10)) {
    console.log(`  ${r.addr}  score ${nf(r.score).padStart(12)}  twa ${nf(r.twab).padStart(12)}  now ${nf(r.bal).padStart(12)}`);
  }
  console.log(`\nwritten to ${path.relative(ROOT, REPORT)}`);
}

(async () => {
  if (REPORT_ONLY) return report();
  if (!takeLock()) { console.error("another holder-ledger is running (holder-ledger.lock). Exiting."); process.exit(1); }
  process.on("exit", dropLock);
  process.on("SIGINT", () => { dropLock(); process.exit(0); });
  process.on("SIGTERM", () => { dropLock(); process.exit(0); });

  if (!WATCH) { await pass(); await report(); return; }
  for (;;) {
    try {
      await pass();
      // Regenerate the published scores too, so the site's dashboard tracks the
      // ledger instead of whatever was committed by hand last. Cheap now that
      // address classification is cached.
      await report();
    } catch (e) {
      // Loud, and the cursor stays put. Never swallow this: a run that fails
      // silently for a week loses a week of holding history that cannot be
      // rebuilt from a pruning node.
      console.error(`\nPASS FAILED: ${e.shortMessage || e.message}\n`);
    }
    await new Promise((r) => setTimeout(r, 10 * 60 * 1000));
  }
})().catch((e) => { console.error("\n" + (e.shortMessage || e.message) + "\n"); dropLock(); process.exit(1); });
