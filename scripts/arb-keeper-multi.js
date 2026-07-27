// Keeper for MintrArbMulti. Each round it asks the contract for the best
// contract-arb across every pool AND the best cross-pool arb, at several sizes,
// then fires whichever wins. Every call is simulated first, so a losing
// transaction is never broadcast.
//
//   ARB=0x... PRIVATE_KEY=0x... node scripts/arb-keeper-multi.js
//
// Optional env:
//   POLL_MS      poll interval, default 20000
//   MAX_SIZE     largest single arb in USDT0, default "250"
//   TG_BOT_TOKEN + TG_CHAT_ID   post a Telegram note on each successful arb
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://rpc.stable.xyz";
const POLL_MS = Number(process.env.POLL_MS || "20000");
const MAX_SIZE = process.env.MAX_SIZE || "250";
const BURNER = (process.env.BURNER || "0x7F007fbc6061806888A39A79763808aF5B94F4f4").toLowerCase();

const ABI = [
  "function poolCount() view returns (uint256)",
  "function pools(uint256) view returns (address pair, bool usdtIs0, uint16 feeBps, bool active)",
  "function prices(uint8) view returns (uint256 market1e18, uint256 contract1e18)",
  "function quote(uint8,uint256) view returns (bool premium, uint256 profit)",
  "function quoteBest(uint256) view returns (uint8 id, bool premium, uint256 profit)",
  "function quoteCross(uint8,uint8,uint256) view returns (uint256)",
  "function quoteBestCross(uint256) view returns (uint8 buyId, uint8 sellId, uint256 profit)",
  "function arb(uint8,uint256) returns (uint256)",
  "function arbCross(uint8,uint8,uint256) returns (uint256)",
  "function available() view returns (uint256)",
  "function minProfit() view returns (uint256)",
  "function paused() view returns (bool)",
  "function callerBps() view returns (uint256)",
  "function profitTo() view returns (address)",
  "function totalProfit() view returns (uint256)",
  "function totalRuns() view returns (uint256)",
];

async function tg(text) {
  const token = process.env.TG_BOT_TOKEN, chat = process.env.TG_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: "Markdown", disable_web_page_preview: true }),
    });
  } catch { /* notification is best-effort */ }
}

// Percentages here are tiny. A flat 2dp would print "+0.00%" for a real move.
function pctStr(pct) {
  const a = Math.abs(pct);
  if (a === 0) return "0%";
  let dp = 2;
  while (dp < 8 && a < 5 / Math.pow(10, dp)) dp++;
  return pct.toFixed(dp).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") + "%";
}

