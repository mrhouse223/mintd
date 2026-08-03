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
//   SELL  when r >  4d         and only if the vault is overweight, which the
//                              contract enforces, not this file
//   HOLD  otherwise
// Asymmetric on purpose: one band to buy, four to sell.
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
const STATE = path.join(__dirname, "..", "data", "vault-keeper-state.json");

// Randomised, never a fixed cron. A predictable buyer in a thin pool on a chain
// whose front-running hole is documented and unfixed is a free lunch, so the
// interval jitters and the next one is never published anywhere.
const MIN_MS = Number(process.env.MIN_MS || 600_000);   // 10 min
const MAX_MS = Number(process.env.MAX_MS || 900_000);   // 15 min
const DEAD_ZONE = Number(process.env.DEAD_ZONE || 1500); // ~0.15%
const SELL_MULT = Number(process.env.SELL_MULT || 4);

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
  "function slot0() view returns (uint160 sqrtPriceX96, int24, uint16, uint16, uint16, uint8, bool)",
  "function token0() view returns (address)",
];
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

  for (;;) {
    try { await cycle(provider, signer, me, dry); }
    catch (e) { console.error("cycle failed:", e.shortMessage || e.message); }
    if (process.argv.includes("--once")) break;
    await sleep(MIN_MS + Math.floor(Math.random() * (MAX_MS - MIN_MS)));
  }
}

if (require.main === module) main();

module.exports = { decide };
