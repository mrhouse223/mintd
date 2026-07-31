// Tells you the moment StableEarn starts accepting deposits again.
//
//   TG_BOT_TOKEN=… TG_CHAT_ID=… node scripts/stable-earn-cap-watch.js
//
// The vault has a supply cap. While it is full, maxDeposit is 0 and a deposit
// reverts, so mintd.fun disables the button. The cap has been raised repeatedly,
// but there is no event for it: Morpho Vault V2 emits nothing when maxDeposit
// changes, because it is derived from the caps and allocations of the underlying
// markets rather than stored. So this polls.
//
// Alerts on the TRANSITION only, closed to open, and re-arms if it shuts again.
// A message every poll while it happens to be open is a message nobody reads.
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const RPC = process.env.STABLE_RPC_URL || "https://rpc.stable.xyz";
const VAULT = "0xb7Df8db22A5DBBFA9ebeb94b3910aec6a4f05c08";
const POLL_MS = Number(process.env.POLL_MS || 120000);
const STATE = path.join(__dirname, "..", "data", "stable-earn-cap.json");

const ABI = [
  "function maxDeposit(address) view returns (uint256)",
  "function totalAssets() view returns (uint256)",
];

async function tg(method, body) {
  const token = process.env.TG_BOT_TOKEN;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!j.ok) {
      console.error(`telegram ${method} failed: ${j.description}`);
      if (j.error_code === 401) console.error("  -> TG_BOT_TOKEN is invalid. Check ~/mintd/.env, then: pm2 delete all && pm2 start ecosystem.config.js && pm2 save");
    }
    return j;
  } catch (e) {
    console.error(`telegram ${method} threw:`, e.message);
    return { ok: false, description: e.message };
  }
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return { open: null }; }
}
function saveState(s) {
  try {
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify(s, null, 1) + "\n");
  } catch (e) { console.error("could not persist state:", e.message); }
}

(async () => {
  const chat = process.env.TG_CHAT_ID;
  if (!process.env.TG_BOT_TOKEN || !chat) throw new Error("Set TG_BOT_TOKEN and TG_CHAT_ID");
  // Verify the token before claiming to be watching anything. A bad token
  // otherwise looks identical to a cap that never reopens, which is the exact
  // failure mode CLAUDE.md records the buybots having shipped with.
  const me = await tg("getMe", {});
  if (!me.ok) throw new Error("telegram getMe failed, refusing to start: " + me.description);
  console.log(`telegram ok as @${me.result.username}`);

  // batchMaxCount 1: this chain rejects batched JSON-RPC outright.
  const rp = new ethers.JsonRpcProvider(RPC, 988, { staticNetwork: true, batchMaxCount: 1 });
  const v = new ethers.Contract(VAULT, ABI, rp);

  let state = loadState();
  console.log(`watching StableEarn cap every ${POLL_MS / 1000}s, last known: ${state.open === null ? "unknown" : state.open ? "open" : "closed"}`);

  for (;;) {
    try {
      const cap = await v.maxDeposit(ethers.ZeroAddress);
      const open = cap > 0n;

      if (state.open !== open) {
        // First observation after a restart is not a transition. Record it
        // silently, or every pm2 restart pings you about a cap that never moved.
        if (state.open === null) {
          console.log(`first observation: ${open ? "open" : "closed"}`);
        } else if (open) {
          const tvl = await v.totalAssets();
          const text =
            `*StableEarn is accepting deposits again*\n\n` +
            `Cap reopened: *${Number(ethers.formatUnits(cap, 6)).toLocaleString(undefined, { maximumFractionDigits: 0 })} USDT0* can be deposited right now.\n` +
            `Vault holds ${Number(ethers.formatUnits(tvl, 6)).toLocaleString(undefined, { maximumFractionDigits: 0 })} USDT0.\n\n` +
            `Deposit from the Earn tab: mintd.fun`;
          const res = await tg("sendMessage", { chat_id: chat, text, parse_mode: "Markdown", disable_web_page_preview: true });
          // Only record the transition once Telegram confirms it. Saving first
          // would swallow the alert permanently if the send failed.
          if (!res.ok) { console.error("alert not delivered, will retry next poll"); continue; }
          console.log(`ALERT SENT: cap reopened at ${ethers.formatUnits(cap, 6)} USDT0`);
        } else {
          console.log("cap closed again, re-armed");
        }
        state = { open, ts: Math.floor(Date.now() / 1000), cap: cap.toString() };
        saveState(state);
      }
    } catch (e) {
      // A transient RPC failure is not a state change. Say so and keep going
      // rather than letting it look like the cap closed.
      console.error("poll failed:", e.shortMessage || e.message);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
