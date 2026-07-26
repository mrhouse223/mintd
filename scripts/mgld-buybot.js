// $MGLD buybot: watches the Uniswap V3 MGLD/USDT0 pool and the MintSwap V2 pool
// for BUYS (USDT0 in -> MGLD out) and posts an alert to Telegram. Also reports
// the live gold price and how far the pool has drifted from the oracle.
//
//   TG_BOT_TOKEN=123:abc TG_CHAT_ID=-100123 node scripts/mgld-buybot.js
//
// Env:
//   V3_POOL      Uniswap V3 MGLD/USDT0 pool  (default set below)
//   V2_POOL      MintSwap MGLD/USDT0 pair    (optional, set to also watch it)
//   SYNTH        MintSynth engine, for the oracle price + system stats
//   MIN_USD      ignore buys under this (default "1")
//   POLL_MS      poll interval (default "12000")
//   LOGO_URL     image posted with each alert (default the site's gold bar)
//   BUY_TOKEN    emoji repeated per unit of buy size (default 🟡)
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://rpc.stable.xyz";
const USDT0 = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";
const MGLD = process.env.MGLD || "0x872a3C280B846759187c9E57F62d1Ed8407b135C";
const SYNTH = process.env.SYNTH || "0x09Eb7D9B18e56270F8898C4f3Ac3F2dc99F3b213";
const V3_POOL = process.env.V3_POOL || "0x3191ad893DB28A571Fd551d37A618E289451A363";
const V2_POOL = process.env.V2_POOL || "";
const BUY_TOKEN = process.env.BUY_TOKEN || "🟡";
const LOGO_URL = process.env.LOGO_URL || "https://mintd.fun/mgld.png";
const MIN_USD = Number(process.env.MIN_USD || "1");
const POLL_MS = Number(process.env.POLL_MS || "12000");
const MAX_RANGE = Number(process.env.MAX_RANGE || "2000");

const V3_SWAP_TOPIC = ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)");
const v3Iface = new ethers.Interface([
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
]);
const V2_SWAP_TOPIC = ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)");
const v2Iface = new ethers.Interface([
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
]);
const SYNTH_ABI = [
  "function price() view returns (uint256)",
  "function totalDebt() view returns (uint256)",
  "function totalCollateral() view returns (uint256)",
];

async function tg(method, body) {
  const token = process.env.TG_BOT_TOKEN;
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) console.error("telegram error:", j.description);
  return j;
}
function emojiRow(usd) {
  const n = Math.min(48, Math.max(1, Math.floor(usd / 5)));
  return BUY_TOKEN.repeat(n);
}

