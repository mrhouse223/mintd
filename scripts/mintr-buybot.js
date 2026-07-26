// MINTR buybot: watches the MintSwap MINTR/USDT0 pair for BUYS (USDT0 in ->
// MINTR out) and posts an alert to a Telegram chat/channel. Long-running; poll
// based, no websockets needed. Sells are ignored by default.
//
//   TG_BOT_TOKEN=123:abc TG_CHAT_ID=-1001234567890 node scripts/mintr-buybot.js
//
// Setup:
//   1. Message @BotFather on Telegram -> /newbot -> copy the token.
//   2. Add the bot to your group/channel as an admin.
//   3. Get the chat id: add @RawDataBot to the group, or call
//      https://api.telegram.org/bot<TOKEN>/getUpdates after posting a message.
//      Channel ids look like -1001234567890.
//
// Env:
//   PAIR         MintSwap MINTR/USDT0 pair (auto-resolved from factory if unset)
//   MIN_USD      ignore buys smaller than this (default "1")
//   POLL_MS      poll interval (default "12000")
//   CHART_URL    link shown in the alert (default dexscreener pair page)
//   BUY_TOKEN    emoji used per unit of buy size (default "🟢" green circle)
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://rpc.stable.xyz";
const USDT0 = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";
const MINTR = process.env.MINTR || "0x8817D05f2560189F3697028f639Dbb4C68688400";
const FACTORY = process.env.FACTORY || "0x65E12569E20E8706A4a60fCAB13e9069B78F9f8E";
const BUY_TOKEN = process.env.BUY_TOKEN || "🟣"; // purple circle per buy size, MINTR brand
const LOGO_URL = process.env.LOGO_URL || "https://mintd.fun/mintr.png"; // purple M logo; alerts post as a photo
const MIN_USD = Number(process.env.MIN_USD || "1");
const POLL_MS = Number(process.env.POLL_MS || "12000");

const PAIR_ABI = [
  "event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
];
const MINTR_ABI = ["function price1e18() view returns (uint256)", "function totalSupply() view returns (uint256)"];

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
  const n = Math.min(48, Math.max(1, Math.floor(usd / 5))); // 1 icon per ~$5, capped
  return BUY_TOKEN.repeat(n);
}

