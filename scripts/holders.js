// Real MINTD holder distribution on Stable.
//
//   node scripts/holders.js
//
// Walks every Transfer log from the token's first block, rebuilds the full
// balance set, classifies each holder, and writes docs/mintd-holders.md.
//
// The correctness bar: the sum of every balance must equal totalSupply. A
// getLogs window that fails and gets skipped produces a plausible-looking
// distribution that is quietly wrong, which is worse than no answer, so a
// failed window is retried and an unrecoverable one aborts the run.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
const RPC = process.env.RPC_URL || "https://rpc.stable.xyz";
const MINTD = "0xE62C47074abb52A2bc87B62E47e3411A0020f020";
const PAD = "0x75FAdB240006313294A5B502CA9268cB03Fa9AC0";
const DEAD = "0x000000000000000000000000000000000000dEaD";
const ZERO = ethers.ZeroAddress;
const XFER = ethers.id("Transfer(address,address,uint256)");
const SPAN = 500;               // Stable's hard getLogs ceiling
const OUT = path.join(ROOT, "docs", "mintd-holders.md");

// Wallets the owner controls. Excluded from "real holders" and named in the
// report so the exclusion is auditable rather than a silent filter.
const MINE = {
  "0x8fc933374a2c1aa6d19c5f2bda33ad0b6be9eba4": "old deployer (compromised)",
  "0xe5f40204c8e921834c70b0e2631be79f076b0e28": "Safe (current owner)",
  "0xb48f00519c1ccf70c030a781880414c0dc9ac73b": "Safe signer",
  "0xfe93602c1d76834b6370833b9ce7c86939b5d97f": "arb keeper",
  "0x715bfd232483b2e9232d543cd1e99cc5219bb88e": "personal wallet",
  "0x0944f9aa36be35fe1aa148544b1000fdc099e770": "personal wallet",
};

// Known protocol contracts, labelled. Anything else with code is still
// excluded from the holder count, just labelled generically.
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

const nf = (n, d = 2) => Number(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });

