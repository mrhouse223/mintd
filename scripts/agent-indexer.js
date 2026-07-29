// Indexes AgentVault activity into money/agent-data.json for the dashboard.
//
//   FACTORY=0x42D5... node scripts/agent-indexer.js
//   FROM_BLOCK=54170000 node scripts/agent-indexer.js     # first run only
//
// WHY AN INDEXER AND NOT A LIVE PAGE
// Arc produces roughly four blocks a second, and getLogs is capped at 500
// blocks a call, so scanning a day of history from the browser would be a
// thousand round trips before the page rendered anything. The same reason
// stats-indexer.js exists.
//
// The output file is also the durable record. Chains prune logs, so an event
// that is not banked here is gone; the cursor only ever moves forward and the
// event list is only ever appended to. Committing this file is what makes the
// dashboard survive pruning, exactly like stats-cache.json.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const RPC = process.env.RPC_URL || "https://rpc.testnet.arc.network";
const FACTORY = (process.env.FACTORY || "0x42D58A7dFB4235F25F8ef6Bf84753B4F9A6531be").trim();
const SPAN = Number(process.env.SPAN || "500");
const OUT = path.join(__dirname, "..", "money", "agent-data.json");

const FACTORY_ABI = [
  "function vaultCount() view returns (uint256)",
  "function allVaultsSlice(uint256 start, uint256 count) view returns (address[])",
];
const POOL_ABI = [
  "function slot0() view returns (uint160,int24 tick,uint16,uint16,uint16,uint8,bool)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
];
const E20 = ["function symbol() view returns (string)", "function decimals() view returns (uint8)"];
const NPM_ABI = [
  "function positions(uint256) view returns (uint96,address,address,address,uint24,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256,uint256,uint128,uint128)",
];

const MODES = ["PAUSED", "PROPOSE_ONLY", "TIMELOCKED", "AUTONOMOUS"];
const log = (m) => console.log(`${new Date().toISOString().slice(11, 19)}  ${m}`);

function load() {
  try { return JSON.parse(fs.readFileSync(OUT, "utf8")); }
  catch { return { chainId: 0, factory: FACTORY, fromBlock: 0, lastScanned: 0, vaults: {} }; }
}

/// Both getLogs caps handled by shrinking and retrying the SAME range. Skipping
/// a window that failed on the result cap would drop trades silently, and a
/// dashboard missing a rebalance is worse than one that is late.
async function getLogsChunked(rp, address, from, to, span) {
  const out = [];
  let cur = from;
  while (cur <= to) {
    let width = Math.min(span, to - cur + 1);
    for (;;) {
      const end = cur + width - 1;
      try {
        out.push(...await rp.getLogs({ address, fromBlock: cur, toBlock: end }));
        cur = end + 1;
        break;
      } catch (e) {
        if (width <= 1) throw e;
        width = Math.max(1, Math.floor(width / 2));
      }
    }
  }
  return out;
}

async function main() {
  const rp = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
  const net = await rp.getNetwork();
  const latest = await rp.getBlockNumber();
  const vart = require(path.join(__dirname, "..", "build", "AgentVault.json"));
  const iface = new ethers.Interface(vart.abi);

  const data = load();
  data.chainId = Number(net.chainId);
  data.factory = FACTORY;
  if (!data.fromBlock) data.fromBlock = Number(process.env.FROM_BLOCK || (latest - 20000));
  if (!data.lastScanned) data.lastScanned = data.fromBlock - 1;

  // Discover vaults from the registry, not from events: on-chain state survives
  // log pruning, so a vault created before the retention window is still found.
  const f = new ethers.Contract(FACTORY, FACTORY_ABI, rp);
  const count = Number(await f.vaultCount());
  const addrs = [];
  for (let i = 0; i < count; i += 200) addrs.push(...await f.allVaultsSlice(i, 200));
  log(`factory ${FACTORY}: ${count} vault(s)`);

  const from = data.lastScanned + 1;
  const to = latest;
  for (const a of addrs) {
    const addr = ethers.getAddress(a);
    const v = new ethers.Contract(addr, vart.abi, rp);
    const rec = data.vaults[addr] || (data.vaults[addr] = { events: [] });

    // Live state, re-read every pass.
    rec.address = addr;
    rec.owner = await v.owner();
    rec.agent = await v.agent();
    rec.pool = await v.pool();
    rec.mode = MODES[Number(await v.mode())];
    rec.valueInToken0 = await v.valueInToken0();
    rec.positionId = (await v.positionId()).toString();
    rec.checkpoint = (await v.valueCheckpoint()).toString();
    try { rec.value = (await v.valueNow()).toString(); }
    catch { rec.value = null; rec.valueError = "no TWAP available"; }

    const pool = new ethers.Contract(rec.pool, POOL_ABI, rp);
    const t0 = await pool.token0(), t1 = await pool.token1();
    const c0 = new ethers.Contract(t0, E20, rp), c1 = new ethers.Contract(t1, E20, rp);
    rec.token0 = { address: t0, symbol: await c0.symbol().catch(() => "?"), decimals: Number(await c0.decimals().catch(() => 18)) };
    rec.token1 = { address: t1, symbol: await c1.symbol().catch(() => "?"), decimals: Number(await c1.decimals().catch(() => 18)) };
    rec.fee = Number(await pool.fee());
    rec.tick = Number((await pool.slot0()).tick);
    // The numeraire decides how every value figure on the dashboard is scaled.
    rec.numeraire = rec.valueInToken0 ? rec.token0 : rec.token1;

    if (rec.positionId !== "0") {
      const npm = new ethers.Contract(await v.npm(), NPM_ABI, rp);
      const p = await npm.positions(rec.positionId);
      rec.position = {
        tickLower: Number(p.tickLower), tickUpper: Number(p.tickUpper),
        liquidity: p.liquidity.toString(),
        inRange: rec.tick >= Number(p.tickLower) && rec.tick < Number(p.tickUpper),
      };
    } else rec.position = null;

    if (from > to) continue;
    const logs = await getLogsChunked(rp, addr, from, to, SPAN);
    const times = new Map();
    for (const l of logs) {
      let parsed;
      try { parsed = iface.parseLog(l); } catch { continue; }
      if (!times.has(l.blockNumber)) times.set(l.blockNumber, (await rp.getBlock(l.blockNumber)).timestamp);
      rec.events.push({
        block: l.blockNumber,
        time: times.get(l.blockNumber),
        tx: l.transactionHash,
        name: parsed.name,
        args: parsed.args.map((x) => x.toString()),
      });
    }
    // Append-only, but a re-scan of an overlapping range would duplicate. Key on
    // tx plus log position rather than trusting the cursor to be exact.
    const seen = new Set();
    rec.events = rec.events.filter((e) => {
      const k = `${e.tx}:${e.name}:${e.block}:${e.args.join(",")}`;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    }).sort((a, b) => a.block - b.block);
    log(`${addr.slice(0, 10)}  ${rec.events.length} event(s), mode ${rec.mode}`);
  }

  data.lastScanned = to;
  data.updated = Math.floor(Date.now() / 1000);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(data, null, 2) + "\n");
  log(`wrote ${path.relative(path.join(__dirname, ".."), OUT)} through block ${to}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