async function main() {
  const token = process.env.TG_BOT_TOKEN, chat = process.env.TG_CHAT_ID;
  if (!token || !chat) throw new Error("Set TG_BOT_TOKEN and TG_CHAT_ID");
  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
  const eng = new ethers.Contract(SYNTH, SYNTH_ABI, provider);

  // which side of each pool is USDT0
  const poolAbi = ["function token0() view returns (address)"];
  const v3t0 = (await new ethers.Contract(V3_POOL, poolAbi, provider).token0()).toLowerCase();
  const v3UsdtIs0 = v3t0 === USDT0.toLowerCase();
  let v2UsdtIs0 = null;
  if (V2_POOL) {
    const t0 = (await new ethers.Contract(V2_POOL, poolAbi, provider).token0()).toLowerCase();
    v2UsdtIs0 = t0 === USDT0.toLowerCase();
  }

  console.log("MGLD buybot live");
  console.log(`  v3 pool:  ${V3_POOL}`);
  if (V2_POOL) console.log(`  v2 pool:  ${V2_POOL}`);
  console.log(`  engine:   ${SYNTH}`);
  console.log(`  chat:     ${chat}`);
  console.log(`  min:      $${MIN_USD}   poll: ${POLL_MS}ms`);

  async function stats() {
    try {
      const [p, debt, coll] = await Promise.all([eng.price(), eng.totalDebt(), eng.totalCollateral()]);
      const gold = Number(ethers.formatEther(p));
      const minted = Number(ethers.formatEther(debt));
      const locked = Number(ethers.formatEther(coll));
      const ratio = minted > 0 ? (locked / (minted * gold)) * 100 : 0;
      return { gold, minted, locked, ratio };
    } catch { return null; }
  }

  async function postBuy({ usd, mgld, txHash, via }) {
    const s = await stats();
    const lines = [
      `*$MGLD Buy!*`,
      emojiRow(usd),
      ``,
      `💵 *$${usd.toFixed(2)}* USDT0`,
      `🥇 Got *${mgld.toFixed(6)} MGLD*`,
      s ? `📈 Gold: $${s.gold.toFixed(2)}` : ``,
      s ? `🔒 Collateral locked: $${s.locked.toLocaleString(undefined, { maximumFractionDigits: 0 })} (${s.ratio.toFixed(0)}%)` : ``,
      `🔥 Every mint burns $MINTD`,
      via ? `_via ${via}_` : ``,
      ``,
      `📋 CA (tap to copy):`,
      `\`${MGLD}\``,
      `[Mint](https://mintd.fun/#/synth) | [Chart](https://dexscreener.com/stable/${V3_POOL}) | [Tx](https://stablescan.xyz/tx/${txHash})`,
    ].filter(Boolean);
    const text = lines.join("\n");
    if (LOGO_URL) await tg("sendPhoto", { chat_id: chat, photo: LOGO_URL, caption: text, parse_mode: "Markdown" });
    else await tg("sendMessage", { chat_id: chat, text, parse_mode: "Markdown", disable_web_page_preview: true });
    console.log(`posted buy $${usd.toFixed(2)} (${txHash})`);
  }

  let last = await provider.getBlockNumber();
  let fails = 0;
  async function loop() {
    try {
      const head = await provider.getBlockNumber();
      if (head >= last) {
        const from = Math.max(last, head - MAX_RANGE);
        if (from > last) console.log(`range clamp: skipped ${last}..${from - 1}`);

        // Uniswap V3: negative amount means the pool paid it out
        const v3logs = await provider.getLogs({ address: V3_POOL, topics: [V3_SWAP_TOPIC], fromBlock: from, toBlock: head });
        for (const lg of v3logs) {
          const { args } = v3Iface.parseLog(lg);
          const usdtDelta = v3UsdtIs0 ? args.amount0 : args.amount1;   // + means USDT0 came in
          const mgldDelta = v3UsdtIs0 ? args.amount1 : args.amount0;   // - means MGLD went out
          if (usdtDelta > 0n && mgldDelta < 0n) {
            const usd = Number(ethers.formatUnits(usdtDelta, 6));
            if (usd < MIN_USD) continue;
            await postBuy({ usd, mgld: Number(ethers.formatEther(-mgldDelta)), txHash: lg.transactionHash, via: "Uniswap V3" });
          }
        }

        if (V2_POOL) {
          const v2logs = await provider.getLogs({ address: V2_POOL, topics: [V2_SWAP_TOPIC], fromBlock: from, toBlock: head });
          for (const lg of v2logs) {
            const { args } = v2Iface.parseLog(lg);
            const usdtIn = v2UsdtIs0 ? args.amount0In : args.amount1In;
            const mgldOut = v2UsdtIs0 ? args.amount1Out : args.amount0Out;
            if (usdtIn > 0n && mgldOut > 0n) {
              const usd = Number(ethers.formatUnits(usdtIn, 6));
              if (usd < MIN_USD) continue;
              await postBuy({ usd, mgld: Number(ethers.formatEther(mgldOut)), txHash: lg.transactionHash, via: "MintSwap" });
            }
          }
        }
        last = head + 1;
        fails = 0;
      }
    } catch (e) {
      fails++;
      console.error(`loop error (${fails} in a row):`, e.shortMessage || e.message);
      if (fails >= 5) {
        try { last = (await provider.getBlockNumber()) + 1; fails = 0; console.log(`resynced to head ${last}`); } catch {}
      }
    }
    setTimeout(loop, POLL_MS);
  }
  loop();
}

main().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