(async () => {
  // batchMaxCount 1 per CLAUDE.md gotcha 1: this RPC rejects batched requests,
  // and ethers batches anything pending in the same tick regardless of origin.
  const rp = new ethers.JsonRpcProvider(RPC, 988, { batchMaxCount: 1, staticNetwork: true });

  const head = await rp.getBlockNumber();
  const hb = await rp.getBlock(head);
  const ob = await rp.getBlock(head - 100000);
  const perBlock = (hb.timestamp - ob.timestamp) / 100000;

  const pad = new ethers.Contract(PAD, [
    "function launches(address) view returns (address token,address creator,address pool,uint256 positionId,uint64 createdAt,uint256 a,uint256 b)",
  ], rp);
  const L = await pad.launches(MINTD);
  const created = Number(L.createdAt);
  // Start a margin before the estimated launch block. The estimate comes from
  // average block time, so it drifts; starting early costs a few empty windows
  // and starting late loses the mint itself.
  const startBlock = Math.max(0, head - Math.ceil((hb.timestamp - created) / perBlock) - 3000);

  const tok = new ethers.Contract(MINTD, [
    "function totalSupply() view returns (uint256)",
    "function symbol() view returns (string)",
  ], rp);
  const supply = await tok.totalSupply();

  console.log(`MINTD ${MINTD}`);
  console.log(`launched ${new Date(created * 1000).toISOString()}`);
  console.log(`scanning blocks ${startBlock} -> ${head}  (${Math.ceil((head - startBlock) / SPAN)} windows)\n`);

  // ---------------------------------------------------------------- the walk
  const bal = new Map();          // addr(lower) -> BigInt
  const everReceived = new Set(); // addr(lower) that ever had a positive credit
  const add = (a, v) => {
    const k = a.toLowerCase();
    bal.set(k, (bal.get(k) || 0n) + v);
    if (v > 0n) everReceived.add(k);
  };

  let transfers = 0, windows = 0, retried = 0;
  for (let from = startBlock; from <= head; from += SPAN) {
    const to = Math.min(head, from + SPAN - 1);
    let logs = null;
    // Retry rather than skip. A skipped window silently corrupts every number
    // in this report.
    for (let attempt = 0; attempt < 6 && logs === null; attempt++) {
      try { logs = await rp.getLogs({ address: MINTD, topics: [XFER], fromBlock: from, toBlock: to }); }
      catch (e) {
        if (attempt) retried++;
        if (attempt === 5) {
          console.error(`\nABORT: window ${from}-${to} unreadable after 6 attempts: ${e.shortMessage || e.message}`);
          console.error("Refusing to publish a distribution built on a gap.\n");
          process.exit(1);
        }
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      }
    }
    for (const lg of logs) {
      const fromA = "0x" + lg.topics[1].slice(26);
      const toA = "0x" + lg.topics[2].slice(26);
      const v = BigInt(lg.data);
      if (fromA.toLowerCase() !== ZERO) add(fromA, -v);
      if (toA.toLowerCase() !== ZERO) add(toA, v);
      transfers++;
    }
    windows++;
    if (windows % 150 === 0) process.stdout.write(`  ${windows} windows, ${transfers} transfers, ${bal.size} addresses\n`);
  }

  // ------------------------------------------------------- completeness check
  let sum = 0n;
  for (const v of bal.values()) sum += v;
  const complete = sum === supply;
  console.log(`\n${transfers} transfers across ${windows} windows (${retried} retries)`);
  console.log(`balances sum: ${ethers.formatEther(sum)}`);
  console.log(`totalSupply:  ${ethers.formatEther(supply)}`);
  console.log(complete ? "COMPLETE: every token is accounted for\n" : "INCOMPLETE: sum does not match supply\n");
  if (!complete) {
    console.error("Refusing to write a report from an incomplete walk.");
    process.exit(1);
  }

  // ------------------------------------------------------------------- price
  const pool = new ethers.Contract(L.pool, ["function slot0() view returns (uint160 sqrtPriceX96,int24,uint16,uint16,uint16,uint8,bool)", "function token0() view returns (address)"], rp);
  const [slot, t0] = [await pool.slot0(), await pool.token0()];
  const tokenIs0 = t0.toLowerCase() === MINTD.toLowerCase();
  const Q96 = 2n ** 96n;
  const sq = slot[0];
  // 1e18-scaled USD per token, accounting for the 18/6 decimal gap
  const price1e18 = tokenIs0 ? (sq * sq * 10n ** 30n) / (Q96 * Q96) : (10n ** 30n * Q96 * Q96) / (sq * sq);
  const price = Number(ethers.formatEther(price1e18));
  console.log(`price: $${price.toPrecision(6)} per MINTD\n`);

  // -------------------------------------------------------------- classify
  const holders = [...bal.entries()].filter(([, v]) => v > 0n);
  console.log(`classifying ${holders.length} addresses with a positive balance...`);
  const rows = [];
  let checked = 0;
  for (const [addr, v] of holders) {
    let kind = "holder", label = "";
    if (addr === DEAD.toLowerCase()) { kind = "burned"; label = "dead address"; }
    else if (MINE[addr]) { kind = "mine"; label = MINE[addr]; }
    else if (KNOWN[addr]) { kind = "contract"; label = KNOWN[addr]; }
    else {
      // anything else with code is a contract, whatever it is
      const code = await rp.getCode(addr);
      if (code !== "0x") { kind = "contract"; label = "unlabelled contract"; }
    }
    rows.push({ addr, bal: v, usd: Number(ethers.formatEther(v)) * price, kind, label });
    if (++checked % 100 === 0) process.stdout.write(`  ${checked}/${holders.length}\n`);
  }

  const real = rows.filter((r) => r.kind === "holder").sort((a, b) => b.usd - a.usd);
  const mine = rows.filter((r) => r.kind === "mine").sort((a, b) => b.usd - a.usd);
  const contracts = rows.filter((r) => r.kind === "contract").sort((a, b) => b.usd - a.usd);
  const burned = rows.find((r) => r.kind === "burned");

  const over = (n) => real.filter((r) => r.usd > n).length;
  // Received at some point, holds nothing now. Zero balances were dropped from
  // `holders`, so this is computed against everReceived.
  const soldToZero = [...everReceived].filter((a) => {
    const v = bal.get(a) || 0n;
    if (v > 0n) return false;
    if (a === DEAD.toLowerCase() || MINE[a] || KNOWN[a]) return false;
    return true;
  });

  const fmt = (r) => `\`${r.addr}\``;
  const dt = new Date().toISOString().slice(0, 10);
  const md = `# MINTD holder distribution

Snapshot ${dt}. Generated by \`scripts/holders.js\`, which walks every Transfer
log from the token's first block and rebuilds the full balance set.

Contract \`${MINTD}\` on Stable (chain 988).

## Method and its limits

Every Transfer log from block ${startBlock} to ${head} was read in ${SPAN}-block
windows, the maximum this RPC allows. A window that failed was retried up to
six times; the run aborts rather than skipping one, because a gap produces a
plausible distribution that is quietly wrong.

**Completeness check passed**: the balances sum to exactly \`totalSupply\`
(${nf(Number(ethers.formatEther(supply)), 0)} MINTD), so no transfer was missed.

Price used: **$${price.toPrecision(6)}** per MINTD, read from the V3 pool's
\`sqrtPriceX96\` at block ${head}. Every dollar figure moves with that price.

An address is excluded as a contract if \`eth_getCode\` returns anything. That
is deliberately blunt: it correctly removes pools, farms, lockers and routers,
and it would also remove a smart-contract wallet held by a real person.

## Headline

| | count |
|---|---|
| Addresses that ever received MINTD | ${everReceived.size} |
| Addresses holding any MINTD now | ${rows.length} |
| **Real holders** (not me, not a contract, not burned) | **${real.length}** |
| Holding more than $1 | ${over(1)} |
| Holding more than $10 | ${over(10)} |
| Holding more than $100 | ${over(100)} |
| Holding more than $1,000 | ${over(1000)} |
| Received then sold to zero | ${soldToZero.length} |

## Top 10 real holders

Excludes the dead address, every contract, and every wallet I control.

| # | address | MINTD | USD |
|---|---|---|---|
${real.slice(0, 10).map((r, i) => `| ${i + 1} | ${fmt(r)} | ${nf(Number(ethers.formatEther(r.bal)), 0)} | $${nf(r.usd)} |`).join("\n") || "| – | none | – | – |"}

## What was excluded

### Burned
${burned ? `${fmt(burned)} holds ${nf(Number(ethers.formatEther(burned.bal)), 0)} MINTD ($${nf(burned.usd)}), ${((Number(ethers.formatEther(burned.bal)) / Number(ethers.formatEther(supply))) * 100).toFixed(2)}% of supply.` : "Nothing at the dead address."}

### My own wallets
${mine.length ? `| address | label | MINTD | USD |
|---|---|---|---|
${mine.map((r) => `| ${fmt(r)} | ${r.label} | ${nf(Number(ethers.formatEther(r.bal)), 0)} | $${nf(r.usd)} |`).join("\n")}` : "None hold MINTD."}

### Contracts
${contracts.length ? `| address | what | MINTD | USD |
|---|---|---|---|
${contracts.map((r) => `| ${fmt(r)} | ${r.label} | ${nf(Number(ethers.formatEther(r.bal)), 0)} | $${nf(r.usd)} |`).join("\n")}` : "None hold MINTD."}

## Reading this honestly

The real-holder count is what it is. Liquidity in the pool is not held by
anyone, burned supply is gone, and my own wallets are not distribution.

${transfers} transfers, ${windows} windows, ${retried} retried.
`;

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, md);

  console.log(`\nreal holders: ${real.length}`);
  console.log(`  >$1 ${over(1)}   >$10 ${over(10)}   >$100 ${over(100)}   >$1000 ${over(1000)}`);
  console.log(`  sold to zero: ${soldToZero.length}`);
  console.log(`\nwritten to ${path.relative(ROOT, OUT)}`);
})().catch((e) => { console.error("\n" + (e.shortMessage || e.message) + "\n"); process.exit(1); });
