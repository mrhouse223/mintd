// Keeper for MintrArb: polls the spread, sizes the trade, and fires only when
// the on-chain quote says it clears minProfit. Every call is simulated first, so
// a losing transaction is never broadcast.
//
//   ARB=0x... PRIVATE_KEY=0x... node scripts/arb-keeper.js
//
// Optional env:
//   POLL_MS      poll interval, default 20000
//   MAX_SIZE     largest single arb in USDT0, default "250"
//   TG_BOT_TOKEN + TG_CHAT_ID   post a Telegram note on each successful arb
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://rpc.stable.xyz";
const POLL_MS = Number(process.env.POLL_MS || "20000");
const MAX_SIZE = process.env.MAX_SIZE || "250";

const ARB_ABI = [
  "function prices() view returns (uint256 market1e18, uint256 contract1e18)",
  "function quote(uint256 usdtIn) view returns (bool premium, uint256 profit)",
  "function available() view returns (uint256)",
  "function minProfit() view returns (uint256)",
  "function paused() view returns (bool)",
  "function arb(uint256 usdtIn) returns (uint256)",
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

async function main() {
  const pk = process.env.PRIVATE_KEY, arbAddr = process.env.ARB;
  if (!pk || !arbAddr) throw new Error("Set ARB and PRIVATE_KEY env vars");
  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
  const wallet = new ethers.Wallet(pk, provider);
  const arb = new ethers.Contract(arbAddr, ARB_ABI, wallet);

  console.log("MINTR arb keeper live");
  console.log(`  arb:      ${arbAddr}`);
  console.log(`  keeper:   ${wallet.address}`);
  console.log(`  max size: ${MAX_SIZE} USDT0   poll: ${POLL_MS}ms`);

  let fails = 0;
  async function loop() {
    try {
      if (await arb.paused()) { console.log("paused, skipping"); return schedule(); }
      const [float, minProfit] = await Promise.all([arb.available(), arb.minProfit()]);
      const cap = ethers.parseUnits(MAX_SIZE, 6);
      const ceiling = float < cap ? float : cap;
      if (ceiling === 0n) { console.log("float empty, fund the contract"); return schedule(); }

      // search a few sizes and keep the most profitable. Bigger is not always
      // better: price impact eats the spread past a point.
      let best = { size: 0n, profit: 0n, premium: false };
      for (const frac of [100n, 75n, 50n, 25n, 10n]) {
        const size = (ceiling * frac) / 100n;
        if (size === 0n) continue;
        try {
          const [premium, profit] = await arb.quote(size);
          if (profit > best.profit) best = { size, profit, premium };
        } catch { /* size not viable */ }
      }

      if (best.profit < minProfit) {
        const [m, c] = await arb.prices();
        const dev = (Number(ethers.formatEther(m)) / Number(ethers.formatEther(c)) - 1) * 100;
        console.log(`no trade: spread ${dev >= 0 ? "+" : ""}${dev.toFixed(2)}%, best profit ${ethers.formatUnits(best.profit, 6)}`);
        return schedule();
      }

      // simulate the exact call before spending gas
      await arb.arb.staticCall(best.size);
      console.log(`arbing ${ethers.formatUnits(best.size, 6)} USDT0 (${best.premium ? "premium" : "discount"}), expecting ${ethers.formatUnits(best.profit, 6)}`);
      const tx = await arb.arb(best.size);
      const rc = await tx.wait();
      const [totalProfit, runs] = await Promise.all([arb.totalProfit(), arb.totalRuns()]);
      console.log(`done ${rc.hash}  lifetime ${ethers.formatUnits(totalProfit, 6)} USDT0 over ${runs} runs`);
      await tg([
        `*MINTR arb*`,
        `${best.premium ? "Market was above backing" : "Market was below backing"}`,
        `Profit: *${ethers.formatUnits(best.profit, 6)} USDT0*`,
        `90% of it buys and burns $MINTD`,
        `[tx](https://stablescan.xyz/tx/${rc.hash})`,
      ].join("\n"));
      fails = 0;
    } catch (e) {
      fails++;
      console.error(`loop error (${fails}):`, e.shortMessage || e.message);
    }
    schedule();
  }
  function schedule() { setTimeout(loop, POLL_MS); }
  loop();
}

main().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
