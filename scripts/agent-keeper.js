// Keeper for AgentVault. Watches vaults and proposes rebalances.
//
//   FACTORY=0x42D5... PRIVATE_KEY=0x... node scripts/agent-keeper.js
//   VAULTS=0xabc,0xdef PRIVATE_KEY=0x... node scripts/agent-keeper.js
//
//   FACTORY     AgentVaultFactory to discover vaults from. Optional; VAULTS
//               still works on its own and the two can be combined
//   VAULTS      comma-separated vaults to watch regardless of discovery
//   RPC_URL     chain rpc, default Arc testnet
//   POLL_MS     poll interval, default 60000
//   PAGE        vaults per registry page, default 200
//   RECHECK_EVERY  polls between re-checking vaults that are not ours, default 10
//   MIN_GAIN_BPS  minimum modelled improvement before proposing, default 50
//   DRY         set to 1 to log decisions without sending anything
//
// DISCOVERY, AND WHY IT FILTERS
// Vault creation is permissionless, so the factory's list is spammable by
// design: anyone can create a vault naming anyone as its agent. This process
// therefore acts only on vaults whose `agent()` is this keeper's own address.
// Without that filter a stranger could enlist us into polling, and paying gas
// for, an unbounded number of vaults we have no authority over anyway. Being
// dropped as agent later is equally normal, so the check is re-run rather than
// cached forever.
//
// Discovery reads the factory's registry, not VaultCreated logs. The registry
// is on-chain state and so survives log pruning, which on Stable removes
// history after about four days; an event-based keeper restarting after that
// would find nothing and manage no vaults, looking exactly like a quiet day.
//
// WHAT THIS PROCESS CAN AND CANNOT DO
// It can decide *when* to propose a rebalance and what range to suggest. It
// cannot choose an execution price, a venue, or a slippage bound: the vault
// derives all of those from the pool's TWAP and ignores anything this process
// might want. If this key is stolen, the attacker inherits exactly one power,
// which is to make badly timed rebalances that waste gas. That is the whole
// design, and it is why this script is allowed to be a plain node process with
// a hot key.
//
// The wallet must be gas-only, never an address holding funds, exactly like
// the arb keeper. That buys nothing on its own, since the authority is the
// asset rather than the balance, but a keeper that also holds money is a
// strictly worse target for no benefit.
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const RPC_URL = process.env.RPC_URL || "https://rpc.testnet.arc.network";
const POLL_MS = Number(process.env.POLL_MS || "60000");
const MIN_GAIN_BPS = BigInt(process.env.MIN_GAIN_BPS || "50");
const DRY = process.env.DRY === "1";
const FACTORY = (process.env.FACTORY || "").trim();
const RECHECK_EVERY = Number(process.env.RECHECK_EVERY || "10");
const PAGE = Number(process.env.PAGE || "200");

const FACTORY_ABI = [
  "function vaultCount() view returns (uint256)",
  "function allVaultsSlice(uint256 start, uint256 count) view returns (address[])",
];

const VAULT_ABI = [
  "function owner() view returns (address)",
  "function pool() view returns (address)",
  "function npm() view returns (address)",
  "function agent() view returns (address)",
  "function mode() view returns (uint8)",
  "function positionId() view returns (uint256)",
  "function maxTickDrift() view returns (int24)",
  "function cooldown() view returns (uint256)",
  "function lastAction() view returns (uint256)",
  "function valueNow() view returns (uint256)",
  "function valueCheckpoint() view returns (uint256)",
  "function twapWindow() view returns (uint32)",
  "function proposal() view returns (int24 lower, int24 upper, uint64 readyAt, bool approved, bool open)",
  "function propose(int24 lower, int24 upper)",
  "function execute()",
  "function compound()",
];
const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function tickSpacing() view returns (int24)",
  "function observe(uint32[]) view returns (int56[],uint160[])",
];
const NPM_ABI = [
  "function positions(uint256) view returns (uint96,address,address,address,uint24,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256,uint256,uint128,uint128)",
];

const MODE = ["PAUSED", "PROPOSE_ONLY", "TIMELOCKED", "AUTONOMOUS"];
const ts = () => new Date().toISOString().slice(11, 19);
const log = (m) => console.log(`${ts()}  ${m}`);

const alignDown = (t, s) => Math.floor(t / s) * s;
const alignUp = (t, s) => Math.ceil(t / s) * s;

