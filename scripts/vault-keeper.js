// Keeper for BuybackVault. Walks every vault the factory has made, and acts on
// the ones that have named THIS wallet as their agent.
//
//   node scripts/vault-keeper.js --dry     decide and print, broadcast nothing
//   node scripts/vault-keeper.js           live
//
// WHAT THIS PROCESS CAN AND CANNOT DO
// It holds no funds and has no privileges beyond being named. execute() and
// executeSell() take no arguments, so this key cannot choose a price, a size, a
// recipient or a direction beyond buy-versus-sell. If it is stolen the thief can
// waste gas and trade at bad moments inside the vault's own bounds, and the
// owner can revoke it with one transaction. See BuybackVault.sol.
//
// THE RULE, from DCR (dcr-rh.tech), adapted
//   r = 1e6 * (s^2 - s_prev^2) / s_prev^2      oriented move, off sqrtPriceX96
//   d = DEAD_ZONE                              band, in the same units
//   BUY   when r < -d          buy the drawdown
//   SELL  when r >  3d         and only if the vault is overweight, which the
//                              contract enforces, not this file
//   HOLD  otherwise
// Asymmetric on purpose: one band to buy, three to sell.
//
// WHY s_prev IS ON DISK
// The RPC prunes at roughly four days and has no archive state (CLAUDE.md
// gotcha 3), so a previous price cannot be read back from the chain. It is
// persisted here, and a missing file means HOLD rather than a guess.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://rpc.stable.xyz";
const FACTORY = process.env.VAULT_FACTORY || "0x3db601869c2C47Bfa9b08c62E077Df4806C1283A";
// One process, two vault types. Two keepers would mean two gas wallets and two
// things to notice have died.
const LP_FACTORY = process.env.AGENT_FACTORY || "0x28A9C05d0e31E2fEBf983F479d3c0278794BEE35";
// How wide a range to propose, in tick spacings either side of the TWAP tick.
const LP_WIDTH = Number(process.env.LP_WIDTH || 8);
// Re-centre once the TWAP tick sits within this fraction of the half-width of an
// edge. 0.25 means "act when price has eaten three quarters of the way out".
const LP_EDGE = Number(process.env.LP_EDGE || 0.25);
const STATE = path.join(__dirname, "..", "data", "vault-keeper-state.json");

// Randomised, never a fixed cron. A predictable buyer in a thin pool on a chain
// whose front-running hole is documented and unfixed is a free lunch, so the
// interval jitters and the next one is never published anywhere.
const MIN_MS = Number(process.env.MIN_MS || 600_000);   // 10 min
const MAX_MS = Number(process.env.MAX_MS || 900_000);   // 15 min
const DEAD_ZONE = Number(process.env.DEAD_ZONE || 1500); // ~0.15%
const SELL_MULT = Number(process.env.SELL_MULT || 3);

const FACTORY_ABI = [
  "function vaultCount() view returns (uint256)",
  "function vaults(uint256) view returns (address)",
];
const VAULT_ABI = [
  "function owner() view returns (address)",
  "function agent() view returns (address)",
  "function pool() view returns (address)",
  "function token() view returns (address)",
  "function balances() view returns (uint256 quoteBal, uint256 tokenBal)",
  "function cooldown() view returns (uint32)",
  "function lastExec() view returns (uint64)",
  "function execute() returns (uint256, uint256)",
  "function executeSell() returns (uint256, uint256)",
];
const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function token0() view returns (address)",
  "function observe(uint32[]) view returns (int56[], uint160[])",
];
const LP_FACTORY_ABI = [
  "function vaultCount() view returns (uint256)",
  "function allVaultsSlice(uint256,uint256) view returns (address[])",
];
const LP_VAULT_ABI = [
  "function agent() view returns (address)",
  "function mode() view returns (uint8)",
  "function pool() view returns (address)",
  "function tickSpacing() view returns (int24)",
  "function maxTickDrift() view returns (int24)",
  "function twapWindow() view returns (uint32)",
  "function cooldown() view returns (uint256)",
  "function lastAction() view returns (uint256)",
  "function positionId() view returns (uint256)",
  "function valueCheckpoint() view returns (uint256)",
  "function proposal() view returns (int24 lower, int24 upper, uint64 readyAt, bool approved, bool open, uint256 nonce)",
  "function propose(int24,int24)",
  "function execute()",
  "function compound()",
];
const MODE = ["PAUSED", "PROPOSE_ONLY", "TIMELOCKED", "AUTONOMOUS"];
const QUOTE = process.env.QUOTE || "0x779Ded0c9e1022225f8E0630b35a9b54bE713736"; // USDT0

