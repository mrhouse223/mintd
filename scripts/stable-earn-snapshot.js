// Records StableEarn's share price so the site can state a measured yield.
//
//   node scripts/stable-earn-snapshot.js        # append one snapshot
//
// WHY THIS EXISTS
// The vault's APY cannot be read from the chain, and it cannot be reconstructed
// afterwards either. Stable keeps no archive state, so an eth_call at a past
// block fails outright (CLAUDE.md gotcha 3), and Morpho's public API does not
// cover chain 988. A yield figure therefore has to be measured forward from
// snapshots taken while the chain is live, or not shown at all.
//
// The file it writes is the only record. Like stats-cache.json, history that is
// not captured before it passes is gone, so run this on a timer rather than by
// hand. Once a day is enough; the site refuses to annualise anything under a day.
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const RPC = process.env.STABLE_RPC_URL || "https://rpc.stable.xyz";
const VAULT = "0xb7Df8db22A5DBBFA9ebeb94b3910aec6a4f05c08";
const OUT = path.join(__dirname, "..", "frontend", "stable-earn.json");
const MAX = 400;   // roughly a year of daily points

const ABI = [
  "function convertToAssets(uint256) view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function maxDeposit(address) view returns (uint256)",
];

(async () => {
  // batchMaxCount 1: this chain rejects batched JSON-RPC outright, and ethers
  // batches anything pending in the same tick regardless of who issued it.
  const rp = new ethers.JsonRpcProvider(RPC, 988, { staticNetwork: true, batchMaxCount: 1 });
  const v = new ethers.Contract(VAULT, ABI, rp);

  const px = await v.convertToAssets(10n ** 18n);
  const tvl = await v.totalAssets();
  const cap = await v.maxDeposit(ethers.ZeroAddress);

  let doc = { vault: VAULT, note: "share price measured by mintd.fun, one point per run", snapshots: [] };
  if (fs.existsSync(OUT)) {
    try { doc = JSON.parse(fs.readFileSync(OUT, "utf8")); doc.snapshots = doc.snapshots || []; }
    catch { /* a corrupt file should not stop today's measurement */ }
  }

  const now = Math.floor(Date.now() / 1000);
  const last = doc.snapshots[doc.snapshots.length - 1];
  // Skip a same-hour rerun rather than stacking points that cannot differ. Two
  // snapshots minutes apart annualise noise into an absurd APY.
  if (last && now - last.ts < 3600) {
    console.log(`last snapshot was ${Math.round((now - last.ts) / 60)}m ago, skipping`);
    return;
  }
  // A share price that went DOWN is possible (a loss) but is far more often a
  // misread. Record it, and say so loudly rather than letting it quietly halve
  // the published yield.
  if (last && Number(px) < Number(last.px)) {
    console.log(`WARNING: share price fell, ${last.px} -> ${px}. Recording it, but check the vault.`);
  }

  doc.vault = VAULT;
  doc.snapshots.push({ ts: now, px: px.toString(), tvl: tvl.toString(), capOpen: cap > 0n });
  if (doc.snapshots.length > MAX) doc.snapshots = doc.snapshots.slice(-MAX);
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 1) + "\n");

  const f = doc.snapshots[0];
  const days = (now - f.ts) / 86400;
  const apy = days >= 1 ? (Math.pow(Number(px) / Number(f.px), 365 / days) - 1) * 100 : null;
  console.log(`share price ${ethers.formatUnits(px, 6)} USDT0`);
  console.log(`totalAssets ${ethers.formatUnits(tvl, 6)} USDT0`);
  console.log(`deposits    ${cap > 0n ? "open" : "AT CAPACITY"}`);
  console.log(`snapshots   ${doc.snapshots.length}, spanning ${days.toFixed(2)}d`);
  console.log(`measured    ${apy == null ? "needs a day of history" : apy.toFixed(2) + "%"}`);
})().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
