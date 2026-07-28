// Arc testnet activity points.
//
//   node scripts/arc-points.js
//
// Indexes what people actually did with the mintd contracts on Arc testnet and
// writes a leaderboard to docs/arc-points.md and frontend/arc-points.json.
//
// No funds are held, nothing is deposited, nothing is issued. This reads
// public logs and scores them. That is the whole point: the same "reward early
// users" outcome as a deposit-taking synthetic, with nothing to steal and
// nobody to trust.
//
// READ THE SYBIL NOTE in the generated report before using this as an airdrop
// formula. Arc's faucet is free, so raw testnet activity is farmable and this
// leaderboard is evidence, not a payout function.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
const REC = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "arc-testnet.json"), "utf8"));
const C = REC.contracts;
const RPC = process.env.ARC_RPC || "https://rpc.testnet.arc.network";
const SPAN = 5000;   // Arc is comfortable here; Stable would cap at 500
const OUT_MD = path.join(ROOT, "docs", "arc-points.md");
const OUT_JSON = path.join(ROOT, "frontend", "arc-points.json");

// Published formula. Deliberately legible: anyone can recompute it from chain.
const POINTS = {
  swapPerUsd: 1,      // trading is the core action
  launchFlat: 50,     // launching is high effort and seeds the venue
  burnFlat: 40,       // per burn. Pricing an arbitrary burned token needs a
                      // pool that may not exist, so this counts the act.
  lockFlat: 25,       // per lock
  mintrPerUsd: 1,     // MINTR buys and sells, in gas-token terms
};

const V3_SWAP = ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)");
const BURNED = ethers.id("Burned(address,address,uint256,uint256)");
const LOCKED = ethers.id("Locked(uint256,address,address,uint256,uint64)");
const MINTR_BOUGHT = ethers.id("Bought(address,uint256,uint256,uint256)");
const MINTR_SOLD = ethers.id("Sold(address,uint256,uint256,uint256)");
const nf = (n, d = 0) => Number(n).toLocaleString("en-US", { maximumFractionDigits: d });