async function main() {
  const token = process.env.TG_BOT_TOKEN, chat = process.env.TG_CHAT_ID;
  if (!token || !chat) throw new Error("Set TG_BOT_TOKEN and TG_CHAT_ID");
  // batchMaxCount 1: Stable's RPC mishandles batched JSON-RPC requests, which
  // surfaces in ethers as "could not coalesce error"
  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });

  let pairAddr = process.env.PAIR;
  if (!pairAddr) {
    const fac = new ethers.Contract(FACTORY, ["function getPair(address,address) view returns (address)"], provider);
    pairAddr = await fac.getPair(USDT0, MINTR);
  }
  if (!pairAddr || pairAddr === ethers.ZeroAddress) throw new Error("MINTR/USDT0 pair not found; seed it first");
  const chartUrl = process.env.CHART_URL || `https://dexscreener.com/stable/${pairAddr}`;

  const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
  const mintrC = new ethers.Contract(MINTR, MINTR_ABI, provider);
  const swapTopic = ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)");
  const iface = new ethers.Interface(PAIR_ABI);

  // AMM pools to watch: the MintSwap pair plus any extras (default: the
  // canonical Uniswap V2 MINTR/USDT0 pool). Override with EXTRA_PAIRS=addr,addr
  const extra = (process.env.EXTRA_PAIRS || "0x5e89ECD99A02BD709C71cDF62518490E07Fb567b")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const poolAddrs = [pairAddr, ...extra].filter((a, i, arr) => a && arr.map((x) => x.toLowerCase()).indexOf(a.toLowerCase()) === i);
  const pools = [];
  for (const a of poolAddrs) {
    try {
      const p = new ethers.Contract(a, PAIR_ABI, provider);
      const t0 = (await p.token0()).toLowerCase();
      const isMintSwap = a.toLowerCase() === pairAddr.toLowerCase();
      pools.push({ addr: a, usdtIs0: t0 === USDT0.toLowerCase(), label: isMintSwap ? "MintSwap pool" : "Uniswap pool" });
    } catch (e) { console.error(`skip pool ${a}: ${e.shortMessage || e.message}`); }
  }

  console.log(`MINTR buybot live`);
  pools.forEach((p) => console.log(`  pool:  ${p.addr}  (${p.label})`));
  console.log(`  contract: ${MINTR}`);
  console.log(`  chat:  ${chat}`);
  console.log(`  min:   $${MIN_USD}   poll: ${POLL_MS}ms`);

  // --- command listener: /price and /help in the chat ---
  async function mintrStats() {
    const px = await mintrC.price1e18();
    const supply = await mintrC.totalSupply();
    const contractPx = Number(ethers.formatEther(px));
    const mcap = contractPx * Number(ethers.formatEther(supply));
    return { contractPx, mcap, supply: Number(ethers.formatEther(supply)) };
  }
  async function handleCommands() {
    let cmdOffset = 0;
    try { await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`); } catch {}
    async function cmdLoop() {
      try {
        const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?timeout=30&offset=${cmdOffset}`);
        const j = await r.json();
        for (const u of j.result || []) {
          cmdOffset = u.update_id + 1;
          const msg = u.message || u.channel_post;
          if (!msg || !msg.text) continue;
          const text = msg.text.split("@")[0].trim().toLowerCase();
          const from = msg.chat.id;
          if (text === "/price") {
            try {
              const s = await mintrStats();
              await tg("sendMessage", { chat_id: from, parse_mode: "Markdown", disable_web_page_preview: true,
                text: [`*MINTR* backing price`, `📈 *$${s.contractPx.toFixed(8)}*`, `🏦 Market cap: $${s.mcap.toLocaleString(undefined,{maximumFractionDigits:0})}`, ``, `MINTR only goes up: every buy/sell adds to the reserve. [Buy](https://mintd.fun/#mintr) | [Chart](${chartUrl})`].join("\n") });
            } catch { await tg("sendMessage", { chat_id: from, text: "couldn't read MINTR price right now, try again in a sec" }); }
          } else if (text === "/help" || text === "/start") {
            await tg("sendMessage", { chat_id: from, parse_mode: "Markdown",
              text: [`*MINTR bot*`, `/price — current MINTR backing price & market cap`, `Buy alerts post here automatically.`].join("\n") });
          }
        }
      } catch (e) { console.error("cmd error:", e.message); }
      setTimeout(cmdLoop, 500);
    }
    cmdLoop();
  }
  handleCommands();

  // MINTR contract "Bought" event (buys made on the site's MINTR page, minted
  // against the reserve — these never touch the pool, so watch them separately)
  const boughtTopic = ethers.id("Bought(address,uint256,uint256,uint256)");
  const mintrIface = new ethers.Interface(["event Bought(address indexed buyer,uint256 usdtIn,uint256 mintrOut,uint256 price1e18)"]);

  let lastBacking = null; // last backing price we reported, for the "since last buy" delta
  async function postBuy({ usd, mintr, contractPx, mcap, txHash, via }) {
    let backingLine = "";
    if (contractPx != null) {
      let deltaTxt = "";
      if (lastBacking != null && lastBacking > 0) {
        const pct = ((contractPx - lastBacking) / lastBacking) * 100;
        if (pct > 0.0001) deltaTxt = ` (▲ +${pct.toFixed(2)}% since last buy)`;
        else if (pct < -0.0001) deltaTxt = ` (▼ ${pct.toFixed(2)}%)`;
      }
      backingLine = `📈 Backing price: $${contractPx.toFixed(8)}${deltaTxt}`;
      lastBacking = contractPx;
    }
    const lines = [
      `*MINTR Buy!*`,
      emojiRow(usd),
      ``,
      `💵 *$${usd.toFixed(2)}* (${usd.toFixed(2)} USDT0)`,
      `🪙 Got *${mintr.toLocaleString(undefined, { maximumFractionDigits: 2 })} MINTR*`,
      backingLine,
      `🟣 MINTR only goes up`,
      mcap != null ? `🏦 Market cap: $${mcap.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : ``,
      via ? `_via ${via}_` : ``,
      ``,
      `📋 CA (tap to copy):`,
      `\`${MINTR}\``,
      `[Chart](${chartUrl}) | [Buy on mintd.fun](https://mintd.fun/#mintr) | [Tx](https://stablescan.xyz/tx/${txHash})`,
    ].filter(Boolean);
    const text = lines.join("\n");
    if (LOGO_URL) await tg("sendPhoto", { chat_id: chat, photo: LOGO_URL, caption: text, parse_mode: "Markdown" });
    else await tg("sendMessage", { chat_id: chat, text, parse_mode: "Markdown", disable_web_page_preview: true });
    console.log(`posted buy $${usd.toFixed(2)} (${txHash})`);
  }
  async function statsSafe() {
    try {
      const px = await mintrC.price1e18();
      const supply = await mintrC.totalSupply();
      const contractPx = Number(ethers.formatEther(px));
      return { contractPx, mcap: contractPx * Number(ethers.formatEther(supply)) };
    } catch { return { contractPx: null, mcap: null }; }
  }

  let last = await provider.getBlockNumber();
  let fails = 0;
  const MAX_RANGE = Number(process.env.MAX_RANGE || "2000"); // never scan more blocks than this per poll
  try { lastBacking = Number(ethers.formatEther(await mintrC.price1e18())); console.log(`  starting backing price: $${lastBacking.toFixed(8)}`); } catch {}
  async function loop() {
    try {
      const head = await provider.getBlockNumber();
      if (head >= last) {
        // clamp the scan window so a bad stretch can't grow the range until
        // the RPC rejects every request (the old stuck-forever failure mode)
        const from = Math.max(last, head - MAX_RANGE);
        if (from > last) console.log(`range clamp: skipped blocks ${last}..${from - 1}`);
        // 1) pool swaps (MintSwap + Uniswap MINTR/USDT0)
        for (const pool of pools) {
          const swaps = await provider.getLogs({ address: pool.addr, topics: [swapTopic], fromBlock: from, toBlock: head });
          for (const log of swaps) {
            const { args } = iface.parseLog(log);
            const usdtIn = pool.usdtIs0 ? args.amount0In : args.amount1In;
            const mintrOut = pool.usdtIs0 ? args.amount1Out : args.amount0Out;
            if (usdtIn > 0n && mintrOut > 0n) {
              const usd = Number(ethers.formatUnits(usdtIn, 6));
              if (usd < MIN_USD) continue;
              const s = await statsSafe();
              await postBuy({ usd, mintr: Number(ethers.formatEther(mintrOut)), ...s, txHash: log.transactionHash, via: pool.label });
            }
          }
        }
        // 2) contract buys (MINTR page, minted from reserve)
        const boughts = await provider.getLogs({ address: MINTR, topics: [boughtTopic], fromBlock: from, toBlock: head });
        for (const log of boughts) {
          const { args } = mintrIface.parseLog(log);
          const usd = Number(ethers.formatUnits(args.usdtIn, 6));
          if (usd < MIN_USD) continue;
          const contractPx = Number(ethers.formatEther(args.price1e18));
          let mcap = null;
          try { const supply = await mintrC.totalSupply(); mcap = contractPx * Number(ethers.formatEther(supply)); } catch {}
          await postBuy({ usd, mintr: Number(ethers.formatEther(args.mintrOut)), contractPx, mcap, txHash: log.transactionHash, via: "mintd.fun (backing)" });
        }
        last = head + 1;
        fails = 0;
      }
    } catch (e) {
      fails++;
      console.error(`loop error (${fails} in a row):`, e.shortMessage || e.message);
      // after 5 straight failures, jump to the chain head instead of retrying
      // the same doomed range forever. Missing a few alerts beats going silent.
      if (fails >= 5) {
        try { last = (await provider.getBlockNumber()) + 1; fails = 0; console.log(`resynced to chain head, resuming from block ${last}`); } catch {}
      }
    }
    setTimeout(loop, POLL_MS);
  }
  loop();
}

main().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
