// One-time backfill of agent trades into frontend/agent-trades.json, plus a
// reusable record() the keeper imports to append going forward.
//
// Scans BY TOPIC across all vaults at once, not vault by vault (gotcha 3b): one
// getLogs per 500-block chunk covers every vault's trades in that window and
// costs two orders of magnitude fewer calls than per-vault scanning.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const OUT = path.join(__dirname, "..", "frontend", "agent-trades.json");
const BF = "0x3db601869c2C47Bfa9b08c62E077Df4806C1283A";
const AF = "0x28A9C05d0e31E2fEBf983F479d3c0278794BEE35";
const SPAN = 500;              // hard cap (gotcha 2)
const MAX = 400;               // ~4 days of blocks at most; retention bounds it
const KEEP = 500;              // cap the file

const BUY = new ethers.Interface(["event Executed(bool indexed isBuy,uint256 amountIn,uint256 amountOut,uint256 minOut,uint64 at)"]);
const LP  = new ethers.Interface(["event Rebalanced(int24 lower,int24 upper,uint256 valueBefore,uint256 valueAfter)"]);
const facABI = ["function vaultCount() view returns (uint256)", "function vaults(uint256) view returns (address)", "function allVaultsSlice(uint256,uint256) view returns (address[])"];

function load() { try { return JSON.parse(fs.readFileSync(OUT, "utf8")); } catch { return { updated: 0, trades: [] }; } }
function save(data) {
  data.trades = data.trades.sort((a, b) => b.block - a.block).slice(0, KEEP);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(data, null, 1) + "\n");
}

// Append one trade, deduped by tx+logIndex. Imported by the keeper.
function record(entry) {
  const data = load();
  const key = entry.tx + ":" + (entry.li ?? 0);
  if (data.trades.some((t) => t.tx + ":" + (t.li ?? 0) === key)) return;
  data.trades.push(entry);
  data.updated = entry.ts || Math.floor(Date.now() / 1000);
  save(data);
}

async function main() {
  const rp = new ethers.JsonRpcProvider(process.env.STABLE_RPC_URL || "https://rpc.stable.xyz", 988, { staticNetwork: true, batchMaxCount: 1 });
  const bf = new ethers.Contract(BF, facABI, rp), af = new ethers.Contract(AF, facABI, rp);
  const buyVaults = new Set(), lpVaults = new Set();
  for (let i = 0; i < Number(await bf.vaultCount()); i++) buyVaults.add((await bf.vaults(i)).toLowerCase());
  for (const v of await af.allVaultsSlice(0, Number(await af.vaultCount()))) lpVaults.add(v.toLowerCase());

  const head = await rp.getBlockNumber();
  const topicBuy = BUY.getEvent("Executed").topicHash, topicLp = LP.getEvent("Rebalanced").topicHash;
  const data = load();
  const seen = new Set(data.trades.map((t) => t.tx + ":" + (t.li ?? 0)));
  let added = 0;

  for (let k = 0; k < MAX; k++) {
    const to = head - k * SPAN, from = to - SPAN + 1;
    if (to < 0) break;
    let logs = [];
    try { logs = await rp.getLogs({ topics: [[topicBuy, topicLp]], fromBlock: from, toBlock: to }); }
    catch { continue; }
    for (const l of logs) {
      const a = l.address.toLowerCase();
      const isBuyVault = buyVaults.has(a), isLpVault = lpVaults.has(a);
      if (!isBuyVault && !isLpVault) continue;         // not one of ours
      const key = l.transactionHash + ":" + l.index;
      if (seen.has(key)) continue;
      seen.add(key);
      let e;
      if (isBuyVault && l.topics[0] === topicBuy) {
        const p = BUY.parseLog(l);
        e = { vault: a, kind: "buyback", type: p.args.isBuy ? "buy" : "sell",
              amountIn: p.args.amountIn.toString(), amountOut: p.args.amountOut.toString() };
      } else if (isLpVault && l.topics[0] === topicLp) {
        const p = LP.parseLog(l);
        e = { vault: a, kind: "lp", type: "rebalance",
              lower: Number(p.args.lower), upper: Number(p.args.upper) };
      } else continue;
      const blk = await rp.getBlock(l.blockNumber);
      e.block = l.blockNumber; e.tx = l.transactionHash; e.li = l.index; e.ts = blk ? Number(blk.timestamp) : 0;
      data.trades.push(e); added++;
    }
    if (k % 40 === 0) process.stderr.write(`  ..${k}/${MAX} chunks, ${added} new\n`);
  }
  data.updated = Math.floor(Date.now() / 1000);
  save(data);
  console.log(`backfill done: ${added} new trades, ${data.trades.length} total -> ${OUT}`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { record };