async function main() {
  const pk = process.env.PRIVATE_KEY, arbAddr = process.env.ARB;
  if (!pk || !arbAddr) throw new Error("Set ARB and PRIVATE_KEY env vars");
  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
  const wallet = new ethers.Wallet(pk, provider);
  const arb = new ethers.Contract(arbAddr, ABI, wallet);

  const n = Number(await arb.poolCount());
  console.log("MINTR multi-pool arb keeper live");
  console.log(`  arb:      ${arbAddr}`);
  console.log(`  keeper:   ${wallet.address}`);
  console.log(`  max size: ${MAX_SIZE} USDT0   poll: ${POLL_MS}ms`);
  for (let i = 0; i < n; i++) {
    const p = await arb.pools(i);
    console.log(`  pool ${i}:   ${p.pair}  fee ${Number(p.feeBps) / 100}%${p.active ? "" : "  (inactive)"}`);
  }

  // Say where profit goes by reading the contract, so the public alert can
  // never drift from the truth after a redeploy or a param change.
  const dest = (await arb.profitTo()).toLowerCase();
  const callerBps = Number(await arb.callerBps());
  const destPct = (10000 - callerBps) / 100;
  const destLine = dest === BURNER
    ? `${destPct}% goes to platform fees, which buy back and burn $MINTD`
    : `${destPct}% goes to the protocol treasury`;
  console.log(`  profit:   ${destPct}% -> ${dest === BURNER ? "BuybackBurner" : dest}${callerBps ? `, ${callerBps / 100}% -> keeper` : ""}`);

  let fails = 0;
  async function loop() {
    try {
      if (await arb.paused()) { console.log("paused, skipping"); return schedule(); }
      const float = await arb.available();
      const minProfit = await arb.minProfit();
      const cap = ethers.parseUnits(MAX_SIZE, 6);
      const ceiling = float < cap ? float : cap;
      if (ceiling === 0n) { console.log("float empty, fund the contract"); return schedule(); }

      // Search sizes, and both strategies at each size. Bigger is not always
      // better: price impact eats the spread past a point, so the best size is
      // usually well under the cap.
      let best = null;
      for (const frac of [100n, 75n, 50n, 25n, 10n]) {
        const size = (ceiling * frac) / 100n;
        if (size === 0n) continue;
        try {
          const [id, premium, profit] = await arb.quoteBest(size);
          if (profit > 0n && (!best || profit > best.profit)) {
            best = { kind: "single", id: Number(id), premium, profit, size };
          }
        } catch { /* size not viable */ }
        try {
          const [buyId, sellId, profit] = await arb.quoteBestCross(size);
          if (profit > 0n && (!best || profit > best.profit)) {
            best = { kind: "cross", buyId: Number(buyId), sellId: Number(sellId), profit, size };
          }
        } catch { /* size not viable */ }
      }

      if (!best || best.profit < minProfit) {
        const parts = [];
        for (let i = 0; i < n; i++) {
          try {
            const [m, c] = await arb.prices(i);
            const dev = (Number(ethers.formatEther(m)) / Number(ethers.formatEther(c)) - 1) * 100;
            parts.push(`p${i} ${dev >= 0 ? "+" : ""}${dev.toFixed(2)}%`);
          } catch { parts.push(`p${i} ?`); }
        }
        console.log(`no trade: ${parts.join("  ")}, best ${best ? ethers.formatUnits(best.profit, 6) : "0"}`);
        fails = 0;
        return schedule();
      }

      // simulate the exact call before spending gas
      let rc, label;
      if (best.kind === "single") {
        await arb.arb.staticCall(best.id, best.size);
        label = `pool ${best.id} ${best.premium ? "premium" : "discount"}`;
        console.log(`arbing ${ethers.formatUnits(best.size, 6)} USDT0 on ${label}, expecting ${ethers.formatUnits(best.profit, 6)}`);
        rc = await (await arb.arb(best.id, best.size)).wait();
      } else {
        await arb.arbCross.staticCall(best.buyId, best.sellId, best.size);
        label = `pool ${best.buyId} -> pool ${best.sellId}`;
        console.log(`cross-arbing ${ethers.formatUnits(best.size, 6)} USDT0 ${label}, expecting ${ethers.formatUnits(best.profit, 6)}`);
        rc = await (await arb.arbCross(best.buyId, best.sellId, best.size)).wait();
      }

      const [totalProfit, runs] = [await arb.totalProfit(), await arb.totalRuns()];
      console.log(`done ${rc.hash}  lifetime ${ethers.formatUnits(totalProfit, 6)} USDT0 over ${runs} runs`);

      await tg([
        `*MINTR arb*`,
        best.kind === "single"
          ? (best.premium ? `Market was above backing` : `Market was below backing`)
          : `Price gap between two pools`,
        `Profit: *${ethers.formatUnits(best.profit, 6)} USDT0*`,
        destLine,
        `[tx](https://stablescan.xyz/tx/${rc.hash})`,
      ].join("\n"));
      fails = 0;
    } catch (e) {
      fails++;
      console.error(`loop error (${fails}):`, e.shortMessage || e.message);
    }
    schedule();
  }
  // back off while the RPC is unhappy, then return to the normal cadence
  function schedule() {
    setTimeout(loop, fails ? Math.min(POLL_MS * Math.pow(2, fails), 120000) : POLL_MS);
  }
  loop();
}

main().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