(async () => {
  const rp = new ethers.JsonRpcProvider(RPC, REC.chainId, { batchMaxCount: 1, staticNetwork: true });
  const head = await rp.getBlockNumber();
  const from0 = REC.fromBlock || (head - 200000);

  console.log(`Arc testnet, blocks ${from0} -> ${head} (${Math.ceil((head - from0) / SPAN)} windows)\n`);

  // Retry rather than skip: a dropped window silently understates someone's
  // activity, and this is meant to decide who gets rewarded.
  async function logs(filter, from, to) {
    for (let a = 0; a < 6; a++) {
      try { return await rp.getLogs({ ...filter, fromBlock: from, toBlock: to }); }
      catch (e) {
        if (a === 5) throw new Error(`window ${from}-${to} unreadable: ${e.shortMessage || e.message}`);
        await new Promise((r) => setTimeout(r, 400 * 2 ** a));
      }
    }
  }
  async function walk(filter, onLog) {
    for (let f = from0; f <= head; f += SPAN) {
      const t = Math.min(head, f + SPAN - 1);
      for (const lg of await logs(filter, f, t)) onLog(lg);
    }
  }

  const P = new Map();   // addr -> { swapUsd, launches, burnUsd, locks, mintrUsd, days:Set }
  const rec = (a) => {
    const k = a.toLowerCase();
    if (!P.has(k)) P.set(k, { swapUsd: 0, launches: 0, burns: 0, locks: 0, mintrUsd: 0, blocks: new Set() });
    return P.get(k);
  };

  // ---- launches --------------------------------------------------------
  const pad = new ethers.Contract(C.InstantLaunchpad, [
    "function tokenCount() view returns (uint256)",
    "function allTokens(uint256) view returns (address)",
    "function launches(address) view returns (address token,address creator,address pool,uint256 positionId,uint64 createdAt,uint256 a,uint256 b)",
  ], rp);
  const n = Number(await pad.tokenCount());
  const pools = [];
  for (let i = 0; i < n; i++) {
    const t = await pad.allTokens(i);
    const L = await pad.launches(t);
    rec(L.creator).launches++;
    pools.push({ token: t, pool: L.pool, tokenIs0: BigInt(t) < BigInt(REC.gasToken.address) });
  }
  console.log(`launches: ${n} by ${new Set([...P.keys()]).size} address(es)`);

  // ---- swaps, per launched pool ---------------------------------------
  let swaps = 0;
  for (const p of pools) {
    await walk({ address: p.pool, topics: [V3_SWAP] }, (lg) => {
      // recipient is the trader for a router-executed swap
      const who = "0x" + lg.topics[2].slice(26);
      const d = ethers.AbiCoder.defaultAbiCoder().decode(["int256", "int256", "uint160", "uint128", "int24"], lg.data);
      const usdcDelta = p.tokenIs0 ? d[1] : d[0];       // the gas-token leg, 6 dec
      const abs = usdcDelta < 0n ? -usdcDelta : usdcDelta;
      const usd = Number(ethers.formatUnits(abs, 6));
      const r = rec(who);
      r.swapUsd += usd;
      r.blocks.add(Math.floor(lg.blockNumber / 164000));  // ~1 day of Arc blocks
      swaps++;
    });
  }
  console.log(`swaps: ${swaps}`);

  // ---- burns through the Furnace --------------------------------------
  let burns = 0;
  if (C.Furnace) {
    await walk({ address: C.Furnace, topics: [BURNED] }, (lg) => {
      const who = "0x" + lg.topics[2].slice(26);   // burner
      const r = rec(who);
      r.burns++;
      r.blocks.add(Math.floor(lg.blockNumber / 164000));
      burns++;
    });
  }
  console.log(`furnace burns: ${burns}`);

  // ---- token locks ------------------------------------------------------
  let locks = 0;
  if (C.TokenLocker) {
    await walk({ address: C.TokenLocker, topics: [LOCKED] }, (lg) => {
      const who = "0x" + lg.topics[3].slice(26);   // owner
      const r = rec(who);
      r.locks++;
      r.blocks.add(Math.floor(lg.blockNumber / 164000));
      locks++;
    });
  }
  console.log(`locks: ${locks}`);

  // ---- MINTR mints and burns -------------------------------------------
  let mintrTx = 0;
  if (C.MINTR) {
    for (const [topic, gasLegFirst] of [[MINTR_BOUGHT, true], [MINTR_SOLD, false]]) {
      await walk({ address: C.MINTR, topics: [topic] }, (lg) => {
        const who = "0x" + lg.topics[1].slice(26);
        const d = ethers.AbiCoder.defaultAbiCoder().decode(["uint256", "uint256", "uint256"], lg.data);
        // Bought: (usdtIn, mintrOut, price). Sold: (mintrIn, usdtOut, price).
        const gasLeg = gasLegFirst ? d[0] : d[1];
        const r = rec(who);
        r.mintrUsd += Number(ethers.formatUnits(gasLeg, 6));
        r.blocks.add(Math.floor(lg.blockNumber / 164000));
        mintrTx++;
      });
    }
  }
  console.log(`MINTR trades: ${mintrTx}`);

  // ---- score ------------------------------------------------------------
  const rows = [...P.entries()].map(([addr, v]) => ({
    addr,
    ...v,
    days: v.blocks.size,
    points: Math.round(
      v.swapUsd * POINTS.swapPerUsd +
      v.launches * POINTS.launchFlat +
      v.burns * POINTS.burnFlat +
      v.locks * POINTS.lockFlat +
      v.mintrUsd * POINTS.mintrPerUsd
    ),
  })).filter((r) => r.points > 0).sort((a, b) => b.points - a.points);

  const total = rows.reduce((s, r) => s + r.points, 0);
  const dt = new Date().toISOString().slice(0, 10);

  const md = `# Arc testnet points

Snapshot ${dt}, blocks ${from0} to ${head}. Generated by \`scripts/arc-points.js\`.

mintd is deployed and running on **Arc testnet** (chain ${REC.chainId}). This
page scores what people actually did with those contracts, read from public
logs.

**No deposits. No custody. No IOUs.** Nothing is held on anyone's behalf and
nothing is issued. This is an index of onchain activity, and anyone can
recompute every number in it from the chain.

## Formula

| action | points |
|---|---|
| Swap volume | ${POINTS.swapPerUsd} per $1 |
| Launch a token | ${POINTS.launchFlat} |
| Burn via the Furnace | ${POINTS.burnFlat} per burn |
| Lock tokens | ${POINTS.lockFlat} per lock |
| MINTR volume | ${POINTS.mintrPerUsd} per $1 bought or sold |

## Leaderboard

${rows.length ? `| # | address | points | swap volume | launches | burns | locks | MINTR | active days |
|---|---|---|---|---|---|---|---|---|
${rows.slice(0, 50).map((r, i) => `| ${i + 1} | \`${r.addr}\` | ${nf(r.points)} | $${nf(r.swapUsd, 2)} | ${r.launches} | ${r.burns} | ${r.locks} | $${nf(r.mintrUsd, 2)} | ${r.days} |`).join("\n")}` : "No activity indexed yet."}

${rows.length ? `\n${rows.length} addresses, ${nf(total)} points total.` : ""}

## Sybil note, read this before treating it as an airdrop formula

Arc's faucet hands out 20 USDC per address every two hours, for free. Creating
a hundred wallets and farming this leaderboard costs nothing but time, and
anyone who wants to will.

So this is **evidence of real usage, not a payout function**. Weighting by
volume rather than transaction count raises the cost of farming slightly, and
active-day counts make a single burst look like what it is, but neither is a
defence. Any actual distribution should treat this as one input among several
and should not be announced as a formula in advance, because a published
formula on a free-faucet chain is a specification for farming it.

## Contracts indexed

| contract | address |
|---|---|
| InstantLaunchpad | \`${C.InstantLaunchpad}\` |
| MintSwapRouter | \`${C.MintSwapRouter}\` |
| SwapRouter02 | \`${C.SwapRouter02}\` |
| MINTR | \`${C.MINTR}\` |
| Furnace | \`${C.Furnace}\` |
| TokenLocker | \`${C.TokenLocker}\` |

Explorer: https://testnet.arcscan.app
`;

  fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });
  fs.writeFileSync(OUT_MD, md);
  fs.writeFileSync(OUT_JSON, JSON.stringify({
    updated: Math.floor(Date.now() / 1000), chainId: REC.chainId,
    fromBlock: from0, toBlock: head, formula: POINTS,
    addresses: rows.length, totalPoints: total,
    leaderboard: rows.slice(0, 200).map((r) => ({ addr: r.addr, points: r.points, swapUsd: Number(r.swapUsd.toFixed(2)), launches: r.launches, burns: r.burns, locks: r.locks, mintrUsd: Number(r.mintrUsd.toFixed(2)), days: r.days })),
  }, null, 2) + "\n");

  console.log(`\n${rows.length} addresses scored, ${nf(total)} points total`);
  for (const r of rows.slice(0, 10)) console.log(`  ${r.addr}  ${String(r.points).padStart(6)}  $${r.swapUsd.toFixed(2)} swapped, ${r.launches} launches, ${r.burns} burns, ${r.locks} locks, $${r.mintrUsd.toFixed(2)} MINTR`);
  console.log(`\nwritten to ${path.relative(ROOT, OUT_MD)} and ${path.relative(ROOT, OUT_JSON)}`);
})().catch((e) => { console.error("\n" + (e.shortMessage || e.message) + "\n"); process.exit(1); });
