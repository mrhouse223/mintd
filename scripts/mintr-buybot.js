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
// Text-only alerts by default: they are more compact in a busy chat and can't
// break on a bad image host. Set LOGO_URL=https://mintd.fun/mintr.png to post
// each alert as a photo instead.
const LOGO_URL = process.env.LOGO_URL || "";
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
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!j.ok) {
      console.error(`telegram ${method} failed: ${j.description}`);
      // 401 means the token itself is wrong: say so plainly rather than
      // letting it look like an ordinary transient hiccup
      if (j.error_code === 401) console.error("  -> TG_BOT_TOKEN is invalid. Check ~/mintd/.env, then: pm2 restart all --update-env");
    }
    return j;
  } catch (e) {
    console.error(`telegram ${method} threw:`, e.message);
    return { ok: false, description: e.message };
  }
}

// Backing moves in tiny increments, so a fixed 2dp prints "+0.00%" for a real
// change. Grow the precision until at least two significant digits survive,
// capped at 8dp so it never turns into noise.
function pctStr(pct) {
  const a = Math.abs(pct);
  if (a === 0) return "0%";
  let dp = 2;
  while (dp < 8 && a < 5 / Math.pow(10, dp)) dp++;
  return pct.toFixed(dp).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") + "%";
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

  // Prove the token works at boot. Otherwise the bot happily scans for hours
  // and every alert dies at the Telegram API with nobody watching.
  const me = await tg("getMe", {});
  if (me.ok) console.log(`  telegram: @${me.result.username}  OK`);
  else console.error(`  telegram: NOT AUTHENTICATED - no alerts will be delivered`);

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
              text: [`*MINTR bot*`, `/price - current MINTR backing price and market cap`, `Buy alerts post here automatically.`].join("\n") });
          }
        }
      } catch (e) { console.error("cmd error:", e.message); }
      setTimeout(cmdLoop, 500);
    }
    cmdLoop();
  }
  handleCommands();

  // MINTR contract "Bought" event (buys made on the site's MINTR page, minted
  // against the reserve: these never touch the pool, so watch them separately)
  const boughtTopic = ethers.id("Bought(address,uint256,uint256,uint256)");
  const mintrIface = new ethers.Interface(["event Bought(address indexed buyer,uint256 usdtIn,uint256 mintrOut,uint256 price1e18)"]);

  let lastBacking = null; // last backing price we reported, for the "since last buy" delta
  // `minted` means the buy went through the contract on the site: new MINTR was
  // created against the reserve and the backing price moved. A pool swap just
  // changes hands, so it stays a plain buy.
  async function postBuy({ usd, mintr, contractPx, mcap, txHash, via, minted }) {
    let backingLine = "";
    if (contractPx != null) {
      let deltaTxt = "";
      if (lastBacking != null && lastBacking > 0) {
        const pct = ((contractPx - lastBacking) / lastBacking) * 100;
        if (pct > 0) deltaTxt = ` (▲ +${pctStr(pct)} since last buy)`;
        else if (pct < 0) deltaTxt = ` (▼ ${pctStr(pct)})`;
      }
      backingLine = `📈 Backing price: $${contractPx.toFixed(8)}${deltaTxt}`;
      lastBacking = contractPx;
    }
    const lines = [
      minted ? `*MINTR MINTED!*` : `*MINTR Buy!*`,
      emojiRow(usd),
      ``,
      `💵 *$${usd.toFixed(2)}* (${usd.toFixed(2)} USDT0)`,
      minted
        ? `🪙 Minted *${mintr.toLocaleString(undefined, { maximumFractionDigits: 2 })} MINTR*`
        : `🪙 Got *${mintr.toLocaleString(undefined, { maximumFractionDigits: 2 })} MINTR*`,
      backingLine,
      minted ? `🔒 Reserve grew, backing price up for every holder` : `🟣 MINTR only goes up`,
      mcap != null ? `🏦 Market cap: $${mcap.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : ``,
      via ? `_via ${via}_` : ``,
      ``,
      `📋 CA (tap to copy):`,
      `\`${MINTR}\``,
      `[Chart](${chartUrl}) | [Buy on mintd.fun](https://mintd.fun/#mintr) | [Tx](https://stablescan.xyz/tx/${txHash})`,
    ].filter(Boolean);
    const text = lines.join("\n");
    let res;
    if (LOGO_URL) {
      res = await tg("sendPhoto", { chat_id: chat, photo: LOGO_URL, caption: text, parse_mode: "Markdown" });
      // a broken image URL shouldn't cost us the alert: fall back to plain text
      if (!res.ok && res.error_code !== 401) {
        res = await tg("sendMessage", { chat_id: chat, text, parse_mode: "Markdown", disable_web_page_preview: true });
      }
    } else {
      res = await tg("sendMessage", { chat_id: chat, text, parse_mode: "Markdown", disable_web_page_preview: true });
    }
    // only claim success when Telegram actually accepted it
    console.log(`${res.ok ? "posted" : "FAILED TO POST"} buy $${usd.toFixed(2)} (${txHash})`);
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
  const MAX_RANGE = Number(process.env.MAX_RANGE || "500");
// 500 is the RPC's hard [from, to] distance limit, not a tuning choice.
// It was 2000, which worked only while the bot kept up: the moment it fell
// more than 500 blocks behind, EVERY request exceeded the cap, so it could
// never catch up and sat in a permanent failure loop skipping blocks while
// pm2 still reported it online. Measured: a 500-block span succeeds and 501
// fails with "could not coalesce error".

  // Stable's RPC rate-limits in bursts, surfacing as "could not coalesce error"
  // or "exceeded maximum retry limit". Retrying the individual call with a
  // short backoff clears almost all of them without losing the scan position.
  async function rpc(fn, label) {
    let lastErr;
    for (let i = 0; i < 4; i++) {
      try { return await fn(); } catch (e) {
        lastErr = e;
        const wait = 300 * Math.pow(3, i) + Math.random() * 300; // 0.3s, 0.9s, 2.7s, 8.1s
        if (i < 3) await new Promise((r) => setTimeout(r, wait));
      }
    }
    throw new Error(`${label}: ${lastErr.shortMessage || lastErr.message}`);
  }

  // A failure halfway through a scan makes us re-read blocks we already
  // handled. Remember what we posted so a retry can't double-alert the chat.
  const posted = new Set();
  const seen = (h) => {
    if (posted.has(h)) return true;
    posted.add(h);
    if (posted.size > 500) posted.delete(posted.values().next().value);
    return false;
  };

  try { lastBacking = Number(ethers.formatEther(await mintrC.price1e18())); console.log(`  starting backing price: $${lastBacking.toFixed(8)}`); } catch {}
  async function loop() {
    try {
      const head = await rpc(() => provider.getBlockNumber(), "getBlockNumber");
      if (head >= last) {
        // clamp the scan window so a bad stretch can't grow the range until
        // the RPC rejects every request (the old stuck-forever failure mode)
        const from = Math.max(last, head - MAX_RANGE);
        if (from > last) console.log(`range clamp: skipped blocks ${last}..${from - 1}`);
        // 1) pool swaps (MintSwap + Uniswap MINTR/USDT0)
        for (const pool of pools) {
          const swaps = await rpc(() => provider.getLogs({ address: pool.addr, topics: [swapTopic], fromBlock: from, toBlock: head }), "getLogs pool");
          for (const log of swaps) {
            const { args } = iface.parseLog(log);
            const usdtIn = pool.usdtIs0 ? args.amount0In : args.amount1In;
            const mintrOut = pool.usdtIs0 ? args.amount1Out : args.amount0Out;
            if (usdtIn > 0n && mintrOut > 0n) {
              const usd = Number(ethers.formatUnits(usdtIn, 6));
              if (usd < MIN_USD) continue;
              if (seen(log.transactionHash + ":" + log.index)) continue;
              const s = await statsSafe();
              await postBuy({ usd, mintr: Number(ethers.formatEther(mintrOut)), ...s, txHash: log.transactionHash, via: pool.label });
            }
          }
        }
        // 2) contract buys (MINTR page, minted from reserve)
        const boughts = await rpc(() => provider.getLogs({ address: MINTR, topics: [boughtTopic], fromBlock: from, toBlock: head }), "getLogs contract");
        for (const log of boughts) {
          const { args } = mintrIface.parseLog(log);
          const usd = Number(ethers.formatUnits(args.usdtIn, 6));
          if (usd < MIN_USD) continue;
          if (seen(log.transactionHash + ":" + log.index)) continue;
          const contractPx = Number(ethers.formatEther(args.price1e18));
          let mcap = null;
          try { const supply = await mintrC.totalSupply(); mcap = contractPx * Number(ethers.formatEther(supply)); } catch {}
          await postBuy({ usd, mintr: Number(ethers.formatEther(args.mintrOut)), contractPx, mcap, txHash: log.transactionHash, via: "mintd.fun", minted: true });
        }
        last = head + 1;
        fails = 0;
      }
    } catch (e) {
      fails++;
      console.error(`loop error (${fails} in a row):`, e.shortMessage || e.message);
      // Do NOT jump to head here. The old code skipped every block in between,
      // which silently dropped any buy that happened during the bad stretch.
      // MAX_RANGE already bounds the scan, so the safe move is to keep our
      // position and let the backoff below give the RPC room to recover.
      if (fails >= 10) {
        // genuinely wedged: step forward one clamped window so we make progress
        last = last + MAX_RANGE;
        fails = 0;
        console.error(`still failing, stepping forward to block ${last} (blocks may have been missed)`);
      }
    }
    // back off hard while the RPC is unhappy, then return to the normal cadence
    const delay = fails ? Math.min(POLL_MS * Math.pow(2, fails), 120000) : POLL_MS;
    setTimeout(loop, delay);
  }
  loop();
}

main().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