/// The whole decision, as a pure function so it can be tested without a chain.
/// `s` and `sPrev` are sqrtPriceX96 as BigInt. `quoteIs0` says which side of the
/// pool the quote asset sorts on, and it is NOT optional.
///
/// WHY ORIENTATION IS THE WHOLE THING
/// sqrtPriceX96 is token1 per token0, so which direction means "the coin got
/// cheaper" depends on address ordering. USDT0 sorts below MINTD, so USDT0 is
/// token0 and the price is MINTD PER USDT0: when MINTD gets cheaper that number
/// goes UP. Reading the raw move as the coin's move therefore inverts the whole
/// strategy, and the agent buys pumps and sells dips while every log line still
/// reads as if it were working. DCR's formula carries a leading +/- for exactly
/// this reason; dropping it is what put a live keeper on the wrong side.
///
/// Returns r as THE COIN'S move: negative is a drawdown, in every ordering.
function decide(s, sPrev, quoteIs0, deadZone = DEAD_ZONE, sellMult = SELL_MULT) {
  if (typeof quoteIs0 !== "boolean") throw new Error("decide needs quoteIs0");
  if (!sPrev || sPrev === 0n || !s || s === 0n) return { action: "HOLD", r: null, why: "no previous price" };
  // Scaled to integers before dividing, so a sub-basis-point move is not lost
  // to truncation. Squaring sqrt prices gives the actual price ratio.
  const num = s * s - sPrev * sPrev;
  const raw = Number((num * 1_000_000n) / (sPrev * sPrev));
  const r = quoteIs0 ? -raw : raw;
  if (r < -deadZone) return { action: "BUY", r, why: `fell past -${deadZone}` };
  if (r > deadZone * sellMult) return { action: "SELL", r, why: `rose past ${deadZone * sellMult}` };
  return { action: "HOLD", r, why: `inside the band` };
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return { pools: {} }; }
}
function saveState(st) {
  try {
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify(st, null, 1) + "\n");
  } catch (e) { console.error("could not persist state:", e.message); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


/// Where to put an LP range, as a pure function so it can be tested without a
/// chain. Centred on the TWAP tick, never on spot: spot is what an attacker can
/// shove for one block, and the vault will reject a proposal that sits far from
/// its own TWAP anyway.
///
/// Both edges are snapped to `spacing`, because Uniswap only accepts ticks on
/// the spacing grid and an unsnapped proposal reverts inside the vault rather
/// than being rounded for you.
function rangeFor(twapTick, spacing, widthSpacings = LP_WIDTH) {
  const w = Math.max(1, Math.round(widthSpacings));
  const centre = Math.round(twapTick / spacing) * spacing;
  return { lower: centre - w * spacing, upper: centre + w * spacing };
}

/// Whether a live position is far enough off-centre to be worth moving.
///
/// Rebalancing is not free: it burns the position, swaps to rebalance the legs,
/// and re-mints, paying the pool fee on the swap every time. So this deliberately
/// does nothing until price has eaten most of the way to an edge, rather than
/// chasing every wiggle and grinding the vault down in fees.
function needsRebalance(twapTick, lower, upper, edgeFrac = LP_EDGE) {
  if (lower === upper) return { move: true, why: "no range set" };
  if (twapTick <= lower || twapTick >= upper) return { move: true, why: "price is outside the range" };
  const half = (upper - lower) / 2;
  const centre = (upper + lower) / 2;
  const off = Math.abs(twapTick - centre);
  // off/half is 0 dead centre, 1 at an edge.
  const slack = 1 - edgeFrac;
  return off / half >= slack
    ? { move: true, why: `price is ${(off / half * 100).toFixed(0)}% of the way to an edge` }
    : { move: false, why: `price is ${(off / half * 100).toFixed(0)}% of the way to an edge` };
}

/// Arithmetic-mean tick over the window, the same way the vault computes it.
async function twapTickOf(pool, window) {
  const [cum] = await pool.observe([window, 0]);
  const delta = cum[1] - cum[0];
  let t = Number(delta / BigInt(window));
  if (delta < 0n && delta % BigInt(window) !== 0n) t--;
  return t;
}

async function lpCycle(provider, signer, me, dry) {
  const f = new ethers.Contract(LP_FACTORY, LP_FACTORY_ABI, provider);
  const n = Number(await f.vaultCount());
  if (n === 0) { console.log("lp: no vaults yet"); return; }
  const list = await f.allVaultsSlice(0, Math.min(n, 200));
  let mine = 0, acted = 0;

  for (const addr of list) {
    const v = new ethers.Contract(addr, LP_VAULT_ABI, signer);
    try {
      if ((await v.agent()).toLowerCase() !== me.toLowerCase()) continue;
      mine++;
      const mode = Number(await v.mode());
      if (mode === 0) { console.log(`lp ${addr} PAUSED, skipping`); continue; }

      const last = Number(await v.lastAction());
      const cool = Number(await v.cooldown());
      if (Math.floor(Date.now() / 1000) < last + cool) continue;

      const poolAddr = await v.pool();
      const pc = new ethers.Contract(poolAddr, POOL_ABI, provider);
      const window = Number(await v.twapWindow());
      let tw;
      try { tw = await twapTickOf(pc, window); }
      catch (e) { console.log(`lp ${addr} no usable TWAP, skipping`); continue; }

      const spacing = Number(await v.tickSpacing());
      const p = await v.proposal();

      // An open proposal is a decision already made. Try to land it before
      // making another, or a TIMELOCKED vault never gets past its review window
      // because every cycle replaces the proposal and restarts the clock.
      if (p.open) {
        const ready = mode === 3 || p.approved || (mode === 2 && Date.now() / 1000 >= Number(p.readyAt));
        if (!ready) { console.log(`lp ${addr} proposal ${p.lower}..${p.upper} waiting (${MODE[mode]})`); continue; }
        try { await v.execute.staticCall(); }
        catch (e) { console.log(`lp ${addr} execute not possible: ${(e.shortMessage || e.message).slice(0, 80)}`); continue; }
        console.log(`lp ${addr} EXECUTE ${p.lower}..${p.upper}`);
        if (!dry) {
          // Explicit gasLimit: the vault's own header warns that execute and
          // deposit are under-reported by eth_estimateGas, because clearing a
          // proposal refunds storage and the estimate comes back NET while the
          // EVM charges GROSS.
          const tx = await v.execute({ gasLimit: 2_500_000 });
          console.log(`   sent ${(await tx.wait()).hash}`);
        } else console.log("   would send (dry run)");
        acted++;
        continue;
      }

      // No proposal. Decide whether the current range is still good enough.
      const posId = Number(await v.positionId());
      const decision = posId === 0
        ? { move: true, why: "no position yet" }
        : needsRebalance(tw, Number(p.lower), Number(p.upper));

      // A vault holding a position reports its range through the proposal only
      // after one has been made, so a live position with no stored proposal is
      // read as centred and left alone until it drifts out. Cheap and safe: the
      // worst case is a late rebalance, never an unwanted one.
      if (!decision.move) { console.log(`lp ${addr} HOLD (${decision.why})`); continue; }

      const { lower, upper } = rangeFor(tw, spacing);
      const drift = Number(await v.maxTickDrift());
      if (Math.abs(tw - (lower + upper) / 2) > drift) {
        console.log(`lp ${addr} proposed range would exceed maxTickDrift, skipping`);
        continue;
      }
      try { await v.propose.staticCall(lower, upper); }
      catch (e) { console.log(`lp ${addr} propose rejected: ${(e.shortMessage || e.message).slice(0, 80)}`); continue; }
      console.log(`lp ${addr} PROPOSE ${lower}..${upper} twap=${tw} (${decision.why}, ${MODE[mode]})`);
      if (!dry) {
        const tx = await v.propose(lower, upper, { gasLimit: 400_000 });
        console.log(`   sent ${(await tx.wait()).hash}`);
      } else console.log("   would send (dry run)");
      acted++;

      // AUTONOMOUS has nobody to wait for, so proposing and then sitting on the
      // proposal for a full interval before executing is pure latency: a fresh
      // vault would take two cycles, up to half an hour, just to mint its first
      // position. Execute in the same cycle. PROPOSE_ONLY and TIMELOCKED still
      // wait, which is their whole point.
      if (mode === 3) {
        try { await v.execute.staticCall(); }
        catch (e) { console.log(`   execute not yet possible: ${(e.shortMessage || e.message).slice(0, 70)}`); continue; }
        console.log(`lp ${addr} EXECUTE ${lower}..${upper} (same cycle, AUTONOMOUS)`);
        if (!dry) {
          const tx = await v.execute({ gasLimit: 2_500_000 });
          console.log(`   sent ${(await tx.wait()).hash}`);
        } else console.log("   would send (dry run)");
      }
    } catch (e) {
      console.error(`lp ${addr} errored: ${(e.shortMessage || e.message || "").slice(0, 100)}`);
    }
  }
  console.log(`lp cycle done: ${list.length} vaults, ${mine} mine, ${acted} acted`);
}

async function cycle(provider, signer, me, dry) {
  const st = loadState();
  const f = new ethers.Contract(FACTORY, FACTORY_ABI, provider);
  const n = Number(await f.vaultCount());
  let acted = 0, considered = 0;

  for (let i = 0; i < n; i++) {
    // Sequential throughout. Gotcha 1: ethers batches everything pending in the
    // same tick and Stable rejects the whole array, so two concurrent reads is
    // already too many.
    let addr;
    try { addr = await f.vaults(i); } catch { continue; }
    const v = new ethers.Contract(addr, VAULT_ABI, signer);
    try {
      const agent = await v.agent();
      // Opt-in, and the only gate that matters: a vault that has not named this
      // wallet is none of its business, and execute() would revert anyway.
      if (agent.toLowerCase() !== me.toLowerCase()) continue;
      considered++;

      const cooldown = Number(await v.cooldown());
      const last = Number(await v.lastExec());
      const now = Math.floor(Date.now() / 1000);
      if (now < last + cooldown) continue;

      const poolAddr = await v.pool();
      const pc = new ethers.Contract(poolAddr, POOL_ABI, provider);
      const slot = await pc.slot0();
      const s = BigInt(slot[0]);
      // Read from the pool, never assumed: the vault stores the same flag and
      // getting it backwards inverts the strategy silently.
      const quoteIs0 = (await pc.token0()).toLowerCase() === QUOTE.toLowerCase();
      const key = poolAddr.toLowerCase();
      const sPrev = st.pools[key] ? BigInt(st.pools[key]) : 0n;

      const d = decide(s, sPrev, quoteIs0);
      // Recorded whatever the decision, so the next cycle has a reference even
      // after a HOLD. Written before acting: a crash mid-swap must not make the
      // next run compare against a price two cycles old.
      st.pools[key] = s.toString();
      saveState(st);

      const [qBal, tBal] = await v.balances();
      if (d.action === "BUY" && qBal === 0n) continue;
      if (d.action === "SELL" && tBal === 0n) continue;

      console.log(`${addr} ${d.action.padEnd(4)} r=${d.r === null ? "-" : d.r} (${d.why})`);
      if (d.action === "HOLD") continue;

      const fn = d.action === "BUY" ? "execute" : "executeSell";
      // Simulated first, always. A losing or reverting transaction is never
      // broadcast, and the revert reason is only readable from a call: an
      // explicit gasLimit skips estimation, so a sent transaction that fails
      // comes back with no reason at all.
      try {
        await v[fn].staticCall();
      } catch (e) {
        const m = e.shortMessage || e.message || "";
        console.log(`   skipped: ${m.slice(0, 90)}`);
        continue;
      }
      if (dry) { console.log("   would send (dry run)"); acted++; continue; }
      const tx = await v[fn]({ gasLimit: 900_000 });
      const rc = await tx.wait();
      console.log(`   ${d.action} sent ${rc.hash}`);
      acted++;
    } catch (e) {
      console.error(`${addr} errored: ${(e.shortMessage || e.message || "").slice(0, 100)}`);
    }
  }
  console.log(`cycle done: ${n} vaults, ${considered} mine, ${acted} acted`);
}

// Only when run directly. Requiring this file for the decision tests must not
// start a keeper, which is what it did until the tests refused to load.
async function main() {
  const dry = process.argv.includes("--dry");
  const key = process.env.KEEPER_KEY || process.env.PRIVATE_KEY;
  if (!key) { console.error("Set KEEPER_KEY. It must be gas-only, never the deployer."); process.exit(1); }
  const provider = new ethers.JsonRpcProvider(RPC_URL, 988, { staticNetwork: true, batchMaxCount: 1 });
  const signer = new ethers.Wallet(key, provider);
  const me = await signer.getAddress();
  if (me.toLowerCase() === "0x8fc933374a2c1aa6d19c5f2bda33ad0b6be9eba4") {
    console.error("refusing to run as the compromised deployer key");
    process.exit(1);
  }
  console.log(`vault-keeper as ${me}${dry ? " (dry run)" : ""}, factory ${FACTORY}`);
  console.log(`band ${DEAD_ZONE}, sell at ${DEAD_ZONE * SELL_MULT}, interval ${MIN_MS / 1000}-${MAX_MS / 1000}s`);
  console.log(`lp factory ${LP_FACTORY}, width +/-${LP_WIDTH} spacings, re-centre at ${(1 - LP_EDGE) * 100}% to an edge`);

  for (;;) {
    try { await cycle(provider, signer, me, dry); }
    catch (e) { console.error("buyback cycle failed:", e.shortMessage || e.message); }
    // Separate try: an LP failure must not stop buyback vaults being serviced,
    // and the reverse.
    try { await lpCycle(provider, signer, me, dry); }
    catch (e) { console.error("lp cycle failed:", e.shortMessage || e.message); }
    if (process.argv.includes("--once")) break;
    await sleep(MIN_MS + Math.floor(Math.random() * (MAX_MS - MIN_MS)));
  }
}

if (require.main === module) main();

module.exports = { decide, rangeFor, needsRebalance };