/// The tick the VAULT will validate against, computed exactly as the contract
/// does. Proposals are checked against the TWAP, never against spot, so a
/// keeper that builds ranges around spot proposes things the vault rejects.
async function twapTick(pool, window) {
  const [cum] = await pool.observe([window, 0]);
  const delta = cum[1] - cum[0];
  const w = BigInt(window);
  let t = delta / w;
  // Solidity truncates toward zero; the contract compensates so that a negative
  // tick rounds down. Reproduce it rather than approximating, or ranges near
  // zero land one tick off and fail validation for no visible reason.
  if (delta < 0n && delta % w !== 0n) t -= 1n;
  return Number(t);
}

const cacheFile = (chainId) =>
  path.join(__dirname, "..", "data", `agent-vaults-${chainId}.json`);

/// Purely an optimisation, unlike the indexer caches elsewhere in this repo.
/// The factory's registry is the durable record and can always rebuild this
/// from scratch, so losing the file costs one extra page of reads and nothing
/// else. It exists to avoid re-paging the whole registry every restart.
function loadCache(chainId) {
  try { return JSON.parse(fs.readFileSync(cacheFile(chainId), "utf8")); }
  catch { return { factory: FACTORY, registryCount: 0, vaults: {} }; }
}
function saveCache(chainId, c) {
  const f = cacheFile(chainId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n");
}

/// Find every vault this factory has created.
///
/// Reads the factory's registry rather than scanning VaultCreated logs, and the
/// difference matters more than it looks. The registry is on-chain state, so it
/// is immune to log pruning: Stable drops logs after roughly four days, and an
/// event-based keeper restarting after that would find nothing and silently
/// manage no vaults, which is indistinguishable from having nothing to do. It
/// also sidesteps both getLogs caps entirely (gotcha 2), because paging is
/// bounded by an argument we choose rather than by the node's result limit.
///
/// The list is append-only, so a changed `vaultCount` means new entries at the
/// tail and the whole check costs one call when nothing has happened.
async function discover(provider, cache) {
  if (!FACTORY) return 0;
  const f = new ethers.Contract(FACTORY, FACTORY_ABI, provider);
  const count = Number(await f.vaultCount());
  const seen = Number(cache.registryCount || 0);
  if (count === seen) return 0;
  // A count that went DOWN cannot happen against one factory, so it means this
  // cache belongs to a different deployment. Re-read from the start.
  const from = count < seen ? 0 : seen;

  let added = 0;
  for (let i = from; i < count; i += PAGE) {
    // Sequential: ethers batches everything pending in the same tick and both
    // chains reject batched JSON-RPC (gotcha 1).
    const page = await f.allVaultsSlice(i, PAGE);
    for (const v of page) {
      const a = ethers.getAddress(v);
      if (!cache.vaults[a]) { cache.vaults[a] = { mine: null }; added++; }
    }
  }
  cache.registryCount = count;
  return added;
}

/// Width of the range we aim for, as a multiple of tick spacing. Deliberately
/// simple: a wider range earns less fee per unit but needs rebalancing far less
/// often, and every rebalance costs a swap. Tuning this is a product decision,
/// not something to hide in a heuristic.
const WIDTH_SPACINGS = 30;

/// Build a range the vault will actually accept. `t` must be the TWAP tick.
///
/// Both bounds align INWARD: lower rounds up, upper rounds down. Rounding both
/// down, as this did originally, pushes `lower` below the band floor whenever
/// t - half is not already on a spacing boundary, and the vault rejects it with
/// "outside TWAP band". That is not a rare edge: with drift 2000 and spacing
/// 200 it happened on the very first live proposal.
function desiredRange(t, spacing, maxDrift) {
  let half = WIDTH_SPACINGS * spacing;
  if (half > maxDrift) half = maxDrift;
  let lower = alignUp(t - half, spacing);
  let upper = alignDown(t + half, spacing);
  // The vault requires the range to CONTAIN the TWAP, not merely sit near it.
  // Inward alignment can push a bound past t when half is close to spacing.
  if (lower > t) lower = alignDown(t, spacing);
  if (upper < t) upper = alignUp(t, spacing);
  if (lower >= upper) { lower = alignDown(t, spacing); upper = lower + spacing; }
  return [lower, upper];
}

/// Should this vault be rebalanced at all?
///
/// Being out of range is NOT sufficient. Every rebalance realises impermanent
/// loss and pays a swap fee, so an eager keeper loses more than it earns. The
/// bar is that the position is meaningfully off-centre AND the cooldown has
/// elapsed AND the vault is not already halted by its loss breaker.
async function decide(v, pool, npm) {
  const mode = Number(await v.mode());
  if (mode === 0) return { act: false, why: "paused" };

  const agent = await v.agent();
  if (agent === ethers.ZeroAddress) return { act: false, why: "agent revoked" };

  const cooldown = await v.cooldown();
  const last = await v.lastAction();
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (last > 0n && now < last + cooldown) {
    return { act: false, why: `cooldown, ${last + cooldown - now}s left` };
  }

  const p = await v.proposal();
  if (p.open) {
    // Something is already pending. Whether we may push it through depends on
    // the owner's mode, which the vault enforces regardless of what we think.
    if (mode === 1 && !p.approved) return { act: false, why: "awaiting owner approval" };
    if (mode === 2 && !p.approved && now < BigInt(p.readyAt)) {
      return { act: false, why: `in review for ${BigInt(p.readyAt) - now}s` };
    }
    return { act: true, exec: true, why: "pending proposal is executable" };
  }

  const spacing = Number(await pool.tickSpacing());
  const tick = Number((await pool.slot0()).tick);
  const drift = Number(await v.maxTickDrift());
  // Range built on the TWAP, because that is what the vault validates against.
  // The off-centre test below stays on spot, because whether the position is
  // actually earning fees is a question about where trading happens now.
  const tw = await twapTick(pool, Number(await v.twapWindow()));
  const [lower, upper] = desiredRange(tw, spacing, drift);

  const posId = await v.positionId();
  if (posId === 0n) return { act: true, exec: false, lower, upper, why: "no position yet" };

  const pos = await npm.positions(posId);
  const lo = Number(pos.tickLower), hi = Number(pos.tickUpper);
  const width = hi - lo;
  if (width <= 0) return { act: true, exec: false, lower, upper, why: "degenerate range" };

  // How far the price has drifted from the centre, as a share of half-width.
  // 1.0 means it is sitting exactly on an edge.
  const centre = (lo + hi) / 2;
  const off = Math.abs(tick - centre) / (width / 2);

  if (off < 0.6) return { act: false, why: `centred enough (${(off * 100).toFixed(0)}% to edge)` };

  // Rough modelled gain: recentring restores the whole range's usefulness. Use
  // the drift itself as the proxy and require it to clear MIN_GAIN_BPS, so a
  // marginal improvement does not pay for a swap.
  const gainBps = BigInt(Math.floor(off * 10000)) - 6000n;
  if (gainBps < MIN_GAIN_BPS) return { act: false, why: `gain ${gainBps}bps under threshold` };

  return { act: true, exec: false, lower, upper, why: `${(off * 100).toFixed(0)}% to edge` };
}

async function main() {
  const pk = process.env.PRIVATE_KEY;
  const manual = (process.env.VAULTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!pk) throw new Error("Set PRIVATE_KEY");
  if (!manual.length && !FACTORY) throw new Error("Set FACTORY or VAULTS (or both)");

  // batchMaxCount 1 per CLAUDE.md gotcha 1. Both Stable and Arc mishandle
  // batched JSON-RPC, and ethers batches anything pending in the same tick
  // regardless of which part of the process issued it.
  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
  const net = await provider.getNetwork();
  const wallet = new ethers.Wallet(pk.startsWith("0x") ? pk : "0x" + pk, provider);

  const chainId = String(net.chainId);
  log(`agent-keeper on chain ${chainId}`);
  log(`keeper ${wallet.address}${DRY ? "   DRY RUN, nothing will be sent" : ""}`);
  log(`poll ${POLL_MS}ms, min gain ${MIN_GAIN_BPS}bps`);

  const bal = await provider.getBalance(wallet.address);
  log(`gas balance ${ethers.formatEther(bal)}`);
  if (bal === 0n) log("WARNING: keeper has no gas, every action will fail");

  const cache = loadCache(chainId);
  // A cache written against a different factory describes vaults this keeper
  // has no business with. Start clean rather than silently mixing the two.
  if (FACTORY && cache.factory && cache.factory.toLowerCase() !== FACTORY.toLowerCase()) {
    log(`factory changed, discarding cache for ${cache.factory}`);
    cache.factory = FACTORY; cache.registryCount = 0; cache.vaults = {};
  }
  if (FACTORY) { cache.factory = FACTORY; log(`discovering from factory ${FACTORY}`); }
  for (const m of manual) if (!cache.vaults[m]) cache.vaults[m] = { mine: null, block: 0, manual: true };

  let polls = 0;
  let fails = 0;
  async function loop() {
    try {
      polls++;
      if (FACTORY) {
        const added = await discover(provider, cache);
        if (added) log(`discovered ${added} new vault(s), ${Object.keys(cache.vaults).length} known`);
      }

      // Resolve which vaults are actually ours. An owner can point a vault at
      // this keeper long after creating it, so vaults that were not ours get
      // re-checked periodically rather than written off for good.
      for (const [addr, meta] of Object.entries(cache.vaults)) {
        if (meta.mine === true) continue;
        if (meta.mine === false && polls % RECHECK_EVERY !== 1) continue;
        try {
          const agent = await new ethers.Contract(addr, VAULT_ABI, provider).agent();
          const mine = agent.toLowerCase() === wallet.address.toLowerCase();
          if (mine !== meta.mine) log(`${addr.slice(0, 10)}  ${mine ? "is now ours" : "is not ours"}`);
          meta.mine = mine;
        } catch { meta.mine = false; }
      }
      saveCache(chainId, cache);

      const list = Object.entries(cache.vaults).filter(([, m]) => m.mine).map(([a]) => a);
      if (!list.length) log(`nothing to do: 0 of ${Object.keys(cache.vaults).length} known vault(s) name us as agent`);

      for (const addr of list) {
        const v = new ethers.Contract(addr, VAULT_ABI, wallet);
        let d;
        try {
          const poolAddr = await v.pool();
          const pool = new ethers.Contract(poolAddr, POOL_ABI, provider);
          // Read from the vault itself, not from env. A keeper pointed at the
          // wrong position manager would misread every range and propose
          // nonsense, and the vault is the authority on which one it uses.
          const npm = new ethers.Contract(await v.npm(), NPM_ABI, provider);
          d = await decide(v, pool, npm);
        } catch (e) {
          // A vault whose TWAP is not yet available reverts on valueNow and on
          // any action. That is a normal state for a fresh pool, not a fault.
          log(`${addr.slice(0, 10)}  unreadable: ${(e.shortMessage || e.message).slice(0, 60)}`);
          continue;
        }

        if (!d.act) { log(`${addr.slice(0, 10)}  skip: ${d.why}`); continue; }
        if (DRY) { log(`${addr.slice(0, 10)}  WOULD ${d.exec ? "execute" : `propose ${d.lower}..${d.upper}`}: ${d.why}`); continue; }

        try {
          if (!d.exec) {
            const tx = await v.propose(d.lower, d.upper);
            await tx.wait();
            log(`${addr.slice(0, 10)}  proposed ${d.lower}..${d.upper} (${d.why})`);
          }
          // Try to execute. In PROPOSE_ONLY this reverts until the owner
          // approves, which is expected and not an error worth shouting about.
          try {
            const tx2 = await v.execute();
            await tx2.wait();
            log(`${addr.slice(0, 10)}  executed`);
          } catch (e) {
            const m = (e.shortMessage || e.message || "").slice(0, 70);
            if (/needs approval|in review/.test(m)) log(`${addr.slice(0, 10)}  waiting on the owner`);
            else if (/loss breaker/.test(m)) log(`${addr.slice(0, 10)}  HALTED by loss breaker, owner must reset`);
            else log(`${addr.slice(0, 10)}  execute failed: ${m}`);
          }
        } catch (e) {
          log(`${addr.slice(0, 10)}  propose failed: ${(e.shortMessage || e.message).slice(0, 70)}`);
        }
      }
      fails = 0;
    } catch (e) {
      fails++;
      log(`loop error (${fails}): ${e.shortMessage || e.message}`);
    }
    setTimeout(loop, fails ? Math.min(POLL_MS * 2 ** fails, 300000) : POLL_MS);
  }
  loop();
}

main().catch((e) => { console.error("\n" + (e.shortMessage || e.message) + "\n"); process.exit(1); });
